#!/bin/bash
set -Eeuo pipefail
project=$(cd "$(dirname "$0")/.." && pwd)
image=${AUDIO_TEST_IMAGE:-matterbridge-audio:local}
test_dir=$(mktemp -d /tmp/mb-media-playback.XXXXXX)
test_container=mb-media-playback-test
mkdir -p "$test_dir/captures" "$test_dir/bin" "$test_dir/data"
cp "$project/test/ffmpeg" "$test_dir/bin/ffmpeg"
chmod +x "$test_dir/bin/ffmpeg"
cleanup() {
  sudo -n docker logs "$test_container" > "$test_dir/server.log" 2>&1 || true
  sudo -n docker rm -f "$test_container" >/dev/null 2>&1 || true
  echo "Résultats du test : $test_dir"
}
trap cleanup EXIT
sudo -n docker run --rm -v "$project/test:/usr/local/lib/node_modules/audio-fixture:ro" \
  --entrypoint node "$image" /usr/local/lib/node_modules/audio-fixture/failures.mjs
sudo -n docker run -d --name "$test_container" --network host \
  -e MATTERBRIDGE_LINK_LOCAL_PLUGINS=false \
  -e POC_HTTP_BIND=127.0.0.1 -e POC_HTTP_PORT=46104 -e POC_MATTER_PORT=46103 \
  -e PATH=/test/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  -v "$test_dir:/test" -v "$test_dir/data:/data" \
  "$image" >/dev/null
for attempt in $(seq 1 25); do
  sudo -n docker logs "$test_container" 2>&1 | sed -nE 's/.*[Mm]anual pairing code[[:space:]:]+([0-9]{11}).*/\1/p' | head -1 > "$test_dir/bridge-code"
  if test -s "$test_dir/bridge-code"; then break; fi
  sleep 1
done
test -s "$test_dir/bridge-code"
sudo -n docker run --rm --network host \
  -v "$test_dir:/test" -v "$project/test:/usr/local/lib/node_modules/audio-fixture:ro" \
  --entrypoint node "$image" /usr/local/lib/node_modules/audio-fixture/integration.mjs
sudo -n docker restart --time 10 "$test_container" >/dev/null
sudo -n docker run --rm --network host -e VERIFY_RESTART=1 \
  -v "$test_dir:/test" -v "$project/test:/usr/local/lib/node_modules/audio-fixture:ro" \
  --entrypoint node "$image" /usr/local/lib/node_modules/audio-fixture/integration.mjs
