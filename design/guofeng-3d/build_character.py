"""Build the first-pass true 3D Chinese-beauty character in Blender.

This script intentionally keeps downloaded MakeHuman/MPFB asset packs outside the
repository.  Run it with Blender while the MPFB extension is enabled; MPFB discovers
asset packs from its user data directory.
"""

from __future__ import annotations

import importlib
import json
import struct
import sys
from math import cos, pi, radians, sin
from pathlib import Path

import bpy
from mathutils import Quaternion, Vector


OUTPUT_ROOT = Path(__file__).resolve().parent
EXPERIMENT_ROOT = OUTPUT_ROOT / "experimental-full-glb"
BLEND_PATH = EXPERIMENT_ROOT / "guofeng-beauty-working.blend"
PREVIEW_PATH = EXPERIMENT_ROOT / "guofeng-beauty-base-preview.png"
BROCADE_PATH = OUTPUT_ROOT / "hanfu-brocade-albedo.png"
GLB_PATH = EXPERIMENT_ROOT / "src" / "assets" / "term-character-guofeng-beauty.glb"


def dynamic_import(package_suffix: str, symbol: str):
    """Resolve an MPFB symbol regardless of Blender's extension namespace."""
    for module_name in tuple(sys.modules):
        if module_name.endswith(package_suffix):
            module = importlib.import_module(module_name)
            return getattr(module, symbol)
    raise RuntimeError(f"MPFB module is not loaded: {package_suffix}")


HumanService = dynamic_import("mpfb.services.humanservice", "HumanService")
TargetService = dynamic_import("mpfb.services.targetservice", "TargetService")
AssetService = dynamic_import("mpfb.services.assetservice", "AssetService")
LocationService = dynamic_import("mpfb.services.locationservice", "LocationService")
ExportService = dynamic_import("mpfb.services.exportservice", "ExportService")


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.materials,
        bpy.data.cameras,
        bpy.data.lights,
    ):
        for datablock in tuple(datablocks):
            if datablock.users == 0:
                datablocks.remove(datablock)


def load_target(basemesh: bpy.types.Object, relative_path: str, weight: float) -> None:
    target_path = Path(LocationService.get_mpfb_data("targets")) / relative_path
    if not target_path.exists():
        raise FileNotFoundError(target_path)
    TargetService.load_target(basemesh, str(target_path), weight=weight)


def create_face() -> bpy.types.Object:
    macro = {
        "gender": 0.0,
        "age": 0.43,
        "muscle": 0.34,
        "weight": 0.44,
        "proportions": 0.34,
        "height": 0.56,
        "cupsize": 0.46,
        "firmness": 0.60,
        "race": {"asian": 1.0, "caucasian": 0.0, "african": 0.0},
    }
    basemesh = HumanService.create_human(
        mask_helpers=True,
        detailed_helpers=True,
        extra_vertex_groups=True,
        feet_on_ground=True,
        scale=0.1,
        macro_detail_dict=macro,
    )
    basemesh.name = "GuofengBeauty_Body"

    # Gentle identity shaping from the generated front / three-quarter / profile
    # sheet. Values stay conservative so the production topology remains natural.
    targets = {
        "head/head-oval.target.gz": 0.24,
        "head/head-invertedtriangular.target.gz": 0.16,
        "head/head-scale-horiz-decr.target.gz": 0.14,
        "head/head-scale-depth-decr.target.gz": 0.08,
        "head/head-scale-vert-incr.target.gz": 0.08,
        "forehead/forehead-scale-vert-incr.target.gz": 0.08,
        "chin/chin-width-decr.target.gz": 0.42,
        "chin/chin-height-incr.target.gz": 0.10,
        "chin/chin-triangle.target.gz": 0.30,
        "chin/chin-prominent-decr.target.gz": 0.08,
        "cheek/l-cheek-bones-incr.target.gz": 0.13,
        "cheek/r-cheek-bones-incr.target.gz": 0.13,
        "cheek/l-cheek-volume-incr.target.gz": 0.06,
        "cheek/r-cheek-volume-incr.target.gz": 0.06,
        "eyes/l-eye-scale-incr.target.gz": 0.20,
        "eyes/r-eye-scale-incr.target.gz": 0.20,
        "eyes/l-eye-height1-incr.target.gz": 0.08,
        "eyes/r-eye-height1-incr.target.gz": 0.08,
        "eyes/l-eye-epicanthus-in.target.gz": 0.24,
        "eyes/r-eye-epicanthus-in.target.gz": 0.24,
        "eyes/l-eye-corner1-up.target.gz": 0.08,
        "eyes/r-eye-corner1-up.target.gz": 0.08,
        "eyes/l-eye-bag-decr.target.gz": 0.14,
        "eyes/r-eye-bag-decr.target.gz": 0.14,
        "nose/nose-scale-horiz-decr.target.gz": 0.16,
        "nose/nose-volume-decr.target.gz": 0.10,
        "nose/nose-scale-depth-decr.target.gz": 0.08,
        "nose/nose-scale-vert-decr.target.gz": 0.08,
        "nose/nose-nostrils-width-decr.target.gz": 0.12,
        "nose/nose-point-width-decr.target.gz": 0.10,
        "mouth/mouth-scale-horiz-incr.target.gz": 0.04,
        "mouth/mouth-scale-vert-incr.target.gz": 0.06,
        "mouth/mouth-upperlip-volume-incr.target.gz": 0.17,
        "mouth/mouth-lowerlip-volume-incr.target.gz": 0.15,
        "mouth/mouth-cupidsbow-incr.target.gz": 0.14,
        "mouth/mouth-angles-up.target.gz": 0.035,
        "neck/neck-scale-horiz-decr.target.gz": 0.18,
    }
    for relative_path, weight in targets.items():
        load_target(basemesh, relative_path, weight)

    return basemesh


