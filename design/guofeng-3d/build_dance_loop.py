#!/usr/bin/env python3
"""Rebuild the retired guofeng dance experiment for offline review."""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image
from rife_mlx.config import DEFAULT_VERSION
from rife_mlx.pipeline_mlx import interpolate_pair
from rife_mlx.utils.weights import build_model


FRAME_DIR = Path(__file__).with_name("dance-frames")
SEQUENCE_FILE = FRAME_DIR / "sequence.txt"
DEFAULT_OUTPUT = Path(__file__).with_name("previews") / "dance-loop-retina.mp4"
FPS = 60
SOURCE_WIDTH = 1586
SOURCE_HEIGHT = 992
OUTPUT_WIDTH = 3584
OUTPUT_HEIGHT = 2240
TOTAL_FRAMES = 480

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--crf", type=int, default=17)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    return parser.parse_args()


def load_timeline() -> tuple[tuple[int, str], ...]:
    """Read the reviewed frame timeline so documentation and the build cannot drift."""
    timeline: list[tuple[int, str]] = []
    for line_number, raw_line in enumerate(SEQUENCE_FILE.read_text().splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) != 3:
            raise ValueError(f"{SEQUENCE_FILE}:{line_number} must contain frame, seconds and file")
        frame_text, seconds_text, name = parts
        frame_number = int(frame_text)
        seconds = float(seconds_text)
        if abs(seconds - frame_number / FPS) > 0.001:
            raise ValueError(f"{SEQUENCE_FILE}:{line_number} frame and seconds disagree")
        if timeline and frame_number <= timeline[-1][0]:
            raise ValueError(f"{SEQUENCE_FILE}:{line_number} frame numbers must increase")
        timeline.append((frame_number, name))
    if not timeline or timeline[0][0] != 0 or timeline[-1][0] != TOTAL_FRAMES:
        raise ValueError(f"{SEQUENCE_FILE} must cover frames 0 through {TOTAL_FRAMES}")
    return tuple(timeline)


def load_frames(timeline: tuple[tuple[int, str], ...]) -> dict[str, np.ndarray]:
    loaded: dict[str, np.ndarray] = {}
    for _, name in timeline:
        if name in loaded:
            continue
        image = Image.open(FRAME_DIR / name).convert("RGB")
        if image.size != (SOURCE_WIDTH, SOURCE_HEIGHT):
            raise ValueError(
                f"{name} must be {SOURCE_WIDTH}x{SOURCE_HEIGHT}, got {image.size}"
            )
        loaded[name] = np.asarray(image)
    return loaded


def segment_progress(left_name: str, right_name: str, progress: float) -> float:
    """Add weight-transfer easing only at the two deep sway poses and loop rest."""
    if left_name.endswith("dance-a.png"):
        return progress * progress
    if right_name.endswith("dance-body-left.png") or right_name.endswith("dance-body-right.png"):
        return 1.0 - (1.0 - progress) ** 2
    if left_name.endswith("dance-body-left.png") or left_name.endswith("dance-body-right.png"):
        return progress * progress
    if right_name.endswith("dance-a.png"):
        return 1.0 - (1.0 - progress) ** 2
    return progress


def frame_at(
    model: object,
    loaded: dict[str, np.ndarray],
    timeline: tuple[tuple[int, str], ...],
    frame_number: int,
) -> np.ndarray:
    for (left_frame, left_name), (right_frame, right_name) in zip(timeline, timeline[1:]):
        if frame_number > right_frame:
            continue
        if frame_number == left_frame:
            return loaded[left_name]
        if frame_number == right_frame:
            return loaded[right_name]
        progress = (frame_number - left_frame) / (right_frame - left_frame)
        progress = segment_progress(left_name, right_name, progress)
        return interpolate_pair(model, loaded[left_name], loaded[right_name], progress)
    raise ValueError(f"frame {frame_number} is outside the timeline")


def main() -> None:
    args = parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = args.output.with_suffix(".building.mp4")
    command = [
        args.ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgb24",
        "-video_size",
        f"{SOURCE_WIDTH}x{SOURCE_HEIGHT}",
        "-framerate",
        str(FPS),
        "-i",
        "-",
        "-an",
        "-vf",
        (
            f"scale={OUTPUT_WIDTH}:{OUTPUT_HEIGHT}:"
            "flags=lanczos+accurate_rnd+full_chroma_int,"
            "cas=strength=0.65,unsharp=5:5:0.40:5:5:0.0"
        ),
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-profile:v",
        "high",
        "-level:v",
        "5.2",
        "-crf",
        str(args.crf),
        "-pix_fmt",
        "yuv420p",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-colorspace",
        "bt709",
        "-movflags",
        "+faststart",
        str(temporary_output),
    ]

    timeline = load_timeline()
    loaded = load_frames(timeline)
    model = build_model(DEFAULT_VERSION)
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    assert process.stdin is not None
    try:
        for frame_number in range(TOTAL_FRAMES):
            frame = frame_at(model, loaded, timeline, frame_number)
            process.stdin.write(np.ascontiguousarray(frame).tobytes())
            if (frame_number + 1) % FPS == 0:
                print(f"rendered {(frame_number + 1) // FPS}/8 seconds", flush=True)
        process.stdin.close()
        stderr = process.stderr.read().decode("utf-8", errors="replace") if process.stderr else ""
        return_code = process.wait()
    except BaseException:
        process.kill()
        temporary_output.unlink(missing_ok=True)
        raise
    if return_code:
        temporary_output.unlink(missing_ok=True)
        raise RuntimeError(stderr.strip() or f"ffmpeg exited with {return_code}")
    temporary_output.replace(args.output)
    print(f"wrote {args.output}", flush=True)


if __name__ == "__main__":
    main()
