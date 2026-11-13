"""Landing-page consent and real browser submission, without a live backend.

Run: uv run --with playwright python -m unittest discover -s tests -p test_marketing_signup.py
"""
from pathlib import Path
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit

from runtime import public_site


ROOT = Path(__file__).resolve().parents[1]
API = 'https://list.cubbyarcade.com/signup'
SDK = 'https://superstruct-marketing.onrender.com/sdk.js'


class MarketingSignup(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise unittest.SkipTest('browser check requires uv run --with playwright') from None
        cls.automation = sync_playwright().start()
        cls.browser = cls.automation.chromium.launch(executable_path='/usr/bin/chromium',
                                                    headless=True, args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.automation.stop()

    def page(self, *, javascript=True, status=202, network_error=False, mobile=False):
        context = self.browser.new_context(java_script_enabled=javascript,
                                           viewport={'width': 390 if mobile else 1440,
                                                     'height': 844 if mobile else 1000},
                                           reduced_motion='reduce')
        self.addCleanup(context.close)
        submissions = []

        def route(request_route):
            request = request_route.request
            if request.url == API:
                submissions.append(request)
                if network_error:
                    request_route.abort()
                else:
                    request_route.fulfill(status=status, content_type='application/json',
                                          headers={'Access-Control-Allow-Origin': 'https://cubbyarcade.com'},
                                          body='{"status":"accepted"}')
            elif request.url == 'https://cubbyarcade.com/':
                request_route.fulfill(content_type='text/html',
                                      body=(ROOT / 'website/index.html').read_text())
            elif request.url.startswith('https://cubbyarcade.com/site/'):
                path = ROOT / 'website' / urlsplit(request.url).path.removeprefix('/site/')
                if path.is_file():
                    request_route.fulfill(path=str(path))
                else:
                    request_route.fulfill(status=404)
            elif request.url == SDK:
                request_route.fulfill(content_type='application/javascript', body='')
            else:
                request_route.abort()

        context.route('**/*', route)
        page = context.new_page()
        page.goto('https://cubbyarcade.com/')
        return page, submissions

    def fill(self, page):
        page.get_by_label('Email address', exact=True).fill('signup-check@example.com')
        page.get_by_label('Email me Cubby Buddy availability updates. Unsubscribe anytime.').check()

    def test_consent_required_then_success_only_after_accepted(self):
        page, submissions = self.page()
        page.get_by_label('Email address', exact=True).fill('signup-check@example.com')
        page.get_by_role('button', name='Join the waitlist').click()
        self.assertEqual(submissions, [])
        self.fill(page)
        page.get_by_role('button', name='Join the waitlist').click()
        page.get_by_text('Check your email to confirm.', exact=True).wait_for()
        self.assertEqual(len(submissions), 1)
        self.assertEqual(parse_qs(submissions[0].post_data), {
            'email': ['signup-check@example.com'], 'consent': ['yes'],
            'consent_version': ['cubby-waitlist-v1']})
        self.assertEqual(submissions[0].header_value('origin'), 'https://cubbyarcade.com')
        self.assertEqual(page.evaluate('localStorage.length + sessionStorage.length'), 0)
        self.assertEqual(page.evaluate('document.cookie'), '')

    def test_server_and_network_errors_preserve_retryable_form(self):
        for settings in ({'status': 503}, {'status': 200}, {'network_error': True}):
            with self.subTest(settings=settings):
                page, submissions = self.page(**settings)
                self.fill(page)
                page.get_by_role('button', name='Join the waitlist').click()
                page.get_by_text('Unable to join right now. Please try again.', exact=True).wait_for()
                self.assertEqual(len(submissions), 1)
                self.assertTrue(page.get_by_role('button', name='Join the waitlist').is_enabled())
                self.assertEqual(page.get_by_label('Email address', exact=True).input_value(),
                                 'signup-check@example.com')
                self.assertEqual(page.get_by_text('Check your email to confirm.', exact=True).count(), 0)

    def test_no_javascript_submits_same_consent_contract(self):
        page, submissions = self.page(javascript=False)
        self.fill(page)
        page.get_by_role('button', name='Join the waitlist').click()
        page.wait_for_url(API)
        self.assertEqual(len(submissions), 1)
        self.assertEqual(submissions[0].method, 'POST')
        self.assertEqual(parse_qs(submissions[0].post_data)['consent_version'], ['cubby-waitlist-v1'])
        self.assertEqual(submissions[0].header_value('origin'), 'https://cubbyarcade.com')

    def test_mobile_layout_and_screenshots(self):
        page, _ = self.page(mobile=True)
        self.assertFalse(page.evaluate('document.documentElement.scrollWidth > innerWidth'))
        for selector in ('input[type=email]', '.waitlist button', '.waitlist-consent'):
            self.assertGreaterEqual(page.locator(selector).bounding_box()['height'], 44)
        shots = Path('/tmp/cubby-marketing-signup')
        shots.mkdir(exist_ok=True)
        page.screenshot(path=str(shots / 'mobile.png'), full_page=True)
        page.set_viewport_size({'width': 1440, 'height': 1000})
        page.screenshot(path=str(shots / 'desktop.png'), full_page=True)

    def test_exported_docs_and_landing_use_only_public_cdn_sdk(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            (output / 'index.html').write_text('native fixture')
            public_site.build(output)
            for path in ('site/index.html', 'docs/game-authoring.html', 'docs/game-release-manifest.html'):
                content = (output / path).read_text()
                self.assertIn(SDK, content)
                self.assertNotIn('saasco', content.lower())


if __name__ == '__main__':
    unittest.main()