def bake_identity_to_basis(basemesh: bpy.types.Object) -> None:
    """Bake the customized identity while preserving MakeHuman vertex indices."""
    if not basemesh.data.shape_keys:
        return
    mixed = basemesh.shape_key_add(name="__identity_baked", from_mix=True)
    basis = basemesh.data.shape_keys.key_blocks["Basis"]
    coordinates = [0.0] * (len(basemesh.data.vertices) * 3)
    mixed.data.foreach_get("co", coordinates)
    basis.data.foreach_set("co", coordinates)
    for shape_key in tuple(basemesh.data.shape_keys.key_blocks)[::-1]:
        if shape_key.name != "Basis":
            basemesh.shape_key_remove(shape_key)
    basemesh.data.update()


def add_expression_morphs(basemesh: bpy.types.Object) -> None:
    """Add only the compact expression/viseme contract used by the web runtime."""
    target_roots = (
        Path(LocationService.get_user_data("targets")),
        Path(LocationService.get_mpfb_data("targets")),
    )

    def add(relative_path: str, name: str) -> bpy.types.ShapeKey:
        full_path = next(
            (root / relative_path for root in target_roots if (root / relative_path).exists()),
            None,
        )
        if not full_path:
            raise FileNotFoundError(relative_path)
        return TargetService.load_target(basemesh, str(full_path), weight=0.0, name=name)

    add("faceunits/eyeBlinkLeft.target", "blinkLeft")
    add("faceunits/eyeBlinkRight.target", "blinkRight")

    for output_name, relative_paths in {
        "smile": (
            "faceunits/mouthSmileLeft.target",
            "faceunits/mouthSmileRight.target",
        ),
        "frown": (
            "faceunits/mouthFrownLeft.target",
            "faceunits/mouthFrownRight.target",
        ),
    }.items():
        temporary_keys = [
            add(relative_path, f"__{output_name}_{index}")
            for index, relative_path in enumerate(relative_paths)
        ]
        for shape_key in temporary_keys:
            shape_key.value = 1.0
        basemesh.shape_key_add(name=output_name, from_mix=True)
        for shape_key in temporary_keys:
            basemesh.shape_key_remove(shape_key)

    for output_name, relative_path in {
        "visemeA": "visemes/aa_ah_ax_01.target",
        "visemeI": "visemes/y_iy_ih_ix_06.target",
        "visemeU": "visemes/w_uw_07.target",
        "visemeE": "visemes/ey_eh_uh_04.target",
        "visemeO": "visemes/ow_08.target",
    }.items():
        add(relative_path, output_name)

    for shape_key in basemesh.data.shape_keys.key_blocks:
        shape_key.value = 0.0

    expected = {
        "Basis",
        "blinkLeft",
        "blinkRight",
        "smile",
        "frown",
        "visemeA",
        "visemeI",
        "visemeU",
        "visemeE",
        "visemeO",
    }
    actual = {shape_key.name for shape_key in basemesh.data.shape_keys.key_blocks}
    if actual != expected:
        raise RuntimeError(f"Unexpected expression morphs: {sorted(actual)}")


