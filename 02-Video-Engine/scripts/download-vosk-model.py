import os
import sys
import urllib.request
import zipfile


DEFAULT_URL = "https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip"


def main() -> int:
  if "--help" in sys.argv:
    print(
      "Uso: py scripts/download-vosk-model.py [modelZipUrl] [targetDir]\n"
      "Ejemplo: py scripts/download-vosk-model.py https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip models"
    )
    return 0

  project_root = os.getcwd()
  model_url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_URL
  target_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(project_root, "models")

  os.makedirs(target_dir, exist_ok=True)

  zip_name = os.path.basename(model_url)
  zip_path = os.path.join(target_dir, zip_name)
  print(f"Descargando modelo desde: {model_url}")
  urllib.request.urlretrieve(model_url, zip_path)

  with zipfile.ZipFile(zip_path, "r") as zip_ref:
    zip_ref.extractall(target_dir)

  os.remove(zip_path)

  extracted_folders = [
    name
    for name in os.listdir(target_dir)
    if os.path.isdir(os.path.join(target_dir, name))
  ]

  if len(extracted_folders) == 1:
    model_path = os.path.join(target_dir, extracted_folders[0])
    target_model = os.path.join(target_dir, "vosk-model")
    if model_path != target_model and not os.path.exists(target_model):
      os.rename(model_path, target_model)
      model_path = target_model
    print(f"Modelo listo en: {model_path}")
  else:
    print(f"Modelo extraido en: {target_dir}")

  return 0


if __name__ == "__main__":
  raise SystemExit(main())
