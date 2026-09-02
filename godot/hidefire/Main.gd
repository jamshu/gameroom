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

# Opposite corners so the two teams never spawn on top of each other. Keyed by
# BOTH the team id (A/B, current) and the legacy role (hider/seeker) so the bot,
# which still reasons in roles, spawns at the right corner too.
const SPAWNS := {
	"A": Vector3(-26, 1, -26), "B": Vector3(26, 1, 26),
	"hider": Vector3(-26, 1, -26), "seeker": Vector3(26, 1, 26)
}

# Fan up to four teammates out from a corner so they don't spawn inside each other.
func _team_spawn(key: String, slot: int) -> Vector3:
	var base = SPAWNS.get(key, Vector3(16, 1, 16))
	return base + Vector3(float(slot % 2) * 3.0, 0.0, float((slot / 2) % 2) * 3.0)

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
	# Floor + outer walls — 60x60, wide enough for two teams of four to spread out.
	_box(Vector3(60, 1, 60), Vector3(0, -0.5, 0), Color(0.45, 0.42, 0.38))
	_box(Vector3(60, h, 1), Vector3(0, h / 2, -30), Color(0.6, 0.6, 0.62))
	_box(Vector3(60, h, 1), Vector3(0, h / 2, 30), Color(0.6, 0.6, 0.62))
	_box(Vector3(1, h, 60), Vector3(-30, h / 2, 0), Color(0.6, 0.6, 0.62))
	_box(Vector3(1, h, 60), Vector3(30, h / 2, 0), Color(0.6, 0.6, 0.62))
	# Inner dividers -> a maze of rooms and lanes to break sightlines.
	_box(Vector3(1, h, 34), Vector3(-10, h / 2, -12), Color(0.55, 0.5, 0.5))
	_box(Vector3(1, h, 34), Vector3(12, h / 2, 12), Color(0.5, 0.55, 0.5))
	_box(Vector3(24, h, 1), Vector3(-18, h / 2, 6), Color(0.5, 0.5, 0.55))
	_box(Vector3(24, h, 1), Vector3(18, h / 2, -6), Color(0.52, 0.5, 0.53))
	_box(Vector3(1, h, 16), Vector3(2, h / 2, 22), Color(0.54, 0.52, 0.5))
	_box(Vector3(1, h, 16), Vector3(-2, h / 2, -22), Color(0.5, 0.53, 0.52))
	_box(Vector3(14, h, 1), Vector3(0, h / 2, 0), Color(0.53, 0.51, 0.55))
	# Camo props: distinct colours a hider can match against, scattered across the
	# whole floor so there is cover near every route.
	_box(Vector3(2, 2, 2), Vector3(-24, 1, -24), Color(0.2, 0.5, 0.8))
	_box(Vector3(2, 3, 2), Vector3(22, 1.5, -22), Color(0.8, 0.3, 0.3))
	_box(Vector3(3, 1, 3), Vector3(0, 0.5, 0), Color(0.3, 0.7, 0.35))
	_box(Vector3(2, 2, 2), Vector3(24, 1, 24), Color(0.8, 0.7, 0.2))
	_box(Vector3(2.5, 2.5, 2.5), Vector3(-22, 1.25, 20), Color(0.6, 0.35, 0.75))
	_box(Vector3(2, 2, 3), Vector3(18, 1, 4), Color(0.25, 0.65, 0.7))
	_box(Vector3(3, 2, 2), Vector3(-16, 1, -4), Color(0.75, 0.55, 0.25))
	_box(Vector3(2, 4, 2), Vector3(8, 2, -18), Color(0.4, 0.6, 0.4))
	_box(Vector3(2, 2, 2), Vector3(-8, 1, 16), Color(0.7, 0.4, 0.5))
	_box(Vector3(2.5, 1.5, 2.5), Vector3(14, 0.75, 20), Color(0.45, 0.5, 0.7))
	_box(Vector3(2, 3, 2), Vector3(-14, 1.5, 10), Color(0.65, 0.65, 0.3))
	_box(Vector3(3, 2, 3), Vector3(6, 1, 26), Color(0.3, 0.55, 0.6))
	_box(Vector3(2, 2, 2), Vector3(26, 1, -8), Color(0.55, 0.45, 0.6))
	_box(Vector3(2, 2.5, 2), Vector3(-26, 1.25, 2), Color(0.5, 0.6, 0.45))

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

