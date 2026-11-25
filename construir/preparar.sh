#!/usr/bin/env bash
# Deja en modelo/ y bin/ todo lo que viaja dentro del instalador: modelos de voz, Whisper compilado y ffmpeg.
# Corre en macOS (Apple Silicon) y en Windows (Git Bash). Todo lo descargado se comprueba con su suma SHA-256.
set -euo pipefail
cd "$(dirname "$0")/.."
WHISPER=d1be6fde11ac6e0407606b4e42fe72d34add8037   # whisper.cpp v1.9.5
FFMPEG=https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1
mkdir -p modelo bin trabajo

suma() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
bajar() { # url destino sha256
  if [ -f "$2" ] && [ "$(suma "$2")" = "$3" ]; then return; fi
  curl -fL --retry 6 --retry-all-errors --retry-delay 5 -sS -o "$2" "$1"
  [ "$(suma "$2")" = "$3" ] || { echo "La suma de $2 no coincide: $(suma "$2")"; exit 1; }
}

bajar https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin modelo/ggml-large-v3-turbo-q5_0.bin 394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2
bajar https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin modelo/ggml-silero-v5.1.2.bin 29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf

if [ ! -d trabajo/whisper ]; then
  git init -q trabajo/whisper
  git -C trabajo/whisper fetch -q --depth 1 https://github.com/ggml-org/whisper.cpp "$WHISPER"
  git -C trabajo/whisper checkout -q FETCH_HEAD
fi
COMUN=(-S trabajo/whisper -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF)
AVX2=(-DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_BMI2=ON)

if [ "$(uname)" = Darwin ]; then
  cmake -B trabajo/arm "${COMUN[@]}" -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON
  cmake -B trabajo/intel "${COMUN[@]}" "${AVX2[@]}" -DCMAKE_OSX_ARCHITECTURES=x86_64 -DCMAKE_SYSTEM_PROCESSOR=x86_64 -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 -DGGML_METAL=OFF
  for v in arm intel; do cmake --build trabajo/$v --config Release -j 4 --target whisper-cli; done
  lipo -create trabajo/arm/bin/whisper-cli trabajo/intel/bin/whisper-cli -output bin/whisper-cli
  bajar $FFMPEG/ffmpeg-darwin-arm64.gz trabajo/ff-arm.gz 8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa
  bajar $FFMPEG/ffmpeg-darwin-x64.gz trabajo/ff-intel.gz 929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106
  for v in arm intel; do gunzip -c trabajo/ff-$v.gz > trabajo/ff-$v; done
  lipo -create trabajo/ff-arm trabajo/ff-intel -output bin/ffmpeg
  chmod +x bin/whisper-cli bin/ffmpeg
else
  cmake -B trabajo/avx2 -A x64 "${COMUN[@]}" "${AVX2[@]}" -DCMAKE_POLICY_DEFAULT_CMP0091=NEW -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded
  # sin AVX2 (Celeron, Pentium, Atom): con Clang, porque MSVC no usa SSE y queda varias veces más lento
  cmake -B trabajo/compat -A x64 -T ClangCL "${COMUN[@]}" -DGGML_SSE42=ON -DGGML_AVX=OFF -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_F16C=OFF -DGGML_BMI2=OFF -DCMAKE_POLICY_DEFAULT_CMP0091=NEW -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded -DCMAKE_C_FLAGS="-DWIN32 -D_WINDOWS -msse4.2" -DCMAKE_CXX_FLAGS="-DWIN32 -D_WINDOWS -EHsc -msse4.2"
  for v in avx2 compat; do cmake --build trabajo/$v --config Release -j 4 --target whisper-cli; done
  cp trabajo/avx2/bin/Release/whisper-cli.exe bin/whisper-cli.exe
  cp trabajo/compat/bin/Release/whisper-cli.exe bin/whisper-cli-compat.exe
  bajar $FFMPEG/ffmpeg-win32-x64.gz trabajo/ff.gz 8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77
  gunzip -c trabajo/ff.gz > bin/ffmpeg.exe
fi
ls -la bin modelo