def find_asset(subdir: str, *candidates: str) -> str | None:
    for filename in candidates:
        path = AssetService.find_asset_absolute_path(filename, asset_subdir=subdir)
        if path:
            return path
    return None


def add_asset(
    basemesh: bpy.types.Object,
    subdir: str,
    asset_type: str,
    *candidates: str,
    material_type: str = "GAMEENGINE",
    subdiv_levels: int = 1,
) -> bpy.types.Object | None:
    path = find_asset(subdir, *candidates)
    if not path:
        print(f"[guofeng-3d] optional asset missing: {subdir}/{candidates[0]}")
        return None
    return HumanService.add_mhclo_asset(
        path,
        basemesh,
        asset_type=asset_type,
        material_type=material_type,
        subdiv_levels=subdiv_levels,
    )


def add_skin_and_features(basemesh: bpy.types.Object) -> list[bpy.types.Object]:
    skin = find_asset(
        "skins",
        "onlytheghosts_young_eurasian_female.mhmat",
        "young_asian_female.mhmat",
    )
    if skin:
        HumanService.set_character_skin(skin, basemesh, skin_type="GAMEENGINE")
    else:
        material = bpy.data.materials.new("GuofengBeauty_SkinFallback")
        material.diffuse_color = (0.62, 0.36, 0.30, 1.0)
        material.use_nodes = True
        principled = material.node_tree.nodes.get("Principled BSDF")
        principled.inputs["Base Color"].default_value = (0.62, 0.36, 0.30, 1.0)
        principled.inputs["Roughness"].default_value = 0.48
        basemesh.data.materials.clear()
        basemesh.data.materials.append(material)

    assets = [
        add_asset(basemesh, "eyes", "Eyes", "high-poly.mhclo", "low-poly.mhclo"),
        add_asset(basemesh, "eyebrows", "Eyebrows", "eyebrow007.mhclo", "eyebrow001.mhclo"),
        add_asset(basemesh, "eyelashes", "Eyelashes", "eyelashes03.mhclo", "eyelashes01.mhclo"),
        add_asset(basemesh, "tongue", "Tongue", "tongue01.mhclo"),
        add_asset(basemesh, "teeth", "Teeth", "teeth_base.mhclo"),
    ]
    loaded_assets = [asset for asset in assets if asset is not None]

    # MakeHuman links every diffuse alpha channel by default.  That is useful
    # for card-like hair and lashes, but makes the body/eyes/teeth transparent
    # in glTF (Three.js then shows the internal mouth through the face).
    opaque_assets = [
        basemesh,
        *[
            asset
            for asset in loaded_assets
            if any(token in asset.name for token in ("high-poly", "teeth_base", "tongue01"))
        ],
    ]
    for obj in opaque_assets:
        for material in obj.data.materials:
            if not material.use_nodes:
                continue
            principled = material.node_tree.nodes.get("Principled BSDF")
            alpha = principled.inputs.get("Alpha") if principled else None
            if not alpha:
                continue
            for link in tuple(alpha.links):
                material.node_tree.links.remove(link)
            alpha.default_value = 1.0

    skin_material = basemesh.data.materials[0] if basemesh.data.materials else None
    if skin_material and skin_material.use_nodes:
        principled = skin_material.node_tree.nodes.get("Principled BSDF")
        if principled:
            principled.inputs["Roughness"].default_value = 0.50
            set_principled_input(principled, ("Subsurface Weight", "Subsurface"), 0.025)
            set_principled_input(principled, ("Coat Weight", "Clearcoat"), 0.0)

    eye = next((asset for asset in loaded_assets if "high-poly" in asset.name), None)
    if eye:
        for material in eye.data.materials:
            if not material.use_nodes:
                continue
            principled = material.node_tree.nodes.get("Principled BSDF")
            if principled:
                principled.inputs["Roughness"].default_value = 0.28
                set_principled_input(principled, ("Coat Weight", "Clearcoat"), 0.16)
                set_principled_input(principled, ("Coat Roughness", "Clearcoat Roughness"), 0.16)

    return loaded_assets


