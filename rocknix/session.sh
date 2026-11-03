#!/bin/bash
# Runs inside the WPE rootfs. ROCKNIX owns Sway, input and PulseAudio/PipeWire.
set -euo pipefail
cd /opt/cubby
export XDG_RUNTIME_DIR=/run/host-runtime
export XDG_DATA_HOME=/var/lib/handheld/profile
export XDG_CACHE_HOME=/var/lib/handheld/cache
export HOME=/var/lib/handheld
export PULSE_SERVER=unix:/run/host-runtime/pulse/native
export COG_PLATFORM_NAME=wl
export COG_PLATFORM_WL_VIEW_FULLSCREEN=1
mkdir -p "$XDG_DATA_HOME" "$XDG_CACHE_HOME"
# Prefer the compositor's exported socket; otherwise choose its first socket.
if [[ -z ${WAYLAND_DISPLAY:-} ]]; then
  for socket in "$XDG_RUNTIME_DIR"/wayland-*; do
    if [[ -S "$socket" ]]; then export WAYLAND_DISPLAY=${socket##*/}; break; fi
  done
fi
[[ -n ${WAYLAND_DISPLAY:-} && -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]]
python3 -m rocknix.server &
server_pid=$!
cleanup() { kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; }
trap cleanup EXIT
trap 'exit 143' TERM INT
for ((n=0; n<30; n++)); do
  kill -0 "$server_pid"
  if python3 -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8080/health", timeout=1)' 2>/dev/null; then break; fi
  sleep 1
done
python3 -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8080/health", timeout=1)'
# Do not force software graphics or disable WebKit sandboxing. A failure returns
# to the ROCKNIX launcher through the outer bounded restart/fallback wrapper.
# This bundle uses WPE WebKit's 2.0 API, where sandboxing is always enabled;
# Cog's --enable-sandbox option exists only for the older 1.x API.
cog --config rocknix/cog.ini --platform=wl --gamepad=manette --webprocess-failure=exit http://127.0.0.1:8080/
