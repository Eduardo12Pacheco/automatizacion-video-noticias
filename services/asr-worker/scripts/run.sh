#!/bin/sh
# Start the ASR worker. The GPU image installs the CUDA 12 libraries from PyPI
# (the `gpu` extra); ctranslate2 loads them by name, so expose their directories
# on LD_LIBRARY_PATH before starting the app. CPU images skip this silently.
set -eu

if [ "${TRANSCRIPT_SERVICE_DEVICE:-cpu}" != "cpu" ]; then
  nvidia_libs="$(python - <<'PY'
import importlib
import os

paths = []
for module in ("nvidia.cublas.lib", "nvidia.cudnn.lib", "nvidia.cuda_runtime.lib", "nvidia.cuda_nvrtc.lib"):
    try:
        loaded = importlib.import_module(module)
    except Exception:
        continue
    # These are namespace packages: `__file__` is None and `__path__` holds
    # the directory that contains libcublas/libcudnn.
    namespace = getattr(loaded, "__path__", None)
    if namespace:
        paths.append(str(next(iter(namespace))))
    elif getattr(loaded, "__file__", None):
        paths.append(os.path.dirname(loaded.__file__))
print(":".join(paths))
PY
)"
  if [ -n "$nvidia_libs" ]; then
    LD_LIBRARY_PATH="$nvidia_libs${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    export LD_LIBRARY_PATH
  fi
fi

exec uvicorn app.main:app --host 0.0.0.0 --port 8765
