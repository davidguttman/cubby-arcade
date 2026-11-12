#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Real shared hub: a long shelf scrolls without moving the handheld UI."""
import argparse
import asyncio
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def fixture():
    css = ''.join((ROOT / 'runtime/core' / name).read_text() for name in ('screen.css', 'hub.css'))
    scripts = ''.join('<script>' + (ROOT / 'runtime/core' / name).read_text() + '</script>'
                      for name in ('preferences.js', 'input.js', 'hub.js'))
    art = 'data:image/svg+xml,' + '%3Csvg xmlns="http://www.w3.org/2000/svg" width="160" height="120"%3E%3Crect width="160" height="120" fill="%23574381"/%3E%3C/svg%3E'
    games = [{'id': f'game-{i}', 'artwork': art, 'entrypoint': f'/games/{i}'} for i in range(15)]
    setup = 'const games=' + json.dumps(games) + ''';
    window.HandheldPlatform={createPlatform:()=>({capabilities:{},library:async()=>games.map(g=>({...g})),catalog:async()=>games.map(g=>({...g,id:'offer-'+g.id})),onInstallState:fn=>window.refreshLibrary=()=>{games[0].version='new';fn({refresh:{phase:'installed'}});}})};
    window.hub=HandheldHub.mount(document.querySelector('#hub'));
    '''
    return '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + '</style><body class="hub"><main id="hub"></main>' + scripts + '<script>' + setup + '</script>'


async def exercise(cdp, screenshots):
    from playwright.async_api import async_playwright
    async with async_playwright() as automation:
        browser = await automation.chromium.connect_over_cdp(cdp)
        for width, height in [(640, 480), (390, 844), (1280, 800)]:
            context = await browser.new_context(viewport={'width': width, 'height': height}, has_touch=True)
            try:
                page = await context.new_page()
                await page.route('https://shelf.test/', lambda route: route.fulfill(content_type='text/html', body=fixture()))
                await page.goto('https://shelf.test/')
                await page.locator('.game-card').nth(14).wait_for()
                # The handheld cannot depend on a browser's implicit focus scrolling.
                await page.evaluate('''() => {const focus=HTMLElement.prototype.focus;HTMLElement.prototype.focus=function(){focus.call(this,{preventScroll:true});};}''')
                for view in ('library', 'store'):
                    await page.evaluate('(view)=>hub.show(view)', view)
                    await page.locator('.game-card').first.focus()
                    for i in range(15):
                        await page.wait_for_timeout(260)
                        report = await page.evaluate('''() => {
                          const shelf=document.querySelector('.shelf'),card=document.activeElement;
                          const r=card.getBoundingClientRect(),s=shelf.getBoundingClientRect(),hero=document.querySelector('.hero').getBoundingClientRect();
                          return {id:card.dataset.gameId,left:r.left,right:r.right,top:r.top,bottom:r.bottom,
                            shelfLeft:s.left,shelfRight:s.right,shelfBottom:s.bottom,scroll:shelf.scrollLeft,
                            max:shelf.scrollWidth-shelf.clientWidth,heroLeft:hero.left,heroRight:hero.right,
                            pageX:scrollX,pageY:scrollY,bodyWidth:document.body.scrollWidth};
                        }''')
                        assert report['id'] == ('offer-' if view == 'store' else '') + f'game-{i}', report
                        assert report['left'] >= report['shelfLeft'] and report['right'] <= report['shelfRight'], report
                        assert report['heroLeft'] >= 0 and report['heroRight'] <= width, report
                        assert report['shelfBottom'] <= height and report['bodyWidth'] <= width, report
                        assert report['pageX'] == report['pageY'] == 0, report
                        if i < 14:
                            await page.keyboard.press('ArrowRight')
                    assert report['scroll'] > 0 and report['max'] > 0, report
                    if view == 'library':
                        old_selected = await page.locator('.is-selected').element_handle()
                        play = await page.locator('.play-game').element_handle()
                        await play.focus()
                        await page.evaluate('refreshLibrary()')
                        await page.wait_for_function('(card)=>!card.isConnected', arg=old_selected)
                        await page.wait_for_timeout(300)
                        assert await page.locator('.is-selected').get_attribute('data-game-id') == 'game-14'
                        assert await page.locator('.is-selected').evaluate('(card,old)=>card!==old', old_selected)
                        restored = await page.locator('.is-selected').bounding_box()
                        shelf = await page.locator('.shelf').bounding_box()
                        assert restored['x'] >= shelf['x'] and restored['x'] + restored['width'] <= shelf['x'] + shelf['width'], restored
                        assert await play.evaluate('(el)=>el.isConnected&&document.activeElement===el')
                        await page.locator('.game-card').nth(14).focus()
                    screenshots.mkdir(parents=True, exist_ok=True)
                    await page.screenshot(path=str(screenshots / f'{view}-{width}x{height}.png'))
                    for _ in range(14):
                        await page.keyboard.press('ArrowLeft')
                    await page.wait_for_timeout(260)
                    assert await page.locator('.game-card').first.evaluate('(el)=>document.activeElement===el')
                    # Scrolling is not locked to focus/selection.
                    await page.locator('.shelf').evaluate('(el)=>el.scrollLeft=el.scrollWidth')
                    assert await page.locator('.shelf').evaluate('(el)=>el.scrollLeft>0')
                    print(f'{view} {width}x{height}: all 15 cards reachable, selected card visible, shell stationary')
            finally:
                await context.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--cdp', required=True)
    parser.add_argument('--screenshots', type=Path, default=Path('/tmp/cubby-shelf-scroll'))
    args = parser.parse_args()
    asyncio.run(exercise(args.cdp, args.screenshots))
