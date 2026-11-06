#!/usr/bin/env bash
# Builds the Cog launcher that app releases carry at runtime/native/rg353v/cog.
# Only this binary changes; libcogcore and the GTK4 module stay in the pinned
# runtime, so it keeps that runtime's prefix and library versions.
set -euo pipefail
COG_SHA=fc426f71c7438e708896c989e268625846abf72eed2dfd053448555db7f8f77b
project=$(cd "$(dirname "$0")/.." && pwd)
source_tar=$(realpath "${1:?Usage: rocknix/build-bundled-cog.sh COG_0.18.4_SOURCE.tar.gz}")
printf '%s  %s\n' "$COG_SHA" "$source_tar" | sha256sum -c --status
docker run --rm --platform linux/arm64 \
  -v "$source_tar:/in/cog.tar.gz:ro" -v "$project/rocknix/patches:/in/patches:ro" \
  -v "$project/runtime/native/rg353v:/out" debian:trixie bash -euxc '
    printf "%s\n" \
      "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261027T000000Z/ trixie main" \
      "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20261027T000000Z/ trixie-security main" \
      > /etc/apt/sources.list
    rm -f /etc/apt/sources.list.d/*
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      build-essential meson ninja-build pkg-config patch \
      libwpewebkit-2.0-dev=2.48.3-1 libwpebackend-fdo-1.0-dev=1.16.0-1 \
      libgtk-4-dev=4.18.6+ds-2 libepoxy-dev libmanette-0.2-dev
    mkdir /src; tar -xzf /in/cog.tar.gz -C /src --strip-components=1; cd /src
    patch -p1 < /in/patches/cog-0.18.4-gtk4-kiosk.patch
    patch -p1 < /in/patches/cog-0.18.4-autoplay.patch
    meson setup build --prefix=/opt/cubby-cog-gtk4-kiosk -Dplatforms=gtk4 -Dwpe_api=2.0 -Ddocumentation=false -Dmanpages=false
    meson compile -C build -j 8
    meson install -C build --destdir /stage --no-rebuild
    install -m 0755 /stage/opt/cubby-cog-gtk4-kiosk/bin/cog /out/cog
    strip /out/cog
    chown --reference=/out /out/cog
    ! readelf -d /out/cog | grep -E "RUNPATH|RPATH"
    readelf -d /out/cog | grep NEEDED
  '