## A short red particle burst at a world point. `big` = a kill spray. CPUParticles
## (not GPU) so it renders in the GL-compatibility web export.
func spawn_blood(pos: Vector3, big := false) -> void:
	var fx := CPUParticles3D.new()
	fx.position = pos
	fx.emitting = true
	fx.one_shot = true
	fx.amount = 28 if big else 12
	fx.lifetime = 0.7
	fx.explosiveness = 1.0
	fx.direction = Vector3(0, 1, 0)
	fx.spread = 80.0
	fx.initial_velocity_min = 1.5
	fx.initial_velocity_max = 6.0 if big else 3.5
	fx.gravity = Vector3(0, -9.8, 0)
	fx.scale_amount_min = 0.05
	fx.scale_amount_max = 0.16 if big else 0.1
	var drop := SphereMesh.new()
	drop.radius = 0.06
	drop.height = 0.12
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(0.7, 0.04, 0.04)
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	drop.material = mat
	fx.mesh = drop
	add_child(fx)
	get_tree().create_timer(fx.lifetime + 0.2).timeout.connect(fx.queue_free)

## A kill blast: fiery particle burst + a brief flash of light. Paired with a big
## blood spray on death.
func spawn_explosion(pos: Vector3) -> void:
	var fx := CPUParticles3D.new()
	fx.position = pos
	fx.emitting = true
	fx.one_shot = true
	fx.amount = 40
	fx.lifetime = 0.6
	fx.explosiveness = 1.0
	fx.direction = Vector3(0, 1, 0)
	fx.spread = 180.0
	fx.initial_velocity_min = 3.0
	fx.initial_velocity_max = 9.0
	fx.gravity = Vector3(0, -4.0, 0)
	fx.scale_amount_min = 0.1
	fx.scale_amount_max = 0.3
	var chunk := SphereMesh.new()
	chunk.radius = 0.08
	chunk.height = 0.16
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(1.0, 0.55, 0.1)
	mat.emission_enabled = true
	mat.emission = Color(1.0, 0.5, 0.05)
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	chunk.material = mat
	fx.mesh = chunk
	add_child(fx)

	var flash := OmniLight3D.new()
	flash.position = pos
	flash.light_color = Color(1.0, 0.7, 0.3)
	flash.light_energy = 8.0
	flash.omni_range = 8.0
	add_child(flash)
	get_tree().create_timer(0.12).timeout.connect(flash.queue_free)
	get_tree().create_timer(fx.lifetime + 0.2).timeout.connect(fx.queue_free)

## Convenience: the full death FX at a body position.
func death_fx(pos: Vector3) -> void:
	spawn_blood(pos, true)
	spawn_explosion(pos)

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
		p.setup(uid, self)
		puppets[uid] = p
	p.apply_state(data)

func _apply_round(json: String) -> void:
	var data = JSON.parse_string(json)
	if typeof(data) != TYPE_DICTIONARY:
		return
	# Team combat: spawn by team, fall back to the legacy role field for an old host.
	var new_team := str(data.get("team", ""))
	if new_team == "":
		new_team = str(data.get("role", ""))
	var slot := int(data.get("slot", 0))
	my_uid = int(data.get("you", 0))
	round_over = data.get("result", null) != null

	# Stamp our identity so a shooter's ray names the right victim (and the bot
	# knows which body is the human).
	if player:
		player.set_meta("uid", my_uid)

	# (Re)spawn by team at the start of a live round. Everyone can camo now — both
	# teams hide AND fire.
	if not round_over and new_team != "":
		if new_team != my_role:
			my_role = new_team
			if player:
				player.spawn_at(_team_spawn(new_team, slot))
		if player:
			player.can_camo = true

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
