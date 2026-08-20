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
