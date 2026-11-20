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

Mute is not a user setting: silence means volume zero. At startup and once per
second while awake, the existing power helper checks the default speaker and clears
any mute without changing volume. During gameplay it also clears mute on active,
uncorked Cog application streams, checking the result after each change. The
`/api/power-state` gameplay flag keeps intentionally muted hub previews and unrelated
applications alone; old servers without the flag leave streams untouched. Server and
PulseAudio queries use the same short timeout. It retries if audio starts late or a command fails,
and verifies the unmute by reading it back. Input events cannot make the check run
more often. The check never runs during managed sleep, dark wakes or power-off.
Wake restoration always unmutes; only the temporary internal sleep mute is allowed.
On devices using stock fake suspend, ROCKNIX's power-suspend and lid-closed flags
also defer audio/display recovery until resume. If the sleep-signal monitor exits,
the helper releases its power locks and keeps this stock-sleep-aware audio check.

There is no saved user mute state or new durable audio recovery record. Startup
unmutes even after a reboot erased `/run`. Legacy `power-audio.json` records, including
ones saying `muted: true`, are treated only as a request for display/audio recovery
and removed after verified recovery; their contents cannot block unmuting. Failed
wake restoration keeps the dark marker and retries while awake. `power.log` records
the first failure (without repeating every second) and verified recovery.

The power key stays blocked in logind while asleep and for 2 seconds after waking, so
the press that wakes the device can't also put it back to sleep.

## Settings and log

`/storage/cubby/state/power.json` can override the defaults in `power.py`, including
`idle_seconds` and `sleep_on_external_power`. Unknown keys and wrong types are
ignored. `power_supply_dir` and `poweroff_dry_run` exist for hardware tests. Every
sleep, measurement and wake is logged to `/storage/cubby/state/power.log`.

## Hardware testing

Tested on an RG353V on USB power (release 0.22.0), with a simulated battery for
the drain measurements:

- A power key event injected at the kernel input device slept from a running game. The
  game heard `handheld:sleep` with the reason, and its `waitUntil` finished first.
- The idle timer slept on time, and on a real charger with default rules it didn't.
- The display stayed disabled, the sink muted and Cog stopped through every dark wake.
- Drain measurements and a dry-run power-off at 9% ran through real suspends, and the
  real battery read correctly through them.
- A wake earlier than the alarm lit up in under a second. A helper replaced while dark
  restored the display and sound.
- Music and input came back after every real wake.

When testing, cap `max_wake_seconds`: a fake battery that never drains backs off for
hours, and the device looks dead. The kernel refuses to overwrite an armed wake alarm
without clearing it first.

### Bounded maintainer probe

`rocknix/device/sleep_probe.py` is an explicitly invoked, stdlib-only native test,
not a background service. Copy the reviewed script to `/tmp` on the pinned target
and run `python3 /tmp/sleep_probe.py preflight` first. Preflight does not suspend,
change settings, or arm an alarm: it checks deep sleep, a clear writable RTC alarm,
awake display/audio/Cog, and exactly one power-capable kernel input. It opens that
input and verifies `KEY_POWER` with the kernel before any suspend. The characterized
input is named **`rk805 pwrkey`**; `rk805_pwrkey/input0` is its physical path, not its
name. Never assume an event number or match only that old underscore spelling.

Run `python3 /tmp/sleep_probe.py run` in a detached **systemd transient unit**, not
an SSH-dependent foreground session or the Cubby session's process group. For
example, after checking that the unit and output paths are not already in use:

```sh
systemd-run --unit=cubby-sleep-probe /bin/sh -c \
  'python3 /tmp/sleep_probe.py run > /tmp/cubby-sleep-probe.json 2> /tmp/cubby-sleep-probe.log'
```

The run repeats preflight, proves the RTC can arm/clear an alarm, creates an
exclusive temporary `power.json` (refusing any existing file or link), and restarts
Cubby to load a 15-second wake interval with a 30-second cap. It confirms the power
helper loaded the test settings before requesting suspend. A local process checks
`CLOCK_BOOTTIME - CLOCK_MONOTONIC` for actual suspension, then injects a power-key
press through its already-open input during the RTC wake. It requires fresh power
log restoration evidence plus lit display, unmuted speaker and running Cog. Its
90-second boottime budget includes suspension, but like any userspace timeout it
can act only when the CPU resumes. It does not claim a hard recovery guarantee if
hardware fails to wake.

On success, ordinary failure, SIGINT or SIGTERM, it removes only its exact,
unchanged settings file and verifies restart with normal defaults. If another
actor replaces/changes that file, the probe preserves it and fails. SIGKILL, power
loss or a kernel that never resumes cannot execute userspace cleanup: recover
pinned access, inspect the exact settings and receipt, and restore only the
probe-owned state before handoff. Never reset unrelated settings or update state.

Read `/tmp/cubby-sleep-probe.json` and inspect the actual screen after reconnecting.
A passing receipt verifies automatic RTC wake and the injected kernel power-key
path, **not physical switch actuation**, speaker acoustics, or USB recovery.
Check USB and Wi-Fi independently with pinned identity; an unreachable SSH address
alone proves neither that the unit is asleep nor that a human power press is
needed. Preserve the receipt, relevant power log and post-wake screenshot, then
verify both recovery transports and clean customer state separately.
