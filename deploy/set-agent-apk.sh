#!/usr/bin/env bash
# Sets the agent APK that the Device Owner setup QR installs on new phones.
#   ./set-agent-apk.sh path/to/mt5-agent-0.6.1.apk 15 0.6.1
# Defaults to the production stack; for the LAN stack:
#   COMPOSE_FILE=docker-compose.lan.yml ENV_FILE=.env.lan ./set-agent-apk.sh ...
set -euo pipefail
cd "$(dirname "$0")"
[ $# -eq 3 ] || { echo "usage: $0 <apk> <versionCode> <versionName>"; exit 1; }
APK=$1 CODE=$2 NAME=$3
[ -f "$APK" ] || { echo "no such file: $APK"; exit 1; }
[[ "$CODE" =~ ^[0-9]+$ ]] || { echo "versionCode must be a number"; exit 1; }
DC=(docker compose -f "${COMPOSE_FILE:-docker-compose.yml}" --env-file "${ENV_FILE:-.env}")

"${DC[@]}" cp "$APK" "api:/data/apk/agent-$CODE.apk"
"${DC[@]}" exec -T api python - "$CODE" "$NAME" <<'PY'
import hashlib, json, os, sys
from datetime import datetime, timezone
code, name = int(sys.argv[1]), sys.argv[2]
d = "/data/apk"; f = f"agent-{code}.apk"; p = os.path.join(d, f)
rel = {"version_code": code, "version_name": name,
       "sha256": hashlib.sha256(open(p, "rb").read()).hexdigest(), "file": f,
       "url": "/api/agent/download/agent.apk", "size": os.path.getsize(p),
       "uploaded_at": datetime.now(timezone.utc).isoformat(), "uploaded_by": "set-agent-apk.sh"}
tmp = os.path.join(d, ".latest.tmp"); json.dump(rel, open(tmp, "w")); os.replace(tmp, os.path.join(d, "latest.json"))
print(f"Setup QR now installs {name} (code {code}), sha256 {rel['sha256']}")
PY
