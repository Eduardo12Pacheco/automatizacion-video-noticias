import importlib.util
import json
import os
import sys
import urllib.error
import urllib.request
import wave


SUPPORTED_BACKENDS = {"auto", "whisper", "vosk", "deepspeech"}


def round_ts(value: float) -> float:
  return float(f"{value:.3f}")


def module_available(module_name: str) -> bool:
  return importlib.util.find_spec(module_name) is not None


def parse_backend(argv: list[str]) -> str:
  for arg in argv:
    if arg.startswith("--backend="):
      backend = arg.split("=", maxsplit=1)[1].strip().lower()
      if backend not in SUPPORTED_BACKENDS:
        raise ValueError(
          f"Backend invalido '{backend}'. Usa uno de: {', '.join(sorted(SUPPORTED_BACKENDS))}"
        )
      return backend
  return "auto"


def parse_whisper_model(argv: list[str]) -> str:
  for arg in argv:
    if arg.startswith("--whisper-model="):
      model_name = arg.split("=", maxsplit=1)[1].strip()
      if not model_name:
        raise ValueError("--whisper-model no puede estar vacio")
      return model_name
  return os.environ.get("STT_WHISPER_MODEL", "small")


def parse_whisper_device(argv: list[str]) -> str:
  for arg in argv:
    if arg.startswith("--whisper-device="):
      device_name = arg.split("=", maxsplit=1)[1].strip()
      if not device_name:
        raise ValueError("--whisper-device no puede estar vacio")
      return device_name
  return os.environ.get("STT_WHISPER_DEVICE", "cpu")


def asr_worker_url() -> str:
  return (os.environ.get("ASR_WORKER_URL") or os.environ.get("STT_ASR_WORKER_URL") or "http://127.0.0.1:8765").rstrip("/")


def resolve_backend(requested_backend: str) -> tuple[str, list[str]]:
  notes = []
  if requested_backend in {"auto", "whisper"}:
    notes.append(
      f"Backend Whisper delegado al servicio asr-worker en {asr_worker_url()} (modelo y GPU compartidos)."
    )
    return "whisper", notes

  if requested_backend == "vosk":
    return "vosk", notes

  if requested_backend == "deepspeech":
    notes.append(
      "DeepSpeech oficial no esta disponible en este entorno. "
      "Se usa backend deepspeech-compatible basado en Vosk para cumplir STT con timestamps reales."
    )
    return "deepspeech-compatible-vosk", notes

  raise RuntimeError(f"Backend no soportado: {requested_backend}")


def diagnose_backends() -> int:
  py_version = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
  try:
    with urllib.request.urlopen(f"{asr_worker_url()}/api/radar/live", timeout=3) as response:
      worker_reachable = response.status == 200
  except Exception:
    worker_reachable = False
  payload = {
    "pythonVersion": py_version,
    "asrWorkerUrl": asr_worker_url(),
    "asrWorkerReachable": worker_reachable,
    "voskModuleAvailable": module_available("vosk"),
    "recommendation": "whisper (asr-worker)" if worker_reachable else "start services/asr-worker",
    "notes": [
      "Whisper (faster-whisper) vive en services/asr-worker; este script solo envia el audio por HTTP.",
      "El worker aplica el slot GPU compartido y el fallback CPU/small automaticamente.",
    ],
  }
  print(json.dumps(payload, ensure_ascii=False, indent=2))
  return 0


def _split_words(text: str, start: float, end: float) -> list[dict]:
  tokens = [token for token in str(text or "").split() if token]
  if not tokens:
    return []
  span = max(0.0, float(end) - float(start))
  weights = [max(1, len(token)) for token in tokens]
  total = float(sum(weights))
  words = []
  cursor = float(start)
  for token, weight in zip(tokens, weights):
    duration = span * weight / total
    words.append(
      {
        "word": token,
        "start": round_ts(cursor),
        "end": round_ts(cursor + duration),
        "confidence": 0.0,
      }
    )
    cursor += duration
  return words


def transcribe_with_whisper(
  audio_path: str,
  model_name: str,
  device: str,
) -> tuple[list[dict], list[dict]]:
  payload = json.dumps({"audio_path": os.path.abspath(audio_path)}).encode("utf8")
  request = urllib.request.Request(
    f"{asr_worker_url()}/api/radar/transcribe",
    data=payload,
    headers={
      "content-type": "application/json",
      "x-api-key": os.environ.get("TRANSCRIPT_SERVICE_API_KEY", ""),
    },
    method="POST",
  )
  timeout = float(os.environ.get("STT_TRANSCRIBE_TIMEOUT_MS", "120000")) / 1000.0
  try:
    with urllib.request.urlopen(request, timeout=timeout) as response:
      body = json.loads(response.read().decode("utf8"))
  except urllib.error.HTTPError as exc:
    detail = exc.read().decode("utf8", errors="replace")
    raise RuntimeError(f"asr-worker HTTP {exc.code}: {detail[:500]}") from exc
  except urllib.error.URLError as exc:
    raise RuntimeError(f"asr-worker no disponible en {asr_worker_url()}: {exc}") from exc

  segments = []
  words = []
  for index, segment in enumerate(body.get("segments", []), start=1):
    text = str(segment.get("text", "")).strip()
    if not text:
      continue
    start = float(segment.get("start_ms", 0)) / 1000.0
    end = float(segment.get("end_ms", 0)) / 1000.0
    segment_words = _split_words(text, start, end)
    words.extend(segment_words)
    segments.append(
      {
        "id": index,
        "text": text,
        "start": round_ts(start),
        "end": round_ts(end),
        "words": segment_words,
      }
    )

  return segments, words


