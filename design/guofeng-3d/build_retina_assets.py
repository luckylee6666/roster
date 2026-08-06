#!/usr/bin/env python3
"""Build pixel-aligned Retina runtime assets from the 1586x992 art sources.

The idle background remains a full 3584x2240 image. Animation frames are first
scaled onto that same canvas and are then cropped into feathered RGBA patches.
Cropping *after* the common scale/filter pass keeps every visible source pixel
aligned with the idle background while avoiding four additional full-canvas
textures at runtime.
"""

from __future__ import annotations

import argparse
import struct
import subprocess
from dataclasses import dataclass
from math import ceil, floor, hypot
from pathlib import Path
from typing import Literal

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIR = Path(__file__).resolve().parent / "source-frames"
ASSET_DIR = ROOT / "src/assets"
METADATA_PATH = ROOT / "src/terminal-theme-character-patch-metadata.js"
SOURCE_WIDTH = 1586
SOURCE_HEIGHT = 992
OUTPUT_WIDTH = 3584
OUTPUT_HEIGHT = 2240

# Keep these normalized coordinates in sync with the original production masks
# in terminal-theme-character-utils.js. The generated metadata below becomes the
# runtime source of truth after the patches have been built.
FEATURE_ELLIPSES = {
    "eyeLeft": (0.761, 0.249, 0.016, 0.0095),
    "eyeRight": (0.795, 0.250, 0.016, 0.0095),
    "mouth": (0.769, 0.319, 0.017, 0.008),
    "typingHands": (0.646, 0.770, 0.150, 0.120),
}

# This reproduces the existing CSS scene reveal:
# transparent through 38%, 66% opacity at 52%, and opaque from 63% onward.
CODING_FEATHER_STOPS = ((0.38, 0.0), (0.52, 0.66), (0.63, 1.0))
FULL_FRAME_ASSETS = (
    ("term-bg-guofeng-beauty.png", "term-bg-guofeng-beauty-retina.png"),
)


@dataclass(frozen=True)
class Crop:
    x: int
    y: int
    width: int
    height: int


@dataclass(frozen=True)
class PatchSpec:
    key: str
    source_name: str
    output_name: str
    mask_kind: Literal["ellipses", "right-feather"]
    features: tuple[str, ...] = ()


PATCH_SPECS = (
    PatchSpec(
        key="blink",
        source_name="term-character-guofeng-beauty-blink.png",
        output_name="term-character-guofeng-beauty-blink-patch-retina.png",
        mask_kind="ellipses",
        features=("eyeLeft", "eyeRight"),
    ),
    PatchSpec(
        key="smile",
        source_name="term-character-guofeng-beauty-smile.png",
        output_name="term-character-guofeng-beauty-smile-patch-retina.png",
        mask_kind="ellipses",
        features=("mouth",),
    ),
    PatchSpec(
        key="codingScene",
        source_name="term-bg-guofeng-beauty-coding-a.png",
        output_name="term-bg-guofeng-beauty-coding-a-right-patch-retina.png",
        mask_kind="right-feather",
    ),
    PatchSpec(
        key="typingHands",
        source_name="term-bg-guofeng-beauty-coding-b.png",
        output_name="term-bg-guofeng-beauty-coding-b-hands-patch-retina.png",
        mask_kind="ellipses",
        features=("typingHands",),
    ),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--compression-level", type=int, default=6)
    return parser.parse_args()


def png_size(path: Path) -> tuple[int, int]:
    header = path.read_bytes()[:24]
    if len(header) != 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path} is not a PNG")
    return struct.unpack(">II", header[16:24])


def validate_source(path: Path) -> None:
    size = png_size(path)
    if size != (SOURCE_WIDTH, SOURCE_HEIGHT):
        raise ValueError(
            f"{path.name} must be {SOURCE_WIDTH}x{SOURCE_HEIGHT}, got {size}"
        )


