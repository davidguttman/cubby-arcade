#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright", "pyyaml==6.0.3"]
# ///
"""Coarse-pointer device defaults; disposable HTTP/browser fixture only."""
import argparse
import asyncio
import hashlib
from pathlib import Path
import sys
import tempfile
import threading

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rocknix.server import State, make_server
from runtime import packages

ROOT = Path(__file__).resolve().parents[1]


async def exercise(cdp, screenshots):
    from playwright.async_api import async_playwright
    package = ROOT / 'hosting/releases/line-cutter/0.2.1/line-cutter-0.2.1.game.zip'
    digest = hashlib.sha256(package.read_bytes()).hexdigest()
    with tempfile.TemporaryDirectory() as directory:
        state = State(ROOT, directory)
        packages.install(package, state.games)
        server = make_server(state, 0)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            origin = 'http://127.0.0.1:' + str(server.server_address[1])
            heights = {}
            async with async_playwright() as automation:
                browser = await automation.chromium.connect_over_cdp(cdp)
                for case in ('device-default', 'device-explicit-on', 'browser-auto'):
                    context = await browser.new_context(viewport={'width': 640, 'height': 480}, has_touch=True)
                    page = await context.new_page()
                    try:
                        if case == 'browser-auto':
                            await page.route('**/runtime/core/preferences.js', lambda route: route.fulfill(
                                status=200, content_type='text/javascript',
                                body=(ROOT / 'runtime/core/preferences.js').read_text()))
                        await page.goto(origin + '/')
                        await page.wait_for_function('window.HandheldPreferences !== undefined')
                        if case == 'device-explicit-on':
                            await page.evaluate("HandheldPreferences.preferences.set({touchOverlay:'on'})")
                        mode = await page.evaluate('HandheldPreferences.preferences.get().touchOverlay')
                        assert mode == {'device-default':'off', 'device-explicit-on':'on', 'browser-auto':'auto'}[case]
                        await page.goto(origin + '/games/line-cutter/play.html')
                        await page.wait_for_function('window.HandheldOSD !== undefined')
                        await page.wait_for_timeout(150)
                        report = await page.evaluate('''() => ({
                          touch:navigator.maxTouchPoints,
                          coarse:matchMedia('(any-pointer:coarse)').matches,
                          mode:HandheldPreferences.preferences.get().touchOverlay,
                          deck:document.documentElement.hasAttribute('data-cubby-osd'),
                          height:document.querySelector('#screen').getBoundingClientRect().height
                        })''')
                        assert report['touch'] > 0 and report['coarse'], report
                        expected = case != 'device-default'
                        assert report['deck'] == expected, (case, report)
                        heights[case] = report['height']
                        screenshots.mkdir(parents=True, exist_ok=True)
                        await page.screenshot(path=str(screenshots / (case + '.png')))
                        print(case, report)
                    finally:
                        await context.close()
                assert heights['device-default'] > heights['device-explicit-on'] * 1.5, heights
        finally:
            server.shutdown()
            server.server_close()
    assert hashlib.sha256(package.read_bytes()).hexdigest() == digest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cdp', required=True)
    parser.add_argument('--screenshots', type=Path, required=True)
    args = parser.parse_args()
    asyncio.run(exercise(args.cdp, args.screenshots))
