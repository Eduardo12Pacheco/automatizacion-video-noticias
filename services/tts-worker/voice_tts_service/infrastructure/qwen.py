from __future__ import annotations

from pathlib import Path
from typing import Optional

import soundfile as sf

from newsroom_worker_common.gpu_slot import GpuSlot, GpuSlotTimeout

from voice_tts_service.domain.segmenter import Segment


class QwenCloneEngine:
    def __init__(self, generation_cfg: dict, device: Optional[str] = None, *, gpu_slot: GpuSlot | None = None):
        generation_cfg = generation_cfg or {}
        try:
            import torch
            from qwen_tts import Qwen3TTSModel
        except ImportError as exc:
            raise RuntimeError("No se pudo importar qwen-tts. Instalá dependencias con: pip install -r requirements.txt") from exc
        if device is None:
            if torch.cuda.is_available():
                device = "cuda:0"
            else:
                raise RuntimeError("TTS requiere CUDA (GPU) pero no se detecto ninguna GPU disponible. Verifica que los drivers NVIDIA esten instalados y que la GPU no este ocupada.")
        selected_device = str(device)
        cuda_available = bool(torch.cuda.is_available())
        cuda_device_count = int(torch.cuda.device_count()) if cuda_available else 0
        if selected_device.startswith("cuda"):
            try:
                if not cuda_available:
                    raise RuntimeError("torch.cuda.is_available() devolvio False")
                if cuda_device_count <= 0:
                    raise RuntimeError("torch.cuda.device_count() devolvio 0")
                torch.zeros(1).to(selected_device)
            except Exception as exc:
                raise RuntimeError(f"CUDA es obligatoria para TTS pero no esta operativa. Dispositivo solicitado: {selected_device}. Error: {type(exc).__name__}: {exc}. Verifica drivers NVIDIA, CUDA toolkit y VRAM disponible.") from exc
        print(f"[INFO] TTS device resuelto: device={device} requested={selected_device} cuda_available={cuda_available} cuda_device_count={cuda_device_count}")
        self.device = selected_device
        dtype_raw = str(generation_cfg.get("dtype", "bfloat16")).lower()
        dtype = torch.bfloat16 if dtype_raw in ("bfloat16", "bf16") else torch.float16 if dtype_raw in ("float16", "fp16") else torch.float32
        use_flash = bool(generation_cfg.get("use_flash_attention", True))
        attn_impl = "flash_attention_2" if use_flash and str(device).startswith("cuda") else None
        model_name = str(generation_cfg.get("model_name", "Qwen/Qwen3-TTS-12Hz-1.7B-Base"))
        self.gpu_slot = gpu_slot or GpuSlot(owner="tts-worker")
        try:
            self._acquire_slot()
            try:
                self.model = Qwen3TTSModel.from_pretrained(model_name, device_map=device, dtype=dtype, attn_implementation=attn_impl)
            finally:
                self.gpu_slot.release()
        except Exception as exc:
            raise RuntimeError(f"Error cargando Qwen3TTSModel.from_pretrained: model={model_name}, device={device}, dtype={dtype}, cuda_available={torch.cuda.is_available()}, cuda_device_count={torch.cuda.device_count() if torch.cuda.is_available() else 0}, original_error={type(exc).__name__}: {exc}") from exc
        self.model_name = model_name
        self.language = str(generation_cfg.get("language", "Spanish"))
        self._voice_clone_prompt = None
        self._generation_kwargs = {k: generation_cfg.get(k) for k in ["max_new_tokens", "do_sample", "top_k", "top_p", "temperature", "repetition_penalty", "subtalker_dosample", "subtalker_top_k", "subtalker_top_p", "subtalker_temperature"]}

    def _acquire_slot(self) -> None:
        try:
            self.gpu_slot.acquire()
        except GpuSlotTimeout as exc:
            raise RuntimeError(str(exc)) from exc

    def prepare_reference(self, reference_audio_path: Path, reference_text: str) -> None:
        reference_text = reference_text.strip()
        if not reference_text:
            raise ValueError("ref_text está vacío. Debe ser la transcripción del audio de referencia.")
        self._acquire_slot()
        try:
            self._voice_clone_prompt = self.model.create_voice_clone_prompt(ref_audio=str(reference_audio_path), ref_text=reference_text, x_vector_only_mode=False)
        finally:
            self.gpu_slot.release()

    def synthesize_to_file(self, segment: Segment, output_path: Path) -> int:
        if self._voice_clone_prompt is None:
            raise RuntimeError("Llamá prepare_reference(...) antes de sintetizar segmentos.")
        self._acquire_slot()
        try:
            wavs, sr = self.model.generate_voice_clone(text=segment.text, language=self.language, voice_clone_prompt=self._voice_clone_prompt, **{k: v for k, v in self._generation_kwargs.items() if v is not None})
        finally:
            self.gpu_slot.release()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(output_path), wavs[0], sr)
        return int(sr)
