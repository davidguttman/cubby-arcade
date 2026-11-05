"""Read kernel-reported battery state; never estimate or invent a charge level."""
from pathlib import Path


def read_battery(root=Path('/sys/class/power_supply')):
    try:
        supplies = sorted(root.iterdir())
    except OSError:
        return {'available': False}
    for supply in supplies:
        try:
            if (supply / 'type').read_text().strip() != 'Battery':
                continue
            present = supply / 'present'
            if present.exists() and present.read_text().strip() != '1':
                continue
            level = int((supply / 'capacity').read_text().strip())
            status = (supply / 'status').read_text().strip()
            if not 0 <= level <= 100 or status not in {'Charging', 'Discharging', 'Full', 'Not charging', 'Unknown'}:
                continue
            return {'available': True, 'level': level, 'charging': status == 'Charging'}
        except (OSError, ValueError):
            continue
    return {'available': False}