def retina_filter() -> str:
    return (
        f"scale={OUTPUT_WIDTH}:{OUTPUT_HEIGHT}:"
        "flags=lanczos+accurate_rnd+full_chroma_int,"
        "cas=strength=0.55,unsharp=5:5:0.28:5:5:0.0"
    )


def render_retina_source(
    source: Path,
    output: Path,
    *,
    ffmpeg: str,
    compression_level: int,
) -> None:
    validate_source(source)
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-vf",
        retina_filter(),
        "-frames:v",
        "1",
        "-compression_level",
        str(compression_level),
        str(output),
    ]
    subprocess.run(command, check=True)
    if png_size(output) != (OUTPUT_WIDTH, OUTPUT_HEIGHT):
        raise ValueError(
            f"{output} must be {OUTPUT_WIDTH}x{OUTPUT_HEIGHT}, got {png_size(output)}"
        )


def ellipse_crop(features: tuple[str, ...]) -> Crop:
    ellipses = [FEATURE_ELLIPSES[name] for name in features]
    left = floor(min((x - radius_x) * OUTPUT_WIDTH for x, _, radius_x, _ in ellipses))
    top = floor(min((y - radius_y) * OUTPUT_HEIGHT for _, y, _, radius_y in ellipses))
    right = ceil(max((x + radius_x) * OUTPUT_WIDTH for x, _, radius_x, _ in ellipses))
    bottom = ceil(max((y + radius_y) * OUTPUT_HEIGHT for _, y, _, radius_y in ellipses))
    return Crop(left, top, right - left, bottom - top)


def patch_crop(spec: PatchSpec) -> Crop:
    if spec.mask_kind == "ellipses":
        return ellipse_crop(spec.features)
    left = floor(CODING_FEATHER_STOPS[0][0] * OUTPUT_WIDTH)
    return Crop(left, 0, OUTPUT_WIDTH - left, OUTPUT_HEIGHT)


def feature_alpha(distance: float) -> int:
    """Match the existing radial CSS feather with an intrinsic alpha mask."""
    if distance <= 0.34:
        opacity = 1.0
    elif distance <= 0.54:
        progress = (distance - 0.34) / (0.54 - 0.34)
        opacity = 1.0 + (0.78 - 1.0) * progress
    elif distance < 1.0:
        progress = (distance - 0.54) / (1.0 - 0.54)
        opacity = 0.78 * (1.0 - progress)
    else:
        opacity = 0.0
    return round(opacity * 255)


def build_ellipse_mask(crop: Crop, features: tuple[str, ...]) -> Image.Image:
    ellipses = [
        (
            x * OUTPUT_WIDTH,
            y * OUTPUT_HEIGHT,
            radius_x * OUTPUT_WIDTH,
            radius_y * OUTPUT_HEIGHT,
        )
        for x, y, radius_x, radius_y in (FEATURE_ELLIPSES[name] for name in features)
    ]
    mask = Image.new("L", (crop.width, crop.height), 0)
    pixels = mask.load()
    for local_y in range(crop.height):
        canvas_y = crop.y + local_y + 0.5
        for local_x in range(crop.width):
            canvas_x = crop.x + local_x + 0.5
            distance = min(
                hypot((canvas_x - center_x) / radius_x, (canvas_y - center_y) / radius_y)
                for center_x, center_y, radius_x, radius_y in ellipses
            )
            pixels[local_x, local_y] = feature_alpha(distance)
    return mask


def interpolate_stops(position: float, stops: tuple[tuple[float, float], ...]) -> float:
    if position <= stops[0][0]:
        return stops[0][1]
    for (start_x, start_value), (end_x, end_value) in zip(stops, stops[1:]):
        if position <= end_x:
            progress = (position - start_x) / (end_x - start_x)
            return start_value + (end_value - start_value) * progress
    return stops[-1][1]


def build_right_feather_mask(crop: Crop) -> Image.Image:
    row = [
        round(
            interpolate_stops(
                (crop.x + local_x + 0.5) / OUTPUT_WIDTH,
                CODING_FEATHER_STOPS,
            )
            * 255
        )
        for local_x in range(crop.width)
    ]
    mask_row = Image.new("L", (crop.width, 1))
    mask_row.putdata(row)
    return mask_row.resize((crop.width, crop.height))


