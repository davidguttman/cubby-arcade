#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Hold the embedded document and bootstrap separately: boot paints before both."""
import argparse
import asyncio
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


async def exercise(cdp, origin, screenshots):
    from playwright.async_api import async_playwright
    async with async_playwright() as automation:
        browser = await automation.chromium.connect_over_cdp(cdp)
        for width, height in [(1280, 900), (390, 844)]:
            context = await browser.new_context(viewport={'width': width, 'height': height})
            try:
                native_requested, native_release = asyncio.Event(), asyncio.Event()
                script_requested, script_release = asyncio.Event(), asyncio.Event()
                page = await context.new_page()

                async def native(route):
                    native_requested.set()
                    await native_release.wait()
                    await route.continue_()

                async def bootstrap(route):
                    script_requested.set()
                    await script_release.wait()
                    await route.continue_()

                # Use the exact source wrapper; the real native shell, storage,
                # worker and shared hub still load from the supplied HTTPS site.
                await page.route(origin + '/site/play.html', lambda route: route.fulfill(
                    path=str(ROOT / 'website/play.html'), content_type='text/html'))
                await page.route('**/native/index.html?*', native)
                await page.route('**/runtime/core/browser-bootstrap.js', bootstrap)
                await page.goto(origin + '/site/play.html', wait_until='commit')
                await asyncio.wait_for(native_requested.wait(), 15)
                boot = page.locator('#boot')
                await boot.wait_for(state='visible')
                assert await boot.inner_text() == ''
                screenshots.mkdir(parents=True, exist_ok=True)
                await page.screenshot(path=str(screenshots / f'boot-{width}.png'))
                native_release.set()
                await asyncio.wait_for(script_requested.wait(), 20)
                await boot.wait_for(state='visible')
                # The embed has already announced control readiness, but hub
                # bootstrap is still held: that message must not dismiss boot.
                frame = page.frame_locator('#hub')
                await frame.locator('html[data-cubby-embed="handheld"]').wait_for()
                assert await boot.is_visible()
                script_release.set()
                await frame.locator('#hub .view-tab').first.wait_for(state='visible', timeout=30000)
                await boot.wait_for(state='hidden')
                await page.screenshot(path=str(screenshots / f'loaded-{width}.png'))
                print(f'{width}x{height}: boot before document, survives early ready, reveals mounted hub')
            finally:
                await context.close()
        # Reduced-motion gets an entirely static picture, still with no words.
        context = await browser.new_context(reduced_motion='reduce')
        try:
            page = await context.new_page()
            await page.route(origin + '/site/play.html', lambda route: route.fulfill(
                path=str(ROOT / 'website/play.html'), content_type='text/html'))
            await page.route('**/native/index.html?*', lambda route: route.abort())
            await page.goto(origin + '/site/play.html')
            assert await page.locator('#boot svg').evaluate('(el) => getComputedStyle(el).animationName') == 'none'
            assert await page.locator('.boot-dots i').first.evaluate('(el) => getComputedStyle(el).animationName') == 'none'
            print('Reduced motion: static boot picture')
        finally:
            await context.close()
        context = await browser.new_context()
        try:
            await context.add_init_script("Object.defineProperty(navigator, 'serviceWorker', {value: undefined})")
            page = await context.new_page()
            await page.route(origin + '/site/play.html', lambda route: route.fulfill(
                path=str(ROOT / 'website/play.html'), content_type='text/html'))
            await page.goto(origin + '/site/play.html')
            await page.frame_locator('#hub').locator('.browser-storage-error').wait_for(state='visible')
            await page.locator('#boot').wait_for(state='hidden')
            print('Storage failure: boot reveals the existing error picture')
        finally:
            await context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cdp', required=True)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--screenshots', type=Path, default=ROOT / '.cache/play-boot-screenshots')
    args = parser.parse_args()
    asyncio.run(exercise(args.cdp, args.origin.rstrip('/'), args.screenshots))


if __name__ == '__main__':
    main()
