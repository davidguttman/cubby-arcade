#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright==1.65.2"]
# ///
"""Computed-style guards for measured handheld paint-cost optimizations.

No server or remote media is needed. This is not a hardware timing benchmark.
"""
import argparse
import asyncio
import re

from browser_shelf_scroll import fixture


def shadow_lengths(shadow):
    # Chromium resolves colors to rgb()/rgba(); remove them before reading lengths.
    return [float(x) for x in re.findall(r'(-?[\d.]+)px', re.sub(r'rgba?\([^)]*\)', '', shadow))]


def check(report):
    assert report['backdrop'] == 'none', 'handheld blurred backdrop must remain hidden'
    for card in report['cards']:
        label = card['label']
        assert card['transitionProperty'] == 'none' or all(
            float(value.removesuffix('s')) == 0 for value in card['transitionDuration'].split(', ')
        ), f'{label}: shelf cards must not interpolate selection effects'
        assert card['animationName'] == 'none', f'{label}: shelf animation reintroduced'
        if card['selected']:
            lengths = shadow_lengths(card['boxShadow'])
            assert len(lengths) == 4 and lengths[:3] == [0, 0, 0] and lengths[3] >= 4, (
                f'{label}: selection must use one unblurred ring: {card["boxShadow"]}'
            )
            assert 'rgb(255, 201, 77)' in card['boxShadow'], f'{label}: visible gold ring missing'
        else:
            assert card['boxShadow'] == 'none', f'{label}: idle card shadow reintroduced'
    assert any(card['selected'] and card['copy'] for card in report['cards']), 'selected copies exercised'
    assert any(not card['selected'] and card['copy'] for card in report['cards']), 'idle copies exercised'
    for item in report['decorations']:
        assert item['animationName'] == 'none', f'{item["label"]}: idle decoration animation reintroduced'


async def inspect(page):
    return await page.evaluate('''() => {
      const shelf=document.querySelector('.shelf');
      const style=el=>{const s=getComputedStyle(el);return {
        boxShadow:s.boxShadow,animationName:s.animationName,
        transitionProperty:s.transitionProperty,transitionDuration:s.transitionDuration};};
      return {backdrop:getComputedStyle(document.querySelector('.hero-backdrop')).display,
        cards:[...shelf.children].map((el,i)=>({...style(el),label:el.className+' '+i,
          copy:el.classList.contains('shelf-copy'),
          selected:el.matches('.is-selected,.is-copy-selected,:focus,:focus-visible')})),
        decorations:[...document.querySelectorAll('.detail .stage,.detail-actions,.play-game svg,.brand-face circle,.rest-hint svg,.shelf-status.empty svg,.shelf-status.error svg')]
          .map(el=>({...style(el),label:el.className.baseVal||el.className||el.tagName}))};
    }''')


async def exercise(executable=None, verify_guards=False):
    from playwright.async_api import async_playwright
    async with async_playwright() as automation:
        browser = await automation.chromium.launch(headless=True, executable_path=executable)
        try:
            page = await browser.new_page(viewport={'width': 640, 'height': 480}, reduced_motion='no-preference')
            html = fixture().replace('window.hub=HandheldHub.mount', "window.CubbyDeviceProfile='rg353v';window.hub=HandheldHub.mount")
            await page.route('https://shelf.test/', lambda route: route.fulfill(content_type='text/html', body=html))
            await page.goto('https://shelf.test/')
            await page.locator('.game-card').nth(14).wait_for()
            for view in ('library', 'store'):
                await page.evaluate('(view)=>hub.show(view)', view)
                for index in (0, 1, 14):
                    await page.locator('.game-card').nth(index).focus()
                    check(await inspect(page))
                # Focus can select an original independently of the controller's selected class.
                await page.locator('.play-game,.download-game,.not-installed').first.focus()
                check(await inspect(page))
                print(f'{view}: original/copy gold rings, idle shadows, transitions, backdrop and decorations passed')
            if verify_guards:
                regressions = {
                    'blurred selection shadows': '.hub .device-hub :is(.game-card,.shelf-copy):is(.is-selected,.is-copy-selected,:focus,:focus-visible){box-shadow:0 0 0 4px #ffc94d,0 0 26px 4px rgba(255,184,56,.45)!important}',
                    'idle shadows': '.hub .device-hub :is(.game-card,.shelf-copy){box-shadow:0 3px 12px #000!important}',
                    'shadow interpolation': '.hub .device-hub :is(.game-card,.shelf-copy){transition:box-shadow .2s!important}',
                    'blurred backdrop': '.device-hub .hero-backdrop{display:block!important}',
                    'idle animation': '.device-hub .brand-face circle{animation:blink 6s infinite!important}',
                }
                for name, css in regressions.items():
                    override = await page.add_style_tag(content=css)
                    try:
                        try:
                            check(await inspect(page))
                        except AssertionError as error:
                            print(f'RED verified ({name}): {error}')
                        else:
                            raise AssertionError(f'guard failed to reject {name}')
                    finally:
                        await override.evaluate('(el)=>el.remove()')
                check(await inspect(page))
                print('GREEN: tracked CSS passes after all injected regressions are removed')
            await page.evaluate('hub.dispose()')
        finally:
            await browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser-executable', help='Optional installed Chromium path; CI uses Playwright Chromium')
    parser.add_argument('--verify-guards', action='store_true', help='Also prove known CSS regressions are rejected in memory')
    args = parser.parse_args()
    asyncio.run(exercise(args.browser_executable, args.verify_guards))