def set_material_color(
    obj: bpy.types.Object | None,
    rgba: tuple[float, float, float, float],
    *,
    roughness: float,
    metallic: float = 0.0,
) -> None:
    if not obj:
        return
    for material in obj.data.materials:
        material.diffuse_color = rgba
        if material.use_nodes:
            principled = material.node_tree.nodes.get("Principled BSDF")
            if principled:
                base_color = principled.inputs["Base Color"]
                for link in tuple(base_color.links):
                    material.node_tree.links.remove(link)
                base_color.default_value = rgba
                principled.inputs["Roughness"].default_value = roughness
                principled.inputs["Metallic"].default_value = metallic


def set_principled_input(
    principled: bpy.types.ShaderNode,
    names: tuple[str, ...],
    value: float,
) -> None:
    for name in names:
        socket = principled.inputs.get(name)
        if socket:
            socket.default_value = value
            return


def apply_brocade_material(robe: bpy.types.Object | None) -> None:
    """Use the generated seamless silk/brocade tile on the production robe."""
    if not robe:
        return
    if not BROCADE_PATH.exists():
        raise FileNotFoundError(BROCADE_PATH)

    image = bpy.data.images.load(str(BROCADE_PATH), check_existing=True)
    image.colorspace_settings.name = "sRGB"
    material = robe.data.materials[0] if robe.data.materials else None
    if not material:
        material = bpy.data.materials.new("GuofengBeauty_HanfuBrocade")
        robe.data.materials.append(material)
    material.name = "GuofengBeauty_HanfuBrocade"
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()

    output = nodes.new("ShaderNodeOutputMaterial")
    output.location = (480, 0)
    principled = nodes.new("ShaderNodeBsdfPrincipled")
    principled.location = (180, 0)
    texture = nodes.new("ShaderNodeTexImage")
    texture.location = (-220, 80)
    texture.image = image
    texture.extension = "REPEAT"
    texture.interpolation = "Linear"
    texcoord = nodes.new("ShaderNodeTexCoord")
    texcoord.location = (-620, 80)
    mapping = nodes.new("ShaderNodeMapping")
    mapping.location = (-420, 80)
    mapping.inputs["Scale"].default_value = (3.4, 3.4, 3.4)

    links.new(texcoord.outputs["UV"], mapping.inputs["Vector"])
    links.new(mapping.outputs["Vector"], texture.inputs["Vector"])
    links.new(texture.outputs["Color"], principled.inputs["Base Color"])
    links.new(principled.outputs["BSDF"], output.inputs["Surface"])
    principled.inputs["Roughness"].default_value = 0.46
    principled.inputs["Metallic"].default_value = 0.02
    set_principled_input(principled, ("Sheen Weight", "Sheen"), 0.18)
    set_principled_input(principled, ("Coat Weight", "Clearcoat"), 0.08)


def create_material(
    name: str,
    rgba: tuple[float, float, float, float],
    *,
    roughness: float,
    metallic: float = 0.0,
) -> bpy.types.Material:
    material = bpy.data.materials.new(name)
    material.diffuse_color = rgba
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = rgba
    principled.inputs["Roughness"].default_value = roughness
    principled.inputs["Metallic"].default_value = metallic
    if metallic > 0.1:
        set_principled_input(principled, ("Coat Weight", "Clearcoat"), 0.22)
    return material


def assign_material(obj: bpy.types.Object, material: bpy.types.Material) -> bpy.types.Object:
    obj.data.materials.clear()
    obj.data.materials.append(material)
    return obj


def cylinder_between(
    name: str,
    start: tuple[float, float, float],
    end: tuple[float, float, float],
    radius: float,
    material: bpy.types.Material,
) -> bpy.types.Object:
    start_vector = Vector(start)
    end_vector = Vector(end)
    direction = end_vector - start_vector
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=12,
        radius=radius,
        depth=direction.length,
        location=(start_vector + end_vector) * 0.5,
    )
    obj = bpy.context.object
    obj.name = name
    obj.rotation_euler = direction.to_track_quat("Z", "Y").to_euler()
    return assign_material(obj, material)


def flattened_sphere(
    name: str,
    location: tuple[float, float, float],
    scale: tuple[float, float, float],
    material: bpy.types.Material,
    *,
    rotation_y: float = 0.0,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=16,
        ring_count=8,
        location=location,
        rotation=(0.0, rotation_y, 0.0),
    )
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return assign_material(obj, material)


def polygon_panel(
    name: str,
    vertices: list[tuple[float, float, float]],
    material: bpy.types.Material,
) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    mesh.from_pydata(vertices, [], [tuple(range(len(vertices)))])
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return assign_material(obj, material)


