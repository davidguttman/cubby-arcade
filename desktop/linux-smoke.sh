#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/.." && pwd)
state=$(mktemp -d "${RUNNER_TEMP:-/tmp}/cubby-linux-smoke-XXXXXX")
uv run python "$root/desktop/smoke-fixture.py" "$state/fixture"
export CUBBY_ARCADE_SMOKE_INSTALL_DIR="$state/fixture"
export CUBBY_ARCADE_SMOKE_UNINSTALL_PACKAGE="$root/hosting/releases/line-cutter/0.2.1/line-cutter-0.2.1.game.zip"
export CUBBY_ARCADE_SMOKE_OFFLINE=1
for mode in install uninstall; do
    export CUBBY_ARCADE_USER_DATA="$state/$mode-profile"
    export CUBBY_ARCADE_SMOKE_DIR="$root/dist/linux-smoke/$mode"
    mkdir -p "$CUBBY_ARCADE_SMOKE_DIR"
    # Sandbox bypass is confined to the ephemeral CI runner, not shipped defaults.
    if timeout 120s xvfb-run -a "$root/dist/CubbyArcade-linux-x64/CubbyArcade" \
        "--$mode-smoke" --disable-gpu --ozone-platform=x11 --no-sandbox \
        > "$CUBBY_ARCADE_SMOKE_DIR/stdout.log" 2> "$CUBBY_ARCADE_SMOKE_DIR/stderr.log"; then
        cat "$CUBBY_ARCADE_SMOKE_DIR/stdout.log" "$CUBBY_ARCADE_SMOKE_DIR/stderr.log"
    else
        status=$?
        cat "$CUBBY_ARCADE_SMOKE_DIR/stdout.log" "$CUBBY_ARCADE_SMOKE_DIR/stderr.log"
        exit "$status"
    fi
    uv run python - "$mode" "$CUBBY_ARCADE_SMOKE_DIR" <<'PY'
import json
from pathlib import Path
import sys
mode, folder = sys.argv[1], Path(sys.argv[2])
report = json.loads((folder / (mode + '-report.json')).read_text())
checks = ('nativeInstall retry progress play fileManifest unchangedFilesReused fileGamePlayable deferredUpdate corruptPreserved offlinePlayable' if mode == 'install' else 'uninstall cancelDefault repeatSafe backCancels retry bytesRemoved savesPreserved favoritesPreserved tokensPreserved reinstall gameIPCRejected').split()
assert all(report.get(key) is True for key in checks), report
if mode == 'install':
    assert {'id': 'demo', 'version': '3'} in report['versions'], report
assert len(list(folder.glob('*.png'))) >= 2, 'Missing smoke screenshots'
PY
done
