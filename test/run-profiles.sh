#!/bin/bash
set -Eeuo pipefail
project=$(cd "$(dirname "$0")/.." && pwd)
image=${AUDIO_TEST_IMAGE:-matterbridge-securitysystem-stack:local}
task=$(mktemp -d /tmp/mb-profiles-test.XXXXXX)
container=mb-audio-profiles-test
mkdir -p "$task/bin" "$task/captures" "$task/data"
cp "$project/test/ffmpeg" "$project/test/amixer" "$task/bin/"
chmod +x "$task/bin/ffmpeg" "$task/bin/amixer"
cleanup() {
  sudo -n docker logs "$container" > "$task/server.log" 2>&1 || true
  sudo -n docker rm -f "$container" >/dev/null 2>&1 || true
  echo "Résultats des profils : $task"
}
trap cleanup EXIT
sudo -n docker run -d --name "$container" --network host \
  -e MATTERBRIDGE_LINK_LOCAL_PLUGINS=false \
  -e POC_HTTP_BIND=127.0.0.1 -e POC_HTTP_PORT=45804 -e POC_MATTER_PORT=45803 \
  -e PATH=/test/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  -v "$task:/test" -v "$task/data:/data" "$image" >/dev/null
for attempt in $(seq 1 25); do
  sudo -n docker logs "$container" 2>&1 | sed -nE 's/.*[Mm]anual pairing code[[:space:]:]+([0-9]{11}).*/\1/p' | head -1 > "$task/bridge-code"
  if test -s "$task/bridge-code"; then break; fi
  sleep 1
done
test -s "$task/bridge-code"
sudo -n docker run --rm --network host \
  -v "$task:/test" -v "$project/test:/usr/local/lib/node_modules/profiles-fixture:ro" \
  --entrypoint node "$image" /usr/local/lib/node_modules/profiles-fixture/profiles.mjs &
fixture_pid=$!
for attempt in $(seq 1 100); do
  if test -f "$task/restart"; then
    sudo -n docker restart --time 10 "$container" >/dev/null
    touch "$task/restarted"
    break
  fi
  if ! kill -0 "$fixture_pid" 2>/dev/null; then break; fi
  sleep 1
done
wait "$fixture_pid"
