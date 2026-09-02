extends CharacterBody3D
## A remote player, driven entirely by relayed `move` frames. In the "players"
## group with its uid in meta, so the local shooter's raycast can name it as the
## victim. Position is lerped between ticks; camo colour and alive flag mirror the
## sender so a well-hidden peer really does blend into the wall.

var uid := 0
var arena
var body_mat: StandardMaterial3D
var body_node: Node3D             # the humanoid mesh; laid flat as a corpse on death
var gun_pivot: Node3D             # holds the shotgun; tilts with the peer's pitch
var _target := Vector3.ZERO
var _has_target := false
var _alive := true
var _downed := false              # corpse already laid down (idempotent guard)

func setup(u: int, main) -> void:
	uid = u
	arena = main
	add_to_group("players")
	set_meta("uid", u)

	var col := CollisionShape3D.new()
	var cap := CapsuleShape3D.new()
	cap.height = 1.6
	cap.radius = 0.3
	col.shape = cap
	col.position = Vector3(0, 0.8, 0)
	add_child(col)

	body_mat = StandardMaterial3D.new()
	body_node = CharacterMesh.make(body_mat)
	add_child(body_node)

	# Visible shotgun held in front of the body at the right hand / chest height.
	# On its own pivot so `pitch` can tilt the barrel up/down like real aim. Uses
	# the gun's own dark material (not body_mat), so it's readable even when the
	# peer is fully camouflaged.
	gun_pivot = Node3D.new()
	gun_pivot.position = Vector3(0.22, 1.0, -0.15)
	gun_pivot.add_child(CharacterMesh.make_shotgun())
	add_child(gun_pivot)

	visible = false  # stays hidden until the first position arrives

func apply_state(d: Dictionary) -> void:
	var p = d.get("pos", null)
	if typeof(p) == TYPE_ARRAY and p.size() == 3:
		_target = Vector3(p[0], p[1], p[2])
		# First frame: SNAP, don't lerp — otherwise the puppet flashes at world
		# origin (map centre) before sliding over, which reads as "in two places".
		if not _has_target:
			global_position = _target
		_has_target = true
	if d.has("yaw"):
		rotation.y = float(d["yaw"])
	# Tilt the held gun up/down to match the peer's real aim (yaw already turns the
	# whole body). Mirrors Player's camera.rotation.x = _pitch.
	if d.has("pitch") and gun_pivot:
		gun_pivot.rotation.x = float(d["pitch"])
	if d.has("camo") and body_mat:
		body_mat.albedo_color = Color.html(str(d["camo"]))
	# Death (peer flips alive -> dead) or revive (new round) from the round state.
	var now_alive := bool(d.get("alive", true))
	if _alive and not now_alive and _has_target:
		_go_down()
	elif not _alive and now_alive:
		_stand_up()
	_alive = now_alive
	# Show once placed — a corpse stays visible so its killer can see the body.
	visible = _has_target

## Shot by the local player — immediate feedback before the round state confirms.
func on_shot() -> void:
	_go_down()

## Collapse into a corpse: death spray, then lay the body (and gun) flat. Idempotent.
func _go_down() -> void:
	if _downed:
		return
	_downed = true
	if arena:
		arena.death_fx(global_position + Vector3(0, 1, 0))
	var tw := create_tween()
	tw.set_trans(Tween.TRANS_SINE)
	if body_node:
		tw.tween_property(body_node, "rotation:x", deg_to_rad(-88), 0.5)
		tw.parallel().tween_property(body_node, "position:y", 0.15, 0.5)
	if gun_pivot:
		tw.parallel().tween_property(gun_pivot, "position:y", 0.2, 0.5)

## Stand back up for a fresh round.
func _stand_up() -> void:
	_downed = false
	if body_node:
		body_node.rotation.x = 0.0
		body_node.position.y = 0.0
	if gun_pivot:
		gun_pivot.position.y = 1.0

func _physics_process(delta: float) -> void:
	if _has_target:
		global_position = global_position.lerp(_target, clamp(delta * 12.0, 0.0, 1.0))
