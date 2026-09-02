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
var body: Node3D
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
	cap.height = 1.6
	cap.radius = 0.3
	col.shape = cap
	col.position = Vector3(0, 0.8, 0)
	add_child(col)

	# Humanoid body: VISIBLE so you can see your own painted body + pose. The head
	# is dropped so it doesn't block the first-person camera.
	body_mat = StandardMaterial3D.new()
	body_mat.albedo_color = camo_color
	body = CharacterMesh.make(body_mat, true)
	add_child(body)

	camera = Camera3D.new()
	camera.position = Vector3(0, 1.5, 0)
	camera.keep_aspect = Camera3D.KEEP_HEIGHT  # fov is vertical → predictable framing
	camera.fov = 75.0
	add_child(camera)
	camera.make_current()

	# First-person gun viewmodel: a shotgun, child of the camera so it's always in
	# view. Raised + KEEP_HEIGHT camera so it isn't cropped at the bottom on the
	# (smaller) non-fullscreen 16:9 stage. Same model the opponent puppet holds.
	var gun := CharacterMesh.make_shotgun()
	gun.position = Vector3(0.18, -0.16, -0.1)
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
		# Before pointer-lock the cursor is free, so aim at the CLICK position
		# (otherwise the shot would come from the centre crosshair and miss what
		# you clicked). After locking, fire from the centre.
		if Input.mouse_mode != Input.MOUSE_MODE_CAPTURED:
			_fire(event.position)
			Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
		else:
			_fire()
		camo_still = false
	elif event.is_action_pressed("camo") and can_camo:
		_apply_camo()
	elif event.is_action_pressed("pose") and can_camo:
		_toggle_pose()
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
		camera.rotation.z = 0.0  # undo the death-cam tip-over
	_apply_pose_visual()  # reset crouch + camera height (position.y)
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
		_toggle_pose()
	if bool(t.get("jump", false)):
		_touch_jump = true

## Toggle the mimic pose: freeze in place and visibly crouch (peers see it too).
func _toggle_pose() -> void:
	posed = not posed
	if posed:
		velocity = Vector3.ZERO
		camo_still = true
	_apply_pose_visual()

func _apply_pose_visual() -> void:
	if body:
		body.scale = Vector3(1.0, 0.55, 1.0) if posed else Vector3.ONE
	if camera:
		camera.position.y = 1.0 if posed else 1.5

## Marked dead by the round state (someone shot us): stop input, drop to the floor
## and spectate from a fallen death-cam.
func die() -> void:
	if not alive:
		return
	alive = false
	frozen = true
	velocity = Vector3.ZERO
	if arena:
		arena.death_fx(global_position + Vector3(0, 1, 0))
	_fall_camera()
	# Red hit-flash + death recap in the DOM overlay.
	if OS.has_feature("web"):
		var w = JavaScriptBridge.get_interface("window")
		if w and w.hidefireOnDeath:
			w.hidefireOnDeath()

## Death cam: sink to the ground and tip over, so being hit reads as collapsing
## rather than freezing on your feet.
func _fall_camera() -> void:
	if camera == null:
		return
	var tw := create_tween()
	tw.set_trans(Tween.TRANS_SINE)
	tw.tween_property(camera, "position:y", 0.35, 0.6)
	tw.parallel().tween_property(camera, "rotation:z", 1.2, 0.6)  # tip sideways
	tw.parallel().tween_property(camera, "rotation:x", 0.25, 0.6) # look up from floor

func _physics_process(delta: float) -> void:
	if frozen or not alive:
		return
	# Posed: hold perfectly still to mimic the scenery. Look around, but no walking
	# — the first movement key breaks the pose.
	if posed:
		if Input.get_vector("move_left", "move_right", "move_forward", "move_back").length() > 0.0 \
				or _touch_move.length() > 0.0:
			posed = false
			_apply_pose_visual()  # stand back up
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

func _fire(screen_pos = null) -> void:
	_muzzle_flash()
	var space := get_world_3d().direct_space_state
	var from: Vector3
	var dir: Vector3
	if screen_pos != null and camera:
		# Cursor-aim (pointer not locked): shoot through the clicked pixel.
		from = camera.project_ray_origin(screen_pos)
		dir = camera.project_ray_normal(screen_pos)
	else:
		# Locked: shoot through the EXACT viewport centre where the crosshair sits,
		# so the shot lands pinpoint under the dot at any fov/aspect (projecting the
		# centre pixel is exact; camera.basis.z drifts with KEEP_HEIGHT framing).
		var c := get_viewport().get_visible_rect().size * 0.5
		from = camera.project_ray_origin(c)
		dir = camera.project_ray_normal(c)
	var to := from + dir * 100.0
	var q := PhysicsRayQueryParameters3D.create(from, to)
	q.exclude = [self]
	var hit := space.intersect_ray(q)

	# Visible tracer: from the gun muzzle to whatever the ray met (or 100u into the
	# distance on a miss). Spawned before the early-return so misses fly too.
	var muzzle := camera.to_global(Vector3(0.18, -0.14, -1.0)) if camera else from
	var endpoint: Vector3 = hit.position if hit.has("collider") else to
	if arena:
		arena.spawn_bullet(muzzle, endpoint)

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
	l.position = Vector3(0.18, -0.14, -1.0) # at the shotgun muzzle
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
		camera.global_position - camera.global_transform.basis.z * 6.0,
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
