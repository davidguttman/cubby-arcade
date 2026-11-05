from pathlib import Path
import os
import socket
import subprocess
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ReadinessTests(unittest.TestCase):
    def scenario(self, explicit='', sockets=(), regular=False, broken_logs=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime, state = root/'runtime', root/'state'
            runtime.mkdir(); state.mkdir()
            if broken_logs:
                (state/'session.log').mkdir()
                (state/'session.previous.log').mkdir()
            else:
                (state/'session.log').write_text('previous session event\n')
            if regular: (runtime/'wayland-0').touch()
            bindir = root/'bin'; bindir.mkdir()
            (bindir/'python3').write_text('#!/bin/sh\nif [ "$1" = -m ]; then exec /bin/sleep 10; fi\nexit 0\n')
            (bindir/'cog').write_text('#!/bin/sh\nprintf "%s" "$WAYLAND_DISPLAY" > "$RESULT"\n')
            for item in bindir.iterdir(): item.chmod(0o755)
            script = (ROOT/'rocknix/session.sh').read_text().replace('/opt/cubby', str(root)).replace('/run/host-runtime', str(runtime)).replace('/var/lib/handheld', str(state))
            # Execute the real control flow, shortening only the retry window.
            script = script.replace('n<300', 'n<30').replace('sleep .1', 'sleep .01')
            path = root/'session.sh'; path.write_text(script)
            holders = []
            def provide():
                for name, delay in sockets:
                    time.sleep(delay)
                    sock=socket.socket(socket.AF_UNIX)
                    sock.bind(str(runtime/name)); holders.append(sock)
            thread = threading.Thread(target=provide)
            thread.start()
            env = {**os.environ, 'PATH': str(bindir)+':'+os.environ['PATH'], 'RESULT': str(root/'result')}
            env.pop('WAYLAND_DISPLAY', None)
            if explicit: env['WAYLAND_DISPLAY'] = str(runtime/explicit[1:]) if explicit.startswith('/') else explicit
            try:
                result = subprocess.run(['bash', str(path)], env=env, capture_output=True, text=True, timeout=3)
                thread.join()
                selected = (root/'result').read_text() if (root/'result').exists() else None
                logs = (state/'session.log').read_text() if (state/'session.log').is_file() else ''
                if not broken_logs:
                    self.assertEqual((state/'session.previous.log').read_text(), 'previous session event\n')
                return result, selected, logs
            finally:
                thread.join()
                for sock in holders: sock.close()

    def test_delayed_auto_and_log(self):
        result, display, logs = self.scenario(sockets=[('wayland-1', .05)])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(display, 'wayland-1')
        self.assertIn('HTTP ready', logs)
        self.assertIn('exit status=0', logs)

    def test_explicit_delayed_does_not_choose_other_socket(self):
        result, display, _ = self.scenario('wayland-2', [('wayland-1',0),('wayland-2',.05)])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(display, 'wayland-2')

    def test_missing_explicit_and_stale_file_timeout(self):
        for explicit, sockets, regular in [('',[],False),('',[],True),('wayland-2',[('wayland-1',0)],False)]:
            result, display, logs = self.scenario(explicit,sockets,regular)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIsNone(display)
            self.assertIn('readiness timed out', logs)
            self.assertIn('exit status=1', logs)

    def test_absolute_display_and_log_failure(self):
        result, display, _ = self.scenario('/wayland-2',[('wayland-2',.05)],broken_logs=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(display.endswith('/runtime/wayland-2'))

    def test_regular_file_ignored_for_delayed_auto_socket(self):
        result, display, _ = self.scenario(sockets=[('wayland-1',.05)],regular=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(display,'wayland-1')

    def test_trial_budget_covers_startup_phases(self):
        from rocknix import updates
        self.assertGreaterEqual(updates.TRIAL_STARTUP_TIMEOUT, 30+30+10+30)


if __name__=='__main__': unittest.main()
