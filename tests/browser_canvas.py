#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright==1.65.2"]
# ///
"""Rendered canvas sizing checks; no server, game-package mutation or hardware claims."""
import argparse
import asyncio
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


async def exercise(executable=None, screenshots=None):
    from playwright.async_api import async_playwright
    async with async_playwright() as automation:
        browser = await automation.chromium.launch(headless=True, executable_path=executable)
        try:
            for size in ((640, 480), (1280, 800), (390, 844)):
                for shape in ('screen', 'library', 'wrapper'):
                    for logical in ((320, 240), (240, 160)):
                        for deck in (False, True):
                            context = await browser.new_context(viewport=dict(zip(('width', 'height'), size)))
                            page = await context.new_page()
                            canvas = f'<canvas width="{logical[0]}" height="{logical[1]}" ' + ('class="library"' if shape == 'library' else 'id="screen"') + '></canvas>'
                            if shape == 'wrapper':
                                canvas = '<div class="screen">' + canvas.replace('id="screen"', '') + '</div>'
                            html = '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/runtime/core/screen.css">' + f'<script>window.HandheldPreferences={{preferences:{{showTouchControls:()=>{str(deck).lower()},subscribe:()=>()=>{{}}}}}};</script><script src="/runtime/core/host-osd.js"></script></head><body>' + canvas + '</body></html>'
                            async def serve(route):
                                path = route.request.url.split('canvas.test', 1)[1]
                                if path.startswith('/runtime/core/'):
                                    file = ROOT / path.lstrip('/')
                                    await route.fulfill(content_type='text/css' if file.suffix == '.css' else 'text/javascript', body=file.read_bytes())
                                else:
                                    await route.fulfill(content_type='text/html', body=html)
                            await page.route('https://canvas.test/**', serve)
                            await page.goto('https://canvas.test/games/fixture/play.html')
                            await page.wait_for_function('window.HandheldOSD?.root !== undefined')
                            report = await page.evaluate('''() => {
                              const c=document.querySelector('canvas'), r=c.getBoundingClientRect();
                              const keys=[...HandheldOSD.root.querySelectorAll('button')].map(b=>b.getBoundingClientRect());
                              return {width:r.width,height:r.height,left:r.left,top:r.top,right:r.right,bottom:r.bottom,
                                overlap:document.documentElement.hasAttribute('data-cubby-osd') && keys.some(k=>k.left<r.right&&k.right>r.left&&k.top<r.bottom&&k.bottom>r.top),
                                logical:[c.width,c.height]};
                            }''')
                            label = (size, shape, logical, deck, report)
                            assert abs(report['width'] / report['height'] - logical[0] / logical[1]) < .002, label
                            assert report['logical'] == list(logical), label
                            assert report['width'] > 0 and report['height'] > 0, label
                            assert report['left'] >= -.1 and report['top'] >= -.1 and report['right'] <= size[0]+.1 and report['bottom'] <= size[1]+.1, label
                            assert not report['overlap'], label
                            if not deck and size == (640, 480) and logical == (320, 240):
                                assert abs(report['width']-640) < 1 and abs(report['height']-480) < 1, label
                            # Intrinsic resizing must update sizing, not silently stretch a game's pixels.
                            await page.evaluate("() => {const c=document.querySelector('canvas');c.width=640;c.height=480;}")
                            await page.wait_for_function("() => {const r=document.querySelector('canvas').getBoundingClientRect();return Math.abs(r.width/r.height-4/3)<.002;}")
                            if screenshots and logical == (320, 240) and shape == 'screen':
                                screenshots.mkdir(parents=True, exist_ok=True)
                                await page.evaluate("() => {const c=document.querySelector('canvas'), x=c.getContext('2d'); x.fillStyle='#263c30';x.fillRect(0,0,c.width,c.height);x.strokeStyle='#edf3dc';x.lineWidth=4;x.strokeRect(2,2,c.width-4,c.height-4);x.beginPath();x.arc(c.width/2,c.height/2,80,0,Math.PI*2);x.stroke();}")
                                await page.screenshot(path=str(screenshots / f'{size[0]}x{size[1]}-deck-{deck}.png'))
                            # Disposal restores only the host's sizing property and stops tracking.
                            await page.evaluate('HandheldOSD.dispose()')
                            assert await page.evaluate("[...document.querySelectorAll('.screen,canvas#screen,canvas.library')].every(c=>!c.style.getPropertyValue('--cubby-canvas-ratio'))")
                            await page.evaluate("() => {const c=document.querySelector('canvas');c.width=240;c.height=160;}")
                            await page.evaluate('() => new Promise(resolve=>requestAnimationFrame(resolve))')
                            assert await page.evaluate("[...document.querySelectorAll('.screen,canvas#screen,canvas.library')].every(c=>!c.style.getPropertyValue('--cubby-canvas-ratio'))")
                            await context.close()
                print(f'{size}: direct/library/wrapped 4:3 and legacy 3:2, deck on/off and intrinsic resize passed')
        finally:
            await browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser-executable')
    parser.add_argument('--screenshots', type=Path)
    args = parser.parse_args()
    asyncio.run(exercise(args.browser_executable, args.screenshots))
