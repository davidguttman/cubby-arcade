#!/bin/bash
set -euxo pipefail
exec > >(tee -a /var/log/handheld-bootstrap.log) 2>&1
export DEBIAN_FRONTEND=noninteractive
mkdir -p /opt/handheld /etc/handheld /var/lib/handheld
mountpoint -q /mnt/handheld-seed || { mkdir -p /mnt/handheld-seed; mount -o ro /dev/disk/by-label/cidata /mnt/handheld-seed; }
tar xzf /mnt/handheld-seed/bundle.tar.gz -C /opt/handheld
# Fixed Debian archive: runtime packages resolve identically on clean rebuilds.
rm -f /etc/apt/sources.list.d/debian.sources
cat >/etc/apt/sources.list <<'EOF'
deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20261027T000000Z/ trixie main
EOF
apt-get update
apt-get install -y --no-install-recommends cog weston libgl1-mesa-dri gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav pulseaudio dbus-user-session fonts-dejavu-core curl
install -m644 /opt/handheld/guest/weston.ini /etc/handheld/weston.ini
install -m644 /opt/handheld/guest/cog.ini /etc/handheld/cog.ini
install -m755 /opt/handheld/guest/run-kiosk.sh /usr/local/bin/handheld-kiosk
install -m644 /opt/handheld/guest/handheld-http.service /etc/systemd/system/handheld-http.service
install -m644 /opt/handheld/guest/handheld-kiosk.service /etc/systemd/system/handheld-kiosk.service
chown -R arcade:arcade /opt/handheld /var/lib/handheld
dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' > /var/lib/handheld/packages.lock.tsv
sha256sum /opt/handheld/public/line-cutter/line-cutter.js > /var/lib/handheld/game.sha256
systemctl daemon-reload
systemctl enable handheld-http.service handheld-kiosk.service
systemctl start handheld-http.service handheld-kiosk.service
touch /var/lib/handheld/bootstrap.complete
echo HANDHELD_BOOTSTRAP_COMPLETE
