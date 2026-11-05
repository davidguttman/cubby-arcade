#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright", "pyyaml==6.0.3"]
# ///
"""Adult update controls in an explicit in-memory simulation; no device writes."""
import argparse
import asyncio
from pathlib import Path
import sys
import tempfile
import threading
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from rocknix.server import State,make_server

class Simulation:
    def __init__(self):self.phase='idle';self.calls=[]
    def dispatch(self,body):
        self.calls.append(body['action'])
        if body['action']=='check':self.phase='available'
        if body['action']=='download':self.phase='staged'
        if body['action']=='apply':self.phase='trial'
        return {'phase':self.phase,'configured':True}

async def exercise(cdp,origin,adapter,directory):
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        browser=await p.chromium.connect_over_cdp(cdp)
        page=await browser.contexts[0].new_page()
        await page.set_viewport_size({'width':640,'height':480})
        try:
            errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            await page.add_init_script("window.fixturePad={connected:true,buttons:Array.from({length:16},()=>({pressed:false})),axes:[0,0]}; Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[window.fixturePad]});")
            async def button(i):
                await page.evaluate('(i)=>fixturePad.buttons[i].pressed=true',i)
                await page.wait_for_timeout(80)
                await page.evaluate('(i)=>fixturePad.buttons[i].pressed=false',i)
                await page.wait_for_timeout(80)
            await page.goto(origin+'/adult/updates')
            await page.get_by_text('Cubby is ready.',exact=False).wait_for()
            await page.screenshot(path=str(directory/'adult-update-idle.png'))
            await button(0)
            await page.get_by_text('An update is available.',exact=True).wait_for()
            assert await page.evaluate('document.activeElement.id')=='action'
            await button(0)
            await page.get_by_text('Update verified.',exact=False).wait_for()
            directory.mkdir(parents=True,exist_ok=True)
            await page.screenshot(path=str(directory/'adult-update-staged.png'))
            assert await page.evaluate('document.documentElement.scrollHeight')<=480
            assert await page.evaluate('document.activeElement.id')=='action'
            await button(0)
            await page.get_by_text('Restarting Cubby…',exact=True).wait_for()
            assert adapter.calls.count('apply')==1
            await page.screenshot(path=str(directory/'adult-update-restarting.png'))
            await page.goto(origin+'/adult/updates')
            await page.get_by_role('button',name='Back').click()
            await page.locator('.settings-tile').first.wait_for()
            assert page.url==origin+'/'  # Hub consumed the return marker.
            # Badge: gear tab and Updates tile, quiet once nothing needs doing.
            adapter.phase='available'
            await page.goto(origin+'/')
            await page.locator('.view-tab.has-notice').wait_for()
            await page.wait_for_timeout(300)
            await page.screenshot(path=str(directory/'update-notice-library.png'))
            await page.get_by_role('button',name='options',exact=True).click()
            await page.locator('.settings-tile[data-notice].has-notice').wait_for()
            assert await page.locator('.settings-tile.has-notice').count()==1
            await page.wait_for_timeout(400)
            await page.screenshot(path=str(directory/'update-notice-settings.png'))
            adapter.phase='idle'
            await page.reload()
            await page.get_by_role('button',name='options',exact=True).wait_for()
            await page.wait_for_timeout(300)
            assert await page.locator('.has-notice').count()==0
            assert not errors,errors
            print('SIMULATION: controller check/download/apply UI verified at640x480; no actual update or device write.')
        finally:await page.close()

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--cdp',required=True)
    parser.add_argument('--screenshots',type=Path,required=True);args=parser.parse_args()
    with tempfile.TemporaryDirectory() as t:
        state=State(Path(__file__).resolve().parents[1],t);adapter=Simulation();state.updater=adapter
        server=make_server(state,0);threading.Thread(target=server.serve_forever,daemon=True).start()
        try:asyncio.run(exercise(args.cdp,'http://127.0.0.1:'+str(server.server_address[1]),adapter,args.screenshots))
        finally:server.shutdown();server.server_close()

if __name__=='__main__':main()
