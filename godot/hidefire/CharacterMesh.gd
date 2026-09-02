class_name CharacterMesh
extends RefCounted
## Builds a small blocky humanoid (torso, head, legs, arms) sharing ONE material,
## so painting the material colours the whole body. Returned as a Node3D the
## caller parents under a player/puppet/bot. ~1.6 units tall, leaner than the old
## capsule.
##
## `hide_head` for the LOCAL player: the first-person camera sits at head height,
## so we drop the head to keep it from blocking the view while the torso/legs stay
## visible when you look down (you can see your own painted body).

static func make(mat: StandardMaterial3D, hide_head := false) -> Node3D:
	var root := Node3D.new()
	# [size, position]
	var parts := [
		[Vector3(0.34, 0.55, 0.22), Vector3(0.0, 1.02, 0.0)],   # torso
		[Vector3(0.14, 0.55, 0.14), Vector3(-0.1, 0.28, 0.0)],  # left leg
		[Vector3(0.14, 0.55, 0.14), Vector3(0.1, 0.28, 0.0)],   # right leg
		[Vector3(0.1, 0.45, 0.1), Vector3(-0.25, 1.02, 0.0)],   # left arm
		[Vector3(0.1, 0.45, 0.1), Vector3(0.25, 1.02, 0.0)],    # right arm
	]
	for p in parts:
		root.add_child(_box(p[0], p[1], mat))
	if not hide_head:
		root.add_child(_box(Vector3(0.26, 0.26, 0.26), Vector3(0.0, 1.5, 0.0), mat))
	return root

static func _box(size: Vector3, pos: Vector3, mat: StandardMaterial3D) -> MeshInstance3D:
	var mi := MeshInstance3D.new()
	var box := BoxMesh.new()
	box.size = size
	box.material = mat
	mi.mesh = box
	mi.position = pos
	return mi

## A pump-action shotgun aimed down -Z. Used for BOTH the first-person viewmodel
## and the opponent puppet's held weapon, so they always match. Own dark-metal +
## wood materials (never the camo body material) so the gun stays visible even on
## a camouflaged player. The muzzle sits at about z = -0.9.
static func make_shotgun() -> Node3D:
	var metal := StandardMaterial3D.new()
	metal.albedo_color = Color(0.10, 0.10, 0.12)
	metal.metallic = 0.8
	metal.roughness = 0.35
	var wood := StandardMaterial3D.new()
	wood.albedo_color = Color(0.35, 0.20, 0.09)
	wood.roughness = 0.7

	var root := Node3D.new()
	# Twin barrels, side by side, running forward.
	root.add_child(_cyl(0.028, 0.7, Vector3(-0.035, 0.02, -0.55), metal))
	root.add_child(_cyl(0.028, 0.7, Vector3(0.035, 0.02, -0.55), metal))
	# Receiver block (where barrels meet the stock).
	root.add_child(_box(Vector3(0.12, 0.11, 0.24), Vector3(0.0, 0.0, -0.16), metal))
	# Pump / forend under the barrels, wood.
	root.add_child(_box(Vector3(0.11, 0.07, 0.2), Vector3(0.0, -0.05, -0.42), wood))
	# Wooden stock angled back toward the shoulder.
	var stock := _box(Vector3(0.08, 0.12, 0.28), Vector3(0.0, -0.04, 0.12), wood)
	stock.rotation_degrees = Vector3(-8, 0, 0)
	root.add_child(stock)
	# Trigger guard.
	root.add_child(_box(Vector3(0.05, 0.06, 0.05), Vector3(0.0, -0.08, -0.05), metal))
	return root

## A cylinder helper for the barrels, stood up along the -Z (forward) axis.
static func _cyl(radius: float, length: float, pos: Vector3, mat: StandardMaterial3D) -> MeshInstance3D:
	var mi := MeshInstance3D.new()
	var cyl := CylinderMesh.new()
	cyl.top_radius = radius
	cyl.bottom_radius = radius
	cyl.height = length
	cyl.material = mat
	mi.mesh = cyl
	mi.position = pos
	mi.rotation_degrees = Vector3(90, 0, 0) # lay the cylinder along -Z
	return mi
