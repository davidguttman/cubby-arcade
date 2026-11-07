# RG353V sleep and power

`rocknix/device/power.py` runs outside the chroot, started by `rocknix/network.py`
for the life of the session. It is delivered in the device bundle, so releases in
either layout carry it. If it can't run, stock ROCKNIX sleep still works.

## One path into sleep

The power button stays with logind. The controller holds logind's sleep delay lock
and watches `PrepareForSleep`, so every route into sleep goes through the same steps:

1. Block the power key, power the display off through Sway, and mute.
2. Send `handheld:sleep` to the game (see `docs/game-authoring.md`) and wait up to
   2 seconds for listeners.
3. Stop Cog and its WebKit processes, read the battery, set the clock's wake alarm,
   and release the lock.

**The display has to go off through Sway.** Turning off only the backlight doesn't
hold: the panel driver turns it back on during kernel resume, before anything here
runs. With the output off, the panel stays disabled through resume.

## Idle timer

After 10 minutes without input the device asks logind to suspend. Input comes from
`/dev/input`, below every page, so frozen game packages need nothing. Stick jitter and
motion sensors don't count. The timer waits during an update check, download or trial,
a game install, network setup, or HDMI output, and sleeps once that ends.

It doesn't run on external power: there's no battery to save, background updates keep
running and the device stays reachable. It restarts from zero when the charger is
unplugged.

## Low battery

Each sleep starts a measurement: read the battery, wake on the alarm 15 minutes later,
read it again, and work out when it would reach 10%. Sleep until then (at most 12 hours,
at least 15 minutes), re-measure, and power off cleanly at or under 10%, otherwise
recompute.

- The reading is `charge_now / charge_full`, falling back to `capacity`. If it hasn't
  moved, the wait doubles and the earlier reading stays the baseline.
- `voltage_avg` at or below `voltage_min_design` powers off whatever the counter says.
- On external power nothing powers off, and it checks again hourly.
- At or under 10% when going to sleep, it still sleeps for the first 15 minutes, so
  someone can come back to it.
- After three failed readings it stops waking. If the alarm can't be set or the display
  can't go off, it sleeps with no timed wake, like stock.

## Dark wakes

A wake stays dark only if every sign agrees: the alarm was due, the RTC interrupt
count rose, the power key interrupt count didn't, and the input watcher saw no press.
Anything else lights up as a real wake, so a person's press always works. A press during
a dark wake, when the next suspend is already on its way, brings it straight back about
3 seconds later. Cog stays
stopped, the display off and the sink muted until then. A step that stalls also ends
lit, and a marker in `/run` restores the display if the helper dies while dark.
Before temporarily muting, the helper also saves the previous mute state to
`/storage/cubby/state/power-audio.json`, because WirePlumber saves the temporary mute
across reboot but `/run` disappears. Startup recovers that record; failed audio or
display restoration keeps it and retries while awake. Only a verified restoration
removes it. An already-muted speaker stays muted; a second sleep never mistakes our
temporary mute for the original state. `power.log` records saved-state recovery,
the first failed restore (without repeating every second), and verified success.
Unreadable or corrupt recovery records are retained, never treated as absent.

The power key stays blocked in logind while asleep and for 2 seconds after waking, so
the press that wakes the device can't also put it back to sleep.

## Settings and log

`/storage/cubby/state/power.json` can override the defaults in `power.py`, including
`idle_seconds` and `sleep_on_external_power`. Unknown keys and wrong types are
ignored. `power_supply_dir` and `poweroff_dry_run` exist for hardware tests. Every
sleep, measurement and wake is logged to `/storage/cubby/state/power.log`.

## Hardware validation

On 2026-11-06 an RG353V on USB power ran this on the 0.22.0 release, with a fake
battery for the drain:

- A power key event injected at the kernel input device slept from a running game. The
  game heard `handheld:sleep` with the reason, and its `waitUntil` finished first.
- The idle timer slept on time, and on a real charger with default rules it didn't.
- The display stayed disabled, the sink muted and Cog stopped through every dark wake.
- Drain measurements and a dry-run power-off at 9% ran through real suspends, and the
  real battery read correctly through them.
- A wake earlier than the alarm lit up in under a second. A helper replaced while dark
  restored the display and sound.
- Music and input came back after every real wake.

**Not yet proven:** real drain on battery power, a physical power button press, a real
power-off, whether the panel shows any light to the eye during a dark wake, and long sleeps.

When testing, cap `max_wake_seconds`: a fake battery that never drains backs off for
hours, and the device looks dead. The kernel refuses to overwrite an armed wake alarm
without clearing it first.
