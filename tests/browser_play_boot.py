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


async def local_shell(page):
    async def vendor(route):
        name = route.request.url.split('/site/vendor/cubby-buddy-shell/', 1)[1].split('?', 1)[0]
        await route.fulfill(path=str(ROOT / 'website/vendor/cubby-buddy-shell' / name))
    await page.route('**/site/vendor/cubby-buddy-shell/**', vendor)


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
                await local_shell(page)

                async def native(route):
                    native_requested.set()
                    await native_release.wait()
                    await route.continue_()

                async def bootstrap(route):
                    script_requested.set()
                    await script_release.wait()
                    await route.continue_()

                async def boot_asset(route):
                    name = route.request.url.rsplit('/', 1)[-1]
                    path = ROOT / ('rocknix/splash/preview.png' if name == 'boot.png' else 'website/boot.webp')
                    await route.fulfill(path=str(path), content_type='image/png' if name == 'boot.png' else 'image/webp')

                await page.route('**/site/boot.*', boot_asset)
                # Use the exact source wrapper; the real native shell, storage,
                # worker and shared hub still load from the supplied HTTPS site.
                await page.route(origin + '/site/play.html', lambda route: route.fulfill(
                    path=str(ROOT / 'website/play.html'), content_type='text/html'))
                await page.route('**/native/index.html?*', native)
                await page.route('**/runtime/core/browser-bootstrap.js', bootstrap)
                await page.goto(origin + '/site/play.html', wait_until='commit')
                await asyncio.wait_for(native_requested.wait(), 15)
                boot = page.locator('.cubby-boot')
                await boot.wait_for(state='visible')
                assert await boot.inner_text() == ''
                await page.locator('.cubby-boot > img').evaluate('(img) => img.decode()')
                assert await page.locator('.cubby-boot > img').evaluate('(img) => img.naturalWidth') == 640
                await page.locator('.cubby-stars img').evaluate('(img) => img.decode()')
                # Native-rendered stars must really animate, not just show the poster.
                first = await page.locator('.cubby-stars').screenshot()
                await page.wait_for_timeout(700)
                assert first != await page.locator('.cubby-stars').screenshot()
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
                # Plastic controls still reach the focused iframe after the shell
                # owns lifecycle handling; focus must never suspend that iframe.
                await frame.locator('html').evaluate("() => { window.__shellMessages=[]; addEventListener('message', e => { if(e.data?.type==='cubby:embed:v1') __shellMessages.push(e.data); }); }")
                await page.locator('.cubby-menu').click(force=True)
                await page.wait_for_timeout(100)
                messages = await frame.locator('html').evaluate('() => window.__shellMessages')
                assert any(m.get('button') == 'select' and m.get('down') is True for m in messages), messages
                assert any(m.get('button') == 'select' and m.get('down') is False for m in messages), messages
                assert not any(m.get('event') == 'active' and m.get('active') is False for m in messages), messages
                assert await page.evaluate("document.activeElement.id === 'hub'")
                await page.screenshot(path=str(screenshots / f'loaded-{width}.png'))
                print(f'{width}x{height}: boot before document, survives early ready, reveals mounted hub')
            finally:
                await context.close()
        # Reduced-motion gets an entirely static picture, still with no words.
        context = await browser.new_context(reduced_motion='reduce')
        try:
            page = await context.new_page()
            await local_shell(page)
            await page.route(origin + '/site/play.html', lambda route: route.fulfill(
                path=str(ROOT / 'website/play.html'), content_type='text/html'))
            await page.route('**/site/boot.png', lambda route: route.fulfill(
                path=str(ROOT / 'rocknix/splash/preview.png'), content_type='image/png'))
            await page.route('**/native/index.html?*', lambda route: route.abort())
            await page.goto(origin + '/site/play.html')
            await page.locator('.cubby-boot > img').evaluate('(img) => img.decode()')
            assert await page.locator('.cubby-boot > img').evaluate('(img) => img.currentSrc.endsWith("/assets/boot.png")')
            assert not await page.locator('.cubby-stars').is_visible()
            assert await page.locator('.cubby-fill').evaluate('(el) => getComputedStyle(el).animationName') == 'none'
            first = await page.locator('.cubby-boot').screenshot()
            await page.wait_for_timeout(700)
            assert first == await page.locator('.cubby-boot').screenshot()
            print('Reduced motion: static boot picture')
        finally:
            await context.close()
        context = await browser.new_context()
        try:
            await context.add_init_script("Object.defineProperty(navigator, 'serviceWorker', {value: undefined})")
            page = await context.new_page()
            await local_shell(page)
            await page.route(origin + '/site/play.html', lambda route: route.fulfill(
                path=str(ROOT / 'website/play.html'), content_type='text/html'))
            await page.goto(origin + '/site/play.html')
            await page.frame_locator('#hub').locator('.browser-storage-error').wait_for(state='visible')
            await page.locator('.cubby-boot').wait_for(state='hidden')
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
