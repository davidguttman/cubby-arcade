#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright", "pyyaml==6.0.3"]
# ///
"""Adult Wi-Fi UI with explicit simulation; connect to OpenClaw CDP only.

  uv run tests/browser_device_network.py --cdp http://127.0.0.1:18800

No Wi-Fi command or physical device is used. Only this script's page and HTTP
fixture are created/closed. Screenshots can be saved with --screenshots DIR.
"""
import argparse
import asyncio
from pathlib import Path
import re
import sys
import tempfile
import threading

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rocknix.network import Onboarding, Simulation
from rocknix.server import State, make_server


async def exercise(cdp, origin, manager, screenshots):
    from playwright.async_api import async_playwright
    async with async_playwright() as automation:
        browser = await automation.chromium.connect_over_cdp(cdp)
        page = await browser.contexts[0].new_page()
        try:
            await page.set_viewport_size({'width': 640, 'height': 480})
            await page.add_init_script('''
              window.fixturePad = {connected:true, axes:[0,0], buttons:Array.from({length:16},()=>({pressed:false}))};
              Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[window.fixturePad]});
            ''')
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            async def button(index, duration=70):
                await page.evaluate('(i)=>window.fixturePad.buttons[i].pressed=true', index)
                await page.wait_for_timeout(duration)
                await page.evaluate('(i)=>window.fixturePad.buttons[i].pressed=false', index)
                await page.wait_for_timeout(70)
            async def screenshot(name):
                if screenshots:
                    screenshots.mkdir(parents=True, exist_ok=True)
                    await page.screenshot(path=str(screenshots / (name + '.png')))
            await page.goto(origin + '/')
            await page.get_by_role('button', name='Cubby simulation Wi-Fi').wait_for()
            assert page.url == origin + '/adult/network'
            assert await page.locator('#simulation').is_visible()
            await screenshot('wifi-scan')
            await button(0)  # Selected first network using controller A.
            await page.locator('#keyboard').wait_for(state='visible')
            await screenshot('wifi-password')
            assert await page.evaluate('document.documentElement.scrollHeight') <= 480
            await button(15)  # D-pad right moves focus on keyboard.
            assert await page.evaluate('document.activeElement.textContent') == '2'
            await button(0)
            assert await page.locator('#password').input_value() == '2'
            await button(5)  # Shoulder toggles case.
            assert await page.locator('#keyboard').get_by_role('button', name='Q', exact=True).is_visible()
            await page.locator('#password').fill('wrong-pass')
            await button(9)  # Start attempts connection.
            await page.get_by_text('Could not connect.', exact=False).wait_for()
            assert not manager.complete
            assert await page.locator('#password').input_value() == ''
            await page.locator('#password').fill('cubby-test')
            await page.get_by_role('button', name='Connect', exact=True).click()
            await page.get_by_role('button', name='Continue to Cubby').wait_for()
            assert manager.complete
            await screenshot('wifi-online')
            await page.get_by_role('button', name='Continue to Cubby').click()
            await page.wait_for_url(origin + '/')
            manager.adapter.online = False
            await page.reload()
            assert page.url == origin + '/'  # Installed library is usable offline.
            # The hub's gear tab is the single route to settings, and it opens on the question.
            await page.get_by_role('button', name='options', exact=True).click()
            gate = page.locator('.settings-gate')
            await gate.wait_for()
            tiles = page.locator('.settings-tile')
            assert await tiles.count() == 0
            assert await page.get_by_role('button', name='Adult keyboard setup').count() == 0
            assert await page.get_by_role('button', name='Adult Wi-Fi settings').count() == 0
            assert await page.evaluate('document.documentElement.scrollHeight') <= 480
            await page.wait_for_timeout(400)  # Let the tab pill finish sliding.
            await screenshot('settings-gate')
            await page.evaluate("window.dispatchEvent(new Event('focus'))")  # CDP tabs lack window focus.
            await page.wait_for_timeout(120)
            async def question_answer():
                match = re.fullmatch(r"What's (\d) ([+×]) (\d)\?", await page.locator('.gate-question').inner_text())
                a, op, b = int(match[1]), match[2], int(match[3])
                return a + b if op == '+' else a * b
            async def answer(value):
                for digit in str(value):
                    await gate.get_by_role('button', name=digit, exact=True).click()
                await gate.get_by_role('button', name='Submit answer').click()
            await answer(await question_answer() + 1)  # A wrong sum asks a new one.
            await page.get_by_text('Try again.').wait_for()
            assert await tiles.count() == 0
            assert await page.locator('.gate-entry').inner_text() == ''
            await gate.get_by_role('button', name='1', exact=True).focus()
            await button(13)  # D-pad moves through the keypad: 1, then down to 4.
            await button(15)  # Right to 5.
            assert await page.evaluate('document.activeElement.textContent') == '5'
            await button(0)
            assert await page.locator('.gate-entry').inner_text() == '5'
            await gate.get_by_role('button', name='Backspace').click()
            await button(1)  # B leaves the question for the library.
            await gate.wait_for(state='hidden')
            await page.get_by_role('button', name='options', exact=True).click()
            await answer(await question_answer())
            await tiles.first.wait_for()
            assert await page.evaluate("document.activeElement.getAttribute('aria-label')") == 'Cubby updates'
            # Most used first, power last; all six fit the handheld screen without scrolling.
            assert await tiles.evaluate_all('ts=>ts.map(t=>t.getAttribute("aria-label"))') == ['Cubby updates', 'Wi-Fi settings', 'Game saves', 'Adult controller setup', 'Restart', 'Power off']
            assert await page.evaluate('document.documentElement.scrollHeight') <= 480
            assert await page.evaluate("(p=>p.scrollHeight<=p.clientHeight)(document.querySelector('.options-panel'))")
            await page.wait_for_timeout(400)
            await screenshot('settings-tab')
            await button(15)  # D-pad moves across the tiles.
            assert await page.evaluate("document.activeElement.getAttribute('aria-label')") == 'Wi-Fi settings'
            await screenshot('settings-tab-focused')
            # Power tiles confirm before doing anything; the simulated host never powers off.
            await page.get_by_role('button', name='Power off', exact=True).click()
            await page.locator('dialog.quit-confirm').wait_for()
            await page.wait_for_timeout(300)
            await screenshot('power-off-confirm')
            await button(1)
            await page.locator('dialog.quit-confirm').wait_for(state='hidden')
            assert await page.evaluate("document.activeElement.getAttribute('aria-label')") == 'Power off'
            await page.get_by_role('button', name='Wi-Fi settings', exact=True).click()
            await page.wait_for_url(origin + '/adult/network')
            await page.get_by_text('You are offline.', exact=False).wait_for()
            await page.locator('.network').first.wait_for()
            await screenshot('wifi-settings-offline')
            await button(1)  # B returns to the settings tab, not the library, without asking again.
            await page.locator('.settings-tile').first.wait_for()
            assert page.url == origin + '/'
            assert await page.evaluate("document.activeElement.getAttribute('aria-label')") == 'Cubby updates'
            manager.adapter.online = True
            await page.goto(origin + '/adult/network')
            await page.get_by_text('Internet is working.', exact=False).wait_for()
            await page.locator('.network.connected').wait_for()
            assert await page.get_by_role('button', name='Continue to Cubby').is_hidden()
            await screenshot('wifi-settings-online')
            await page.goto(origin + '/')
            manager.adapter.online = False
            await page.evaluate('''() => { for (const i of [4,5,9]) window.fixturePad.buttons[i].pressed=true; }''')
            # The shortcut reaches the gear tab; it must not skip the math question.
            await page.wait_for_function("document.activeElement?.closest('.gate-pad')", timeout=6000)
            assert await tiles.count() == 0
            assert page.url == origin + '/'
            await page.evaluate('''() => { for (const i of [4,5,9]) window.fixturePad.buttons[i].pressed=false; }''')
            assert not errors, errors
            print('Wi-Fi UI: required setup, controller selection/typing/case, wrong-password retry, internet completion, offline reboot and adult shortcut verified at 640x480.')
        finally:
            await page.close()

