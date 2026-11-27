#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Real hub and game page with a pad the browser could not map (mapping '').

The fake pad is the Linux xpad/joydev layout a third-party Xbox-style pad gets
when the browser has no mapping for it: 11 buttons, triggers on axes 2/5 resting
at -1, the d-pad as a hat on axes 6/7. With no calibration, the d-pad must move
hub focus, A must open a game, and the game's own frozen input.js must hear A,
Start and the d-pad through the game shell.

Connects to --cdp when given; otherwise launches its own headless, muted Chromium.
"""
import argparse
import asyncio
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'https://pad.test'

FAKE_PAD = '''(() => {
  const pad = {id: '24c6-581a-PowerA Xbox Wired Controller', index: 0, mapping: '', connected: true, timestamp: 0,
    buttons: Array.from({length: 11}, () => ({pressed: false, touched: false, value: 0})), axes: [0, 0, -1, 0, 0, -1, 0, 0]};
  Object.defineProperty(Navigator.prototype, 'getGamepads', {configurable: true,
    value() { pad.timestamp = performance.now(); return [pad, null, null, null]; }});
  window.setPad = (buttons, axes) => {
    pad.buttons.forEach((b, i) => { const on = buttons.includes(i); b.pressed = on; b.touched = on; b.value = on ? 1 : 0; });
    pad.axes.splice(0, 8, ...[0, 0, -1, 0, 0, -1, 0, 0]); Object.entries(axes || {}).forEach(([i, v]) => { pad.axes[i] = v; });
  };
})();'''


def hub_page():
    css = ''.join((ROOT / 'runtime/core' / name).read_text() for name in ('screen.css', 'hub.css'))
    art = 'data:image/svg+xml,' + '%3Csvg xmlns="http://www.w3.org/2000/svg" width="160" height="120"%3E%3Crect width="160" height="120" fill="%23574381"/%3E%3C/svg%3E'
    games = [{'id': f'game-{i}', 'artwork': art, 'entrypoint': f'/games/game-{i}/index.html'} for i in range(3)]
    setup = 'const games=' + json.dumps(games) + ''';
    window.HandheldPlatform={createPlatform:()=>({capabilities:{},library:async()=>games.map(g=>({...g})),catalog:async()=>[]})};
    window.hub=HandheldHub.mount(document.querySelector('#hub'));'''
    # Same order as runtime/index.html: host-osd installs before the hub's input.
    scripts = ''.join(f'<script src="/runtime/core/{name}"></script>' for name in ('preferences.js', 'host-osd.js', 'input.js', 'hub.js'))
    return f'<!doctype html><style>{css}</style><body class="hub"><main id="hub"></main>{scripts}<script>{setup}</script>'


def game_page():
    # What runtime/game_shell.py injects, then the game's own frozen input.js.
    shell = ''.join(f'<script src="/runtime/core/{name}"></script>' for name in ('preferences.js', 'host-osd.js', 'game-shell.js'))
    return ('<!doctype html><body><canvas id="screen"></canvas>' + shell + '<script src="core/input.js"></script>'
            '<script>window.got=[];HandheldInput.createInput({onAction:e=>got.push(e.button)});</script></body>')


async def route(request_route):
    path = request_route.request.url[len(ORIGIN):].split('?')[0]
    if path == '/':
        return await request_route.fulfill(content_type='text/html', body=hub_page())
    if path.startswith('/runtime/core/'):
        file = ROOT / path.lstrip('/')
        kind = 'text/css' if path.endswith('.css') else 'text/javascript'
        return await request_route.fulfill(content_type=kind, body=file.read_text())
    if path.startswith('/games/') and path.endswith('/index.html'):
        return await request_route.fulfill(content_type='text/html', body=game_page())
    if path.startswith('/games/') and path.endswith('/core/input.js'):
        return await request_route.fulfill(content_type='text/javascript', body=(ROOT / 'tests/fixtures/frozen-input/1aef9c86.js').read_text())
    return await request_route.fulfill(status=404, body='')


async def press(page, buttons=(), axes=None):
    await page.evaluate('([b,a])=>setPad(b,a)', [list(buttons), axes or {}])
    await page.wait_for_timeout(120)
    await page.evaluate('()=>setPad([])')
    await page.wait_for_timeout(120)


async def exercise(cdp):
    from playwright.async_api import async_playwright
    async with async_playwright() as automation:
        if cdp:
            browser = await automation.chromium.connect_over_cdp(cdp)
        else:
            browser = await automation.chromium.launch(headless=True, args=['--mute-audio', '--autoplay-policy=user-gesture-required'])
        context = await browser.new_context(viewport={'width': 1280, 'height': 800})
        try:
            await context.add_init_script(FAKE_PAD)
            await context.route(ORIGIN + '/**', route)
            page = await context.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            await page.goto(ORIGIN + '/')
            await page.locator('.game-card').nth(2).wait_for()
            await page.locator('.game-card').first.focus()
            await page.wait_for_timeout(400)
            seen = await page.evaluate('()=>{const p=navigator.getGamepads().find(Boolean);return {id:p.id,mapping:p.mapping,axes:p.axes}}')
            print('hub reads first pad:', seen)
            assert seen['id'].startswith('24c6-581a') and seen['mapping'] == 'standard', seen
            focused = lambda: page.evaluate('()=>document.activeElement?.dataset?.gameId||document.activeElement?.className')
            print('focus before:', await focused())
            await press(page, axes={6: 1})
            after_right = await focused()
            print('focus after hat right:', after_right)
            assert after_right == 'game-1', after_right
            await press(page, axes={6: 1})
            await press(page, axes={6: -1})
            after_left = await focused()
            print('focus after hat right, left:', after_left)
            assert after_left == 'game-1', after_left
            async with page.expect_navigation():
                await press(page, buttons=[0])
            print('A opened:', page.url)
            assert page.url.endswith('/games/game-1/index.html'), page.url
            await page.wait_for_function('()=>window.got!==undefined')
            await page.wait_for_timeout(500)
            for buttons, axes in [([0], None), ([1], None), ([7], None), ([], {7: 1}), ([], {6: -1})]:
                await press(page, buttons, axes)
            got = await page.evaluate('()=>got')
            print('game (frozen input.js via game shell) heard:', got)
            assert got == ['a', 'b', 'start', 'down', 'left'], got
            await page.evaluate('()=>setPad([6,7])')
            await page.wait_for_timeout(200)
            menu = await page.evaluate('()=>HandheldGameShell.isOpen()')
            print('Select+Start opens game menu:', menu)
            assert menu is True
            assert not errors, errors
            print('PASS')
        finally:
            await context.close()
            if not cdp:
                await browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--cdp')
    args = parser.parse_args()
    asyncio.run(exercise(args.cdp))
