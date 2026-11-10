"""Install animation regression in an isolated browser with a synthetic bridge.
Run: uv run --with playwright python scripts/install-spinner-smoke.py
Needs a Chromium listening for CDP on 127.0.0.1:18800 and CUBBY_BROWSER_ORIGIN
set to a static HTTPS deployment; never downloads or changes installed games.
"""
import asyncio
import json
import os
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = os.environ.get('CUBBY_BROWSER_ORIGIN', 'https://cubby-web-installs.davidguttman.jump.sh').rstrip('/')
EVIDENCE = Path(os.environ.get('CUBBY_SPINNER_EVIDENCE', '/tmp/cubby-spinner-evidence'))

FIXTURE = """(() => {
 const game={id:'spinner-demo',artwork:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="seagreen"/></svg>',manifest_url:'https://example.test/manifest.json',entrypoint:'/unused'};
 let listener,library=[];
 window.spinnerTest={emit(phase,received=0){listener?.({'spinner-demo':{phase,received,total:100}});},complete(){library=[game];this.emit('installed');}};
 window.HandheldPlatformOptions={kind:'web',bridge:{
  library:async()=>library,catalog:async()=>[game],install:()=>new Promise(()=>{}),
  installStatus:async()=>({}),onInstallState(fn){listener=fn;return()=>{};}
 }};
})();"""

async def main():
 EVIDENCE.mkdir(parents=True, exist_ok=True)
 async with async_playwright() as p:
  browser = await p.chromium.connect_over_cdp('http://127.0.0.1:18800')
  context = await browser.new_context(viewport={'width':1100,'height':760})
  try:
   await context.add_init_script(FIXTURE)
   # Exercise this checkout's actual hub logic, without depending on a stale SW cache.
   await context.route('**/runtime/core/hub.js', lambda route: route.fulfill(path=str(ROOT/'runtime/core/hub.js'), content_type='text/javascript'))
   page = await context.new_page()
   await page.goto(ORIGIN+'/play')
   await page.get_by_role('button',name='store',exact=True).click()
   await page.locator('.game-card').click()
   await page.get_by_role('button',name='Download game',exact=True).click(force=True)
   await page.evaluate("""() => {
    spinnerTest.emit('checking');window.firstSpinner=document.querySelector('.download-game svg');
    window.firstAnimation=firstSpinner.getAnimations()[0];
   }""")
   await page.wait_for_timeout(180)
   await page.evaluate('window.rotationBefore=firstAnimation.currentTime')
   for phase, received in [('checking',0),('downloading',10),('downloading',35),('downloading',60),('verifying',100),('pending',100)]:
    await page.evaluate('([phase,received])=>spinnerTest.emit(phase,received)',[phase,received])
    assert await page.evaluate('firstSpinner===document.querySelector(".download-game svg")'), 'Progress update replaced spinner and restarted rotation'
    assert await page.evaluate('firstAnimation===firstSpinner.getAnimations()[0]'), 'Progress update restarted CSS animation'
    assert await page.locator('.download-game').is_disabled()
   assert await page.evaluate('firstAnimation.currentTime>=rotationBefore')
   assert await page.locator('.install-progress').evaluate('(el)=>el.value') == 100
   await page.screenshot(path=str(EVIDENCE/'spinner-desktop.png'))
   await page.set_viewport_size({'width':390,'height':844})
   await page.screenshot(path=str(EVIDENCE/'spinner-mobile.png'))
   await page.evaluate("spinnerTest.emit('error')")
   assert await page.get_by_role('button',name='Retry download',exact=True).is_enabled()
   assert await page.locator('.download-game.loading').count()==0
   await page.get_by_role('button',name='Retry download',exact=True).click(force=True)
   assert await page.locator('.download-game.loading').count()==1
   await page.evaluate('spinnerTest.complete()')
   await page.wait_for_selector('.play-game')
   assert await page.locator('.install-progress').count()==0
   assert await page.locator('.download-game').count()==0
   await page.emulate_media(reduced_motion='reduce')
   await page.reload()
   await page.get_by_role('button',name='store',exact=True).click()
   await page.locator('.game-card').click()
   await page.get_by_role('button',name='Download game',exact=True).click(force=True)
   assert await page.locator('.download-game svg').evaluate('(el)=>el.getAnimations().length')==0
   report={'stable_svg':True,'continuous_animation':True,'busy_phases':True,'progress_updates':True,'error_retry':True,'completion':True,'reduced_motion':True}
   (EVIDENCE/'report.json').write_text(json.dumps(report,indent=2)+'\n')
   print(json.dumps(report))
  finally:
   await context.close()

asyncio.run(main())
