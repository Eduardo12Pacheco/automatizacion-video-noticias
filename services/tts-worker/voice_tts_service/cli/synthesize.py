from __future__ import annotations

import argparse
import json
import os
import re
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import soundfile as sf
import yaml

from voice_tts_service.application.assemble import assemble_segments
from voice_tts_service.domain.segmenter import SegmenterConfig, segment_text
from voice_tts_service.infrastructure.engine_factory import create_tts_engine, resolve_engine_mode


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Voice Lab Qwen - voice cloning CLI")
    parser.add_argument("--input", required=True, help="Path to the .txt script")
    parser.add_argument("--ref-audio", required=True, help="Path to the reference audio (.wav)")
    parser.add_argument("--ref-text", required=True, help="Path to the reference transcript .txt")
    parser.add_argument("--config", default="config/default.yaml", help="Path to the YAML config")
    parser.add_argument("--segments-dir", default="segments", help="Directory for per-segment audio")
    parser.add_argument("--output-dir", default="output", help="Directory for the final audio and report")
    parser.add_argument("--run-id", default=None, help="Optional run id")
    parser.add_argument("--device", default=None, help="Device opcional: cuda:0|cpu|mps")
    parser.add_argument("--preset", default=None, help="Generation preset (balanced_default|golazo_emotivo|golazo_informativo). Defaults to generation.preset from the YAML.")
    return parser.parse_args()


