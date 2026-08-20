extends CharacterBody3D
## Simple, readable AI opponent for solo practice (/solo/hidefire).
##
## In the "players" group with its uid in meta, so the human's fire ray tags it
## like any peer. Naive XZ steering (no navmesh) — the arena is open enough.
## # ponytail: waypoints + straight-line steering; add NavigationAgent3D only if
## # it starts snagging on the inner walls.

var uid := 0
var arena                       # Main, for report_hit + my_uid
var target: CharacterBody3D     # the human player
var role := ""
var frozen := true
var body_mat: StandardMaterial3D

const SPEED := 4.0
const FIRE_RANGE := 26.0
const FIRE_CD := 1.1            # seconds between bot shots
const FLEE_DIST := 6.0
const REACH := 1.5             # "arrived at a point" radius

# Seeker patrol loop + hider hiding spots (near the arena props).
const WAYPOINTS := [
	Vector3(-14, 1, -14), Vector3(14, 1, -12), Vector3(0, 1, 0),
	Vector3(14, 1, 14), Vector3(-12, 1, 4)
]
const HIDE_SPOTS := [
	Vector3(-12, 1, -12), Vector3(10, 1, -11), Vector3(2, 1, 2), Vector3(12, 1, 12)
]

var _wp := 0
var _hide_target := Vector3.ZERO
var _fire_t := 0.0
var _camo_done := false

func setup(u: int, main, human: CharacterBody3D) -> void:
	uid = u
	arena = main
	target = human
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
	body_mat.albedo_color = Color(0.9, 0.5, 0.1)  # loud default = clearly visible
	add_child(CharacterMesh.make(body_mat))

## Shot by the player — death blast + hide + stop.
func on_shot() -> void:
	if arena:
		arena.death_fx(global_position + Vector3(0, 1, 0))
	frozen = true
	visible = false

## Fresh round: take a side, spawn, revive.
func begin_round(new_role: String, pos: Vector3) -> void:
	role = new_role
	global_position = pos
	velocity = Vector3.ZERO
	frozen = false
	visible = true
	_camo_done = false
	if role == "hider":
		body_mat.albedo_color = Color.WHITE   # pure white until it paints itself
		_hide_target = _nearest(HIDE_SPOTS, pos)
	else:
		body_mat.albedo_color = Color(0.9, 0.5, 0.1)  # seeker: clearly visible
		_wp = 0

func _physics_process(delta: float) -> void:
	if frozen or target == null:
		return
	_fire_t = max(0.0, _fire_t - delta)
	if role == "seeker":
		_seek(delta)
	else:
		_hide(delta)

# ---- seeker: roam, and shoot the human on a clear line of sight --------------
func _seek(_delta: float) -> void:
	var to_player := target.global_position - global_position
	var dist := to_player.length()
	var goal: Vector3
	if dist < FIRE_RANGE and _can_see(target):
		goal = target.global_position          # chase into view
		if _fire_t <= 0.0:
			_fire_t = FIRE_CD
			if arena:
				arena.report_hit(int(arena.my_uid))
	else:
		goal = WAYPOINTS[_wp]
		if global_position.distance_to(goal) < REACH:
			_wp = (_wp + 1) % WAYPOINTS.size()
	_step_toward(goal)

# ---- hider: reach a spot, camo, hold; flee if the human closes in ------------
func _hide(_delta: float) -> void:
	var dist := global_position.distance_to(target.global_position)
	if dist < FLEE_DIST:
		_step_toward(global_position + (global_position - target.global_position))
		_camo_done = false
		return
	if global_position.distance_to(_hide_target) > REACH:
		_step_toward(_hide_target)
	else:
		velocity = Vector3.ZERO
		move_and_slide()
		if not _camo_done:
			_camo_here()
			_camo_done = true

# ---- helpers -----------------------------------------------------------------
func _step_toward(goal: Vector3) -> void:
	var dir := (goal - global_position)
	dir.y = 0.0
	dir = dir.normalized()
	velocity.x = dir.x * SPEED
	velocity.z = dir.z * SPEED
	velocity.y = 0.0
	if dir.length() > 0.01:
		look_at(global_position + dir, Vector3.UP)
	move_and_slide()

func _can_see(who: Node3D) -> bool:
	var space := get_world_3d().direct_space_state
	var from := global_position + Vector3(0, 1.5, 0)
	var to := who.global_position + Vector3(0, 1.5, 0)
	var q := PhysicsRayQueryParameters3D.create(from, to)
	q.exclude = [self]
	var hit := space.intersect_ray(q)
	return hit.has("collider") and hit.collider == who

func _camo_here() -> void:
	var space := get_world_3d().direct_space_state
	var q := PhysicsRayQueryParameters3D.create(
		global_position + Vector3(0, 1, 0), global_position + Vector3(0, -2, 0))
	q.exclude = [self]
	var hit := space.intersect_ray(q)
	if hit.has("collider"):
		for child in hit.collider.get_children():
			if child is MeshInstance3D:
				var mat = child.get_active_material(0)
				if mat is StandardMaterial3D:
					body_mat.albedo_color = mat.albedo_color
					return

func _nearest(points: Array, from: Vector3) -> Vector3:
	var best: Vector3 = points[0]
	var bd := INF
	for pt in points:
		var d: float = from.distance_to(pt)
		if d < bd:
			bd = d
			best = pt
	return best
