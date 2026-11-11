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
            else:
                raise RuntimeError(
                    "TTS requiere CUDA (GPU) pero no se detecto ninguna GPU disponible. "
                    "Verifica que los drivers NVIDIA esten instalados y que la GPU no este ocupada."
                )

        selected_device = str(device)
        cuda_available = bool(torch.cuda.is_available())
        cuda_device_count = int(torch.cuda.device_count()) if cuda_available else 0
        cuda_probe_error = None

        if selected_device.startswith("cuda"):
            try:
                if not cuda_available:
                    raise RuntimeError("torch.cuda.is_available() devolvio False")
                if cuda_device_count <= 0:
                    raise RuntimeError("torch.cuda.device_count() devolvio 0")
                torch.zeros(1).to(selected_device)
            except Exception as exc:
                cuda_probe_error = f"{type(exc).__name__}: {exc}"
                raise RuntimeError(
                    "CUDA es obligatoria para TTS pero no esta operativa. "
                    f"Dispositivo solicitado: {selected_device}. "
                    f"Error: {cuda_probe_error}. "
                    "Verifica drivers NVIDIA, CUDA toolkit y VRAM disponible."
                ) from exc

        print(
            "[INFO] TTS device resuelto: "
            f"device={device} requested={selected_device} "
            f"cuda_available={cuda_available} cuda_device_count={cuda_device_count}"
        )

        dtype_raw = str(generation_cfg.get("dtype", "bfloat16")).lower()
        if dtype_raw in ("bfloat16", "bf16"):
            dtype = torch.bfloat16
        elif dtype_raw in ("float16", "fp16"):
            dtype = torch.float16
        else:
            dtype = torch.float32

        use_flash = bool(generation_cfg.get("use_flash_attention", True))
        attn_impl = "flash_attention_2" if use_flash and str(device).startswith("cuda") else None

        model_name = str(generation_cfg.get("model_name", "Qwen/Qwen3-TTS-12Hz-1.7B-Base"))

        try:
            self.model = Qwen3TTSModel.from_pretrained(
                model_name,
                device_map=device,
                dtype=dtype,
                attn_implementation=attn_impl,
            )
        except Exception as exc:
            raise RuntimeError(
                "Error cargando Qwen3TTSModel.from_pretrained: "
                f"model={model_name}, device={device}, dtype={dtype}, "
                f"cuda_available={torch.cuda.is_available()}, "
                f"cuda_device_count={torch.cuda.device_count() if torch.cuda.is_available() else 0}, "
                f"original_error={type(exc).__name__}: {exc}"
            ) from exc

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
