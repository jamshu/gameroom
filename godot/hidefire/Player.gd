extends CharacterBody3D
## Local first-person player: move / look / jump / crouch, hitscan fire, and the
## manual colour-match camo. Builds its own camera/body/collider in _ready so the
## scene file stays a single node.

var arena                        # set by Main after instancing
var can_camo := false            # only hiders may camo (set from round state)
var frozen := false              # round over -> stop taking input
var alive := true

const SPEED := 6.0
const CROUCH_SPEED := 2.5
const JUMP := 5.0
const MOUSE_SENS := 0.0025
const GRAVITY := 9.8

const TOUCH_LOOK_SENS := 0.005

var camera: Camera3D
var body_mat: StandardMaterial3D
var _pitch := 0.0
# Touch input (from the DOM overlay via Main._poll_inbound). Move is continuous;
# jump is a one-shot consumed in _physics_process.
var _touch_move := Vector2.ZERO
var _touch_crouch := false
var _touch_jump := false
# Meccha-Chameleon style: the hider's body starts PURE WHITE and you paint it to
# mimic the stage. White = obviously unpainted / easy to spot.
var camo_color := Color.WHITE
var camo_still := false
var posed := false                       # frozen in a pose to mimic an object

func _ready() -> void:
	add_to_group("players")
	# Local player's uid is stamped host-side into the relayed payload; the meta
	# here only matters for puppets (whom the shooter's ray reads). Left 0 locally.
	set_meta("uid", 0)

	var col := CollisionShape3D.new()
	var cap := CapsuleShape3D.new()
	cap.height = 1.8
	cap.radius = 0.4
	col.shape = cap
	col.position = Vector3(0, 0.9, 0)
	add_child(col)

	# Body mesh: what peers see, and what camo tints. Hidden from our own camera.
	var mesh := MeshInstance3D.new()
	var cm := CapsuleMesh.new()
	cm.height = 1.8
	cm.radius = 0.4
	body_mat = StandardMaterial3D.new()
	body_mat.albedo_color = camo_color
	cm.material = body_mat
	mesh.mesh = cm
	mesh.position = Vector3(0, 0.9, 0)
	mesh.visible = false
	add_child(mesh)

	camera = Camera3D.new()
	camera.position = Vector3(0, 1.6, 0)
	camera.fov = 85.0
	add_child(camera)
	camera.make_current()

	# First-person gun viewmodel: a child of the camera so it's always in view.
	# Gives the player a visible weapon even though their own body mesh is hidden.
	var gun := MeshInstance3D.new()
	var gm := BoxMesh.new()
	gm.size = Vector3(0.12, 0.12, 0.6)
	var gmat := StandardMaterial3D.new()
	gmat.albedo_color = Color(0.15, 0.15, 0.17)
	gm.material = gmat
	gun.mesh = gm
	gun.position = Vector3(0.32, -0.26, -0.7)
	camera.add_child(gun)

	# Do NOT capture the mouse here: browsers reject pointer lock without a user
	# gesture. The first click (fire branch) captures it instead — standard for a
	# web FPS.

func _unhandled_input(event) -> void:
	if event is InputEventMouseMotion and Input.mouse_mode == Input.MOUSE_MODE_CAPTURED:
		rotate_y(-event.relative.x * MOUSE_SENS)
		_pitch = clamp(_pitch - event.relative.y * MOUSE_SENS, -1.4, 1.4)
		camera.rotation.x = _pitch
		camo_still = false
	elif event.is_action_pressed("fire"):
		Input.mouse_mode = Input.MOUSE_MODE_CAPTURED   # click to (re)capture
		_fire()
		camo_still = false
	elif event.is_action_pressed("camo") and can_camo:
		_apply_camo()
	elif event.is_action_pressed("pose") and can_camo:
		posed = not posed          # toggle: freeze in a pose to mimic an object
		if posed:
			velocity = Vector3.ZERO
			camo_still = true
	elif event is InputEventKey and event.pressed and event.keycode == KEY_ESCAPE:
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE

## Place the player at a spawn for a fresh round: reset motion, revive, unfreeze,
## show the body to peers again, and face the arena centre.
func spawn_at(pos: Vector3) -> void:
	velocity = Vector3.ZERO
	global_position = pos
	alive = true
	frozen = false
	posed = false
	_pitch = 0.0
	# Fresh round: reset to the unpainted pure-white body.
	camo_color = Color.WHITE
	camo_still = false
	if body_mat:
		body_mat.albedo_color = Color.WHITE
	if camera:
		camera.rotation.x = 0.0
	look_at(Vector3(0, pos.y, 0), Vector3.UP)

