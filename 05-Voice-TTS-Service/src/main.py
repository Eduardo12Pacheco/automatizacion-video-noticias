from __future__ import annotations

import argparse
from datetime import datetime
import json
from pathlib import Path
import re
import time

import numpy as np
import soundfile as sf
import yaml

from assemble import assemble_segments
from generate import QwenCloneEngine
from segmenter import SegmenterConfig, segment_text


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Voice Lab Qwen - CLI de clonación de voz")
    parser.add_argument("--input", required=True, help="Ruta al guion .txt")
    parser.add_argument("--ref-audio", required=True, help="Ruta al audio de referencia (.wav)")
    parser.add_argument("--ref-text", required=True, help="Ruta al txt con transcripción de la referencia")
    parser.add_argument("--config", default="config/default.yaml", help="Ruta de config YAML")
    parser.add_argument("--segments-dir", default="segments", help="Carpeta para audios por segmento")
    parser.add_argument("--output-dir", default="output", help="Carpeta para audio final y reporte")
    parser.add_argument("--run-id", default=None, help="ID de ejecución opcional")
    parser.add_argument("--device", default=None, help="Device opcional: cuda:0|cpu|mps")
    parser.add_argument(
        "--preset",
        default=None,
        help="Preset de generación (fidelity_strict|balanced_default|expressive_plus). Si se omite, usa generation.preset del YAML.",
    )
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
    warning = silence_ratio > 0.40

    return {
        "path": str(path),
        "duration_sec": round(duration_sec, 3),
        "active_sec": round(active_sec, 3),
        "lead_silence_sec": round(lead_silence_sec, 3),
        "tail_silence_sec": round(tail_silence_sec, 3),
        "silence_ratio": round(silence_ratio, 3),
        "warning_high_silence": warning,
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


def resolve_generation_with_preset(cfg: dict, cli_preset: str | None) -> tuple[dict, str | None, dict]:
    generation_cfg = dict(cfg.get("generation", {}) or {})
    presets = dict(cfg.get("presets", {}) or {})

    selected_preset = (cli_preset or generation_cfg.get("preset") or "").strip() or None
    if selected_preset is None:
        return generation_cfg, None, {}

    if selected_preset not in presets:
        available = ", ".join(sorted(presets.keys())) or "(none)"
        raise ValueError(f"Preset inválido: '{selected_preset}'. Disponibles: {available}")

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

    if not input_path.exists():
        raise FileNotFoundError(f"No existe input: {input_path}")
    if not ref_audio_path.exists():
        raise FileNotFoundError(f"No existe audio de referencia: {ref_audio_path}")
    if not ref_text_path.exists():
        raise FileNotFoundError(f"No existe ref_text: {ref_text_path}")
    if not cfg_path.exists():
        raise FileNotFoundError(f"No existe config: {cfg_path}")

    cfg = load_config(cfg_path)
    raw_text = input_path.read_text(encoding="utf-8").strip()
    reference_text = ref_text_path.read_text(encoding="utf-8").strip()

    if not raw_text:
        raise ValueError("El guion está vacío.")
    if not reference_text:
        raise ValueError("El ref_text está vacío. Debe ser la transcripción del audio de referencia.")

    seg_cfg = SegmenterConfig(**cfg.get("segmenter", {}))
    pauses_cfg = cfg.get("pauses_ms", {})
    generation_cfg, preset_used, preset_values = resolve_generation_with_preset(cfg, args.preset)
    assembler_cfg = cfg.get("assembler", {})

    segments = segment_text(raw_text, seg_cfg, pauses_cfg)

    t_model_load_start = time.perf_counter()
    engine = QwenCloneEngine(generation_cfg=generation_cfg, device=args.device)
    engine.prepare_reference(reference_audio_path=ref_audio_path, reference_text=reference_text)
    t_model_load_end = time.perf_counter()

    model_name = generation_cfg.get("model_name", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
    model_tag = model_output_tag(str(model_name))

    segment_folder = Path(args.segments_dir) / model_tag / run_id
    segment_paths = []
    segment_analysis = []
    segment_benchmark = []
    sample_rate_last = None

    for segment in segments:
        seg_file = segment_folder / f"seg_{segment.index:03d}.wav"
        t_seg_start = time.perf_counter()
        sample_rate_last = engine.synthesize_to_file(segment, seg_file)
        t_seg_end = time.perf_counter()
        segment_paths.append(seg_file)
        segment_analysis.append(analyze_segment_audio(seg_file))
        segment_benchmark.append(
            {
                "index": segment.index,
                "synthesis_seconds": round(t_seg_end - t_seg_start, 3),
                "word_count": segment.word_count,
            }
        )

    output_dir = Path(args.output_dir) / model_tag
    output_file = output_dir / f"{run_id}.wav"
    assembled_file, assembled_sr = assemble_segments(
        segments=segments,
        segment_audio_paths=segment_paths,
        output_path=output_file,
        crossfade_ms=int(assembler_cfg.get("crossfade_ms", 30)),
        trim_cfg=assembler_cfg.get("trim_silence", {}),
    )

    warnings = [a for a in segment_analysis if a["warning_high_silence"]]
    t1 = time.perf_counter()
    total_synth_seconds = sum(s["synthesis_seconds"] for s in segment_benchmark)

    report = {
        "run_id": run_id,
        "input": str(input_path),
        "reference_audio": str(ref_audio_path),
        "reference_text": str(ref_text_path),
        "output": str(assembled_file),
        "sample_rate": int(assembled_sr),
        "sample_rate_native_model": int(sample_rate_last or assembled_sr),
        "model": model_name,
        "model_output_tag": model_tag,
        "language": generation_cfg.get("language", "Spanish"),
        "preset_used": preset_used,
        "preset_values": preset_values,
        "segments": [s.to_dict() for s in segments],
        "segment_audio_analysis": segment_analysis,
        "benchmark": {
            "total_pipeline_seconds": round(t1 - t0, 3),
            "model_load_and_reference_seconds": round(t_model_load_end - t_model_load_start, 3),
            "total_synthesis_seconds": round(total_synth_seconds, 3),
            "segment_synthesis": segment_benchmark,
        },
        "warnings": {
            "high_silence_segments": len(warnings),
            "high_silence_segment_paths": [w["path"] for w in warnings],
        },
        "segment_count": len(segments),
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    report_path = output_dir / f"{run_id}.report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"OK - audio final: {assembled_file}")
    print(f"OK - reporte: {report_path}")
    print(f"OK - segmentos: {len(segments)}")
    print(f"OK - sample rate nativo: {assembled_sr}")
    if preset_used:
        print(f"OK - preset usado: {preset_used}")


if __name__ == "__main__":
    main()
