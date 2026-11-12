#!/usr/bin/env bash
# Builds the agent APK in Docker and saves it as releases/mt5-agent-<versionName>.apk.
# Bump versionCode and versionName in app/build.gradle.kts first: an existing release is never
# overwritten.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"

NAME=$(grep -oP 'versionName = "\K[^"]+' app/build.gradle.kts)
CODE=$(grep -oP 'versionCode = \K[0-9]+' app/build.gradle.kts)
OUT="$ROOT/releases/mt5-agent-$NAME.apk"

if [[ -e "$OUT" ]]; then
  echo "releases/mt5-agent-$NAME.apk already exists. Raise versionName/versionCode in app/build.gradle.kts." >&2
  exit 1
fi
for f in "$ROOT"/releases/mt5-agent-*.apk; do
  [[ -e "$f" ]] || continue
  old=$(grep -oP 'versionCode=\K[0-9]+' "${f%.apk}.txt" 2>/dev/null || echo 0)
  if (( old >= CODE )); then
    echo "versionCode $CODE is not above $old (${f##*/}). Android would refuse the update." >&2
    exit 1
  fi
done

docker image inspect mt5-android-build >/dev/null 2>&1 || docker build -f build.Dockerfile -t mt5-android-build .
mkdir -p .build-home "$ROOT/releases"
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/src/.build-home -e GRADLE_USER_HOME=/src/.build-home/gradle \
  -v "$PWD":/src mt5-android-build gradle assembleDebug --no-daemon --console=plain -q

cp app/build/outputs/apk/debug/app-debug.apk "$OUT"
SHA=$(sha256sum "$OUT" | cut -d' ' -f1)
printf 'versionName=%s\nversionCode=%s\nsha256=%s\nbuilt=%s\n' "$NAME" "$CODE" "$SHA" "$(date -u +%FT%TZ)" > "${OUT%.apk}.txt"
echo "Built releases/mt5-agent-$NAME.apk (versionCode $CODE)"
