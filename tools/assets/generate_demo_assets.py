#!/usr/bin/env python3
"""Generate reproducible, fictional look-alike demo media for the portfolio.

The owner's original brand media and the legacy display font are deliberately
not part of this repository. This script builds small stand-ins with the same
roles (alpha logo, green-screen logo, outros, particles, overlays, transitions
and SFX) for the fictional brand "Demo Sports News".

Requirements: ffmpeg/ffprobe, woff2_compress and Python Pillow for stills.
Outputs are copied to examples/brand/ (canonical) and to the runtime asset
folders used by the panel and the renderer. Video/audio metadata is stripped.
"""

from __future__ import annotations

import math
import random
import shutil
import struct
import subprocess
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / "examples" / "brand"
BRAND_SFX = BRAND / "sfx"
BRAND_FONTS = BRAND / "fonts"
RENDERER_OVERLAYS = ROOT / "services" / "renderer" / "assets" / "overlays"
RENDERER_PUBLIC = ROOT / "services" / "renderer" / "public"
PANEL_ASSETS = ROOT / "apps" / "panel" / "assets"
PANEL_BOUNDARY = PANEL_ASSETS / "boundary-transitions"
SOURCE_FONT = ROOT / "services" / "subtitles" / "assets" / "fonts" / "subtitles" / "Anton-Regular.ttf"

DISPLAY_FONT = "Demo Sports News Display"
BRAND_TEXT = "DEMO SPORTS NEWS"


def run(args: list[str]) -> None:
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(f"command failed: {' '.join(args)}\n{result.stderr[-1500:]}")


def ffmpeg(*args: str) -> None:
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args])


def ensure_dirs() -> None:
    for path in (BRAND, BRAND_SFX, BRAND_FONTS, RENDERER_OVERLAYS, RENDERER_PUBLIC,
                 RENDERER_PUBLIC / "fonts" / "versa", RENDERER_PUBLIC / "sfx",
                 PANEL_ASSETS / "fonts" / "versa", PANEL_ASSETS / "sfx", PANEL_BOUNDARY):
        path.mkdir(parents=True, exist_ok=True)


def make_wav(path: Path, kind: str, seconds: float, sample_rate: int = 48000) -> None:
    frames = int(seconds * sample_rate)
    rng = random.Random(hash(kind) & 0xFFFF)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(sample_rate)
        data = bytearray()
        for i in range(frames):
            t = i / sample_rate
            norm = t / seconds
            if kind == "whip":
                env = math.sin(math.pi * min(1.0, norm * 1.6)) * (1.0 - norm) ** 1.4
                sample = (rng.uniform(-1, 1) * 0.5 + math.sin(2 * math.pi * (1100 - 700 * norm) * t)) * env
            elif kind == "whoosh":
                env = math.sin(math.pi * norm) ** 1.7
                sample = (rng.uniform(-1, 1) * 0.7 + math.sin(2 * math.pi * (180 + 240 * norm) * t)) * env
            else:
                env = math.exp(-4.5 * norm)
                sample = (math.sin(2 * math.pi * 523.25 * t) + 0.5 * math.sin(2 * math.pi * 783.99 * t)) * env * 0.5
            data += struct.pack("<h", int(max(-1.0, min(1.0, sample)) * 32767))
        out.writeframes(bytes(data))


def make_display_font() -> None:
    if not SOURCE_FONT.is_file():
        raise SystemExit(f"missing OFL source font: {SOURCE_FONT}")
    temp_ttf = BRAND_FONTS / "Demo-Display.ttf"
    shutil.copyfile(SOURCE_FONT, temp_ttf)
    run(["woff2_compress", str(temp_ttf)])
    generated = BRAND_FONTS / "Demo-Display.woff2"
    for target in (RENDERER_PUBLIC / "fonts" / "versa", PANEL_ASSETS / "fonts" / "versa"):
        shutil.copyfile(generated, target / "Demo-Display.woff2")
    temp_ttf.unlink(missing_ok=True)


def make_logo_png(path: Path, transparent: bool = True) -> None:
    from PIL import Image, ImageDraw, ImageFont

    size = (1280, 720)
    image = Image.new("RGBA", size, (0, 0, 0, 0) if transparent else (0, 177, 64, 255))
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(str(SOURCE_FONT), 96)
    small = ImageFont.truetype(str(SOURCE_FONT), 34)
    text = BRAND_TEXT
    box = draw.textbbox((0, 0), text, font=font)
    draw.text(((size[0] - (box[2] - box[0])) / 2, 280), text, fill=(255, 255, 255, 255), font=font)
    sub = "LOCAL DEMO / CC0"
    sub_box = draw.textbbox((0, 0), sub, font=small)
    draw.text(((size[0] - (sub_box[2] - sub_box[0])) / 2, 410), sub, fill=(255, 209, 102, 255), font=small)
    draw.rectangle([60, 60, size[0] - 60, size[1] - 60], outline=(255, 255, 255, 180), width=6)
    image.save(path)


