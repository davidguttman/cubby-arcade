"""Host-owned system controls; package bytes on disk remain immutable."""
import re

TAG = '<script src="/runtime/core/preferences.js"></script><script data-cubby-controller src="/runtime/core/host-osd.js"></script><script data-handheld-system src="/runtime/core/game-shell.js"></script><script data-cubby-profile src="/runtime/core/profiles.js"></script>'


def inject(content):
    text = content.decode('utf-8')
    if TAG in text:
        return content
    match = re.search(r'<!doctype[^>]*>', text, re.IGNORECASE)
    at = match.end() if match else 0
    return (text[:at] + TAG + text[at:]).encode('utf-8')