def join_meshes(objects: list[bpy.types.Object], name: str) -> bpy.types.Object:
    if not objects:
        raise ValueError(f"Cannot join empty mesh group: {name}")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    objects[0].name = name
    return objects[0]


def parent_to_bone(obj: bpy.types.Object, rig: bpy.types.Object, bone_name: str) -> None:
    world_matrix = obj.matrix_world.copy()
    obj.parent = rig
    obj.parent_type = "BONE"
    obj.parent_bone = bone_name
    obj.matrix_world = world_matrix


def add_hanfu_layers_and_accessories(rig: bpy.types.Object) -> list[bpy.types.Object]:
    """Add a compact set of geometry details that survive the small terminal view."""
    gold = create_material(
        "GuofengBeauty_AntiqueGold",
        (0.62, 0.36, 0.055, 1.0),
        roughness=0.27,
        metallic=0.84,
    )
    jade = create_material(
        "GuofengBeauty_Jade",
        (0.008, 0.39, 0.31, 1.0),
        roughness=0.24,
        metallic=0.12,
    )
    # Hairpins, blossom and dangling jade earrings.  Objects are joined per
    # material to keep draw calls comfortably below the runtime budget.
    hair_gold_parts = [
        cylinder_between("Hairpin_Long", (-0.070, -0.123, 1.474), (0.086, -0.116, 1.505), 0.0022, gold),
        flattened_sphere("Blossom_Center", (0.042, -0.166, 1.500), (0.008, 0.0045, 0.008), gold),
    ]
    hair_jade_parts: list[bpy.types.Object] = []
    center = Vector((0.042, -0.166, 1.500))
    for index in range(5):
        angle = index * (2.0 * pi / 5.0) + radians(18.0)
        petal_location = center + Vector((cos(angle) * 0.0145, 0.0, sin(angle) * 0.0145))
        hair_jade_parts.append(
            flattened_sphere(
                f"Jade_Petal_{index}",
                tuple(petal_location),
                (0.0058, 0.0034, 0.0115),
                jade,
                rotation_y=(pi * 0.5) - angle,
            )
        )
    for side, x in (("L", 0.068), ("R", -0.068)):
        hair_gold_parts.extend(
            [
                cylinder_between(f"Earring_{side}_1", (x, -0.126, 1.360), (x * 1.06, -0.128, 1.330), 0.0009, gold),
                cylinder_between(f"Earring_{side}_2", (x * 1.06, -0.128, 1.330), (x * 1.08, -0.129, 1.305), 0.0008, gold),
            ]
        )
        hair_jade_parts.append(
            flattened_sphere(
                f"Earring_{side}_Jade",
                (x * 1.08, -0.132, 1.298),
                (0.0063, 0.0044, 0.0095),
                jade,
            )
        )

    hair_gold = join_meshes(hair_gold_parts, "GuofengBeauty_HairGold")
    hair_jade = join_meshes(hair_jade_parts, "GuofengBeauty_HairJade")
    parent_to_bone(hair_gold, rig, "Head")
    parent_to_bone(hair_jade, rig, "Head")
    return [hair_gold, hair_jade]


def add_temporary_hair_and_robe(basemesh: bpy.types.Object) -> list[bpy.types.Object]:
    hair = add_asset(
        basemesh,
        "hair",
        "Hair",
        "elvs_50s_updo.mhclo",
        subdiv_levels=1,
    )
    if not hair:
        hair = add_asset(basemesh, "hair", "Hair", "braid01.mhclo", "long01.mhclo")
    robe = add_asset(
        basemesh,
        "clothes",
        "Clothes",
        "mindfront_kimono.mhclo",
        "female_elegantsuit01.mhclo",
        subdiv_levels=1,
    )
    set_material_color(hair, (0.006, 0.009, 0.014, 1.0), roughness=0.42)
    apply_brocade_material(robe)
    return [asset for asset in (hair, robe) if asset is not None]


def descendants(root: bpy.types.Object) -> list[bpy.types.Object]:
    result: list[bpy.types.Object] = []
    stack = list(root.children)
    while stack:
        obj = stack.pop()
        result.append(obj)
        stack.extend(obj.children)
    return result