def make_logo_video(out: Path, green: bool, duration: float = 2.0) -> None:
    color = "0x00b140" if green else "0x0b0f14"
    base = f"color=c={color}:s=1920x1080:d={duration}:r=30"
    draw = (
        f"drawtext=fontfile='{SOURCE_FONT}':text='{BRAND_TEXT}':fontcolor=white:"
        "fontsize=104:x=(w-text_w)/2:y=(h-text_h)/2-30,"
        "drawtext=fontfile='"
        f"{SOURCE_FONT}':text='LOCAL DEMO':fontcolor=0xffd166:fontsize=36:"
        "x=(w-text_w)/2:y=(h-text_h)/2+80,"
        "fade=t=in:st=0:d=0.25,fade=t=out:st=1.55:d=0.45,format=yuv420p"
    )
    if green:
        ffmpeg("-f", "lavfi", "-i", base, "-vf", draw, "-t", str(duration), "-r", "30",
               "-c:v", "libx264", "-crf", "30", "-preset", "veryfast", "-pix_fmt", "yuv420p",
               "-movflags", "+faststart", "-map_metadata", "-1", str(out))
    else:
        ffmpeg("-f", "lavfi", "-i", base, "-vf", draw.replace("format=yuv420p", "format=rgba"),
               "-t", str(duration), "-r", "30", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
               "-crf", "34", "-b:v", "0", "-auto-alt-ref", "0", "-map_metadata", "-1", str(out))


def make_outro(mp4: Path, webm: Path, duration: float, heading: str) -> None:
    base = f"color=c=0x0b0f14:s=1920x1080:d={duration}:r=30"
    draw = (
        f"drawtext=fontfile='{SOURCE_FONT}':text='{heading}':fontcolor=white:"
        "fontsize=120:x=(w-text_w)/2:y=(h-text_h)/2-90,"
        "drawtext=fontfile='"
        f"{SOURCE_FONT}':text='{BRAND_TEXT}':fontcolor=0xffd166:fontsize=52:"
        "x=(w-text_w)/2:y=(h-text_h)/2+60,"
        "drawbox=x=0:y=ih-14:w=iw:h=14:color=0xffd166@0.85:t=fill,"
        "fade=t=in:st=0:d=0.4,fade=t=out:st=" + f"{max(0.0, duration - 0.6):.2f}" + ":d=0.6,format=yuv420p"
    )
    ffmpeg("-f", "lavfi", "-i", base, "-vf", draw, "-t", str(duration), "-r", "30",
           "-c:v", "libx264", "-crf", "33", "-preset", "veryfast", "-pix_fmt", "yuv420p",
           "-movflags", "+faststart", "-map_metadata", "-1", str(mp4))
    ffmpeg("-f", "lavfi", "-i", base, "-vf", draw, "-t", str(duration), "-r", "30",
           "-c:v", "libvpx-vp9", "-crf", "42", "-b:v", "0", "-pix_fmt", "yuv420p",
           "-map_metadata", "-1", str(webm))


def make_particles(out: Path, seed: int, duration: float = 3.0) -> None:
    rng = random.Random(seed)
    noise = rng.randint(30, 70)
    ffmpeg("-f", "lavfi", "-i", f"color=c=black:s=1280x720:d={duration}:r=30,format=rgba",
           "-vf", f"noise=alls={noise}:allf=t+u,colorchannelmixer=aa=0.45,format=yuva420p",
           "-t", str(duration), "-r", "30", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
           "-crf", "40", "-b:v", "0", "-auto-alt-ref", "0", "-map_metadata", "-1", str(out))


def make_overlay(out: Path, hue: int, duration: float = 2.0) -> None:
    src = f"gradients=s=1280x720:d={duration}:r=30:c0=0x{hue:06x}:c1=0x000000:c2=0xffffff:x0=0:y0=0:x1=1280:y1=720"
    ffmpeg("-f", "lavfi", "-i", src, "-vf", "format=rgba,colorchannelmixer=aa=0.30,format=yuva420p",
           "-t", str(duration), "-r", "30", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
           "-crf", "40", "-b:v", "0", "-auto-alt-ref", "0", "-map_metadata", "-1", str(out))


def make_transition(mp4: Path, seed: int, duration: float = 1.0) -> None:
    rng = random.Random(seed)
    hue = rng.randint(0, 0xFFFFFF)
    src = f"gradients=s=1280x720:d={duration}:r=30:c0=0x{hue:06x}:c1=0x000000:c2=0xffffff:x0=0:y0=0:x1=1280:y1=720"
    ffmpeg("-f", "lavfi", "-i", src, "-vf",
           "format=yuv420p,fade=t=in:st=0:d=0.12,fade=t=out:st=0.75:d=0.25",
           "-t", str(duration), "-r", "30", "-c:v", "libx264", "-crf", "28",
           "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
           "-map_metadata", "-1", str(mp4))


def copy(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)


