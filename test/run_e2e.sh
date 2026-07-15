#!/bin/bash
# Test de bout en bout de l'extension : Chrome headless piloté en CDP.
#
# Prérequis : macOS avec Google Chrome, Node >= 22, python3.
# Variables surchargables : CHROME, EXT_PATH, CDP_PORT, HTTP_PORT.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_PATH="${EXT_PATH:-$ROOT}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
CDP_PORT="${CDP_PORT:-9444}"
HTTP_PORT="${HTTP_PORT:-8899}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/image-picker-e2e.XXXXXX")"

CHROME_PID=""
HTTP_PID=""
cleanup() {
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null
  [ -n "$HTTP_PID" ] && kill "$HTTP_PID" 2>/dev/null
  sleep 1
  pkill -f "user-data-dir=$WORK/chrome-profile" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

if [ ! -x "$CHROME" ]; then
  echo "ERREUR : Chrome introuvable ($CHROME) — surchargez avec CHROME=…" >&2
  exit 3
fi

# Ports libres (évite de parler à une instance parasite d'un run précédent)
for port in "$CDP_PORT" "$HTTP_PORT"; do
  if lsof -i ":$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "ERREUR : port $port déjà occupé" >&2
    exit 3
  fi
done

# Profil vierge, téléchargements confinés dans le dossier temporaire
mkdir -p "$WORK/chrome-profile/Default" "$WORK/downloads"
printf '{"download":{"default_directory":"%s","prompt_for_download":false},"profile":{"exit_type":"Normal"}}' \
  "$WORK/downloads" > "$WORK/chrome-profile/Default/Preferences"

# Serveur HTTP local (page et images de test) + Chrome headless
python3 -m http.server "$HTTP_PORT" --directory "$ROOT/test/www" >"$WORK/http.log" 2>&1 &
HTTP_PID=$!
"$CHROME" \
  --headless=new \
  --user-data-dir="$WORK/chrome-profile" \
  --no-first-run --no-default-browser-check \
  --enable-unsafe-extension-debugging \
  --remote-debugging-port="$CDP_PORT" \
  "about:blank" >"$WORK/chrome.log" 2>&1 &
CHROME_PID=$!
sleep 3

if ! lsof -ti ":$CDP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "ERREUR : Chrome n'a pas ouvert le port $CDP_PORT" >&2
  tail -5 "$WORK/chrome.log" >&2
  exit 3
fi

CDP_PORT="$CDP_PORT" \
EXT_PATH="$EXT_PATH" \
PAGE_URL="http://127.0.0.1:$HTTP_PORT/test.html" \
DL_DIR="$WORK/downloads" \
node "$ROOT/test/cdp_test.mjs"
STATUS=$?

echo "--- fichiers téléchargés :"
(cd "$WORK" && find downloads -type f)
exit $STATUS
