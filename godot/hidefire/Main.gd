extends Node3D
## Hide & Fire arena root.
##
## Builds the world, owns the local player and the remote puppets, and is the
## ONLY place that talks to JavaScript. The SvelteKit host (HideFireArena.svelte)
## owns the WebSocket; here we just:
##   - emit the local player's transform  -> window.hidefireOnTick(json)   (~20/s)
##   - report a kill                       -> window.hidefireOnHit(uid)
##   - take peer transforms                <- window.hidefirePushPeers(json)
##   - take the round state                <- window.hidefireSetRound(json)
## The DO relays the ephemeral moves; kills/score/timer are the host's job.

const PlayerScript = preload("res://Player.gd")
const PuppetScript = preload("res://Puppet.gd")
const BotScript = preload("res://Bot.gd")

# Opposite corners so hider and seeker never spawn on top of each other — the bug
# that made the other player's puppet appear inside your own camera.
const SPAWNS := { "hider": Vector3(-16, 1, -16), "seeker": Vector3(16, 1, 16) }

var player: CharacterBody3D
var puppets := {}                 # uid -> Puppet
var bot                           # solo AI opponent, or null
var my_uid := 0
var my_role := ""
var round_over := false

var _tick_accum := 0.0
var _last_round := ""
const TICK_DT := 0.05             # ~20/s; the JS host throttles down to 15

func _ready() -> void:
	_ensure_input()
	_build_environment()
	_build_arena()
	_spawn_local_player()
	_setup_bridge()

func _process(delta: float) -> void:
	_poll_inbound()               # JS -> Godot (peers + round), see _setup_bridge
	_tick_accum += delta
	if _tick_accum >= TICK_DT:
		_tick_accum = 0.0
		_emit_tick()

# ---- input (registered here so project.godot needs no InputEvent authoring) --
func _ensure_input() -> void:
	var keys := {
		"move_forward": KEY_W, "move_back": KEY_S,
		"move_left": KEY_A, "move_right": KEY_D,
		"jump": KEY_SPACE, "crouch": KEY_SHIFT, "camo": KEY_E, "pose": KEY_F
	}
	for act_name in keys:
		if not InputMap.has_action(act_name):
			InputMap.add_action(act_name)
			var ev := InputEventKey.new()
			ev.keycode = keys[act_name]
			InputMap.action_add_event(act_name, ev)
	if not InputMap.has_action("fire"):
		InputMap.add_action("fire")
		var mb := InputEventMouseButton.new()
		mb.button_index = MOUSE_BUTTON_LEFT
		InputMap.action_add_event("fire", mb)

# ---- world -------------------------------------------------------------------
func _build_environment() -> void:
	var light := DirectionalLight3D.new()
	light.rotation_degrees = Vector3(-55, -35, 0)
	light.shadow_enabled = true
	add_child(light)

	var world_env := WorldEnvironment.new()
	var env := Environment.new()
	env.background_mode = Environment.BG_COLOR
	env.background_color = Color(0.53, 0.6, 0.7)
	env.ambient_light_color = Color(0.4, 0.4, 0.45)
	env.ambient_light_energy = 0.6
	world_env.environment = env
	add_child(world_env)

## One coloured, collidable box. `albedo_color` is what a hider's camo copies.
func _box(size: Vector3, pos: Vector3, color: Color) -> void:
	var body := StaticBody3D.new()
	body.position = pos
	var mesh := MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = size
	var mat := StandardMaterial3D.new()
	mat.albedo_color = color
	bm.material = mat
	mesh.mesh = bm
	body.add_child(mesh)
	var col := CollisionShape3D.new()
	var shape := BoxShape3D.new()
	shape.size = size
	col.shape = shape
	body.add_child(col)
	add_child(body)

func _build_arena() -> void:
	var h := 4.0
	# Floor + outer walls
	_box(Vector3(40, 1, 40), Vector3(0, -0.5, 0), Color(0.45, 0.42, 0.38))
	_box(Vector3(40, h, 1), Vector3(0, h / 2, -20), Color(0.6, 0.6, 0.62))
	_box(Vector3(40, h, 1), Vector3(0, h / 2, 20), Color(0.6, 0.6, 0.62))
	_box(Vector3(1, h, 40), Vector3(-20, h / 2, 0), Color(0.6, 0.6, 0.62))
	_box(Vector3(1, h, 40), Vector3(20, h / 2, 0), Color(0.6, 0.6, 0.62))
	# Inner dividers -> a few rooms to hide between
	_box(Vector3(1, h, 22), Vector3(-6, h / 2, -9), Color(0.55, 0.5, 0.5))
	_box(Vector3(1, h, 22), Vector3(8, h / 2, 9), Color(0.5, 0.55, 0.5))
	_box(Vector3(16, h, 1), Vector3(-12, h / 2, 4), Color(0.5, 0.5, 0.55))
	# Camo props: distinct colours a hider can match against
	_box(Vector3(2, 2, 2), Vector3(-14, 1, -14), Color(0.2, 0.5, 0.8))
	_box(Vector3(2, 3, 2), Vector3(12, 1.5, -12), Color(0.8, 0.3, 0.3))
	_box(Vector3(3, 1, 3), Vector3(0, 0.5, 0), Color(0.3, 0.7, 0.35))
	_box(Vector3(2, 2, 2), Vector3(14, 1, 14), Color(0.8, 0.7, 0.2))

