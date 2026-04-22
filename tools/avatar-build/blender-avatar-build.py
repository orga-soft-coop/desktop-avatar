#!/usr/bin/env python3
"""
Build a packed avatar GLB from:
- one visual mesh GLB
- one rigged base FBX
- multiple animation FBX clips

Modes:
- semi: writes <output>.review.blend + <output>.report.json
- full: writes <output>.glb + <output>.report.json
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import bpy
from mathutils import Euler, Matrix, Vector


REQUIRED_STATES = [
    "idle",
    "walking",
    "working",
    "communicating",
    "coffee-break",
    "at-phone",
    "teleport-out",
    "teleport-in",
]

AXIS_LABELS = ("X", "Y", "Z")


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Avatar GLB build pipeline")
    parser.add_argument("--mesh-glb", required=True)
    parser.add_argument("--base-fbx", required=True)
    parser.add_argument("--clips-dir", required=True)
    parser.add_argument("--output-glb", required=True)
    parser.add_argument("--mode", choices=["semi", "full"], required=True)
    parser.add_argument("--working-clip", default="thinking")
    parser.add_argument("--talking-clip", default="talking")
    parser.add_argument("--base-mesh-name", default="")
    parser.add_argument("--base-rotation-x", type=float, default=0.0)
    parser.add_argument("--base-rotation-y", type=float, default=0.0)
    parser.add_argument("--base-rotation-z", type=float, default=0.0)
    parser.add_argument("--auto-base-rotation", choices=["auto", "off"], default="auto")
    parser.add_argument(
        "--rotation-target",
        choices=["normalize", "target-meshes", "base-and-armature"],
        default="normalize",
    )
    parser.add_argument("--align-target-to-base", choices=["auto", "off"], default="auto")
    parser.add_argument(
        "--snap-character-to-world",
        choices=["auto", "off"],
        default="auto",
        help="After rig bind, center character on world origin and place feet on ground plane.",
    )
    parser.add_argument("--transfer-mode", choices=["data-transfer", "index-copy"], default="data-transfer")
    parser.add_argument(
        "--fbx-axis-forward",
        choices=["X", "Y", "Z", "-X", "-Y", "-Z", "auto"],
        default="auto",
        help="Explicit FBX forward axis override. 'auto' lets Blender read the FBX header.",
    )
    parser.add_argument(
        "--fbx-axis-up",
        choices=["X", "Y", "Z", "-X", "-Y", "-Z", "auto"],
        default="auto",
        help="Explicit FBX up axis override. 'auto' lets Blender read the FBX header.",
    )
    parser.add_argument(
        "--translation-warn-threshold",
        type=float,
        default=0.05,
        help="Warn when post-alignment translation exceeds this distance (meters).",
    )
    parser.add_argument(
        "--forward-axis-offset",
        choices=["auto", "0", "90", "180", "270", "-90", "-180", "-270"],
        default="auto",
        help=(
            "Override the forward-axis Z rotation (degrees) applied to the target mesh"
            " in normalize mode. 'auto' uses the shoulder-vs-footprint heuristic;"
            " any numeric choice is applied instead of the heuristic result."
            " Use 180 if the mesh ends up facing the opposite direction from the rig."
        ),
    )
    parser.add_argument(
        "--lock-root-motion",
        choices=["auto", "off"],
        default="auto",
        help="Flatten root/hips translation curves per clip to avoid global avatar sway/drift.",
    )
    return parser.parse_args(argv)


def ensure_file(path: Path, label: str) -> None:
    if not path.exists() or not path.is_file():
        raise RuntimeError(f"{label} does not exist: {path}")


def ensure_dir(path: Path, label: str) -> None:
    if not path.exists() or not path.is_dir():
        raise RuntimeError(f"{label} does not exist: {path}")


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in [bpy.data.meshes, bpy.data.armatures, bpy.data.materials]:
        orphan_names = [item.name for item in collection if item.users == 0]
        for name in orphan_names:
            collection.remove(collection[name])


def import_fbx(
    path: Path,
    use_anim: bool = True,
    ignore_leaf_bones: bool = True,
    axis_forward: str = "auto",
    axis_up: str = "auto",
) -> List[bpy.types.Object]:
    before = set(bpy.data.objects.keys())
    kwargs: Dict[str, object] = {
        "filepath": str(path),
        "use_anim": use_anim,
        "ignore_leaf_bones": ignore_leaf_bones,
    }
    if axis_forward != "auto" and axis_up != "auto":
        kwargs["use_manual_orientation"] = True
        kwargs["axis_forward"] = axis_forward
        kwargs["axis_up"] = axis_up
    bpy.ops.import_scene.fbx(**kwargs)
    return [bpy.data.objects[name] for name in bpy.data.objects.keys() if name not in before]


def import_glb(path: Path) -> List[bpy.types.Object]:
    before = set(bpy.data.objects.keys())
    bpy.ops.import_scene.gltf(filepath=str(path))
    return [bpy.data.objects[name] for name in bpy.data.objects.keys() if name not in before]


def find_first_armature(objects: Iterable[bpy.types.Object]) -> bpy.types.Object:
    for obj in objects:
        if obj.type == "ARMATURE":
            return obj
    raise RuntimeError("No armature found in imported objects.")


def find_meshes(objects: Iterable[bpy.types.Object]) -> List[bpy.types.Object]:
    return [obj for obj in objects if obj.type == "MESH"]


def world_bounds(meshes: Iterable[bpy.types.Object]) -> Tuple[float, float, float, float, float, float]:
    min_x = float("inf")
    min_y = float("inf")
    min_z = float("inf")
    max_x = float("-inf")
    max_y = float("-inf")
    max_z = float("-inf")
    any_vertex = False

    for mesh in meshes:
        if mesh.type != "MESH":
            continue
        matrix = mesh.matrix_world
        for vertex in mesh.data.vertices:
            world = matrix @ vertex.co
            min_x = min(min_x, float(world.x))
            min_y = min(min_y, float(world.y))
            min_z = min(min_z, float(world.z))
            max_x = max(max_x, float(world.x))
            max_y = max(max_y, float(world.y))
            max_z = max(max_z, float(world.z))
            any_vertex = True

    if not any_vertex:
        raise RuntimeError("Unable to compute mesh world bounds: no vertices found.")

    return (min_x, min_y, min_z, max_x, max_y, max_z)


def bounds_size(bounds: Tuple[float, float, float, float, float, float]) -> Tuple[float, float, float]:
    return (
        bounds[3] - bounds[0],
        bounds[4] - bounds[1],
        bounds[5] - bounds[2],
    )


def bounds_center(bounds: Tuple[float, float, float, float, float, float]) -> Tuple[float, float, float]:
    return (
        (bounds[0] + bounds[3]) * 0.5,
        (bounds[1] + bounds[4]) * 0.5,
        (bounds[2] + bounds[5]) * 0.5,
    )


def dominant_axis_label(size: Tuple[float, float, float]) -> str:
    index = max(range(3), key=lambda axis_index: size[axis_index])
    return AXIS_LABELS[index]


def vector_to_axis_label(vec: Vector) -> str:
    axis = snap_to_principal_axis(vec)
    index = max(range(3), key=lambda i: abs(axis[i]))
    sign = "+" if axis[index] > 0 else "-"
    return f"{sign}{AXIS_LABELS[index]}"


def snap_to_principal_axis(vec: Vector) -> Vector:
    if vec.length_squared < 1e-12:
        return Vector((0.0, 0.0, 1.0))
    normalized = vec.normalized()
    best_axis = Vector((0.0, 0.0, 1.0))
    best_dot = -2.0
    for index in range(3):
        for sign in (1.0, -1.0):
            candidate = Vector((0.0, 0.0, 0.0))
            candidate[index] = sign
            dot = normalized.dot(candidate)
            if dot > best_dot:
                best_dot = dot
                best_axis = candidate
    return best_axis


def rotation_euler_between_axes(source_axis: Vector, target_axis: Vector) -> Euler:
    src = Vector(source_axis).normalized()
    dst = Vector(target_axis).normalized()
    dot = max(-1.0, min(1.0, src.dot(dst)))
    if dot > 0.99999:
        return Euler((0.0, 0.0, 0.0), "XYZ")
    if dot < -0.99999:
        helper = Vector((1.0, 0.0, 0.0)) if abs(src.x) < 0.9 else Vector((0.0, 1.0, 0.0))
        axis = src.cross(helper).normalized()
        return Matrix.Rotation(math.pi, 4, axis).to_euler("XYZ")
    axis = src.cross(dst).normalized()
    angle = math.acos(dot)
    return Matrix.Rotation(angle, 4, axis).to_euler("XYZ")


_HIPS_BONE_CANDIDATES = (
    "mixamorig:hips",
    "mixamorig7:hips",
    "hips",
    "hip",
    "pelvis",
    "root",
    "bip01 pelvis",
)
_HEAD_BONE_CANDIDATES = (
    "mixamorig:head",
    "mixamorig7:head",
    "head",
    "neck",
    "spine3",
    "spine_03",
)


def _find_bone(armature: bpy.types.Object, candidates: Iterable[str]) -> Optional[bpy.types.Bone]:
    lower_index = {bone.name.lower(): bone for bone in armature.data.bones}
    for candidate in candidates:
        bone = lower_index.get(candidate)
        if bone is not None:
            return bone
    for candidate in candidates:
        for key, bone in lower_index.items():
            if candidate in key:
                return bone
    return None


def detect_armature_up_world(armature: bpy.types.Object) -> Tuple[Vector, str]:
    if armature.type != "ARMATURE" or not armature.data.bones:
        return (Vector((0.0, 0.0, 1.0)), "fallback-default-z")

    hips_bone = _find_bone(armature, _HIPS_BONE_CANDIDATES)
    head_bone = _find_bone(armature, _HEAD_BONE_CANDIDATES)
    if hips_bone is not None and head_bone is not None and hips_bone != head_bone:
        hips_world = armature.matrix_world @ hips_bone.head_local
        head_world = armature.matrix_world @ head_bone.head_local
        direction = head_world - hips_world
        if direction.length > 1e-6:
            return (direction.normalized(), f"bones:{hips_bone.name}->{head_bone.name}")

    points: List[Vector] = []
    for bone in armature.data.bones:
        points.append(armature.matrix_world @ bone.head_local)
        points.append(armature.matrix_world @ bone.tail_local)
    if not points:
        return (Vector((0.0, 0.0, 1.0)), "fallback-default-z")

    min_p = Vector((
        min(p.x for p in points),
        min(p.y for p in points),
        min(p.z for p in points),
    ))
    max_p = Vector((
        max(p.x for p in points),
        max(p.y for p in points),
        max(p.z for p in points),
    ))
    extent = max_p - min_p
    axis_index = max(range(3), key=lambda i: extent[i])
    axis = Vector((0.0, 0.0, 0.0))
    axis[axis_index] = 1.0
    return (axis, "fallback-bone-bbox")


def detect_mesh_up_world(meshes: List[bpy.types.Object]) -> Tuple[Vector, str]:
    if not meshes:
        return (Vector((0.0, 0.0, 1.0)), "fallback-default-z")
    bounds = world_bounds(meshes)
    size = bounds_size(bounds)
    axis_index = max(range(3), key=lambda i: size[i])
    axis = Vector((0.0, 0.0, 0.0))
    axis[axis_index] = 1.0
    return (axis, "bounds-dominant")


_LEFT_SHOULDER_CANDIDATES = (
    "mixamorig:leftshoulder",
    "mixamorig7:leftshoulder",
    "mixamorig:leftarm",
    "leftshoulder",
    "left_shoulder",
    "shoulder.l",
    "shoulder_l",
    "l_shoulder",
    "leftupperarm",
    "upperarm.l",
    "upperarm_l",
    "leftarm",
    "arm.l",
)
_RIGHT_SHOULDER_CANDIDATES = (
    "mixamorig:rightshoulder",
    "mixamorig7:rightshoulder",
    "mixamorig:rightarm",
    "rightshoulder",
    "right_shoulder",
    "shoulder.r",
    "shoulder_r",
    "r_shoulder",
    "rightupperarm",
    "upperarm.r",
    "upperarm_r",
    "rightarm",
    "arm.r",
)

_LEFT_FOOT_CANDIDATES = (
    "mixamorig:leftfoot",
    "mixamorig7:leftfoot",
    "leftfoot",
    "foot.l",
    "left_foot",
    "l_foot",
)
_RIGHT_FOOT_CANDIDATES = (
    "mixamorig:rightfoot",
    "mixamorig7:rightfoot",
    "rightfoot",
    "foot.r",
    "right_foot",
    "r_foot",
)
_LEFT_TOE_CANDIDATES = (
    "mixamorig:lefttoe_base",
    "mixamorig7:lefttoe_base",
    "mixamorig:lefttoebase",
    "lefttoe_base",
    "lefttoe",
    "toe.l",
    "left_toe",
    "l_toe",
)
_RIGHT_TOE_CANDIDATES = (
    "mixamorig:righttoe_base",
    "mixamorig7:righttoe_base",
    "mixamorig:righttoebase",
    "righttoe_base",
    "righttoe",
    "toe.r",
    "right_toe",
    "r_toe",
)


def detect_armature_sideways_world(
    armature: bpy.types.Object,
) -> Tuple[Optional[Vector], str]:
    if armature.type != "ARMATURE" or not armature.data.bones:
        return (None, "no-armature")
    left = _find_bone(armature, _LEFT_SHOULDER_CANDIDATES)
    right = _find_bone(armature, _RIGHT_SHOULDER_CANDIDATES)
    if left is not None and right is not None and left != right:
        left_world = armature.matrix_world @ left.head_local
        right_world = armature.matrix_world @ right.head_local
        direction = right_world - left_world
        horizontal = Vector((direction.x, direction.y, 0.0))
        if horizontal.length > 1e-6:
            return (
                horizontal.normalized(),
                f"bones:{left.name}->{right.name}",
            )
    return (None, "no-shoulder-bones")


def detect_mesh_sideways_world(
    meshes: List[bpy.types.Object],
) -> Tuple[Vector, str]:
    if not meshes:
        return (Vector((1.0, 0.0, 0.0)), "fallback-default-x")
    bounds = world_bounds(meshes)
    extent_x = bounds[3] - bounds[0]
    extent_y = bounds[4] - bounds[1]
    if extent_x >= extent_y:
        return (Vector((1.0, 0.0, 0.0)), "x-dominant-footprint")
    return (Vector((0.0, 1.0, 0.0)), "y-dominant-footprint")


def align_forward_axis_around_z(
    target_meshes: List[bpy.types.Object],
    base_sideways: Optional[Vector],
    target_sideways: Optional[Vector],
    override_degrees: Optional[float] = None,
) -> Dict[str, object]:
    if override_degrees is not None:
        snapped_angle = math.radians(override_degrees)
        raw_angle = snapped_angle
        ambiguous = False
        mode = "manual-override"
    else:
        if base_sideways is None or target_sideways is None:
            return {
                "applied": False,
                "rawAngleDegrees": 0.0,
                "snappedAngleDegrees": 0.0,
                "ambiguous": False,
                "reason": "missing-sideways-vector",
                "mode": "auto",
            }
        b = Vector((base_sideways.x, base_sideways.y, 0.0))
        t = Vector((target_sideways.x, target_sideways.y, 0.0))
        if b.length < 1e-6 or t.length < 1e-6:
            return {
                "applied": False,
                "rawAngleDegrees": 0.0,
                "snappedAngleDegrees": 0.0,
                "ambiguous": False,
                "reason": "zero-length-sideways",
                "mode": "auto",
            }

        b = b.normalized()
        t = t.normalized()
        raw_angle = math.atan2(b.y, b.x) - math.atan2(t.y, t.x)
        # Map to (-pi, pi]
        while raw_angle > math.pi:
            raw_angle -= 2.0 * math.pi
        while raw_angle <= -math.pi:
            raw_angle += 2.0 * math.pi

        quarter = math.pi / 2.0
        snapped_angle = round(raw_angle / quarter) * quarter
        residual = abs(raw_angle - snapped_angle)
        ambiguous = residual > math.radians(15.0)
        mode = "auto"

    if abs(snapped_angle) < 1e-5:
        return {
            "applied": False,
            "rawAngleDegrees": math.degrees(raw_angle),
            "snappedAngleDegrees": 0.0,
            "ambiguous": ambiguous,
            "reason": "already-aligned",
            "mode": mode,
        }

    # Walk up to the scene's top-level ancestor for each target mesh so we
    # rotate the whole hierarchy (including any glTF parent Empty) rather
    # than rotating each mesh relative to an unchanged parent.
    top_level: Dict[str, bpy.types.Object] = {}
    for mesh in target_meshes:
        root = mesh
        while root.parent is not None:
            root = root.parent
        top_level[root.name] = root
    roots = list(top_level.values())

    # Apply the rotation in WORLD space so parent transforms cannot mask it.
    rot_mat = Matrix.Rotation(snapped_angle, 4, "Z")
    for root in roots:
        root.matrix_world = rot_mat @ root.matrix_world
    bpy.context.view_layer.update()
    for root in roots:
        apply_transform(root)

    return {
        "applied": True,
        "rawAngleDegrees": math.degrees(raw_angle),
        "snappedAngleDegrees": math.degrees(snapped_angle),
        "ambiguous": ambiguous,
        "mode": mode,
        "rotatedRoots": [root.name for root in roots],
    }


def _root_objects_within(objects: List[bpy.types.Object]) -> List[bpy.types.Object]:
    name_set = {obj.name for obj in objects}
    roots: List[bpy.types.Object] = []
    seen: set = set()
    for obj in objects:
        if obj.name in seen:
            continue
        if obj.parent is None or obj.parent.name not in name_set:
            seen.add(obj.name)
            roots.append(obj)
    return roots


def normalize_hierarchy_to_z_up(
    objects: List[bpy.types.Object],
    detected_up_world: Vector,
) -> Dict[str, object]:
    snapped = snap_to_principal_axis(detected_up_world)
    target_axis = Vector((0.0, 0.0, 1.0))
    euler = rotation_euler_between_axes(snapped, target_axis)
    applied = not (abs(euler.x) <= 1e-5 and abs(euler.y) <= 1e-5 and abs(euler.z) <= 1e-5)

    roots = _root_objects_within(objects)
    if applied:
        for root in roots:
            root.rotation_mode = "XYZ"
            root.rotation_euler.x += euler.x
            root.rotation_euler.y += euler.y
            root.rotation_euler.z += euler.z
        for root in roots:
            apply_transform(root)

    return {
        "applied": applied,
        "detectedUpWorld": [float(detected_up_world.x), float(detected_up_world.y), float(detected_up_world.z)],
        "snappedUpAxis": vector_to_axis_label(snapped),
        "rotationEulerDegrees": [
            math.degrees(euler.x),
            math.degrees(euler.y),
            math.degrees(euler.z),
        ],
        "rotatedRoots": [root.name for root in roots],
    }


def pick_source_mesh(
    meshes: List[bpy.types.Object],
    armature: bpy.types.Object,
    target_meshes: List[bpy.types.Object],
    preferred_name: str = "",
) -> bpy.types.Object:
    if not meshes:
        raise RuntimeError("No source mesh found.")

    weighted = [mesh for mesh in meshes if len(mesh.vertex_groups) > 0]
    if not weighted:
        summary = ", ".join(f"{mesh.name}:groups={len(mesh.vertex_groups)}" for mesh in meshes)
        raise RuntimeError(
            "No weighted source mesh found in base FBX. "
            f"Expected at least one mesh with vertex groups. Meshes: {summary}"
        )

    def has_bound_armature(mesh: bpy.types.Object) -> bool:
        for modifier in mesh.modifiers:
            if modifier.type == "ARMATURE" and getattr(modifier, "object", None) == armature:
                return True
        return False

    armature_bound = [mesh for mesh in weighted if has_bound_armature(mesh)]
    candidates = armature_bound if armature_bound else weighted

    preferred = preferred_name.strip().lower()
    if preferred:
        for mesh in candidates:
            if mesh.name.strip().lower() == preferred:
                return mesh
        for mesh in candidates:
            if preferred in mesh.name.strip().lower():
                return mesh

    target_reference = max(target_meshes, key=lambda mesh: len(mesh.data.vertices))
    target_vertex_count = len(target_reference.data.vertices)
    target_bounds = world_bounds([target_reference])
    target_size = bounds_size(target_bounds)

    def score(mesh: bpy.types.Object) -> Tuple[float, float, float]:
        mesh_vertex_count = len(mesh.data.vertices)
        mesh_bounds = world_bounds([mesh])
        mesh_size = bounds_size(mesh_bounds)

        vertex_delta = abs(mesh_vertex_count - target_vertex_count)
        size_delta = (
            abs(mesh_size[0] - target_size[0])
            + abs(mesh_size[1] - target_size[1])
            + abs(mesh_size[2] - target_size[2])
        )
        # Prefer richer skinning when other signals are similar.
        group_priority = -float(len(mesh.vertex_groups))
        return (vertex_delta, size_delta, group_priority)

    return min(candidates, key=score)


def apply_transform(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)


def apply_all_transforms(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def apply_location_transform(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)


def set_object_origins_to_world_origin(objects: List[bpy.types.Object]) -> Dict[str, object]:
    previous_cursor = bpy.context.scene.cursor.location.copy()
    previous_active = bpy.context.view_layer.objects.active
    selected_before = [obj for obj in bpy.context.selected_objects]
    moved: Dict[str, List[float]] = {}

    bpy.context.scene.cursor.location = (0.0, 0.0, 0.0)
    for obj in objects:
        if obj.name not in bpy.data.objects:
            continue
        before = obj.matrix_world.translation.copy()
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.origin_set(type="ORIGIN_CURSOR", center="MEDIAN")
        bpy.context.view_layer.update()
        after = obj.matrix_world.translation.copy()
        moved[obj.name] = [
            float(after.x - before.x),
            float(after.y - before.y),
            float(after.z - before.z),
        ]

    bpy.ops.object.select_all(action="DESELECT")
    for obj in selected_before:
        if obj.name in bpy.data.objects:
            obj.select_set(True)
    if previous_active is not None and previous_active.name in bpy.data.objects:
        bpy.context.view_layer.objects.active = previous_active
    bpy.context.scene.cursor.location = previous_cursor
    return {"origin": [0.0, 0.0, 0.0], "objects": moved}


def bake_world_translation_into_character_data(
    armature: bpy.types.Object,
    meshes: List[bpy.types.Object],
    delta: List[float],
) -> Dict[str, object]:
    world_delta = Vector((float(delta[0]), float(delta[1]), float(delta[2])))
    previous_active = bpy.context.view_layer.objects.active
    selected_before = [obj for obj in bpy.context.selected_objects]
    previous_mode = armature.mode

    mesh_report: Dict[str, List[float]] = {}
    for mesh in meshes:
        if mesh.name not in bpy.data.objects or mesh.type != "MESH":
            continue
        local_delta = mesh.matrix_world.inverted().to_3x3() @ world_delta
        for vertex in mesh.data.vertices:
            vertex.co += local_delta
        mesh.data.update()
        mesh_report[mesh.name] = [float(local_delta.x), float(local_delta.y), float(local_delta.z)]

    armature_local_delta = armature.matrix_world.inverted().to_3x3() @ world_delta
    bpy.ops.object.select_all(action="DESELECT")
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    try:
        bpy.ops.object.mode_set(mode="EDIT")
        for bone in armature.data.edit_bones:
            bone.head += armature_local_delta
            bone.tail += armature_local_delta
    finally:
        bpy.ops.object.mode_set(mode="OBJECT")
        if previous_mode not in {"OBJECT", "EDIT"}:
            bpy.ops.object.mode_set(mode=previous_mode)

    bpy.ops.object.select_all(action="DESELECT")
    for obj in selected_before:
        if obj.name in bpy.data.objects:
            obj.select_set(True)
    if previous_active is not None and previous_active.name in bpy.data.objects:
        bpy.context.view_layer.objects.active = previous_active
    bpy.context.view_layer.update()

    return {
        "worldDelta": [float(world_delta.x), float(world_delta.y), float(world_delta.z)],
        "armatureLocalDelta": [
            float(armature_local_delta.x),
            float(armature_local_delta.y),
            float(armature_local_delta.z),
        ],
        "meshLocalDelta": mesh_report,
    }


def is_zero_rotation(rotation_degrees: Tuple[float, float, float], epsilon: float = 1e-5) -> bool:
    return all(abs(value) <= epsilon for value in rotation_degrees)


def infer_axis_alignment_rotation(
    source_size: Tuple[float, float, float],
    target_size: Tuple[float, float, float],
) -> Tuple[float, float, float]:
    source_axis = max(range(3), key=lambda axis_index: source_size[axis_index])
    target_axis = max(range(3), key=lambda axis_index: target_size[axis_index])
    if source_axis == target_axis:
        return (0.0, 0.0, 0.0)

    # The largest axis for humanoids usually represents "up". Align this first.
    axis_rotation_map: Dict[Tuple[int, int], Tuple[float, float, float]] = {
        (1, 2): (90.0, 0.0, 0.0),   # Y -> Z
        (2, 1): (-90.0, 0.0, 0.0),  # Z -> Y
        (0, 2): (0.0, -90.0, 0.0),  # X -> Z
        (2, 0): (0.0, 90.0, 0.0),   # Z -> X
        (0, 1): (0.0, 0.0, 90.0),   # X -> Y
        (1, 0): (0.0, 0.0, -90.0),  # Y -> X
    }
    return axis_rotation_map.get((source_axis, target_axis), (0.0, 0.0, 0.0))


def apply_rotation_fix(
    objects: List[bpy.types.Object],
    rotation_degrees: Tuple[float, float, float],
) -> bool:
    epsilon = 1e-5
    if sum(abs(value) for value in rotation_degrees) <= epsilon:
        return False

    rx = math.radians(rotation_degrees[0])
    ry = math.radians(rotation_degrees[1])
    rz = math.radians(rotation_degrees[2])

    seen = set()
    unique_objects: List[bpy.types.Object] = []
    for obj in objects:
        if obj.name in seen:
            continue
        seen.add(obj.name)
        unique_objects.append(obj)

    for obj in unique_objects:
        obj.rotation_mode = "XYZ"
        obj.rotation_euler.x += rx
        obj.rotation_euler.y += ry
        obj.rotation_euler.z += rz

    for obj in unique_objects:
        apply_transform(obj)

    return True


def align_target_meshes_to_source_mesh(
    source_mesh: bpy.types.Object,
    target_meshes: List[bpy.types.Object],
    up_axis_index: Optional[int] = None,
) -> Dict[str, object]:
    source_bounds = world_bounds([source_mesh])
    target_bounds_before = world_bounds(target_meshes)

    source_size = bounds_size(source_bounds)
    if up_axis_index is None:
        up_axis = max(range(3), key=lambda axis_index: source_size[axis_index])
    else:
        up_axis = up_axis_index
    source_center = bounds_center(source_bounds)
    target_center = bounds_center(target_bounds_before)

    # Align horizontal center and ground contact to source rig mesh.
    delta = [0.0, 0.0, 0.0]
    for axis_index in range(3):
        if axis_index == up_axis:
            delta[axis_index] = source_bounds[axis_index] - target_bounds_before[axis_index]
        else:
            delta[axis_index] = source_center[axis_index] - target_center[axis_index]

    for mesh in target_meshes:
        mesh.location.x += delta[0]
        mesh.location.y += delta[1]
        mesh.location.z += delta[2]

    target_bounds_after = world_bounds(target_meshes)
    return {
        "upAxis": AXIS_LABELS[up_axis],
        "translation": [float(delta[0]), float(delta[1]), float(delta[2])],
        "sourceBounds": {
            "min": [source_bounds[0], source_bounds[1], source_bounds[2]],
            "max": [source_bounds[3], source_bounds[4], source_bounds[5]],
            "size": list(source_size),
        },
        "targetBoundsBefore": {
            "min": [target_bounds_before[0], target_bounds_before[1], target_bounds_before[2]],
            "max": [target_bounds_before[3], target_bounds_before[4], target_bounds_before[5]],
            "size": list(bounds_size(target_bounds_before)),
        },
        "targetBoundsAfter": {
            "min": [target_bounds_after[0], target_bounds_after[1], target_bounds_after[2]],
            "max": [target_bounds_after[3], target_bounds_after[4], target_bounds_after[5]],
            "size": list(bounds_size(target_bounds_after)),
        },
    }

def footprint_center_at_ground(
    meshes: List[bpy.types.Object],
    up_axis_index: int,
    threshold: float = 0.01,
) -> Optional[Tuple[float, float]]:
    if not meshes:
        return None
    bounds = world_bounds(meshes)
    ground = bounds[up_axis_index]
    horizontal_axes = [idx for idx in range(3) if idx != up_axis_index]
    points: List[Tuple[float, float]] = []
    for mesh in meshes:
        if mesh.type != "MESH":
            continue
        matrix = mesh.matrix_world
        for vertex in mesh.data.vertices:
            world = matrix @ vertex.co
            components = (float(world.x), float(world.y), float(world.z))
            if abs(components[up_axis_index] - ground) <= threshold:
                points.append(
                    (
                        components[horizontal_axes[0]],
                        components[horizontal_axes[1]],
                    )
                )
    if not points:
        return None
    avg0 = sum(point[0] for point in points) / float(len(points))
    avg1 = sum(point[1] for point in points) / float(len(points))
    return (avg0, avg1)


def foot_bone_center(
    armature: bpy.types.Object,
    up_axis_index: int,
) -> Optional[Tuple[float, float]]:
    left_foot = _find_bone(armature, _LEFT_FOOT_CANDIDATES)
    right_foot = _find_bone(armature, _RIGHT_FOOT_CANDIDATES)
    if left_foot is None and right_foot is None:
        return None

    points: List[Vector] = []
    if left_foot is not None:
        points.append(armature.matrix_world @ left_foot.head_local)
    if right_foot is not None:
        points.append(armature.matrix_world @ right_foot.head_local)
    if not points:
        return None

    center = Vector((0.0, 0.0, 0.0))
    for point in points:
        center += point
    center /= float(len(points))

    horizontal_axes = [idx for idx in range(3) if idx != up_axis_index]
    components = (float(center.x), float(center.y), float(center.z))
    return (
        components[horizontal_axes[0]],
        components[horizontal_axes[1]],
    )


def foot_bone_ground_level(
    armature: bpy.types.Object,
    up_axis_index: int,
) -> Optional[float]:
    candidates: List[bpy.types.Bone] = []
    for names in (
        _LEFT_FOOT_CANDIDATES,
        _RIGHT_FOOT_CANDIDATES,
        _LEFT_TOE_CANDIDATES,
        _RIGHT_TOE_CANDIDATES,
    ):
        bone = _find_bone(armature, names)
        if bone is not None and bone not in candidates:
            candidates.append(bone)
    if not candidates:
        return None

    levels: List[float] = []
    for bone in candidates:
        head = armature.matrix_world @ bone.head_local
        tail = armature.matrix_world @ bone.tail_local
        head_components = (float(head.x), float(head.y), float(head.z))
        tail_components = (float(tail.x), float(tail.y), float(tail.z))
        levels.append(head_components[up_axis_index])
        levels.append(tail_components[up_axis_index])
    if not levels:
        return None
    return min(levels)


def snap_character_to_world_origin(
    armature: bpy.types.Object,
    target_meshes: List[bpy.types.Object],
    up_axis_index: int,
) -> Dict[str, object]:
    bounds_before = world_bounds(target_meshes)
    center_before = bounds_center(bounds_before)
    horizontal_axes = [idx for idx in range(3) if idx != up_axis_index]
    footprint_before = footprint_center_at_ground(target_meshes, up_axis_index)
    foot_bone_center_before = foot_bone_center(armature, up_axis_index)
    foot_bone_ground_before = foot_bone_ground_level(armature, up_axis_index)
    delta = [0.0, 0.0, 0.0]
    for axis_index in range(3):
        if axis_index == up_axis_index:
            # Put visible shoe/mesh contact on the ground plane.
            delta[axis_index] = -bounds_before[axis_index]
        else:
            # Center horizontally around world origin, preferring explicit foot-bone midpoint.
            if foot_bone_center_before is not None:
                foot_component = foot_bone_center_before[
                    0 if axis_index == horizontal_axes[0] else 1
                ]
                delta[axis_index] = -foot_component
            elif footprint_before is not None:
                footprint_component = footprint_before[
                    0 if axis_index == horizontal_axes[0] else 1
                ]
                delta[axis_index] = -footprint_component
            else:
                delta[axis_index] = -center_before[axis_index]

    data_bake_report = bake_world_translation_into_character_data(
        armature,
        target_meshes,
        delta,
    )

    bpy.context.view_layer.update()
    bounds_after = world_bounds(target_meshes)
    center_after = bounds_center(bounds_after)
    footprint_after = footprint_center_at_ground(target_meshes, up_axis_index)
    foot_bone_center_after = foot_bone_center(armature, up_axis_index)
    foot_bone_ground_after = foot_bone_ground_level(armature, up_axis_index)
    method = "bounds-center-fallback"
    if foot_bone_center_before is not None and foot_bone_ground_before is not None:
        method = "foot-bone-center+mesh-ground"
    elif foot_bone_center_before is not None:
        method = "foot-bone-center"
    elif footprint_before is not None:
        method = "footprint-center"
    return {
        "upAxis": AXIS_LABELS[up_axis_index],
        "translation": [float(delta[0]), float(delta[1]), float(delta[2])],
        "method": method,
        "dataBake": data_bake_report,
        "boundsBefore": {
            "min": [bounds_before[0], bounds_before[1], bounds_before[2]],
            "max": [bounds_before[3], bounds_before[4], bounds_before[5]],
            "size": list(bounds_size(bounds_before)),
            "center": [center_before[0], center_before[1], center_before[2]],
            "footprintCenter": list(footprint_before) if footprint_before is not None else None,
            "footBoneCenter": list(foot_bone_center_before) if foot_bone_center_before is not None else None,
            "footBoneGround": foot_bone_ground_before,
        },
        "boundsAfter": {
            "min": [bounds_after[0], bounds_after[1], bounds_after[2]],
            "max": [bounds_after[3], bounds_after[4], bounds_after[5]],
            "size": list(bounds_size(bounds_after)),
            "center": [center_after[0], center_after[1], center_after[2]],
            "footprintCenter": list(footprint_after) if footprint_after is not None else None,
            "footBoneCenter": list(foot_bone_center_after) if foot_bone_center_after is not None else None,
            "footBoneGround": foot_bone_ground_after,
        },
    }


def ensure_armature_modifier(target: bpy.types.Object, armature: bpy.types.Object) -> None:
    for modifier in target.modifiers:
        if modifier.type == "ARMATURE":
            modifier.object = armature
            return
    modifier = target.modifiers.new(name="Armature", type="ARMATURE")
    modifier.object = armature


def transfer_vertex_weights(
    source_mesh: bpy.types.Object, target_mesh: bpy.types.Object, transfer_mode: str
) -> str:
    if len(source_mesh.vertex_groups) == 0:
        raise RuntimeError(
            f"Source mesh '{source_mesh.name}' has no vertex groups for weight transfer."
        )

    if transfer_mode == "index-copy" and len(source_mesh.data.vertices) == len(target_mesh.data.vertices):
        while len(target_mesh.vertex_groups) > 0:
            target_mesh.vertex_groups.remove(target_mesh.vertex_groups[0])

        group_names: Dict[int, str] = {}
        for source_group in source_mesh.vertex_groups:
            target_mesh.vertex_groups.new(name=source_group.name)
            group_names[source_group.index] = source_group.name

        for vertex in source_mesh.data.vertices:
            for assignment in vertex.groups:
                if assignment.weight <= 1e-8:
                    continue
                group_name = group_names.get(assignment.group)
                if not group_name:
                    continue
                target_group = target_mesh.vertex_groups.get(group_name)
                if target_group is None:
                    continue
                target_group.add([vertex.index], assignment.weight, "REPLACE")
        return "index-copy"

    def set_enum_with_fallback(modifier: bpy.types.Modifier, attr: str, candidates: List[str]) -> None:
        if not hasattr(modifier, attr):
            return
        prop = modifier.bl_rna.properties.get(attr)
        if prop is None or not hasattr(prop, "enum_items"):
            return

        supported = {item.identifier for item in prop.enum_items}
        for candidate in candidates:
            if candidate in supported:
                setattr(modifier, attr, candidate)
                return

    for source_group in source_mesh.vertex_groups:
        if target_mesh.vertex_groups.get(source_group.name) is None:
            target_mesh.vertex_groups.new(name=source_group.name)

    data_transfer = target_mesh.modifiers.new(name="WeightTransfer", type="DATA_TRANSFER")
    data_transfer.object = source_mesh
    if hasattr(data_transfer, "use_vert_data"):
        data_transfer.use_vert_data = True
    if hasattr(data_transfer, "data_types_verts"):
        data_transfer.data_types_verts = {"VGROUP_WEIGHTS"}
    if hasattr(data_transfer, "vert_mapping"):
        data_transfer.vert_mapping = "POLYINTERP_NEAREST"
    set_enum_with_fallback(data_transfer, "layers_vgroup_select_src", ["NAME", "ALL", "INDEX"])
    set_enum_with_fallback(data_transfer, "layers_vgroup_select_dst", ["NAME", "ALL", "INDEX"])
    if hasattr(data_transfer, "mix_mode"):
        data_transfer.mix_mode = "REPLACE"
    if hasattr(data_transfer, "mix_factor"):
        data_transfer.mix_factor = 1.0

    bpy.ops.object.select_all(action="DESELECT")
    target_mesh.select_set(True)
    bpy.context.view_layer.objects.active = target_mesh
    bpy.ops.object.modifier_apply(modifier=data_transfer.name)
    return "data-transfer"


def validate_skin_binding(mesh: bpy.types.Object, armature: bpy.types.Object) -> None:
    if mesh.type != "MESH":
        raise RuntimeError(f"Expected mesh object, got: {mesh.type}")
    if armature.type != "ARMATURE":
        raise RuntimeError(f"Expected armature object, got: {armature.type}")
    if len(mesh.vertex_groups) == 0:
        raise RuntimeError(
            f"Mesh '{mesh.name}' has no vertex groups after weight transfer. "
            "Cannot export a skinned mesh."
        )

    bone_names = {bone.name for bone in armature.data.bones}
    matching_groups = [group.name for group in mesh.vertex_groups if group.name in bone_names]
    if not matching_groups:
        raise RuntimeError(
            f"Mesh '{mesh.name}' has vertex groups but none match armature bones. "
            "Cannot bind mesh to skeleton."
        )

    matching_indices = {
        group.index for group in mesh.vertex_groups if group.name in bone_names
    }
    weighted_vertex_count = 0
    for vertex in mesh.data.vertices:
        has_weight = any(
            assignment.group in matching_indices and assignment.weight > 1e-6
            for assignment in vertex.groups
        )
        if has_weight:
            weighted_vertex_count += 1

    if weighted_vertex_count == 0:
        raise RuntimeError(
            f"Mesh '{mesh.name}' has matching vertex groups but zero effective weights. "
            "Weight transfer failed."
        )


def parent_mesh_to_armature(mesh: bpy.types.Object, armature: bpy.types.Object) -> None:
    if mesh.parent == armature:
        return
    world_matrix = mesh.matrix_world.copy()
    mesh.parent = armature
    mesh.matrix_parent_inverse = armature.matrix_world.inverted()
    mesh.matrix_world = world_matrix


def remove_objects(objects: Iterable[bpy.types.Object]) -> None:
    deletable = [obj for obj in objects if obj.name in bpy.data.objects]
    if not deletable:
        return
    bpy.ops.object.select_all(action="DESELECT")
    for obj in deletable:
        obj.select_set(True)
    bpy.ops.object.delete(use_global=False)


def create_clip_mapping(args: argparse.Namespace) -> Dict[str, str]:
    mapping = {
        "idle": "idle",
        "walking": "walking",
        "working": args.working_clip,
        "communicating": "communicating",
        "coffee-break": "coffee-break",
        "at-phone": "at-phone",
        "teleport-out": "teleport-out",
        "teleport-in": "teleport-in",
    }
    if args.talking_clip and args.talking_clip.strip():
        mapping["talking"] = args.talking_clip.strip()
    return mapping


def clip_path_for_name(clips_dir: Path, clip_stem: str) -> Path:
    direct = clips_dir / f"{clip_stem}.fbx"
    if direct.exists():
        return direct

    normalized = clip_stem.lower()
    for candidate in clips_dir.glob("*.fbx"):
        if candidate.stem.lower() == normalized:
            return candidate
    raise RuntimeError(f"Missing clip file for '{clip_stem}' in {clips_dir}")


def import_clip_action(
    main_armature: bpy.types.Object,
    clip_path: Path,
    state_name: str,
    axis_forward: str = "auto",
    axis_up: str = "auto",
) -> bpy.types.Action:
    imported = import_fbx(
        clip_path,
        use_anim=True,
        ignore_leaf_bones=True,
        axis_forward=axis_forward,
        axis_up=axis_up,
    )
    imported_armature = find_first_armature(imported)
    action = (
        imported_armature.animation_data.action
        if imported_armature.animation_data is not None
        else None
    )
    if action is None:
        raise RuntimeError(f"Clip {clip_path.name} contains no action.")

    copied_action = action.copy()
    copied_action.name = state_name
    copied_action.use_fake_user = True

    # Detach the original imported action from its owner so we can drop it
    # cleanly. Otherwise names like "mixamo.com|Layer0" linger in bpy.data and
    # end up in the exported GLB as stray actions.
    if imported_armature.animation_data is not None:
        imported_armature.animation_data.action = None
    if action.users == 0 or (action.users == 1 and action.use_fake_user):
        try:
            bpy.data.actions.remove(action, do_unlink=True)
        except (RuntimeError, ReferenceError):
            pass

    main_armature.animation_data_create()
    main_armature.animation_data.action = copied_action
    remove_objects(imported)
    return copied_action


def prune_foreign_actions(keep_names: Iterable[str]) -> List[str]:
    """Remove every action whose name is not in ``keep_names``.

    Returns the list of removed action names so callers can report them.
    Actions are only kept if their name matches exactly — that means the
    canonical state-named copies survive and anything else (imported source
    actions like ``mixamo.com|Layer0``, copies, residuals) is deleted.
    """
    allowed = {name for name in keep_names if name}
    removed: List[str] = []
    for action in list(bpy.data.actions):
        if action.name in allowed:
            continue
        removed.append(action.name)
        try:
            bpy.data.actions.remove(action, do_unlink=True)
        except (RuntimeError, ReferenceError):
            pass
    return removed


def _normalize_bone_name(value: str) -> str:
    return "".join(ch for ch in value.lower() if ch.isalnum())


def find_root_motion_bone_name(armature: bpy.types.Object) -> Optional[str]:
    bone = _find_bone(armature, _HIPS_BONE_CANDIDATES)
    if bone is not None:
        return bone.name
    return None


def collect_action_fcurves(
    action: bpy.types.Action,
    owner_armature: Optional[bpy.types.Object] = None,
) -> Tuple[List[bpy.types.FCurve], str]:
    direct_fcurves = getattr(action, "fcurves", None)
    if direct_fcurves is not None:
        try:
            return (list(direct_fcurves), "action.fcurves")
        except TypeError:
            pass

    slot = None
    if owner_armature is not None:
        anim_data = owner_armature.animation_data
        if anim_data is not None and getattr(anim_data, "action", None) == action:
            slot = getattr(anim_data, "action_slot", None)

    try:
        from bpy_extras import anim_utils as _anim_utils
    except Exception:
        _anim_utils = None

    if _anim_utils is not None and slot is not None:
        try:
            channelbag = _anim_utils.action_get_channelbag_for_slot(action, slot)
        except Exception:
            channelbag = None
        if channelbag is not None and hasattr(channelbag, "fcurves"):
            return (list(channelbag.fcurves), "channelbag.fcurves")

    fcurves: List[bpy.types.FCurve] = []
    layers = getattr(action, "layers", None)
    if layers is not None:
        for layer in layers:
            strips = getattr(layer, "strips", None)
            if strips is None:
                continue
            for strip in strips:
                bag = None
                if slot is not None and hasattr(strip, "channelbag"):
                    try:
                        bag = strip.channelbag(slot)
                    except Exception:
                        bag = None
                if bag is not None and hasattr(bag, "fcurves"):
                    fcurves.extend(list(bag.fcurves))
                    continue
                for attr in ("channelbags", "channel_bags"):
                    bags = getattr(strip, attr, None)
                    if bags is None:
                        continue
                    for candidate in bags:
                        if hasattr(candidate, "fcurves"):
                            fcurves.extend(list(candidate.fcurves))

    if fcurves:
        unique: Dict[int, bpy.types.FCurve] = {}
        for curve in fcurves:
            try:
                key = int(curve.as_pointer())
            except Exception:
                key = id(curve)
            unique[key] = curve
        return (list(unique.values()), "layered-action")

    return ([], "unavailable")


def flatten_root_motion_translation(
    action: bpy.types.Action,
    root_bone_name: Optional[str],
    owner_armature: Optional[bpy.types.Object] = None,
) -> Dict[str, object]:
    if action is None:
        return {"changed": False, "matchedCurves": 0, "flattenedCurves": 0, "fcurveSource": "none"}

    normalized_root = _normalize_bone_name(root_bone_name) if root_bone_name else None
    candidate_tokens = tuple(_normalize_bone_name(token) for token in _HIPS_BONE_CANDIDATES)
    matched_curves = 0
    flattened_curves = 0
    object_curves = 0
    baselines: Dict[str, float] = {}
    fcurves, fcurve_source = collect_action_fcurves(action, owner_armature)

    for fcurve in fcurves:
        path = fcurve.data_path
        is_armature_object_location = path == "location"
        is_root_match = False
        if path.endswith(".location") and path.startswith('pose.bones["'):
            prefix_len = len('pose.bones["')
            end_idx = path.find('"]', prefix_len)
            if end_idx <= prefix_len:
                continue
            bone_name = path[prefix_len:end_idx]
            normalized_bone = _normalize_bone_name(bone_name)
            if normalized_root:
                is_root_match = normalized_bone == normalized_root
            if not is_root_match:
                is_root_match = any(token in normalized_bone for token in candidate_tokens if token)
        if not is_root_match and not is_armature_object_location:
            continue

        matched_curves += 1
        if not fcurve.keyframe_points:
            continue

        # Some Mixamo FBX clips carry object-level armature location curves.
        # Keep those at origin so every state shares one stable world pivot.
        if is_armature_object_location:
            baseline = 0.0
            object_curves += 1
        else:
            baseline = float(fcurve.keyframe_points[0].co[1])
            baselines[str(int(fcurve.array_index))] = baseline

        changed = False
        for key in fcurve.keyframe_points:
            if abs(float(key.co[1]) - baseline) > 1e-7:
                changed = True
            key.co[1] = baseline
            key.handle_left[1] = baseline
            key.handle_right[1] = baseline
        fcurve.update()
        if changed:
            flattened_curves += 1

    return {
        "changed": flattened_curves > 0,
        "matchedCurves": matched_curves,
        "flattenedCurves": flattened_curves,
        "rootBone": root_bone_name,
        "fcurveSource": fcurve_source,
        "baselines": baselines,
        "objectLocationCurves": object_curves,
    }


def align_root_motion_baseline(
    action: bpy.types.Action,
    root_bone_name: Optional[str],
    target_baselines: Dict[int, float],
    axes_to_align: List[int],
    owner_armature: Optional[bpy.types.Object] = None,
) -> Dict[str, object]:
    if action is None:
        return {"changed": False, "matchedCurves": 0, "alignedCurves": 0, "fcurveSource": "none"}

    normalized_root = _normalize_bone_name(root_bone_name) if root_bone_name else None
    candidate_tokens = tuple(_normalize_bone_name(token) for token in _HIPS_BONE_CANDIDATES)
    matched_curves = 0
    aligned_curves = 0
    fcurves, fcurve_source = collect_action_fcurves(action, owner_armature)

    for fcurve in fcurves:
        path = fcurve.data_path
        if not path.endswith(".location"):
            continue
        if not path.startswith('pose.bones["'):
            continue
        prefix_len = len('pose.bones["')
        end_idx = path.find('"]', prefix_len)
        if end_idx <= prefix_len:
            continue
        bone_name = path[prefix_len:end_idx]
        normalized_bone = _normalize_bone_name(bone_name)
        is_root_match = False
        if normalized_root:
            is_root_match = normalized_bone == normalized_root
        if not is_root_match:
            is_root_match = any(token in normalized_bone for token in candidate_tokens if token)
        if not is_root_match:
            continue

        axis_index = int(fcurve.array_index)
        if axis_index not in axes_to_align:
            continue
        if axis_index not in target_baselines:
            continue
        if not fcurve.keyframe_points:
            continue

        matched_curves += 1
        target_value = float(target_baselines[axis_index])
        changed = False
        for key in fcurve.keyframe_points:
            if abs(float(key.co[1]) - target_value) > 1e-7:
                changed = True
            key.co[1] = target_value
            key.handle_left[1] = target_value
            key.handle_right[1] = target_value
        fcurve.update()
        if changed:
            aligned_curves += 1

    return {
        "changed": aligned_curves > 0,
        "matchedCurves": matched_curves,
        "alignedCurves": aligned_curves,
        "rootBone": root_bone_name,
        "axes": axes_to_align,
        "targetBaselines": {str(axis): target_baselines[axis] for axis in axes_to_align if axis in target_baselines},
        "fcurveSource": fcurve_source,
    }


def clear_pose_transforms(armature: bpy.types.Object) -> None:
    if armature.type != "ARMATURE":
        return
    bpy.ops.object.select_all(action="DESELECT")
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    previous_mode = armature.mode
    try:
        bpy.ops.object.mode_set(mode="POSE")
        bpy.ops.pose.select_all(action="SELECT")
        bpy.ops.pose.transforms_clear()
    finally:
        bpy.ops.object.mode_set(mode="OBJECT")
        if previous_mode not in {"OBJECT", "POSE"}:
            bpy.ops.object.mode_set(mode=previous_mode)


def stash_actions_to_nla(
    armature: bpy.types.Object, actions: Iterable[bpy.types.Action]
) -> None:
    armature.animation_data_create()
    animation_data = armature.animation_data
    if animation_data is None:
        return
    for track in list(animation_data.nla_tracks):
        animation_data.nla_tracks.remove(track)
    for action in actions:
        track = animation_data.nla_tracks.new()
        track.name = action.name
        start_frame = int(round(action.frame_range[0]))
        strip = track.strips.new(action.name, start_frame, action)
        strip.action_frame_start = action.frame_range[0]
        strip.action_frame_end = action.frame_range[1]
        track.mute = False


def write_report(path: Path, payload: Dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def build(args: argparse.Namespace) -> None:
    mesh_glb = Path(args.mesh_glb).resolve()
    base_fbx = Path(args.base_fbx).resolve()
    clips_dir = Path(args.clips_dir).resolve()
    output_glb = Path(args.output_glb).resolve()
    clip_mapping = create_clip_mapping(args)

    ensure_file(mesh_glb, "mesh-glb")
    ensure_file(base_fbx, "base-fbx")
    ensure_dir(clips_dir, "clips-dir")
    output_glb.parent.mkdir(parents=True, exist_ok=True)

    warnings: List[str] = []

    clear_scene()
    base_imported = import_fbx(
        base_fbx,
        use_anim=False,
        ignore_leaf_bones=True,
        axis_forward=args.fbx_axis_forward,
        axis_up=args.fbx_axis_up,
    )
    main_armature = find_first_armature(base_imported)
    base_meshes = find_meshes(base_imported)
    if not base_meshes:
        raise RuntimeError("No source meshes found in base FBX.")

    # Force the armature into rest pose from the outset so weight transfer,
    # alignment and review.blend save all sample the T-pose rather than the
    # frame-1 pose of whichever clip was imported last.
    main_armature.data.pose_position = "REST"
    clear_pose_transforms(main_armature)

    mesh_imported = import_glb(mesh_glb)
    target_meshes = find_meshes(mesh_imported)
    if not target_meshes:
        raise RuntimeError("No target meshes found in mesh GLB.")

    base_mesh = pick_source_mesh(base_meshes, main_armature, target_meshes, args.base_mesh_name)
    target_reference_mesh = max(target_meshes, key=lambda mesh: len(mesh.data.vertices))

    base_mesh_bounds = world_bounds([base_mesh])
    target_reference_bounds = world_bounds([target_reference_mesh])
    base_mesh_size = bounds_size(base_mesh_bounds)
    target_reference_size = bounds_size(target_reference_bounds)
    selected_base_mesh_info = {
        "name": base_mesh.name,
        "vertexCount": len(base_mesh.data.vertices),
        "vertexGroupCount": len(base_mesh.vertex_groups),
        "boundsSize": list(base_mesh_size),
        "dominantAxis": dominant_axis_label(base_mesh_size),
    }

    armature_up_world, armature_up_source = detect_armature_up_world(main_armature)
    armature_orientation_info = {
        "detectedUpWorld": [
            float(armature_up_world.x),
            float(armature_up_world.y),
            float(armature_up_world.z),
        ],
        "snappedUpAxis": vector_to_axis_label(armature_up_world),
        "source": armature_up_source,
    }

    manual_rotation = (
        float(args.base_rotation_x),
        float(args.base_rotation_y),
        float(args.base_rotation_z),
    )

    base_normalization: Optional[Dict[str, object]] = None
    target_normalization: Optional[Dict[str, object]] = None
    forward_axis_alignment: Optional[Dict[str, object]] = None
    inferred_rotation: Tuple[float, float, float] = (0.0, 0.0, 0.0)
    base_rotation_fix_applied = False
    base_rotation_fix_degrees: Tuple[float, float, float] = (0.0, 0.0, 0.0)
    rotation_source = "normalize"

    if args.rotation_target == "normalize":
        base_normalization = normalize_hierarchy_to_z_up(
            [main_armature, *base_meshes], armature_up_world
        )
        target_up_world, target_up_source = detect_mesh_up_world(target_meshes)
        target_normalization = normalize_hierarchy_to_z_up(target_meshes, target_up_world)
        target_normalization["source"] = target_up_source
        base_rotation_fix_applied = bool(
            base_normalization.get("applied") or target_normalization.get("applied")
        )

        base_sideways, base_sideways_source = detect_armature_sideways_world(main_armature)
        target_sideways, target_sideways_source = detect_mesh_sideways_world(target_meshes)

        override_degrees: Optional[float] = None
        if args.forward_axis_offset != "auto":
            override_degrees = float(args.forward_axis_offset)

        if override_degrees is not None or base_sideways is not None:
            forward_axis_alignment = align_forward_axis_around_z(
                target_meshes,
                base_sideways,
                target_sideways,
                override_degrees=override_degrees,
            )
            forward_axis_alignment["baseSidewaysSource"] = base_sideways_source
            forward_axis_alignment["targetSidewaysSource"] = target_sideways_source
            if base_sideways is not None:
                forward_axis_alignment["baseSidewaysWorld"] = [
                    float(base_sideways.x),
                    float(base_sideways.y),
                    float(base_sideways.z),
                ]
            if target_sideways is not None:
                forward_axis_alignment["targetSidewaysWorld"] = [
                    float(target_sideways.x),
                    float(target_sideways.y),
                    float(target_sideways.z),
                ]
            post_target_sideways, _ = detect_mesh_sideways_world(target_meshes)
            forward_axis_alignment["targetSidewaysWorldAfter"] = [
                float(post_target_sideways.x),
                float(post_target_sideways.y),
                float(post_target_sideways.z),
            ]
            if forward_axis_alignment.get("ambiguous"):
                warnings.append(
                    "Forward-axis alignment residual exceeds 15°"
                    f" (raw {forward_axis_alignment.get('rawAngleDegrees', 0.0):.1f}°,"
                    f" snapped {forward_axis_alignment.get('snappedAngleDegrees', 0.0):.1f}°)."
                    " Target mesh facing may need a manual --forward-axis-offset override."
                )
        else:
            forward_axis_alignment = {
                "applied": False,
                "reason": base_sideways_source,
                "baseSidewaysSource": base_sideways_source,
                "targetSidewaysSource": target_sideways_source,
                "mode": "auto",
            }
            warnings.append(
                "Forward-axis alignment skipped: shoulder bones not found on armature."
                " Mesh facing may remain misaligned — pass --forward-axis-offset 90/180/270 to override."
            )
    else:
        inferred_rotation = infer_axis_alignment_rotation(base_mesh_size, target_reference_size)
        using_auto_rotation = (
            args.auto_base_rotation == "auto" and is_zero_rotation(manual_rotation)
        )
        base_rotation_fix_degrees = (
            inferred_rotation if using_auto_rotation else manual_rotation
        )
        rotation_source = "inferred-axis" if using_auto_rotation else "manual"
        if not using_auto_rotation and is_zero_rotation(manual_rotation):
            rotation_source = "manual-zero"

        if args.rotation_target == "base-and-armature":
            rotation_objects: List[bpy.types.Object] = [main_armature, *base_meshes]
        else:
            rotation_objects = list(target_meshes)
        base_rotation_fix_applied = apply_rotation_fix(
            rotation_objects, base_rotation_fix_degrees
        )

    # Up-axis index in the normalized frame.
    up_axis_for_alignment: Optional[int] = 2 if args.rotation_target == "normalize" else None

    alignment_report = None
    if args.align_target_to_base == "auto":
        alignment_report = align_target_meshes_to_source_mesh(
            base_mesh, target_meshes, up_axis_index=up_axis_for_alignment
        )
        translation = alignment_report.get("translation") if alignment_report else None
        if isinstance(translation, list):
            magnitude = math.sqrt(sum(component * component for component in translation))
            if magnitude > float(args.translation_warn_threshold):
                warnings.append(
                    f"Target alignment translated {magnitude:.3f} m (threshold "
                    f"{float(args.translation_warn_threshold):.3f} m). Check axis detection."
                )

    post_normalize_armature_up_world, post_normalize_source = detect_armature_up_world(
        main_armature
    )
    if args.rotation_target == "normalize":
        snapped_post = snap_to_principal_axis(post_normalize_armature_up_world)
        if not (snapped_post - Vector((0.0, 0.0, 1.0))).length < 1e-4:
            warnings.append(
                "Armature up axis after normalization is "
                f"{vector_to_axis_label(post_normalize_armature_up_world)} "
                "(expected +Z). Rig orientation heuristic may be wrong."
            )

    # Bake location/rotation/scale into mesh data so DATA_TRANSFER samples in a
    # consistent object space, regardless of upstream import transforms.
    apply_all_transforms(base_mesh)
    for mesh in target_meshes:
        apply_all_transforms(mesh)

    source_bounds = world_bounds(target_meshes)

    weight_transfer_methods: Dict[str, str] = {}
    for mesh in target_meshes:
        weight_transfer_methods[mesh.name] = transfer_vertex_weights(
            base_mesh, mesh, args.transfer_mode
        )
        ensure_armature_modifier(mesh, main_armature)
        parent_mesh_to_armature(mesh, main_armature)
        validate_skin_binding(mesh, main_armature)

    removed_base_objects = [
        obj.name for obj in base_imported if obj != main_armature and obj.name in bpy.data.objects
    ]
    remove_objects([obj for obj in base_imported if obj != main_armature])

    baked_actions: Dict[str, bpy.types.Action] = {}
    used_clips: Dict[str, str] = {}
    root_motion_lock_report: Dict[str, object] = {
        "enabled": args.lock_root_motion == "auto",
        "rootBone": None,
        "referenceState": None,
        "referenceBaselines": {},
        "alignAxes": [],
        "states": {},
        "alignment": {},
    }
    root_motion_bone = find_root_motion_bone_name(main_armature) if args.lock_root_motion == "auto" else None
    if root_motion_bone:
        root_motion_lock_report["rootBone"] = root_motion_bone
    for state_name, clip_stem in clip_mapping.items():
        try:
            path = clip_path_for_name(clips_dir, clip_stem)
        except RuntimeError as error:
            if state_name == "talking":
                warnings.append(str(error))
                continue
            raise
        used_clips[state_name] = path.name
        baked_actions[state_name] = import_clip_action(
            main_armature,
            path,
            state_name,
            axis_forward=args.fbx_axis_forward,
            axis_up=args.fbx_axis_up,
        )
        if args.lock_root_motion == "auto":
            root_motion_lock_report["states"][state_name] = flatten_root_motion_translation(
                baked_actions[state_name],
                root_motion_bone,
                owner_armature=main_armature,
            )

    if args.lock_root_motion == "auto" and baked_actions:
        # Align all location axes (including vertical) to the scene origin so
        # no clip moves the whole rig away from the exported object pivot.
        align_axes = [0, 1, 2]
        root_motion_lock_report["alignAxes"] = align_axes
        reference_state = "idle" if "idle" in baked_actions else next(iter(baked_actions.keys()))
        root_motion_lock_report["referenceState"] = reference_state
        reference_baselines = {axis: 0.0 for axis in align_axes}
        root_motion_lock_report["referenceBaselines"] = {str(axis): value for axis, value in reference_baselines.items()}
        if reference_baselines:
            for state_name, action in baked_actions.items():
                root_motion_lock_report["alignment"][state_name] = align_root_motion_baseline(
                    action,
                    root_motion_bone,
                    reference_baselines,
                    axes_to_align=align_axes,
                    owner_armature=main_armature,
                )

    missing_required = [state for state in REQUIRED_STATES if state not in baked_actions]
    if missing_required:
        raise RuntimeError(f"Missing required actions after import: {', '.join(missing_required)}")

    stash_actions_to_nla(main_armature, baked_actions.values())
    main_armature.animation_data_create()
    if main_armature.animation_data is not None:
        if args.mode == "semi":
            preview_action = baked_actions.get("idle")
            if preview_action is None and baked_actions:
                preview_action = next(iter(baked_actions.values()))
            main_armature.animation_data.action = preview_action
            if preview_action is not None:
                frame_start = int(math.floor(preview_action.frame_range[0]))
                frame_end = int(math.ceil(preview_action.frame_range[1]))
                bpy.context.scene.frame_start = frame_start
                bpy.context.scene.frame_end = max(frame_end, frame_start + 1)
                bpy.context.scene.frame_current = frame_start
        else:
            # Keep a deterministic active action for exporter evaluation.
            main_armature.animation_data.action = baked_actions.get("idle")

    # Evaluate bounds in rest pose (stable), then switch back to POSE for
    # review playback/export so animation curves are actually applied.
    clear_pose_transforms(main_armature)
    main_armature.data.pose_position = "REST"

    post_bind_bounds = world_bounds(target_meshes)
    post_bind_size = bounds_size(post_bind_bounds)
    # Post-normalization Blender-up is Z; legacy modes keep Y as vertical.
    height_axis = 2 if args.rotation_target == "normalize" else 1
    if post_bind_size[height_axis] < 0.05:
        axis_label = AXIS_LABELS[height_axis]
        raise RuntimeError(
            f"Mesh {axis_label}-extent is extremely small after rig binding "
            f"({post_bind_size[height_axis]:.6f}). Check armature parenting/scale in source assets."
        )
    world_snap_report: Optional[Dict[str, object]] = None
    if args.snap_character_to_world == "auto":
        world_snap_report = snap_character_to_world_origin(
            main_armature,
            target_meshes,
            up_axis_index=height_axis,
        )
        mesh_origin_report = set_object_origins_to_world_origin(target_meshes)
        bpy.context.view_layer.update()
        if isinstance(world_snap_report, dict):
            bounds_after_origin = world_bounds(target_meshes)
            world_snap_report["meshOriginReset"] = mesh_origin_report
            world_snap_report["boundsAfterOriginReset"] = {
                "min": [bounds_after_origin[0], bounds_after_origin[1], bounds_after_origin[2]],
                "max": [bounds_after_origin[3], bounds_after_origin[4], bounds_after_origin[5]],
                "size": list(bounds_size(bounds_after_origin)),
                "center": list(bounds_center(bounds_after_origin)),
            }
            world_snap_report["armatureLocation"] = [
                float(main_armature.location.x),
                float(main_armature.location.y),
                float(main_armature.location.z),
            ]
    main_armature.data.pose_position = "POSE"

    review_path = output_glb.with_suffix(".review.blend")
    report_path = output_glb.with_suffix(".report.json")

    report_payload: Dict[str, object] = {
        "mode": args.mode,
        "meshGlb": str(mesh_glb),
        "baseFbx": str(base_fbx),
        "clipsDir": str(clips_dir),
        "outputGlb": str(output_glb),
        "reviewBlend": str(review_path),
        "usedClips": used_clips,
        "warnings": warnings,
        "removedBaseObjects": removed_base_objects,
        "selectedBaseMesh": selected_base_mesh_info,
        "targetReferenceMesh": {
            "name": target_reference_mesh.name,
            "vertexCount": len(target_reference_mesh.data.vertices),
            "boundsSize": list(target_reference_size),
            "dominantAxis": dominant_axis_label(target_reference_size),
        },
        "baseMeshOverride": args.base_mesh_name,
        "armatureOrientation": {
            "beforeNormalization": armature_orientation_info,
            "afterNormalization": {
                "detectedUpWorld": [
                    float(post_normalize_armature_up_world.x),
                    float(post_normalize_armature_up_world.y),
                    float(post_normalize_armature_up_world.z),
                ],
                "snappedUpAxis": vector_to_axis_label(post_normalize_armature_up_world),
                "source": post_normalize_source,
            },
        },
        "baseRotationFix": {
            "applied": base_rotation_fix_applied,
            "degrees": list(base_rotation_fix_degrees),
            "source": rotation_source,
            "inferredDegrees": list(inferred_rotation),
            "target": args.rotation_target,
            "baseNormalization": base_normalization,
            "targetNormalization": target_normalization,
        },
        "forwardAxisAlignment": forward_axis_alignment,
        "targetAlignment": {
            "enabled": args.align_target_to_base == "auto",
            "upAxisIndex": up_axis_for_alignment,
            "translationWarnThreshold": float(args.translation_warn_threshold),
            "report": alignment_report,
        },
        "rootMotionLock": root_motion_lock_report,
        "worldSnap": {
            "enabled": args.snap_character_to_world == "auto",
            "report": world_snap_report,
        },
        "fbxImportOptions": {
            "axisForward": args.fbx_axis_forward,
            "axisUp": args.fbx_axis_up,
            "ignoreLeafBones": True,
        },
        "transferModeRequested": args.transfer_mode,
        "weightTransfer": weight_transfer_methods,
        "meshBoundsBeforeBind": {
            "min": [source_bounds[0], source_bounds[1], source_bounds[2]],
            "max": [source_bounds[3], source_bounds[4], source_bounds[5]],
            "size": list(bounds_size(source_bounds)),
        },
        "meshBoundsAfterBind": {
            "min": [post_bind_bounds[0], post_bind_bounds[1], post_bind_bounds[2]],
            "max": [post_bind_bounds[3], post_bind_bounds[4], post_bind_bounds[5]],
            "size": list(post_bind_size),
        },
        "requiredStatesValidated": REQUIRED_STATES,
        "optionalStates": [state for state in baked_actions.keys() if state not in REQUIRED_STATES],
        "previewAction": "idle" if "idle" in baked_actions else (next(iter(baked_actions.keys()), None)),
        "previewTracksMuted": False,
    }

    # Final hard sweep: keep only actions that belong to our state mapping.
    # This removes any orphaned Mixamo-named source actions, copies, or
    # other stray data-block names that would otherwise ship in the GLB.
    removed_foreign_actions = prune_foreign_actions(baked_actions.keys())
    report_payload["removedForeignActions"] = removed_foreign_actions

    if args.mode == "semi":
        bpy.ops.wm.save_as_mainfile(filepath=str(review_path))
        report_payload["result"] = "review_blend_created"
        write_report(report_path, report_payload)
        print(f"[avatar-build] semi mode done: {review_path}")
        return

    bpy.ops.object.select_all(action="DESELECT")
    main_armature.select_set(True)
    for mesh in target_meshes:
        if mesh.name in bpy.data.objects:
            mesh.select_set(True)
    bpy.context.view_layer.objects.active = main_armature

    export_kwargs: Dict[str, object] = {
        "filepath": str(output_glb),
        "export_format": "GLB",
        "use_selection": True,
        "export_animations": True,
        "export_nla_strips": True,
        "export_force_sampling": True,
        "export_skins": True,
        "export_apply": False,
        "export_optimize_animation_size": True,
    }
    try:
        bpy.ops.export_scene.gltf(**export_kwargs)
    except TypeError as error:
        # Fallback for Blender builds that don't support a newer kwarg.
        warnings.append(f"glTF export kwarg fallback: {error}")
        for removable in ("export_optimize_animation_size", "export_apply", "export_skins"):
            export_kwargs.pop(removable, None)
        bpy.ops.export_scene.gltf(**export_kwargs)
    report_payload["result"] = "glb_exported"
    write_report(report_path, report_payload)
    print(f"[avatar-build] full mode done: {output_glb}")


def main() -> None:
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []
    args = parse_args(argv)
    build(args)


if __name__ == "__main__":
    main()