## Apply one poll of touch input from the DOM overlay. Look deltas + fire/paint/
## pose/jump arrive as one-shots (the JS getter clears them after we read).
func apply_touch(t: Dictionary) -> void:
	_touch_move = Vector2(float(t.get("mx", 0)), float(t.get("my", 0)))
	_touch_crouch = bool(t.get("crouch", false))
	var ldx := float(t.get("lookdx", 0))
	var ldy := float(t.get("lookdy", 0))
	if ldx != 0.0 or ldy != 0.0:
		rotate_y(-ldx * TOUCH_LOOK_SENS)
		_pitch = clamp(_pitch - ldy * TOUCH_LOOK_SENS, -1.4, 1.4)
		if camera:
			camera.rotation.x = _pitch
		camo_still = false
	if frozen or not alive:
		return
	if bool(t.get("fire", false)):
		_fire()
		camo_still = false
	if bool(t.get("paint", false)) and can_camo:
		_apply_camo()
	if bool(t.get("pose", false)) and can_camo:
		posed = not posed
		if posed:
			velocity = Vector3.ZERO
			camo_still = true
	if bool(t.get("jump", false)):
		_touch_jump = true

## Marked dead by the round state (someone shot us): stop input, spectate in place.
func die() -> void:
	if not alive:
		return
	alive = false
	frozen = true
	velocity = Vector3.ZERO
	if arena:
		arena.death_fx(global_position + Vector3(0, 1, 0))
	# Red hit-flash in the DOM overlay.
	if OS.has_feature("web"):
		var w = JavaScriptBridge.get_interface("window")
		if w and w.hidefireOnDeath:
			w.hidefireOnDeath()

func _physics_process(delta: float) -> void:
	if frozen or not alive:
		return
	# Posed: hold perfectly still to mimic the scenery. Look around, but no walking
	# — the first movement key breaks the pose.
	if posed:
		if Input.get_vector("move_left", "move_right", "move_forward", "move_back").length() > 0.0:
			posed = false
		else:
			velocity = Vector3.ZERO
			return
	if not is_on_floor():
		velocity.y -= GRAVITY * delta
	elif Input.is_action_just_pressed("jump") or _touch_jump:
		velocity.y = JUMP
	_touch_jump = false

	# Keyboard OR the touch joystick, whichever is active.
	var input_dir := Input.get_vector("move_left", "move_right", "move_forward", "move_back")
	if input_dir.length() == 0.0:
		input_dir = _touch_move
	var dir := (transform.basis * Vector3(input_dir.x, 0, input_dir.y)).normalized()
	var crouching := Input.is_action_pressed("crouch") or _touch_crouch
	var speed := CROUCH_SPEED if crouching else SPEED
	if dir.length() > 0.0:
		velocity.x = dir.x * speed
		velocity.z = dir.z * speed
		camo_still = false                 # moving breaks the blend
	else:
		velocity.x = move_toward(velocity.x, 0.0, speed)
		velocity.z = move_toward(velocity.z, 0.0, speed)
	move_and_slide()

func _fire() -> void:
	_muzzle_flash()
	var space := get_world_3d().direct_space_state
	var from := camera.global_position
	var to := from - camera.global_transform.basis.z * 100.0
	var q := PhysicsRayQueryParameters3D.create(from, to)
	q.exclude = [self]
	var hit := space.intersect_ray(q)
	if not hit.has("collider"):
		return
	if hit.collider.is_in_group("players"):
		var uid = hit.collider.get_meta("uid", 0)
		# One hit kills, so this is a kill blast at the impact point.
		if arena:
			arena.death_fx(hit.position)
		if hit.collider.has_method("on_shot"):
			hit.collider.on_shot()
		if uid and arena:
			arena.report_hit(int(uid))
	elif arena:
		arena.spawn_blood(hit.position, false)  # wall spark/impact

## Brief gunshot flash at the muzzle.
func _muzzle_flash() -> void:
	if camera == null:
		return
	var l := OmniLight3D.new()
	l.position = Vector3(0.32, -0.26, -0.9)
	l.light_color = Color(1.0, 0.85, 0.45)
	l.light_energy = 4.0
	l.omni_range = 4.0
	camera.add_child(l)
	get_tree().create_timer(0.06).timeout.connect(l.queue_free)

## Take the colour of whatever surface we're looking at (or standing over) and
## paint the body with it — the whole camo mechanic. Moving/firing clears `still`.
func _apply_camo() -> void:
	var space := get_world_3d().direct_space_state
	var targets := [
		camera.global_position - camera.global_transform.basis.z * 3.0,
		global_position + Vector3(0, -2, 0)
	]
	for to in targets:
		var q := PhysicsRayQueryParameters3D.create(camera.global_position, to)
		q.exclude = [self]
		var hit := space.intersect_ray(q)
		if hit.has("collider"):
			var c = _surface_color(hit.collider)
			if c != null:
				camo_color = c
				body_mat.albedo_color = c
				camo_still = true
				return

func _surface_color(collider):
	for child in collider.get_children():
		if child is MeshInstance3D:
			var mat = child.get_active_material(0)
			if mat == null and child.mesh and child.mesh.get_surface_count() > 0:
				mat = child.mesh.surface_get_material(0)
			if mat is StandardMaterial3D:
				return mat.albedo_color
	return null

func get_net_state() -> Dictionary:
	return {
		"pos": [global_position.x, global_position.y, global_position.z],
		"yaw": rotation.y,
		"pitch": _pitch,
		"camo": camo_color.to_html(false),
		"still": camo_still,
		"alive": alive
	}
