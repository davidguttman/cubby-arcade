"""Real browser storage smoke. Run with uv run --with playwright python.
Uses an isolated context in a Chromium already listening for CDP on 127.0.0.1:18800.
No server is started; set CUBBY_BROWSER_ORIGIN to a static HTTPS deployment.
"""
import asyncio,json,os
from pathlib import Path
ORIGIN=os.environ.get('CUBBY_BROWSER_ORIGIN','https://cubby-web-installs.davidguttman.jump.sh').rstrip('/')
EVIDENCE=Path(os.environ.get('CUBBY_BROWSER_EVIDENCE','/tmp/cubby-browser-evidence'))
EVIDENCE.mkdir(parents=True,exist_ok=True)
from playwright.async_api import async_playwright
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.connect_over_cdp('http://127.0.0.1:18800')
  context=await browser.new_context(viewport={'width':1100,'height':760})
  page=await context.new_page()
  page.on('pageerror',lambda e:print('PAGEERROR',e))
  await page.goto(ORIGIN+'/play')
  await page.wait_for_function('window.HandheldPlatformOptions?.bridge',timeout=45000)
  print(await page.evaluate('HandheldPlatformOptions.bridge.catalog()'))
  await page.get_by_role('button',name='store',exact=True).click()
  await page.locator('[data-game-id="trail-mix"]').click()
  await page.get_by_role('button',name='Download game',exact=True).click()
  await page.wait_for_selector('.play-game',timeout=120000)
  # A synthetic quota failure exercises rollback using real IDB and caches.
  assert await page.evaluate("""async()=>{
   const bridge=HandheldPlatformOptions.bridge,before=JSON.stringify(await bridge.library()),original=caches.open.bind(caches);
   caches.open=async name=>{const cache=await original(name);if(!name.startsWith('cubby-game-'))return cache;return {put:async()=>{throw new DOMException('Storage full','QuotaExceededError');}};};
   let rejected=false;try{await bridge.install('trail-mix');}catch{rejected=true;}finally{caches.open=original;}
   return rejected&&before===JSON.stringify(await bridge.library());
  }""")
  print(await page.evaluate('HandheldPlatformOptions.bridge.library()'))
  await page.reload()
  await page.wait_for_selector('.game-card')
  await page.screenshot(path=str(EVIDENCE/'library-desktop.png'))
  await page.locator('.game-card').click()
  await page.screenshot(path=str(EVIDENCE/'detail-desktop.png'))
  await context.set_offline(True)
  await page.get_by_role('button',name='Play game',exact=True).click()
  await page.wait_for_selector('canvas')
  await page.screenshot(path=str(EVIDENCE/'offline-game.png'))
  print('offline game',page.url)
  await page.evaluate('localStorage.setItem("handheld:trail-mix:integration-save",JSON.stringify({ok:true}))')
  await page.keyboard.press('Escape')
  await page.get_by_role('button',name='Return to library',exact=True).click()
  await page.wait_for_selector('.game-card')
  await page.locator('.game-card').click()
  await page.get_by_role('button',name='Uninstall game',exact=True).click()
  assert await page.evaluate('document.activeElement.getAttribute("aria-label")')=='Cancel uninstall'
  await page.screenshot(path=str(EVIDENCE/'confirm-desktop.png'))
  await page.set_viewport_size({'width':390,'height':844})
  await page.screenshot(path=str(EVIDENCE/'confirm-mobile.png'))
  print(await page.locator('dialog[open] button').evaluate_all('(els)=>els.map(e=>e.getAttribute("aria-label"))'))
  await page.get_by_role('button',name='Cancel uninstall',exact=True).click()
  assert len(await page.evaluate('HandheldPlatformOptions.bridge.library()'))==1
  await page.get_by_role('button',name='Uninstall game',exact=True).click()
  await page.get_by_role('button',name='Confirm uninstall; keep saves',exact=True).click()
  await page.wait_for_selector('dialog[open]',state='hidden')
  assert await page.evaluate('HandheldPlatformOptions.bridge.library()')==[]
  assert await page.evaluate('JSON.parse(localStorage.getItem("handheld:trail-mix:integration-save")).ok')
  assert not [n for n in await page.evaluate('caches.keys()') if n.startswith('cubby-game-')]
  await context.set_offline(False)
  await page.evaluate('HandheldPlatformOptions.bridge.install("trail-mix")')
  assert len(await page.evaluate('HandheldPlatformOptions.bridge.library()'))==1
  assert await page.evaluate('JSON.parse(localStorage.getItem("handheld:trail-mix:integration-save")).ok')
  await page.evaluate('HandheldPlatformOptions.bridge.install("line-cutter")')
  games=await page.evaluate('HandheldPlatformOptions.bridge.library()')
  assert len(games)==2
  line=next(game for game in games if game['id']=='line-cutter')
  await context.set_offline(True)
  await page.goto(ORIGIN+line['entrypoint'])
  await page.wait_for_selector('canvas')
  await page.screenshot(path=str(EVIDENCE/'line-cutter-offline.png'))
  report={'line_cutter_live_install_offline':True,'install_ui':True,'real_storage':True,'quota_rollback':True,'offline_game':True,'offline_hub':True,'system_menu_return':True,'cancel_default':True,'cancel_preserves_game':True,'confirmed_uninstall':True,'save_retained':True,'reinstall':True}
  (EVIDENCE/'report.json').write_text(json.dumps(report,indent=2)+'\n')
  print(report)
  await context.close()
asyncio.run(main())