def main() -> None:
    if shutil.which("ffmpeg") is None or shutil.which("woff2_compress") is None:
        raise SystemExit("ffmpeg and woff2_compress are required")
    ensure_dirs()

    # SFX
    make_wav(BRAND_SFX / "whip.wav", "whip", 0.55)
    make_wav(BRAND_SFX / "whoosh.wav", "whoosh", 0.9)
    make_wav(BRAND_SFX / "sting.wav", "sting", 1.2)
    for name in ("whip.wav", "whoosh.wav", "sting.wav"):
        copy(BRAND_SFX / name, RENDERER_PUBLIC / "sfx" / name)
        copy(BRAND_SFX / name, PANEL_ASSETS / "sfx" / name)
    copy(BRAND_SFX / "whip.wav", RENDERER_PUBLIC / "sfx" / "sound-demo.wav")
    copy(BRAND_SFX / "whip.wav", PANEL_ASSETS / "sfx" / "sound-demo.wav")

    # Display font (OFL Anton, renamed for the fictional brand).
    make_display_font()

    # Logo still and videos.
    make_logo_png(BRAND / "logo-demo.png")
    make_logo_png(RENDERER_OVERLAYS / "logo-demo-cup.png")
    make_logo_png(PANEL_ASSETS / "logo-demo-cup.png")
    make_logo_video(BRAND / "logo-demo.webm", green=False)
    make_logo_video(BRAND / "logo-demo-green.mp4", green=True)

    # Outros matching the catalog durations (seconds).
    make_outro(BRAND / "final-demo.mp4", BRAND / "final-demo.webm", 30.12, "FINAL")
    make_outro(RENDERER_OVERLAYS / "final-demo-cup.mp4", PANEL_ASSETS / "final-demo-cup.webm", 30.12, "FINAL")
    make_outro(RENDERER_OVERLAYS / "final-demo-co.mp4", PANEL_ASSETS / "final-demo-co.webm", 30.16, "GOLAZO")
    make_outro(RENDERER_OVERLAYS / "final-demo-ec.mp4", PANEL_ASSETS / "final-demo-ec.webm", 30.53, "GOLAZO")

    # Particles and overlays (alpha WebM).
    for index, seed in enumerate((11, 22, 33, 44), start=1):
        part = BRAND / f"particle-{index}.webm"
        make_particles(part, seed)
        copy(part, RENDERER_OVERLAYS / f"particle-{index}.webm")
        copy(part, PANEL_ASSETS / f"particle-{index}.webm")
    for index, hue in enumerate((0x2E86AB, 0xE4572E), start=1):
        overlay = BRAND / f"overlay-{index}.webm"
        make_overlay(overlay, hue)
        copy(overlay, RENDERER_OVERLAYS / f"overlay-layer-0{index}.webm")
        copy(overlay, PANEL_ASSETS / f"overlay-layer-0{index}.webm")
        copy(overlay, RENDERER_OVERLAYS / f"overlay-layer-0{index}.mp4")  # replaced below with h264
        make_transition(RENDERER_OVERLAYS / f"overlay-layer-0{index}.mp4", 70 + index, 2.0)

    # Logo mirrors used by the renderer and panel.
    copy(BRAND / "logo-demo.webm", RENDERER_OVERLAYS / "logo-demo-alpha.webm")
    copy(BRAND / "logo-demo.webm", RENDERER_OVERLAYS / "logo-demo-co.webm")
    copy(BRAND / "logo-demo.webm", PANEL_ASSETS / "logo-demo-alpha.webm")
    copy(BRAND / "logo-demo.webm", PANEL_ASSETS / "logo-demo-co.webm")
    copy(BRAND / "logo-demo-green.mp4", RENDERER_OVERLAYS / "logo-green.mp4")
    copy(BRAND / "logo-demo-green.mp4", RENDERER_OVERLAYS / "logo-clean.mp4")
    copy(BRAND / "logo-demo-green.mp4", RENDERER_OVERLAYS / "logo-demo-co.mp4")
    copy(BRAND / "logo-demo-green.mp4", PANEL_ASSETS / "logo-green.mp4")
    copy(BRAND / "logo-demo-green.mp4", PANEL_ASSETS / "logo-clean.mp4")

    # Alpha frame sequences (single representative frame each).
    for name in ("logo-demo-co-alpha-frames", "logo-demo-ec-alpha-frames",
                 "logo-colombia-alpha-frames", "logo-ecuador-alpha-frames"):
        target = RENDERER_OVERLAYS / name
        target.mkdir(parents=True, exist_ok=True)
        make_logo_png(target / "frame-0000.png")

    # Boundary transitions (same roles as the removed ripped overlays).
    for index, (name, seed) in enumerate((
        ("TRANSITION 1 NUEVO.mp4", 101),
        ("TRANSITION 2 NUEVO.mp4", 102),
        ("efecto-transition-3.mp4", 103),
    ), start=1):
        make_transition(BRAND / f"transition-{index}.mp4", seed, 1.0)
        copy(BRAND / f"transition-{index}.mp4", PANEL_BOUNDARY / name)
        copy(BRAND / f"transition-{index}.mp4", RENDERER_OVERLAYS / name)

    print("demo assets generated")


if __name__ == "__main__":
    main()