def transcribe_with_vosk(audio_path: str, model_path: str) -> tuple[list[dict], list[dict]]:
  from vosk import KaldiRecognizer, Model, SetLogLevel

  SetLogLevel(0)
  model = Model(model_path)

  with wave.open(audio_path, "rb") as wf:
    if wf.getnchannels() != 1 or wf.getsampwidth() != 2 or wf.getframerate() != 16000:
      raise ValueError("El audio debe ser WAV PCM mono a 16kHz.")

    recognizer = KaldiRecognizer(model, wf.getframerate())
    recognizer.SetWords(True)

    chunks = []
    while True:
      data = wf.readframes(4000)
      if len(data) == 0:
        break
      if recognizer.AcceptWaveform(data):
        result = json.loads(recognizer.Result())
        if result.get("text"):
          chunks.append(result)

    final = json.loads(recognizer.FinalResult())
    if final.get("text"):
      chunks.append(final)

  words = []
  for chunk in chunks:
    words.extend(chunk.get("result", []))

  segments = []
  for index, chunk in enumerate(chunks):
    chunk_words = chunk.get("result", [])
    if not chunk_words:
      continue
    segments.append(
      {
        "id": index + 1,
        "text": chunk.get("text", "").strip(),
        "start": round_ts(chunk_words[0].get("start", 0)),
        "end": round_ts(chunk_words[-1].get("end", 0)),
        "words": [
          {
            "word": item.get("word", "").strip(),
            "start": round_ts(item.get("start", 0)),
            "end": round_ts(item.get("end", 0)),
            "confidence": float(item.get("conf", 0)),
          }
          for item in chunk_words
        ],
      }
    )

  return segments, words


def main() -> int:
  if "--help" in sys.argv:
    print(
      "Uso: py scripts/transcribe-audio.py [audioPath] [voskModelPath] [outputPath] [--backend=auto|whisper|vosk|deepspeech] [--diagnose-backends]"
    )
    return 0

  if "--diagnose-backends" in sys.argv:
    return diagnose_backends()

  backend = parse_backend(sys.argv[1:])
  whisper_model = parse_whisper_model(sys.argv[1:])
  whisper_device = parse_whisper_device(sys.argv[1:])

  positional_args = [
    arg
    for arg in sys.argv[1:]
    if not arg.startswith("--backend=")
    and not arg.startswith("--whisper-model=")
    and not arg.startswith("--whisper-device=")
    and arg != "--diagnose-backends"
  ]

  project_root = os.getcwd()
  audio_path = (
    positional_args[0]
    if len(positional_args) > 0
    else os.path.join(project_root, "audio", "audio-16khz.wav")
  )
  model_path = (
    positional_args[1]
    if len(positional_args) > 1
    else os.path.join(project_root, "models", "vosk-model")
  )
  output_path = (
    positional_args[2]
    if len(positional_args) > 2
    else os.path.join(project_root, "output", "transcript.json")
  )

  if not os.path.exists(audio_path):
    raise FileNotFoundError(
      "No existe el audio para STT. Esperado por defecto: "
      f"{os.path.join(project_root, 'audio', 'audio-16khz.wav')}"
    )

  os.makedirs(os.path.dirname(output_path), exist_ok=True)

  resolved_backend, notes = resolve_backend(backend)

  if resolved_backend == "whisper":
    segments, words = transcribe_with_whisper(
      audio_path,
      model_name=whisper_model,
      device=whisper_device,
    )
  else:
    if not os.path.exists(model_path):
      raise FileNotFoundError(f"No existe el modelo Vosk en: {model_path}")
    segments, words = transcribe_with_vosk(audio_path, model_path)

  total_duration_seconds = words[-1].get("end", 0) if words else 0

  payload = {
    "backend": resolved_backend,
    "requestedBackend": backend,
    "notes": notes,
    "segments": segments,
    "words": [
      {
        "word": item.get("word", "").strip(),
        "start": round_ts(item.get("start", 0)),
        "end": round_ts(item.get("end", 0)),
        "confidence": float(item.get("confidence", item.get("conf", 0))),
      }
      for item in words
    ],
    "totalDurationSeconds": round_ts(total_duration_seconds),
  }

  with open(output_path, "w", encoding="utf8") as f:
    f.write(json.dumps(payload, ensure_ascii=False, indent=2))
    f.write("\n")

  print(
    f"Transcripcion completada. Backend: {resolved_backend}. Segmentos: {len(segments)}"
  )
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