def apply_relaxed_rest_pose(rig: bpy.types.Object) -> None:
    """Turn the MakeHuman A pose into a narrow, portrait-friendly rest pose."""
    bpy.ops.object.select_all(action="DESELECT")
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="POSE")
    rotations = {
        "upperarm_l": radians(58.0),
        "upperarm_r": radians(-58.0),
        "lowerarm_l": radians(-18.0),
        "lowerarm_r": radians(18.0),
    }
    global_axis = Vector((0.0, 1.0, 0.0))
    for bone_name, angle in rotations.items():
        pose_bone = rig.pose.bones[bone_name]
        local_axis = pose_bone.bone.matrix_local.to_3x3().inverted() @ global_axis
        pose_bone.rotation_mode = "QUATERNION"
        pose_bone.rotation_quaternion = Quaternion(local_axis.normalized(), angle)
    bpy.context.view_layer.update()
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode="OBJECT")


def rename_contract_bones(rig: bpy.types.Object) -> None:
    mapping = {"head": "Head", "neck_01": "Neck", "spine_03": "Chest"}
    for old_name, new_name in mapping.items():
        if not rig.data.bones.get(old_name):
            raise RuntimeError(f"Missing required rig bone: {old_name}")
        if rig.data.bones.get(new_name):
            raise RuntimeError(f"Rig bone name already occupied: {new_name}")
        rig.data.bones[old_name].name = new_name

    for obj in descendants(rig):
        if obj.type == "MESH":
            for old_name, new_name in mapping.items():
                vertex_group = obj.vertex_groups.get(old_name)
                if vertex_group:
                    if obj.vertex_groups.get(new_name):
                        raise RuntimeError(f"{obj.name}: vertex group already occupied: {new_name}")
                    vertex_group.name = new_name
        if obj.parent is rig and obj.parent_type == "BONE" and obj.parent_bone in mapping:
            obj.parent_bone = mapping[obj.parent_bone]

    for bone_name in mapping.values():
        if not rig.pose.bones.get(bone_name):
            raise RuntimeError(f"Renamed pose bone missing: {bone_name}")


def reset_pose(rig: bpy.types.Object) -> None:
    for pose_bone in rig.pose.bones:
        pose_bone.rotation_mode = "XYZ"
        pose_bone.rotation_euler = (0.0, 0.0, 0.0)
        pose_bone.location = (0.0, 0.0, 0.0)
        pose_bone.scale = (1.0, 1.0, 1.0)


def key_rotation(
    rig: bpy.types.Object,
    bone_name: str,
    frame: int,
    rotation: tuple[float, float, float],
) -> None:
    pose_bone = rig.pose.bones[bone_name]
    pose_bone.rotation_mode = "XYZ"
    pose_bone.rotation_euler = rotation
    pose_bone.keyframe_insert(data_path="rotation_euler", frame=frame, group=bone_name)


def make_clip(
    rig: bpy.types.Object,
    name: str,
    poses: list[tuple[int, dict[str, tuple[float, float, float]]]],
    *,
    end_frame: int = 72,
) -> None:
    action = bpy.data.actions.new(name)
    rig.animation_data_create()
    rig.animation_data.action = action
    for frame, values in poses:
        reset_pose(rig)
        for bone_name, rotation in values.items():
            key_rotation(rig, bone_name, frame, rotation)

    # Blender 5 actions created through the legacy assignment API still expose
    # fcurves; keep a compatibility guard for future layered-only actions.
    for fcurve in getattr(action, "fcurves", []):
        for point in fcurve.keyframe_points:
            point.interpolation = "BEZIER"
    action.use_frame_range = True
    action.frame_start = 1
    action.frame_end = end_frame

    track = rig.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 1, action)
    strip.action_frame_start = 1
    strip.action_frame_end = end_frame
    track.mute = True
    rig.animation_data.action = None