def load_config(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def analyze_segment_audio(path: Path, threshold: float = 0.005) -> dict:
    audio, sr = sf.read(str(path), dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    duration_sec = float(len(audio) / sr) if sr else 0.0
    active_idx = np.where(np.abs(audio) > threshold)[0]
    if active_idx.size == 0:
        active_sec = 0.0
        lead_silence_sec = duration_sec
        tail_silence_sec = 0.0
    else:
        start = int(active_idx[0])
        end = int(active_idx[-1])
        active_sec = float((end - start + 1) / sr)
        lead_silence_sec = float(start / sr)
        tail_silence_sec = float((len(audio) - end - 1) / sr)
    silence_ratio = 0.0 if duration_sec == 0 else max(0.0, min(1.0, 1 - (active_sec / duration_sec)))
    return {
        "path": str(path),
        "duration_sec": round(duration_sec, 3),
        "active_sec": round(active_sec, 3),
        "lead_silence_sec": round(lead_silence_sec, 3),
        "tail_silence_sec": round(tail_silence_sec, 3),
        "silence_ratio": round(silence_ratio, 3),
        "warning_high_silence": silence_ratio > 0.40,
    }


def model_output_tag(model_name: str) -> str:
    model_name = (model_name or "").strip()
    if not model_name:
        return "unknown-model"
    m = re.search(r"(\d+(?:\.\d+)?)B", model_name, flags=re.IGNORECASE)
    if m:
        return f"{m.group(1)}B".replace(".", "_")
    safe = re.sub(r"[^a-zA-Z0-9._-]+", "-", model_name).strip("-")
    return safe or "model"


def resolve_generation_with_preset(
    cfg: dict,
    cli_preset: str | None,
    env: dict[str, str] | None = None,
) -> tuple[dict, str | None, dict]:
    generation_cfg = dict(cfg.get("generation", {}) or {})
    # The GPU installer downloads Qwen to a local volume; this override keeps
    # the model path out of the committed YAML and lets CPU installs ignore it.
    values = os.environ if env is None else env
    model_override = (values.get("TTS_WORKER_MODEL") or "").strip()
    if model_override:
        generation_cfg["model_name"] = model_override
    presets = dict(cfg.get("presets", {}) or {})
    selected_preset = (cli_preset or generation_cfg.get("preset") or "").strip() or None
    if selected_preset is None:
        return generation_cfg, None, {}
    if selected_preset not in presets:
        available = ", ".join(sorted(presets.keys())) or "(none)"
        raise ValueError(f"Invalid preset: '{selected_preset}'. Available: {available}")
    preset_values = dict(presets.get(selected_preset, {}) or {})
    merged = dict(generation_cfg)
    merged.update(preset_values)
    merged["preset"] = selected_preset
    return merged, selected_preset, preset_values


def main() -> None:
    t0 = time.perf_counter()
    args = parse_args()
    input_path = Path(args.input)
    ref_audio_path = Path(args.ref_audio)
    ref_text_path = Path(args.ref_text)
    cfg_path = Path(args.config)
    run_id = args.run_id or datetime.now().strftime("run-%Y%m%d-%H%M%S")
    for path, label in [(input_path, "input"), (ref_audio_path, "reference audio"), (ref_text_path, "ref_text"), (cfg_path, "config")]:
        if not path.exists():
            raise FileNotFoundError(f"Missing {label}: {path}")
    cfg = load_config(cfg_path)
    raw_text = input_path.read_text(encoding="utf-8").strip()
    reference_text = ref_text_path.read_text(encoding="utf-8").strip()
    if not raw_text:
        raise ValueError("The script is empty.")
    # Piper is a fixed CPU voice and does not use the reference audio/text
    # either for cloning or for its prompt; requiring a reference transcript
    # would make the documented CPU local mode impossible.
    if not reference_text and resolve_engine_mode() != "piper":
        raise ValueError("ref_text is empty. It must be the transcript of the reference audio.")
    seg_cfg = SegmenterConfig(**cfg.get("segmenter", {}))
    pauses_cfg = cfg.get("pauses_ms", {})
    generation_cfg, preset_used, preset_values = resolve_generation_with_preset(cfg, args.preset)
    assembler_cfg = cfg.get("assembler", {})
    segments = segment_text(raw_text, seg_cfg, pauses_cfg)
    print("PROGRESS|stage=loading_model|percent=10", flush=True)
    t_model_load_start = time.perf_counter()
    engine, gpu_slot = create_tts_engine(generation_cfg, device=args.device)
    if gpu_slot is not None:
        import atexit

        atexit.register(gpu_slot.release)
    print("PROGRESS|stage=preparing_reference|percent=20", flush=True)
    engine.prepare_reference(reference_audio_path=ref_audio_path, reference_text=reference_text)
    t_model_load_end = time.perf_counter()
    model_name = generation_cfg.get("model_name", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
    model_tag = model_output_tag(str(model_name))
    segment_folder = Path(args.segments_dir) / model_tag / run_id
    segment_paths = []
    segment_analysis = []
    segment_benchmark = []
    sample_rate_last = None
    total_segments = max(1, len(segments))
    for segment in segments:
        synth_percent = 20 + int((segment.index / total_segments) * 75)
        print(f"PROGRESS|stage=synthesizing|percent={min(95, synth_percent)}|segment={segment.index}/{total_segments}", flush=True)
        seg_file = segment_folder / f"seg_{segment.index:03d}.wav"
        t_seg_start = time.perf_counter()
        sample_rate_last = engine.synthesize_to_file(segment, seg_file)
        t_seg_end = time.perf_counter()
        segment_paths.append(seg_file)
        segment_analysis.append(analyze_segment_audio(seg_file))
        segment_benchmark.append({"index": segment.index, "synthesis_seconds": round(t_seg_end - t_seg_start, 3), "word_count": segment.word_count})
    output_dir = Path(args.output_dir) / model_tag
    output_file = output_dir / f"{run_id}.wav"
    assembled_file, assembled_sr = assemble_segments(segments, segment_paths, output_file, int(assembler_cfg.get("crossfade_ms", 30)), float(assembler_cfg.get("output_gain_db", 0.0)), bool(assembler_cfg.get("peak_protection", True)), float(assembler_cfg.get("peak_target", 0.99)), assembler_cfg.get("trim_silence", {}))
    warnings = [a for a in segment_analysis if a["warning_high_silence"]]
    t1 = time.perf_counter()
    report = {
        "run_id": run_id, "input": str(input_path), "reference_audio": str(ref_audio_path), "reference_text": str(ref_text_path), "output": str(assembled_file),
        "sample_rate": int(assembled_sr), "sample_rate_native_model": int(sample_rate_last or assembled_sr), "model": model_name, "model_output_tag": model_tag,
        "language": generation_cfg.get("language", "Spanish"), "engine": type(engine).__name__, "device": getattr(engine, "device", None), "preset_used": preset_used, "preset_values": preset_values, "segments": [s.to_dict() for s in segments],
        "segment_audio_analysis": segment_analysis,
        "benchmark": {"total_pipeline_seconds": round(t1 - t0, 3), "model_load_and_reference_seconds": round(t_model_load_end - t_model_load_start, 3), "total_synthesis_seconds": round(sum(s["synthesis_seconds"] for s in segment_benchmark), 3), "segment_synthesis": segment_benchmark},
        "audio_output": {"output_gain_db": float(assembler_cfg.get("output_gain_db", 0.0)), "peak_protection": bool(assembler_cfg.get("peak_protection", True)), "peak_target": float(assembler_cfg.get("peak_target", 0.99))},
        "warnings": {"high_silence_segments": len(warnings), "high_silence_segment_paths": [w["path"] for w in warnings]}, "segment_count": len(segments),
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    report_path = output_dir / f"{run_id}.report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"OK - audio final: {assembled_file}")
    print(f"OK - report: {report_path}")
    print(f"OK - segmentos: {len(segments)}")
    print(f"OK - sample rate nativo: {assembled_sr}")
    if preset_used:
        print(f"OK - preset usado: {preset_used}")


if __name__ == "__main__":
    main()