def write_patch(
    source: Path,
    output: Path,
    spec: PatchSpec,
    crop: Crop,
    *,
    ffmpeg: str,
    compression_level: int,
) -> None:
    temporary_retina = output.with_suffix(".full-building.png")
    temporary_patch = output.with_suffix(".building.png")
    try:
        render_retina_source(
            source,
            temporary_retina,
            ffmpeg=ffmpeg,
            compression_level=compression_level,
        )
        with Image.open(temporary_retina) as retina:
            patch = retina.crop(
                (crop.x, crop.y, crop.x + crop.width, crop.y + crop.height)
            ).convert("RGBA")
        if spec.mask_kind == "ellipses":
            alpha = build_ellipse_mask(crop, spec.features)
        else:
            alpha = build_right_feather_mask(crop)
        if alpha.getextrema() != (0, 255):
            raise ValueError(f"{spec.key} patch must contain transparent and opaque pixels")
        patch.putalpha(alpha)
        patch.save(temporary_patch, format="PNG", compress_level=compression_level)
        if png_size(temporary_patch) != (crop.width, crop.height):
            raise ValueError(
                f"{temporary_patch} must be {crop.width}x{crop.height}, "
                f"got {png_size(temporary_patch)}"
            )
        temporary_patch.replace(output)
    finally:
        temporary_retina.unlink(missing_ok=True)
        temporary_patch.unlink(missing_ok=True)


def metadata_source(crops: dict[str, Crop]) -> str:
    lines = [
        "// Generated by design/guofeng-3d/build_retina_assets.py. Do not edit.",
        "export const CHARACTER_PATCH_CANVAS_SIZE = Object.freeze({ width: 3584, height: 2240 });",
        "",
        "export const CHARACTER_PATCHES = Object.freeze({",
    ]
    for spec in PATCH_SPECS:
        crop = crops[spec.key]
        lines.extend(
            [
                f"  {spec.key}: Object.freeze({{",
                f"    file: '{spec.output_name}',",
                f"    url: new URL('./assets/{spec.output_name}', import.meta.url).href,",
                "    crop: Object.freeze({ "
                f"x: {crop.x}, y: {crop.y}, width: {crop.width}, height: {crop.height} "
                "}),",
                "  }),",
            ]
        )
    lines.extend(["});", ""])
    return "\n".join(lines)


def write_metadata(crops: dict[str, Crop]) -> None:
    temporary = METADATA_PATH.with_suffix(".building.js")
    try:
        temporary.write_text(metadata_source(crops), encoding="utf-8")
        temporary.replace(METADATA_PATH)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    args = parse_args()
    if not 0 <= args.compression_level <= 9:
        raise ValueError("--compression-level must be between 0 and 9")

    for source_name, output_name in FULL_FRAME_ASSETS:
        source = SOURCE_DIR / source_name
        output = ASSET_DIR / output_name
        temporary_output = output.with_suffix(".building.png")
        try:
            render_retina_source(
                source,
                temporary_output,
                ffmpeg=args.ffmpeg,
                compression_level=args.compression_level,
            )
            temporary_output.replace(output)
        finally:
            temporary_output.unlink(missing_ok=True)
        print(f"wrote {output}", flush=True)

    crops: dict[str, Crop] = {}
    for spec in PATCH_SPECS:
        source = SOURCE_DIR / spec.source_name
        output = ASSET_DIR / spec.output_name
        crop = patch_crop(spec)
        crops[spec.key] = crop
        write_patch(
            source,
            output,
            spec,
            crop,
            ffmpeg=args.ffmpeg,
            compression_level=args.compression_level,
        )
        print(
            f"wrote {output} ({crop.width}x{crop.height} at {crop.x},{crop.y})",
            flush=True,
        )

    write_metadata(crops)
    print(f"wrote {METADATA_PATH}", flush=True)


if __name__ == "__main__":
    main()