def add_contract_clips(rig: bpy.types.Object) -> None:
    clips = {
        "idle": [
            (1, {"Chest": (0.0, 0.0, 0.0), "Head": (0.0, 0.0, 0.0)}),
            (36, {"Chest": (radians(0.8), 0.0, 0.0), "Head": (radians(-0.45), 0.0, 0.0)}),
            (72, {"Chest": (0.0, 0.0, 0.0), "Head": (0.0, 0.0, 0.0)}),
        ],
        "thinking": [
            (1, {"Head": (0.0, 0.0, 0.0)}),
            (36, {"Head": (radians(-2.6), radians(7.0), radians(-3.4))}),
            (72, {"Head": (0.0, 0.0, 0.0)}),
        ],
        "success": [
            (1, {"Head": (0.0, 0.0, 0.0)}),
            (20, {"Head": (radians(5.0), 0.0, 0.0)}),
            (42, {"Head": (radians(-2.0), 0.0, 0.0)}),
            (72, {"Head": (0.0, 0.0, 0.0)}),
        ],
        "error": [
            (1, {"Head": (0.0, 0.0, 0.0)}),
            (22, {"Head": (0.0, 0.0, radians(5.5))}),
            (44, {"Head": (0.0, 0.0, radians(-5.5))}),
            (72, {"Head": (0.0, 0.0, 0.0)}),
        ],
        "greeting": [
            (1, {"Head": (0.0, 0.0, 0.0), "lowerarm_r": (0.0, 0.0, 0.0)}),
            (36, {"Head": (radians(3.0), 0.0, 0.0), "lowerarm_r": (radians(-12.0), 0.0, radians(8.0))}),
            (72, {"Head": (0.0, 0.0, 0.0), "lowerarm_r": (0.0, 0.0, 0.0)}),
        ],
        "rest": [
            (1, {"Chest": (0.0, 0.0, 0.0), "Head": (0.0, 0.0, 0.0)}),
            (36, {"Chest": (radians(0.4), 0.0, 0.0), "Head": (radians(-0.8), 0.0, radians(0.7))}),
            (72, {"Chest": (0.0, 0.0, 0.0), "Head": (0.0, 0.0, 0.0)}),
        ],
    }
    for name, poses in clips.items():
        make_clip(rig, name, poses)

    actual = {track.name for track in rig.animation_data.nla_tracks}
    if actual != set(clips):
        raise RuntimeError(f"Unexpected NLA clip set: {sorted(actual)}")
    reset_pose(rig)


def bake_export_masks(basemesh: bpy.types.Object) -> None:
    """Bake helper/clothing masks while retaining the nine runtime morphs."""
    mask_names = [modifier.name for modifier in basemesh.modifiers if modifier.type == "MASK"]
    if not mask_names:
        return
    ExportService._apply_modifiers_keep_shapekeys(basemesh, mask_names)
    for modifier in tuple(basemesh.modifiers):
        if modifier.type == "MASK":
            basemesh.modifiers.remove(modifier)


def export_glb(rig: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    rig.select_set(True)
    for obj in descendants(rig):
        if obj.type in {"MESH", "ARMATURE"} and not obj.hide_render:
            obj.select_set(True)
    bpy.context.view_layer.objects.active = rig
    GLB_PATH.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(GLB_PATH),
        export_format="GLB",
        use_selection=True,
        export_apply=False,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_nla_strips=True,
        export_anim_slide_to_zero=True,
        export_skins=True,
        export_morph=True,
        export_morph_normal=False,
        export_morph_tangent=False,
        export_try_sparse_sk=True,
        export_cameras=False,
        export_lights=False,
        export_yup=True,
    )
    if not GLB_PATH.exists() or GLB_PATH.stat().st_size == 0:
        raise RuntimeError(f"GLB export failed: {GLB_PATH}")


def verify_glb_json() -> dict:
    raw = GLB_PATH.read_bytes()
    magic, version, _ = struct.unpack_from("<4sII", raw, 0)
    if (magic, version) != (b"glTF", 2):
        raise RuntimeError("Exported model is not glTF 2.0")
    chunk_length, chunk_type = struct.unpack_from("<I4s", raw, 12)
    if chunk_type != b"JSON":
        raise RuntimeError("GLB does not begin with a JSON chunk")
    data = json.loads(raw[20 : 20 + chunk_length].decode().rstrip(" \t\r\n\0"))
    node_names = {node.get("name") for node in data.get("nodes", [])}
    clip_names = {animation.get("name") for animation in data.get("animations", [])}
    shape_names: set[str] = set()
    for mesh in data.get("meshes", []):
        shape_names.update(mesh.get("extras", {}).get("targetNames", []))

    required_bones = {"Head", "Neck", "Chest"}
    required_shapes = {
        "blinkLeft",
        "blinkRight",
        "smile",
        "frown",
        "visemeA",
        "visemeI",
        "visemeU",
        "visemeE",
        "visemeO",
    }
    required_clips = {"idle", "thinking", "success", "error", "greeting", "rest"}
    for label, required, actual in (
        ("bones", required_bones, node_names),
        ("shapes", required_shapes, shape_names),
        ("clips", required_clips, clip_names),
    ):
        missing = required - actual
        if missing:
            raise RuntimeError(f"GLB missing required {label}: {sorted(missing)}")

    print(
        "[guofeng-3d] GLB contract:",
        json.dumps(
            {
                "bytes": GLB_PATH.stat().st_size,
                "nodes": len(data.get("nodes", [])),
                "meshes": len(data.get("meshes", [])),
                "materials": len(data.get("materials", [])),
                "animations": sorted(clip_names),
                "shapes": sorted(shape_names),
            },
            ensure_ascii=False,
        ),
    )
    return data


