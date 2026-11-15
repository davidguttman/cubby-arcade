"""Per-unit identity is not customer state, and reaches native networking early."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from rocknix import image, production_image
from rocknix.device import identity

ROOT = Path(__file__).resolve().parents[1]


class DeviceIdentityTests(unittest.TestCase):
    def test_random_unique_serial_matches_dns_hostname(self):
        first, second = identity.new_identity(), identity.new_identity()
        self.assertNotEqual(first, second)
        self.assertRegex(first['serial'], r'^CB-[0-9A-F]{12}$')
        self.assertEqual(first['hostname'], 'cubby-' + first['serial'][3:].lower())

    def test_runtime_identity_survives_handoff_and_update_pointer_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            cubby = Path(directory)/'cubby'
            record = cubby/'image-provenance/device.json'
            record.parent.mkdir(parents=True)
            record.write_text(json.dumps({'device_cid': None, 'media_identities': {}}))
            first = identity.ensure_identity(record)
            (cubby/'state').mkdir()
            (cubby/'state').rmdir()  # Same state directory removed by handoff.
            (cubby/'current').symlink_to('releases/next-version')
            with patch.object(identity, 'new_identity', side_effect=AssertionError('regenerated')):
                self.assertEqual(identity.ensure_identity(record), first)
            self.assertEqual(json.loads(record.read_text())['network_identity'], first)

    def test_bound_image_record_includes_and_audits_identity(self):
        with patch.object(image, 'source_provenance', return_value={'source_commit':'a'*40,'source_dirty':False}):
            plan = production_image.bind_plan(production_image.source_plan(ROOT), 'b'*32, b'public key')
        record = image.media_identity_record(plan)
        self.assertIn('network_identity', record)
        self.assertEqual(record['network_identity'], plan['network_identity'])
        production_image.validate_binding(plan)
        broken = copy.deepcopy(plan)
        broken['network_identity']['hostname'] = 'cubby-different'
        with self.assertRaises(ValueError):
            production_image.validate_binding(broken)
        broken = copy.deepcopy(plan)
        broken['network_identity']['serial'] = 'CB-'+'A'*12
        broken['network_identity']['hostname'] = 'cubby-'+'a'*12
        with self.assertRaisesRegex(ValueError, 'audited'):
            production_image.validate_binding(broken)

    def test_invalid_or_missing_bound_identity_is_never_silently_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            record = Path(directory)/'device.json'
            for network in [None, {'serial':'CB-ABCDEF123456','hostname':'wrong'},
                            {'serial':'CB-ABCDEF123456','hostname':'cubby-abcdef123456\nother'}]:
                value = {'device_cid':'b'*32}
                if network is not None: value['network_identity'] = network
                record.write_text(json.dumps(value))
                before = record.read_bytes()
                with self.assertRaises(ValueError): identity.ensure_identity(record)
                self.assertEqual(record.read_bytes(), before)

    def test_bound_plan_requires_network_identity_even_with_matching_record_digest(self):
        plan = production_image.bind_plan({'storage_files': {}}, 'b'*32, b'public key')
        del plan['network_identity']
        plan['storage_files']['cubby/image-provenance/device.json'] = production_image.digest(
            json.dumps(image.media_identity_record(plan), sort_keys=True).encode())
        with self.assertRaisesRegex(ValueError, 'network identity'):
            production_image.validate_binding(plan)

    def test_service_orders_after_stock_config_and_before_hostname_and_dhcp(self):
        unit = (ROOT/'rocknix/device/cubby-device-identity.service').read_text()
        self.assertIn('DefaultDependencies=no', unit)
        self.assertIn('After=local-fs.target userconfig.service', unit)
        self.assertIn('Before=network-base.service NetworkManager.service avahi-daemon.service', unit)
        script = (ROOT/'rocknix/device/device-identity-start.sh').read_text()
        self.assertIn('set_setting system.hostname', script)
        self.assertNotIn('current/', script)
        self.assertIn('cubby-device-identity.service', image.BASE_BOOT_HOOK)


if __name__ == '__main__': unittest.main()
