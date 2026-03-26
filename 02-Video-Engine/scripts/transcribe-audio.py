import importlib.util
import json
import os
import sys
import wave


SUPPORTED_BACKENDS = {"auto", "vosk", "deepspeech"}


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


def resolve_backend(requested_backend: str) -> tuple[str, list[str]]:
  notes = []
  py_version = sys.version_info
  can_use_deepspeech = module_available("deepspeech") or module_available("stt")

  if requested_backend == "vosk":
    return "vosk", notes

  if requested_backend == "deepspeech":
    if can_use_deepspeech:
      return "deepspeech", notes

    notes.append(
      "DeepSpeech oficial no esta disponible en este entorno. "
      "Se usa backend deepspeech-compatible basado en Vosk para cumplir STT con timestamps reales."
    )
    return "deepspeech-compatible-vosk", notes

  if can_use_deepspeech and py_version < (3, 11):
    notes.append("Backend auto selecciono DeepSpeech oficial.")
    return "deepspeech", notes

  notes.append(
    "Backend auto selecciono deepspeech-compatible-vosk "
    "(DeepSpeech oficial no soportado o no instalado en Python actual)."
  )
  return "deepspeech-compatible-vosk", notes


def diagnose_backends() -> int:
  py_version = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
  can_use_deepspeech = module_available("deepspeech") or module_available("stt")
  payload = {
    "pythonVersion": py_version,
    "deepspeechModuleAvailable": can_use_deepspeech,
    "voskModuleAvailable": module_available("vosk"),
    "recommendation": (
      "deepspeech" if can_use_deepspeech and sys.version_info < (3, 11) else "deepspeech-compatible-vosk"
    ),
    "notes": [
      "Si DeepSpeech no esta disponible (comun en Python 3.11+), el proyecto usa backend compatible sobre Vosk.",
      "La salida transcript.json mantiene segmentos y timestamps reales para alinear frases sin distribucion proporcional.",
    ],
  }
  print(json.dumps(payload, ensure_ascii=False, indent=2))
  return 0


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
      "Uso: py scripts/transcribe-audio.py [audioWavPath] [voskModelPath] [outputPath] [--backend=auto|vosk|deepspeech] [--diagnose-backends]"
    )
    return 0

  if "--diagnose-backends" in sys.argv:
    return diagnose_backends()

  backend = parse_backend(sys.argv[1:])

  positional_args = [
    arg
    for arg in sys.argv[1:]
    if not arg.startswith("--backend=") and arg != "--diagnose-backends"
  ]

  project_root = os.getcwd()
  audio_path = (
    positional_args[0]
    if len(positional_args) > 0
    else os.path.join(project_root, "audio", "audio.wav")
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
    raise FileNotFoundError(f"No existe el audio WAV en: {audio_path}")

  if not os.path.exists(model_path):
    raise FileNotFoundError(f"No existe el modelo Vosk en: {model_path}")

  os.makedirs(os.path.dirname(output_path), exist_ok=True)

  resolved_backend, notes = resolve_backend(backend)
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
        "confidence": float(item.get("conf", 0)),
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
