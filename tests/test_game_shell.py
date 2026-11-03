"""System controls are a host transformation, never an installed package edit."""
import unittest
from runtime import game_shell


class GameShellTests(unittest.TestCase):
    def test_system_script_precedes_even_first_game_script_and_is_idempotent(self):
        source = b'<!DOCTYPE html><script>playWithoutSDK()</script><canvas></canvas>'
        result = game_shell.inject(source)
        self.assertTrue(result.startswith(b'<!DOCTYPE html>' + game_shell.TAG.encode()))
        self.assertLess(result.index(b'host-osd.js'), result.index(b'game-shell.js'))
        self.assertLess(result.index(b'data-handheld-system'), result.index(b'playWithoutSDK'))
        self.assertEqual(game_shell.inject(result), result)
        prefixed = b'<!-- game -->\n' + source
        self.assertTrue(game_shell.inject(prefixed).startswith(b'<!-- game -->\n<!DOCTYPE html>' + game_shell.TAG.encode()))
        self.assertEqual(game_shell.inject(b'<canvas></canvas>'), game_shell.TAG.encode() + b'<canvas></canvas>')
