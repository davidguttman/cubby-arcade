# A physical handheld inside another page

`/play?embed=handheld&parentOrigin=<URL-encoded parent origin>` mounts the ordinary
Cubby hub and browser store in an iframe. It is not another launcher, game list,
or game renderer. Games are installed through the same catalog, service worker,
integrity checks and offline storage as `/play`. Browsers may partition this
storage by the embedding top-level site; this is not a cross-origin save sync.

Use a 720×480 CSS-pixel iframe viewport (then scale/project the frame onto the
host's screen). Give it `allow="autoplay; gamepad"`. Cubby supplies no second touch
deck in this mode; the embedding handheld supplies its controls. Direct pointer
interaction with the real hub and games remains possible. Desktop/native and
ordinary browser play do not opt into this behavior.

## Protocol, version 1

All messages are objects with `type: 'cubby:embed:v1'`. Use the exact iframe origin
as `postMessage`'s target origin and validate both `event.origin` and
`event.source === iframe.contentWindow` on receipt. Cubby binds the reverse
direction to the exact `parentOrigin` and `window.parent`; it accepts only
`https://david.app`, `https://www.david.app`, or HTTPS single-label preview
subdomains under `davidguttman.jump.sh`.

Child → parent:

- `{type, event: 'ready'}`: the bridge is installed. Sent on each document load
  (including game navigation and BFCache restoration). The hub/catalog may still
  be loading. Respond by sending the current active state; duplicate ready events
  are harmless.
- `{type, event: 'exit'}`: Escape was pressed inside the frame. Return to the room.
- `{type, event: 'audio-blocked'}`: browser autoplay policy rejected resuming media
  or an audio context. Do not claim audio resumed; allow a direct iframe gesture.

Parent → child:

- `{type, event: 'active', active: boolean}`: whether the handheld is being used.
  A new document starts inactive. Send false on exit, hidden parent tab, or
  otherwise leaving play; send true on re-entry and after each ready.
- `{type, event: 'button', button, down: boolean}`: standard logical controller
  button down/up. Allowed buttons: `a`, `b`, `x`, `y`, `l`, `r`, `select`, `start`,
  `up`, `down`, `left`, `right`. Down/up are not key-code remaps. Short taps remain
  visible for two animation frames after release so polling games cannot lose a
  semantic click. Deactivation clears all buttons immediately.

The bridge persists only its opt-in origin in sessionStorage so navigation to an
installed game's verified HTML retains the same host mode. The worker/native
HTML delivery injects the host bridge before game scripts, without editing
publisher bytes. The adapter is part of the content-hashed browser shell, so
new builds do not reuse an old bridge cache.

Inactive frames suspend animation callbacks (excluding elapsed inactive time from
their timestamps), expose hidden/unfocused lifecycle to existing game SDKs,
release held controls, suspend requested audio contexts, and pause playing media.
Reactivate the existing frame rather than replacing it: saves, downloads and
running sessions retain their ordinary ownership. In handheld embed mode, Select
alone toggles Cubby's game system menu; Start remains ordinary game input. Outside
this mode the Select+Start and both-shoulder shortcuts are unchanged. Escape
belongs to the embedding room.

## Verification

```sh
node --test tests/handheld_embed.cjs tests/host_osd.cjs tests/game_shell.cjs tests/browser_store.cjs tests/shared_core.cjs
uv run python -m unittest tests.test_game_shell tests.test_web_host
uv run python web.py build
```

The device server intentionally denies all framing; this browser embed is for the
public static site/preview, not the physical device's administrative origin.
