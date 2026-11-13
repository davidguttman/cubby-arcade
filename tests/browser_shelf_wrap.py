#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Shared hub overflow affordance and circular keyboard/native scrolling."""
import argparse
import asyncio
from pathlib import Path
from browser_shelf_scroll import fixture

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
                for view in ('library', 'store'):
                    await page.evaluate('(view)=>hub.show(view)', view)
                    cards = page.locator('.game-card')
                    await cards.first.focus()
                    await page.wait_for_timeout(100)
                    assert await page.locator('.shelf').evaluate("el=>el.classList.contains('is-looping')"), 'overflow must loop'
                    edges = await page.locator('.shelf').evaluate('''el=>{const s=el.getBoundingClientRect();return [s.left+2,s.right-2].map(x=>Array.from(el.children).some(c=>{const r=c.getBoundingClientRect();return r.left<x&&r.right>x;}));}''')
                    assert edges == [True, True], edges
                    assert await page.locator('.shelf-copy button,.shelf-copy[tabindex]').count() == 0
                    await page.keyboard.press('ArrowLeft')
                    assert await cards.last.evaluate('(el)=>el===document.activeElement'), 'left must wrap to last'
                    await page.keyboard.press('ArrowRight')
                    assert await cards.first.evaluate('(el)=>el===document.activeElement'), 'right must wrap to first'
                    for _ in range(32):
                        await page.keyboard.press('ArrowRight')
                    assert await cards.nth(2).evaluate('(el)=>el===document.activeElement')
                    # A native swipe/trackpad scroll crossing either seam remains in the ring.
                    for direction in (-1, 1):
                        before = await page.locator('.shelf').evaluate('el=>el.scrollLeft')
                        await page.locator('.shelf').evaluate('(el,d)=>{el.scrollLeft+=d*el.clientWidth*4;}', direction)
                        await page.wait_for_timeout(100)
                        report = await page.locator('.shelf').evaluate('el=>({x:el.scrollLeft,max:el.scrollWidth-el.clientWidth})')
                        assert 0 < report['x'] < report['max'], report
                        assert report['x'] != before
                    copy = page.locator('.shelf-copy').first
                    game_id = await copy.get_attribute('data-game-id')
                    await copy.dispatch_event('click')
                    assert await page.locator('.game-card.is-selected').get_attribute('data-game-id') == game_id
                    assert await page.locator('.game-card.is-selected').evaluate('(el)=>el===document.activeElement')
                    # Hover can change the preview while the original keeps focus.
                    # Clicking its visual copy must restore that game's preview.
                    original = page.locator(f'.game-card[data-game-id="{game_id}"]')
                    hovered = cards.nth(1)
                    await hovered.dispatch_event('pointerenter', {'pointerType': 'mouse'})
                    assert await page.locator('.game-card.is-selected').get_attribute('data-game-id') == game_id, 'scrolling beneath a stationary mouse must not override the focused game'
                    await hovered.dispatch_event('pointermove', {'pointerType': 'mouse'})
                    assert await page.locator('.game-card.is-selected').get_attribute('data-game-id') != game_id
                    assert await original.evaluate('(el)=>el===document.activeElement')
                    await copy.dispatch_event('click')
                    assert await page.locator('.game-card.is-selected').get_attribute('data-game-id') == game_id, 'copy click must reselect its already-focused original'
                    # Favorites update the authoritative card and both visual copies.
                    badges = page.locator(f'[data-game-id="{game_id}"] .card-badge')
                    assert await badges.count() == 3
                    for expected in ('favorite', ''):
                        await page.locator('.favorite').click()
                        kinds = await badges.evaluate_all('(badges)=>badges.map(badge=>badge.dataset.kind)')
                        assert kinds == [expected] * 3, f'favorite badge must sync on original and copies: {kinds}'
                    await page.wait_for_timeout(250)
                    screenshots.mkdir(parents=True, exist_ok=True)
                    await page.screenshot(path=str(screenshots / f'wrap-{view}-{width}x{height}.png'))
                # Owned Store copies stay dimmed/inert, and wrap skips owned controls.
                owned_fixture = fixture().replace("({...g,id:'offer-'+g.id})", "({...g,id:g.id==='game-0'?'game-0':'offer-'+g.id})")
                await page.route('https://owned.test/', lambda route: route.fulfill(content_type='text/html', body=owned_fixture))
                await page.goto('https://owned.test/')
                await page.locator('.game-card').nth(14).wait_for()
                await page.evaluate("hub.show('store')")
                await page.locator('.game-card:not(:disabled)').first.focus()
                await page.keyboard.press('ArrowLeft')
                assert await page.locator('.game-card:not(:disabled)').last.evaluate('(el)=>el===document.activeElement')
                selected_id=await page.locator('.game-card.is-selected').get_attribute('data-game-id')
                await page.locator('.shelf-copy.is-owned').first.dispatch_event('click')
                assert await page.locator('.game-card.is-selected').get_attribute('data-game-id') == selected_id
                await page.keyboard.press('ArrowRight')
                assert await page.locator('.game-card:not(:disabled)').first.evaluate('(el)=>el===document.activeElement')
                # Recompute on resize, and never repeat or wrap a short row.
                await page.evaluate("games.splice(2);refreshLibrary();hub.show('library')")
                await page.set_viewport_size({'width':1280,'height':800})
                await page.wait_for_timeout(150)
                assert await page.locator('.shelf-copy').count() == 0
                await page.locator('.game-card').first.focus()
                await page.keyboard.press('ArrowLeft')
                assert await page.locator('.game-card').first.evaluate('(el)=>el===document.activeElement')
                await page.set_viewport_size({'width':180,'height':480})
                await page.wait_for_timeout(150)
                assert await page.locator('.shelf-copy').count() > 0
                await page.evaluate('hub.dispose()')
                print(f'{width}x{height}: clipped edges, wrap, scrolling, copy click, resize verified')
            finally:
                await context.close()

if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--cdp',required=True)
    parser.add_argument('--screenshots',type=Path,default=Path('/tmp/cubby-shelf-wrap'))
    args=parser.parse_args()
    asyncio.run(exercise(args.cdp,args.screenshots))
