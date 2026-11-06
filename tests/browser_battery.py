#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright", "pyyaml==6.0.3"]
# ///
"""Real device bridge regression: top-right battery stays clear of settings/nav."""
import argparse
import asyncio
from pathlib import Path
import sys
import tempfile
import threading
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rocknix.server import State, make_server

ROOT = Path(__file__).resolve().parents[1]


def overlaps(a, b):
    return (a['x'] < b['x'] + b['width'] and b['x'] < a['x'] + a['width']
            and a['y'] < b['y'] + b['height'] and b['y'] < a['y'] + a['height'])


async def exercise(cdp, origin, screenshots):
    from playwright.async_api import async_playwright
    async with async_playwright() as automation:
        browser = await automation.chromium.connect_over_cdp(cdp)
        for width, height in [(640, 480), (390, 844)]:
            context = await browser.new_context(viewport={'width': width, 'height': height})
            try:
                page = await context.new_page()
                await page.goto(origin)
                battery = page.locator('.battery-indicator')
                await battery.wait_for(state='visible')
                gear = page.get_by_role('button', name='options', exact=True)
                nav = page.locator('.view-nav')
                battery_box, gear_box, nav_box = [await el.bounding_box() for el in (battery, gear, nav)]
                header_box = await page.locator('.topbar').bounding_box()
                assert abs(battery_box['x'] + battery_box['width']
                           - header_box['x'] - header_box['width']) <= 1, (battery_box, header_box)
                assert header_box['y'] <= battery_box['y']
                assert battery_box['y'] + battery_box['height'] <= header_box['y'] + header_box['height']
                assert not overlaps(battery_box, gear_box), (battery_box, gear_box)
                assert not overlaps(battery_box, nav_box), (battery_box, nav_box)
                assert 0 <= battery_box['x'] < battery_box['x'] + battery_box['width'] <= width
                assert await battery.get_attribute('aria-label') == 'Charging, 17%'
                assert await battery.inner_text() == ''
                assert await battery.locator('button, [tabindex]').count() == 0
                screenshots.mkdir(parents=True, exist_ok=True)
                await page.screenshot(path=str(screenshots / f'battery-{width}x{height}.png'))
                await gear.click()
                gate = page.get_by_role('group', name='Adult check', exact=True)
                await gate.wait_for(state='visible')
                assert await page.locator('.settings-tile').count() == 0
                gate_box = await gate.bounding_box()
                assert gate_box['y'] >= header_box['y'] + header_box['height'] and gate_box['y'] + gate_box['height'] <= height, gate_box
                await page.screenshot(path=str(screenshots / f'settings-gate-{width}x{height}.png'))
                assert '/adult/network' not in page.url
                print(f'{width}x{height}: battery top-right, no gear/nav overlap; adult settings remain math-gated')
            finally:
                await context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cdp', required=True)
    parser.add_argument('--screenshots', type=Path, default=Path('/tmp/cubby-battery-layout'))
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as directory, patch('rocknix.server.Handler.log_message'), patch('rocknix.server.battery.read_battery',
            return_value={'available': True, 'level': 17, 'charging': True}):
        server = make_server(State(ROOT, Path(directory)), port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            asyncio.run(exercise(args.cdp, 'http://127.0.0.1:' + str(server.server_address[1]), args.screenshots))
        finally:
            server.shutdown()
            thread.join()
            server.server_close()


if __name__ == '__main__':
    main()
