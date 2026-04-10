from __future__ import annotations

from pathlib import Path
from typing import Optional

import soundfile as sf

from segmenter import Segment


class QwenCloneEngine:
    def __init__(self, generation_cfg: dict, device: Optional[str] = None):
        generation_cfg = generation_cfg or {}
        try:
            import torch
            from qwen_tts import Qwen3TTSModel
        except ImportError as exc:
            raise RuntimeError(
                "No se pudo importar qwen-tts. Instalá dependencias con: pip install -r requirements.txt"
            ) from exc

        if device is None:
            if torch.cuda.is_available():
                device = "cuda:0"
            elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                device = "mps"
            else:
                device = "cpu"

        dtype_raw = str(generation_cfg.get("dtype", "bfloat16")).lower()
        if dtype_raw in ("bfloat16", "bf16"):
            dtype = torch.bfloat16
        elif dtype_raw in ("float16", "fp16"):
            dtype = torch.float16
        else:
            dtype = torch.float32

        use_flash = bool(generation_cfg.get("use_flash_attention", True))
        attn_impl = "flash_attention_2" if use_flash and str(device).startswith("cuda") else None

        model_name = str(generation_cfg.get("model_name", "Qwen/Qwen3-TTS-12Hz-0.6B-Base"))

        try:
            self.model = Qwen3TTSModel.from_pretrained(
                model_name,
                device_map=device,
                dtype=dtype,
                attn_implementation=attn_impl,
            )
        except ImportError as exc:
            if attn_impl == "flash_attention_2" and "flash_attn" in str(exc).lower():
                print("[WARN] flash-attn no está instalado. Reintentando con atención estándar en GPU...")
                self.model = Qwen3TTSModel.from_pretrained(
                    model_name,
                    device_map=device,
                    dtype=dtype,
                    attn_implementation=None,
                )
            else:
                raise

        self.model_name = model_name
        self.language = str(generation_cfg.get("language", "Spanish"))
        self._voice_clone_prompt = None

        self._generation_kwargs = {
            "max_new_tokens": generation_cfg.get("max_new_tokens"),
            "do_sample": generation_cfg.get("do_sample"),
            "top_k": generation_cfg.get("top_k"),
            "top_p": generation_cfg.get("top_p"),
            "temperature": generation_cfg.get("temperature"),
            "repetition_penalty": generation_cfg.get("repetition_penalty"),
            "subtalker_dosample": generation_cfg.get("subtalker_dosample"),
            "subtalker_top_k": generation_cfg.get("subtalker_top_k"),
            "subtalker_top_p": generation_cfg.get("subtalker_top_p"),
            "subtalker_temperature": generation_cfg.get("subtalker_temperature"),
        }

    def prepare_reference(self, reference_audio_path: Path, reference_text: str) -> None:
        reference_text = reference_text.strip()
        if not reference_text:
            raise ValueError("ref_text está vacío. Debe ser la transcripción del audio de referencia.")

        self._voice_clone_prompt = self.model.create_voice_clone_prompt(
            ref_audio=str(reference_audio_path),
            ref_text=reference_text,
            x_vector_only_mode=False,
        )

    def synthesize_to_file(self, segment: Segment, output_path: Path) -> int:
        if self._voice_clone_prompt is None:
            raise RuntimeError("Llamá prepare_reference(...) antes de sintetizar segmentos.")

        kwargs = {k: v for k, v in self._generation_kwargs.items() if v is not None}

        wavs, sr = self.model.generate_voice_clone(
            text=segment.text,
            language=self.language,
            voice_clone_prompt=self._voice_clone_prompt,
            **kwargs,
        )

        output_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(output_path), wavs[0], sr)
        return int(sr)
