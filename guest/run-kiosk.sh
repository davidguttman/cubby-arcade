#!/bin/bash
set -euo pipefail
exec >>/var/lib/handheld/session.log 2>&1
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export WAYLAND_DISPLAY=handheld-wayland
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe
export COG_PLATFORM_NAME=wl
export COG_PLATFORM_WL_VIEW_FULLSCREEN=1
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
# This private socket belongs only to this service. Weston may leave it behind
# after the whole systemd control group is stopped.
rm -f "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY.lock"
pulseaudio --start --exit-idle-time=-1
# The virtual HDA device initially comes up muted. Set a modest guest volume;
# host volume is untouched. Real-device volume policy is a separate concern.
pactl set-sink-mute @DEFAULT_SINK@ false
pactl set-sink-volume @DEFAULT_SINK@ 60%
weston --backend=drm --socket="$WAYLAND_DISPLAY" --config=/etc/handheld/weston.ini --log=/var/lib/handheld/weston.log &
weston_pid=$!
trap 'kill "$weston_pid" 2>/dev/null || true' EXIT
for n in {1..120}; do
  test -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" && break
  kill -0 "$weston_pid"
  sleep 1
done
test -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY"
cog --config=/etc/handheld/cog.ini http://127.0.0.1:8080/