async def exercise_already_online(cdp, origin, manager, screenshots):
    from playwright.async_api import async_playwright
    async with async_playwright() as automation:
        browser = await automation.chromium.connect_over_cdp(cdp)
        page = await browser.contexts[0].new_page()
        try:
            await page.set_viewport_size({'width': 640, 'height': 480})
            assert not manager.complete
            await page.goto(origin + '/')
            await page.get_by_role('button', name='Continue to Cubby').wait_for()
            assert manager.complete, 'Already-online first boot must persist onboarding before Continue'
            if screenshots:
                screenshots.mkdir(parents=True, exist_ok=True)
                await page.screenshot(path=str(screenshots / 'wifi-already-online.png'))
            await page.get_by_role('button', name='Continue to Cubby').click()
            await page.wait_for_url(origin + '/', timeout=5000)
            await page.reload()
            assert page.url == origin + '/'
            # Recreate the manager as on restart: completion cannot be UI-only.
            assert Onboarding(manager.adapter, manager.state).complete
            print('Wi-Fi UI: already-online first boot persists completion before Continue, and stays home after reload.')
        finally:
            await page.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cdp', required=True)
    parser.add_argument('--screenshots', type=Path)
    args = parser.parse_args()
    for scenario, online in ((exercise_already_online, True), (exercise, False)):
        with tempfile.TemporaryDirectory(prefix='cubby-wifi-ui-') as directory:
            root = Path(__file__).resolve().parents[1]
            adapter = Simulation()
            adapter.online = online
            manager = Onboarding(adapter, directory)
            state = State(root, directory, manager)
            server = make_server(state, 0)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                asyncio.run(scenario(args.cdp, 'http://127.0.0.1:' + str(server.server_address[1]),
                                     manager, args.screenshots))
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == '__main__':
    main()