func _spawn_local_player() -> void:
	player = CharacterBody3D.new()
	player.set_script(PlayerScript)
	player.position = SPAWNS["hider"]  # placeholder until setRound assigns a role
	add_child(player)
	player.arena = self
	# Face the arena centre, not the nearest wall — otherwise spawn looks like a
	# tiny box.
	player.look_at(Vector3(0, player.global_position.y, 0), Vector3.UP)

# ---- JS bridge ---------------------------------------------------------------
# Godot -> JS (window.hidefireOnTick / OnHit / OnReady) works by calling window
# methods directly. JS -> Godot does NOT use create_callback — its proxies get
# garbage-collected in the web export and the call silently no-ops. Instead JS
# just appends peer JSON to `window.__hidefireInbox` and sets `window.__hidefireRound`,
# and we POLL them every frame (_poll_inbound). Reading the window is reliable.
func _setup_bridge() -> void:
	if not OS.has_feature("web"):
		return
	var w = JavaScriptBridge.get_interface("window")
	if w and w.hidefireOnReady:
		w.hidefireOnReady()

func _poll_inbound() -> void:
	if not OS.has_feature("web"):
		return
	# PULL model: the only reliable JS<->Godot channel in this export is Godot
	# CALLING a window function and reading its return (create_callback proxies get
	# GC'd; eval() no-ops single-threaded). The JS host exposes hidefireDrain()
	# (returns+clears queued peer JSON) and hidefireRoundJson() (current round).
	var w = JavaScriptBridge.get_interface("window")
	if w == null:
		return
	# Call unconditionally — the host defines these before the engine boots. (A
	# truthiness guard `if w.hidefireDrain:` reads false for a JS-function property
	# even when it exists, so we can't gate on it; the CALL itself works fine.)
	var raw = w.hidefireDrain()
	if typeof(raw) == TYPE_STRING and raw != "" and raw != "[]":
		var arr = JSON.parse_string(raw)
		if typeof(arr) == TYPE_ARRAY:
			for item in arr:
				_apply_peer(str(item))
	var r = w.hidefireRoundJson()
	if typeof(r) == TYPE_STRING and r != "" and r != _last_round:
		_last_round = r
		_apply_round(r)
	# Touch input from the on-screen mobile controls (getter clears one-shots).
	if player:
		var tj = w.hidefireTouchJson()
		if typeof(tj) == TYPE_STRING and tj != "":
			var t = JSON.parse_string(tj)
			if typeof(t) == TYPE_DICTIONARY:
				player.apply_touch(t)

func _emit_tick() -> void:
	if player == null or not OS.has_feature("web"):
		return
	var w = JavaScriptBridge.get_interface("window")
	if w and w.hidefireOnTick:
		w.hidefireOnTick(JSON.stringify(player.get_net_state()))

func report_hit(uid: int) -> void:
	if not OS.has_feature("web"):
		return
	var w = JavaScriptBridge.get_interface("window")
	if w and w.hidefireOnHit:
		w.hidefireOnHit(uid)

func _apply_peer(json: String) -> void:
	var data = JSON.parse_string(json)
	if typeof(data) != TYPE_DICTIONARY:
		return
	var uid := int(data.get("uid", 0))
	if uid == 0:
		return
	var p = puppets.get(uid)
	if p == null:
		p = CharacterBody3D.new()
		p.set_script(PuppetScript)
		add_child(p)
		p.setup(uid)
		puppets[uid] = p
	p.apply_state(data)

func _apply_round(json: String) -> void:
	var data = JSON.parse_string(json)
	if typeof(data) != TYPE_DICTIONARY:
		return
	var new_role := str(data.get("role", ""))
	my_uid = int(data.get("you", 0))
	round_over = data.get("result", null) != null

	# Stamp our identity so a shooter's ray names the right victim (and the bot
	# knows which body is the human).
	if player:
		player.set_meta("uid", my_uid)

	# (Re)spawn by role at the start of a live round or when the side swaps.
	if not round_over and new_role != "":
		if new_role != my_role and SPAWNS.has(new_role):
			my_role = new_role
			if player:
				player.spawn_at(SPAWNS[new_role])
		if player:
			player.can_camo = my_role == "hider"

	# Death / round-over from the authoritative round state.
	var alive_map = data.get("alive", {})
	if player:
		if round_over:
			player.frozen = true
		elif typeof(alive_map) == TYPE_DICTIONARY \
				and alive_map.has(str(my_uid)) and not bool(alive_map[str(my_uid)]):
			player.die()

	# Solo practice: spawn / update the AI opponent.
	var bot_info = data.get("bot", null)
	if bool(data.get("solo", false)) and typeof(bot_info) == TYPE_DICTIONARY:
		_ensure_bot(int(bot_info.get("uid", 0)), str(bot_info.get("role", "")), round_over)

## Create the bot once, then re-seat it only when its role changes (round swap).
func _ensure_bot(buid: int, brole: String, over: bool) -> void:
	if bot == null:
		bot = CharacterBody3D.new()
		bot.set_script(BotScript)
		add_child(bot)
		bot.setup(buid, self, player)
		bot.begin_round(brole, SPAWNS.get(brole, Vector3(16, 1, 16)))
	elif brole != bot.role:
		bot.begin_round(brole, SPAWNS.get(brole, Vector3(16, 1, 16)))
	bot.frozen = over
