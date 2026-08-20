extends CharacterBody3D
## A remote player, driven entirely by relayed `move` frames. In the "players"
## group with its uid in meta, so the local shooter's raycast can name it as the
## victim. Position is lerped between ticks; camo colour and alive flag mirror the
## sender so a well-hidden peer really does blend into the wall.

var uid := 0
var body_mat: StandardMaterial3D
var _target := Vector3.ZERO
var _has_target := false

func setup(u: int) -> void:
	uid = u
	add_to_group("players")
	set_meta("uid", u)

	var col := CollisionShape3D.new()
	var cap := CapsuleShape3D.new()
	cap.height = 1.8
	cap.radius = 0.4
	col.shape = cap
	col.position = Vector3(0, 0.9, 0)
	add_child(col)

	var mesh := MeshInstance3D.new()
	var cm := CapsuleMesh.new()
	cm.height = 1.8
	cm.radius = 0.4
	body_mat = StandardMaterial3D.new()
	cm.material = body_mat
	mesh.mesh = cm
	mesh.position = Vector3(0, 0.9, 0)
	add_child(mesh)
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
	if d.has("camo") and body_mat:
		body_mat.albedo_color = Color.html(str(d["camo"]))
	# Only show once we know where it is AND it's alive.
	visible = _has_target and bool(d.get("alive", true))

func _physics_process(delta: float) -> void:
	if _has_target:
		global_position = global_position.lerp(_target, clamp(delta * 12.0, 0.0, 1.0))
