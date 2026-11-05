#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright", "pyyaml==6.0.3"]
# ///
"""Real browser trial-health regressions; fixtures only, no device changes."""
import argparse
import asyncio
import os
from pathlib import Path
import sys
import tempfile
import threading

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rocknix.network import Onboarding, Simulation
from rocknix.server import State, make_server


class Updates:
    def __init__(self):
        self.ready = []

    def dispatch(self, body):
        if body['action'] == 'ready':
            self.ready.append(body['token'])
        return {'phase': 'idle', 'configured': True}


async def exercise(cdp, screenshots):
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(cdp)
        for route, script in [('/', 'browser-bootstrap.js'),
                              ('/', 'hub.js'),
                              ('/adult/network', 'network.js'),
                              ('/adult/updates', 'updates.js')]:
            for broken in (True, False):
                with tempfile.TemporaryDirectory() as directory:
                    state = State(Path(__file__).resolve().parents[1], directory)
                    updater = Updates()
                    state.updater = updater
                    if route == '/adult/network':
                        state.network = Onboarding(Simulation(), Path(directory))
                    server = make_server(state, 0)
                    threading.Thread(target=server.serve_forever, daemon=True).start()
                    page = await browser.contexts[0].new_page()
                    try:
                        await page.set_viewport_size({'width': 640, 'height': 480})
                        if broken:
                            failure = ("window.HandheldHub={mount(){throw Error('fixture mount failed');}};"
                                       if script == 'hub.js' else "throw Error('fixture initialization failed');")
                            await page.route('**/' + script, lambda r: r.fulfill(
                                status=200, content_type='text/javascript',
                                body=failure))
                        origin = 'http://127.0.0.1:' + str(server.server_address[1])
                        await page.goto(origin + route)
                        if broken:
                            await page.wait_for_timeout(750)
                            assert not updater.ready, f'{route}: broken initialization acknowledged readiness'
                        else:
                            if route == '/':
                                await page.locator('#hub .view-tab').first.wait_for()
                            elif route == '/adult/network':
                                await page.get_by_role('button', name='Cubby simulation Wi-Fi').wait_for()
                            else:
                                await page.get_by_text('Cubby is ready.', exact=False).wait_for()
                            for _ in range(30):
                                if updater.ready:
                                    break
                                await page.wait_for_timeout(50)
                            assert updater.ready == ['fixture-trial'], (route, updater.ready)
                        screenshots.mkdir(parents=True, exist_ok=True)
                        label = (route.strip('/').replace('/', '-') or 'hub') + '-' + script.removesuffix('.js')
                        await page.screenshot(path=str(screenshots / f'{label}-{"broken" if broken else "ready"}.png'))
                        print(f'{route}: {"failed initialization never acknowledged" if broken else "successful initialization acknowledged once"}')
                    finally:
                        await page.close()
                        server.shutdown()
                        server.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cdp', required=True)
    parser.add_argument('--screenshots', type=Path, required=True)
    args = parser.parse_args()
    old = os.environ.get('CUBBY_UPDATE_TRIAL')
    os.environ['CUBBY_UPDATE_TRIAL'] = 'fixture-trial'
    try:
        asyncio.run(exercise(args.cdp, args.screenshots))
    finally:
        if old is None:
            os.environ.pop('CUBBY_UPDATE_TRIAL', None)
        else:
            os.environ['CUBBY_UPDATE_TRIAL'] = old


if __name__ == '__main__':
    main()