def evaluated_bounds(objects: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    bpy.context.view_layer.update()
    points: list[Vector] = []
    for obj in objects:
        if obj.type != "MESH" or obj.hide_render:
            continue
        points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    return (
        Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points))),
        Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points))),
    )


def look_at(obj: bpy.types.Object, target: Vector) -> None:
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def setup_render(objects: list[bpy.types.Object]) -> None:
    scene = bpy.context.scene
    # Blender 5.x exposes Eevee as BLENDER_EEVEE (4.x used the Eevee Next
    # marketing name while keeping a different Python enum in some releases).
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1024
    scene.render.resolution_y = 1024
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.render.filepath = str(PREVIEW_PATH)
    scene.render.image_settings.color_mode = "RGB"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.render.fps = 30

    bounds_min, bounds_max = evaluated_bounds(objects)
    print(f"[guofeng-3d] render bounds: {tuple(bounds_min)} -> {tuple(bounds_max)}")
    face_target = Vector((0.0, -0.045, bounds_max.z - 0.32))

    camera_data = bpy.data.cameras.new("GuofengBeauty_Camera")
    camera = bpy.data.objects.new("GuofengBeauty_Camera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera_data.type = "PERSP"
    camera_data.lens = 82
    camera_data.sensor_width = 36
    camera.location = Vector((0.12, -1.70, face_target.z + 0.02))
    look_at(camera, face_target)
    scene.camera = camera

    world = bpy.data.worlds.new("GuofengBeauty_World") if not scene.world else scene.world
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.006, 0.018, 0.028, 1.0)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.18

    lights = (
        ("Key", "AREA", (-1.15, -1.45, face_target.z + 0.48), (1.0, 0.83, 0.74), 62.0, 2.8),
        ("Fill", "AREA", (1.20, -0.75, face_target.z + 0.10), (0.30, 0.56, 0.76), 28.0, 2.4),
        ("Rim", "AREA", (0.95, 0.72, face_target.z + 0.48), (0.12, 0.62, 0.58), 42.0, 1.25),
        ("FaceSoft", "AREA", (-0.10, -1.12, face_target.z + 0.06), (1.0, 0.89, 0.82), 20.0, 1.2),
    )
    for name, light_type, location, color, energy, size in lights:
        data = bpy.data.lights.new(name, light_type)
        data.energy = energy
        data.color = color
        data.shape = "DISK"
        data.size = size
        light = bpy.data.objects.new(name, data)
        bpy.context.collection.objects.link(light)
        light.location = location
        look_at(light, face_target)


def main() -> None:
    bpy.context.preferences.filepaths.save_version = 0
    clear_scene()
    basemesh = create_face()
    bake_identity_to_basis(basemesh)
    add_expression_morphs(basemesh)
    rig = HumanService.add_builtin_rig(basemesh, "game_engine")
    rig.name = "GuofengBeauty_Rig"
    objects = [basemesh]
    objects.extend(add_skin_and_features(basemesh))
    objects.extend(add_temporary_hair_and_robe(basemesh))

    apply_relaxed_rest_pose(rig)
    rename_contract_bones(rig)
    objects.extend(add_hanfu_layers_and_accessories(rig))
    add_contract_clips(rig)

    subdivision = basemesh.modifiers.new("Production subdivision", "SUBSURF")
    subdivision.levels = 1
    subdivision.render_levels = 2

    setup_render(objects)
    bake_export_masks(basemesh)
    export_glb(rig)
    verify_glb_json()
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH))
    bpy.ops.render.render(write_still=True)
    print(f"[guofeng-3d] blend: {BLEND_PATH}")
    print(f"[guofeng-3d] preview: {PREVIEW_PATH}")
    print(f"[guofeng-3d] glb: {GLB_PATH}")


if __name__ == "__main__":
    main()
