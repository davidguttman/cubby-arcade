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
server_pid=
session_log() {
  local message="Cubby session: $*"
  printf '%s\n' "$message" >&2
  { printf '%(%Y-%m-%dT%H:%M:%S%z)T %s\n' -1 "$message" >> "$HOME/session.log"; } 2>/dev/null || true
}
# Only this session's small event log is persisted; ordinary process output
# remains in the journal. Never let a full/read-only log volume block startup.
{ [ ! -f "$HOME/session.log" ] || mv -fT "$HOME/session.log" "$HOME/session.previous.log"; } 2>/dev/null || true
{ [ -d "$HOME/session.log" ] || : > "$HOME/session.log"; } 2>/dev/null || true
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  session_log "exit status=$status"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 143' TERM INT
# Prefer the compositor's exported socket; otherwise choose its first socket.
wayland_ready() {
  local socket
  if [[ -n ${WAYLAND_DISPLAY:-} ]]; then
    case "$WAYLAND_DISPLAY" in
      /*) socket=$WAYLAND_DISPLAY ;;
      *) socket=$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY ;;
    esac
    [[ -S "$socket" ]]
    return
  fi
  for socket in "$XDG_RUNTIME_DIR"/wayland-*; do
    [[ -S "$socket" ]] || continue
    export WAYLAND_DISPLAY=${socket##*/}
    return 0
  done
  return 1
}
session_log "waiting for Wayland display=${WAYLAND_DISPLAY:-auto}"
for ((n=0; n<300; n++)); do
  if wayland_ready; then break; fi
  sleep .1
done
if ! wayland_ready; then
  session_log 'Wayland readiness timed out after 30 seconds'
  exit 1
fi
session_log "Wayland ready display=$WAYLAND_DISPLAY"
python3 -m rocknix.server &
server_pid=$!
for ((n=0; n<30; n++)); do
  kill -0 "$server_pid"
  if python3 -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8080/health", timeout=1)' 2>/dev/null; then break; fi
  sleep 1
done
python3 -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8080/health", timeout=1)'
session_log 'HTTP ready'
# Do not force software graphics or disable WebKit sandboxing. A failure returns
# to the ROCKNIX launcher through the outer bounded restart/fallback wrapper.
# This bundle uses WPE WebKit's 2.0 API, where sandboxing is always enabled;
# Cog's --enable-sandbox option exists only for the older 1.x API.
cog --config rocknix/cog.ini --platform=wl --gamepad=manette --webprocess-failure=exit http://127.0.0.1:8080/
