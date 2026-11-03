import hashlib
import http.client
import json
from pathlib import Path
import threading
import unittest
import serve


class HTTPContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.host = serve.server(('127.0.0.1', 0))
        cls.thread = threading.Thread(target=cls.host.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.host.shutdown()
        cls.host.server_close()
        cls.thread.join()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection(*self.host.server_address)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        result = response.status, response.headers, response.read()
        connection.close()
        return result

    def test_json_pointers_cors_and_inventories(self):
        for path in ('/catalog', '/library', '/hub-manifest.json'):
            status, headers, body = self.request('GET', path)
            self.assertEqual(status, 200)
            self.assertEqual(headers['Content-Type'], 'application/json; charset=utf-8')
            self.assertEqual(headers['Access-Control-Allow-Origin'], '*')
            self.assertIn('must-revalidate', headers['Cache-Control'])
            json.loads(body)
        _, _, body = self.request('GET', '/hub-manifest.json')
        for path, expected in json.loads(body)['files'].items():
            status, _, data = self.request('GET', path)
            self.assertEqual(status, 200)
            self.assertEqual(len(data), expected['size'])
            self.assertEqual(hashlib.sha256(data).hexdigest(), expected['sha256'])

    def test_installed_game_and_immutable_store_asset(self):
        for path in ('/games/line-cutter/play.html','/games/little-camp/play.html'):
            status, headers, body = self.request('GET', path)
            self.assertEqual(status, 200)
            self.assertIn('text/html', headers['Content-Type'])
            self.assertNotIn('immutable', headers['Cache-Control'])
        path='/store/line-cutter/0.2.0/trailer-handheld.webm'
        status, headers, body = self.request('GET',path)
        self.assertEqual(status,200)
        self.assertIn('immutable',headers['Cache-Control'])
        self.assertEqual(body,(serve.PUBLIC/path.lstrip('/')).read_bytes())
        status,headers,body=self.request('HEAD',path)
        self.assertEqual(status,200)
        self.assertEqual(body,b'')
        self.assertEqual(int(headers['Content-Length']),(serve.PUBLIC/path.lstrip('/')).stat().st_size)
        status,headers,_=self.request('GET','/store/line-cutter/manifest.json')
        self.assertEqual(status,200)
        self.assertNotIn('immutable',headers['Cache-Control'])

    def test_new_line_cutter_release_is_immutable(self):
        status, headers, body = self.request('GET', '/store/line-cutter/0.2.1/line-cutter-0.2.1.game.zip')
        self.assertEqual(status, 200)
        self.assertIn('immutable', headers['Cache-Control'])
        self.assertEqual(hashlib.sha256(body).hexdigest(), json.loads((serve.PUBLIC/'store/line-cutter/manifest.json').read_text())['package']['sha256'])

    def test_video_byte_ranges_and_invalid_ranges(self):
        path='/store/line-cutter/0.2.0/trailer-handheld.webm'
        full=(serve.PUBLIC/path.lstrip('/')).read_bytes()
        for value,start,end in [('bytes=5-24',5,24),('bytes=-12',len(full)-12,len(full)-1),('bytes=12-',12,len(full)-1)]:
            status,headers,body=self.request('GET',path,headers={'Range':value})
            self.assertEqual(status,206)
            self.assertEqual(body,full[start:end+1])
            self.assertEqual(headers['Content-Range'],f'bytes {start}-{end}/{len(full)}')
            self.assertEqual(int(headers['Content-Length']),len(body))
        for value in ('bytes=999999999999-','bytes=4-1','bytes=-0','bytes=0-1,4-6'):
            status,headers,body=self.request('GET',path,headers={'Range':value})
            self.assertEqual(status,416)
            self.assertEqual(headers['Content-Range'],f'bytes */{len(full)}')
            self.assertEqual(body,b'')

    def test_no_source_listing_or_spa_fallback(self):
        for path in ('/missing','/README.md','/serve.py','/store/','/.handheld-web-export','/%2e%2e/README.md','/store/line-cutter/0.2.0/missing.zip'):
            status,headers,_=self.request('GET',path)
            self.assertEqual(status,404,path)
            self.assertNotIn('immutable',headers['Cache-Control'])

    def test_report_discard_and_preflight(self):
        status,_,body=self.request('POST','/report',body=b'{"preview":true}')
        self.assertEqual((status,body),(204,b''))
        status,_,_=self.request('POST','/catalog',body=b'no mutation')
        self.assertEqual(status,404)
        status,headers,body=self.request('OPTIONS','/catalog',headers={'Origin':'https://example.com','Access-Control-Request-Headers':'Range'})
        self.assertEqual((status,body),(204,b''))
        self.assertEqual(headers['Access-Control-Allow-Headers'],'Range')


if __name__=='__main__':unittest.main()
