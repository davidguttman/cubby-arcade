"""Windows repro: real Cubby on Windows, a ViGEm virtual Xbox 360 pad, presses through the OS."""
import json, os, subprocess, sys, time, glob, asyncio
import vgamepad as vg
from playwright.async_api import async_playwright
APP, MODE = sys.argv[1], sys.argv[2]
os.makedirs('evidence', exist_ok=True)
DS4 = MODE.endswith('ds4')
Pad = vg.VDS4Gamepad if DS4 else vg.VX360Gamepad
pads = [Pad()]
if 'two' in MODE: pads.append(Pad())
time.sleep(2)
real = pads[-1]   # the pad the player uses is the last one connected; the first sits idle
def tap(name, pad=None):
    pad = pad or real
    if DS4 and name in ('right', 'left'):
        d = vg.DS4_DPAD_DIRECTIONS.DS4_BUTTON_DPAD_EAST if name == 'right' else vg.DS4_DPAD_DIRECTIONS.DS4_BUTTON_DPAD_WEST
        pad.directional_pad(direction=d); pad.update(); time.sleep(0.15); pad.directional_pad(direction=vg.DS4_DPAD_DIRECTIONS.DS4_BUTTON_DPAD_NONE); pad.update(); time.sleep(0.15); return
    btn = {'A': vg.DS4_BUTTONS.DS4_BUTTON_CROSS, 'B': vg.DS4_BUTTONS.DS4_BUTTON_CIRCLE, 'X': vg.DS4_BUTTONS.DS4_BUTTON_SQUARE, 'Y': vg.DS4_BUTTONS.DS4_BUTTON_TRIANGLE}[name] if DS4 else {'A': vg.XUSB_BUTTON.XUSB_GAMEPAD_A, 'right': vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_RIGHT, 'left': vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_LEFT}[name]
    pad.press_button(button=btn); pad.update(); time.sleep(0.15); pad.release_button(button=btn); pad.update(); time.sleep(0.15)
STATE = '''()=>({url:location.href.slice(0,60),focus:(document.activeElement?.dataset?.gameId||document.activeElement?.className||document.activeElement?.tagName),hasFocus:document.hasFocus(),hidden:document.hidden,
 raw:[...Navigator.prototype.getGamepads.call(navigator)].map(p=>p&&{id:p.id,i:p.index,map:p.mapping,nb:p.buttons.length,ax:p.axes.length,axes:[...p.axes].map(a=>+a.toFixed(2)),down:[...p.buttons].flatMap((b,i)=>b.pressed||b.value>.5?[i]:[])}).filter(Boolean),
 seen:[...navigator.getGamepads()].map(p=>p&&{id:p.id,i:p.index,map:p.mapping}).filter(Boolean)})'''
async def main():
    log = []
    if MODE.startswith('desktop'):
        os.environ['ELECTRON_ENABLE_LOGGING'] = '1'
        exe = glob.glob(os.path.join(APP, '**', 'CubbyArcade.exe'), recursive=True)[0]
        proc = subprocess.Popen([exe, '--remote-debugging-port=9333', '--mute-audio'])
    else:
        chrome = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
        proc = subprocess.Popen([chrome, '--remote-debugging-port=9333', '--mute-audio', '--no-first-run', '--user-data-dir=' + os.path.abspath('chrome-profile'), 'https://play.cubbyarcade.com/'])
    async with async_playwright() as pw:
        for _ in range(60):
            try: b = await pw.chromium.connect_over_cdp('http://localhost:9333'); break
            except Exception: time.sleep(1)
        await asyncio.sleep(8)
        page = [p for c in b.contexts for p in c.pages if 'hub://' in p.url or 'cubbyarcade' in p.url][0]
        frame = page.frames[-1] if len(page.frames) > 1 else page.main_frame
        async def snap(label):
            s = await frame.evaluate(STATE); s['step'] = label; log.append(s); print(json.dumps(s), flush=True)
        await snap('start')
        if 'noisy' in MODE:
            # first device never sits still: its stick wanders past half travel
            import threading
            def wander():
                v = 0
                while True:
                    v = 200 - v; pads[0].left_joystick(x_value=v, y_value=128); pads[0].update(); time.sleep(0.05)
            threading.Thread(target=wander, daemon=True).start()
        if 'setup' in MODE:
            await asyncio.get_running_loop().run_in_executor(None, tap, 'A'); await asyncio.sleep(0.6)
            await frame.evaluate("()=>{location.hash='options'}"); await asyncio.sleep(1)
            import re
            q = await frame.evaluate("()=>document.querySelector('.gate-question')?.textContent"); n = [int(x) for x in re.findall(r'\d+', q)]
            ans = n[0]*n[1] if ('×' in q or 'x' in q) else n[0]-n[1] if ('-' in q or '−' in q) else n[0]+n[1]
            for d in str(ans): await frame.locator('.gate-pad button', has_text=re.compile('^'+d+'$')).click()
            await frame.locator('.gate-submit').click(); await asyncio.sleep(0.6)
            await frame.locator('.controller-settings').click(); await asyncio.sleep(1)
            await snap('setup open')
            for name in ['A', 'B', 'X', 'Y']:
                await asyncio.get_running_loop().run_in_executor(None, tap, name); await asyncio.sleep(0.8)
                s2 = await frame.evaluate("()=>({prompt:document.querySelector('.calibration-prompt')?.getAttribute('aria-label'),dialog:!!document.querySelector('dialog.controller-setup[open]'),blocking:window.HandheldOSD?.calibration?.isBlocking()})"); print('setup', name, s2, flush=True); log.append({'step':'setup '+name, **s2})
            await asyncio.sleep(2.5)
            await snap('after setup')
        for label in ['A', 'right', 'right', 'left']:
            await asyncio.get_running_loop().run_in_executor(None, tap, label); await asyncio.sleep(0.6); await snap(label)
        await page.screenshot(path=f'evidence/{MODE}.png')
        moved = len({s['focus'] for s in log[1:]}) > 1
        print('RESULT', MODE, 'hub moved' if moved else 'HUB DID NOT MOVE', flush=True)
        json.dump(log, open(f'evidence/{MODE}.json', 'w'), indent=1)
    proc.kill()
asyncio.run(main())
