# Setup guide

A step-by-step walkthrough from nothing to a running alerter. Allow about ten
minutes, most of it waiting for a database download.

For the reference material — every config key, how the pipeline works, what the
data actually is — see the [README](../README.md). This page is just the doing.

---

## Contents

1. [What you need](#1-what-you-need)
2. [Create your config](#2-create-your-config)
3. [Find your coordinates](#3-find-your-coordinates)
4. [Set up your phone](#4-set-up-your-phone)
5. [Test the notification](#5-test-the-notification)
6. [Download the tail database](#6-download-the-tail-database)
7. [Dry run and tune](#7-dry-run-and-tune)
8. [Run it for real](#8-run-it-for-real)
9. [Keep it running](#9-keep-it-running)
10. [Troubleshooting](#troubleshooting)
11. [Stopping and removing it](#stopping-and-removing-it)

---

## 1. What you need

| | |
|---|---|
| **Node.js 20 or newer** | `node --version` to check. Nothing else — there are no dependencies, and no `npm install` step. |
| **A phone** | iOS or Android, for the ntfy app. A desktop browser works too. |
| **A machine that stays awake** | The alerter only runs while the process runs. A laptop that sleeps will miss things. A spare desktop, a Raspberry Pi, or the cheapest VPS all work. |
| **~40 MB of disk** | 31 MB of that is the aircraft database. |

You do **not** need an API key, an account anywhere, a radio receiver, or an
antenna.

---

## 2. Create your config

```sh
cd look-up
npm run init
```

This creates `.env` and generates a private ntfy topic:

```
Created .env
Generated a private ntfy topic: lookup-8eb00226b239

Next:
  1. Set LAT and LON in .env to your coordinate.
  2. Install the ntfy app and subscribe to:  lookup-8eb00226b239
  3. npm run test-notify
```

**Copy that topic somewhere — you need it in step 4.**

> [!IMPORTANT]
> The topic is a password, not a name. Anyone who knows the string can read
> every alert you receive, including your approximate location. Never commit it,
> paste it into `.env.example`, or share it.

`npm run init` will refuse to overwrite an existing `.env`. If you want to start
over, delete `.env` first.

---

## 3. Find your coordinates

Open `.env` and set `LAT` and `LON` to where you want to watch — usually home.

### Decimal degrees (what the file wants)

```ini
LAT=38.889484
LON=-77.035278
```

Negative latitude is south, negative longitude is west. Most of the Americas
have a **negative** longitude; forgetting the minus sign puts you in Asia and
you will see no alerts at all.

**To get them:** long-press your house in Google Maps (or right-click on
desktop) and the decimal pair appears at the top of the menu. Apple Maps: drop a
pin, swipe up on the pin's card.

### If your app gives degrees/minutes/seconds

Some apps show `38°53'22.1"N 77°02'07.0"W`. Convert with:

```
decimal = degrees + minutes/60 + seconds/3600
```

then negate it for S or W. So `77°02'07.0"W` becomes
`-(77 + 2/60 + 7.0/3600)` = `-77.035278`. Or just run:

```sh
node -e "const d=(D,m,s,neg)=>{const v=D+m/60+s/3600;return (neg?-v:v).toFixed(6)};
console.log(d(38,53,22.1,false), d(77,2,7.0,true))"
```

### Set your radius

```ini
RADIUS_NM=10
```

In nautical miles (1 nm ≈ 1.15 miles ≈ 1.85 km).

| Radius | Feels like |
|---|---|
| `10` | Genuinely overhead. Long quiet stretches. |
| `25` | A busy neighbourhood feed. A good starting point. |
| `50+` | Regional traffic. Most of it you could not see even in clear weather. |

> [!NOTE]
> Only a two-decimal rounding of your coordinate (about half a mile) is ever
> sent to the ADS-B feed. Distances and bearings in alerts are computed locally
> from the exact value.

---

## 4. Set up your phone

Install **ntfy** — it is free, open source, and needs no account:

- [App Store](https://apps.apple.com/app/ntfy/id1625396347)
- [Google Play](https://play.google.com/store/apps/details?id=io.heckel.ntfy)
- Or just open [ntfy.sh/your-topic](https://ntfy.sh) in a browser

In the app, tap **+** → *Subscribe to topic* → paste the exact string from step
2. No password, no sign-up. That is the whole setup.

<details>
<summary>Using Pushover instead</summary>

<br>

If you already pay for Pushover, set these in `.env` instead of (or as well as)
`NTFY_TOPIC`:

```ini
PUSHOVER_TOKEN=your-application-token
PUSHOVER_USER=your-user-key
```

Alerts go to every configured target. Pushover's priority scale is narrower than
ntfy's, so `look-up` maps onto it and caps at "high" — it will not send
emergency-priority alerts that demand acknowledgement.

</details>

---

## 5. Test the notification

```sh
npm run test-notify
```

Your phone should buzz within a second or two:

```
look-up test - MILITARY + NO CALLSIGN
If you can read this on your phone, alerts are wired up correctly.
```

Nothing arrived? See [Troubleshooting](#troubleshooting).

### Adjusting how intrusive alerts are

By default everything arrives at ntfy priority **3** — a normal notification,
short vibration and sound. If you want military traffic to be more insistent:

```ini
PRIORITY_MILITARY=5
```

Priority 5 is a repeating long vibration burst that **bypasses Do Not Disturb**.
It is the right setting if you want a C-17 overhead to wake you at 2am, and the
wrong one otherwise. Test it before you commit to it.

---

## 6. Download the tail database

```sh
npm run update-db
```

About 8 MB down, 31 MB on disk, roughly ten seconds.

This is what lets `look-up` name aircraft the feeds cannot. It refreshes itself
every 14 days; you only run this by hand for the first fetch or to force an
early update.

Skipping it is survivable but degrades alerts — unidentified aircraft arrive
labelled `(UNIDENTIFIED)` with a link instead of a type name. Set `TAILDB=false`
if you want to skip it permanently.

---

## 7. Dry run and tune

```sh
npm run once
```

One poll, printed to the terminal, then exits. **This is the command to use
while you dial things in** — it shows you exactly what would have been sent
without waiting around.

```
[20:53:01] Watching 10nm around 38.8895, -77.0353 every 30s. Rules: military, noCallsign, interesting, pia.
[20:53:01]   ALERT    2.8nm E     2175ft  N7751L (CESSNA 172 Skyhawk)  [military]
[20:53:01]  27 aircraft in 10nm via adsb.fi | 5 of interest | 5 alerted
```

Reading a line: distance, compass direction, altitude, aircraft, and which rules
it tripped.

### Only telling me about planes I can actually see

By default `look-up` runs in **overhead-only** mode: it dead-reckons each
aircraft forward and alerts only when its track will carry it through the patch
of sky you can genuinely see. Something interesting that stays 8 nm to your
north never pings you, because you would never spot it.

The knob that matters is the cone angle:

```ini
OVERHEAD_MIN_ELEVATION_DEG=45
```

At 45° the ground radius of "overhead" equals the aircraft's altitude — a jet
at 30,000 ft counts within 4.9 nm, a helicopter at 1,000 ft within 0.16 nm.

| Setting | Effect |
|---|---|
| `60` | Nearly straight up. Very few alerts. |
| `45` | Default. Unmistakably overhead. |
| `30` | High in the sky but off to one side. Roughly 2× the ground radius. |
| `20` | Generous. You will get things you have to hunt for. |

To get more warning, raise the lookahead — but raise the search radius with it,
or the app rejects the config:

```ini
OVERHEAD_LOOKAHEAD_MIN=10
OVERHEAD_SEARCH_NM=100
```

To hear about *every* aircraft passing overhead rather than only flagged ones:

```ini
OVERHEAD_SCOPE=all
```

Expect roughly one alert per airliner that crosses you. On a live test near a
busy corridor, 109 aircraft within 60 nm produced 2 predicted passes.

To go back to plain proximity alerting, `OVERHEAD=false` or
`OVERHEAD_ONLY=false`.

### Too many alerts

Expected on the first run. In rough order of effectiveness:

```ini
MIN_ELEVATION_DEG=30    # only things genuinely high in your sky
MAX_ALT_FT=20000        # drop airliners in cruise
RADIUS_NM=10            # tighten the circle
ALERT_NO_CALLSIGN=false # the noisiest remaining rule
```

`MIN_ELEVATION_DEG` is the least obvious and the most useful. An airliner at
35,000 ft that is 25 nm away is only 13° above your horizon — a speck you will
never pick out. At 30° it is unmistakably overhead.

Two sources of noise worth naming, because both look like bugs and are not:

- **Military flags aero clubs.** The flag covers anything on a military
  registry. A test run over Beale AFB flagged a Cessna 172 belonging to the base
  flying club. Correct per the data, probably not what you want.
- **LADD flags airliners.** The FAA opt-out list is applied liberally and goes
  stale. It is off by default for exactly this reason; leave `ALERT_LADD=false`
  unless you specifically want it.

### No alerts at all

Usually correct behaviour rather than a fault. Check in this order:

1. **Is anything even up?** The summary line prints total aircraft in radius. If
   that says `1 aircraft`, the sky is genuinely empty.
2. **Widen temporarily.** `RADIUS_NM=100 npm run once` — if that finds military
   traffic, your setup works and your radius is just tight.
3. **Check your longitude sign.** A missing minus puts you on the wrong
   continent.

Remember that a tight radius means real silence, sometimes for hours. That is
the setting working.

---

## 8. Run it for real

```sh
npm start
```

It polls every 30 seconds and runs until you press `Ctrl+C`.

This is a foreground process — **closing the terminal stops it.** For anything
longer than an afternoon, see the next section.

> [!NOTE]
> `.env` is read once at launch. Any change to it needs a restart.

---

## 9. Keep it running

### Windows (Task Scheduler)

```powershell
schtasks /create /tn "look-up" /sc onstart /ru "$env:USERNAME" /tr "node C:\repos\look-up\src\index.js"
```

Then open Task Scheduler, find the task, and set *Run whether user is logged on
or not* plus a restart-on-failure rule under **Settings**.

### Linux / Raspberry Pi (systemd)

Create `/etc/systemd/system/look-up.service`:

```ini
[Unit]
Description=look-up aircraft alerter
After=network-online.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/look-up
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now look-up
journalctl -u look-up -f      # watch the log
```

### A note on reliability

If both feeds fail, the loop backs off exponentially (capped at ten minutes) and
keeps trying rather than exiting. You do not need a supervisor to handle network
blips — only to handle reboots and crashes.

---

## Troubleshooting

<details>
<summary><b>"Configuration problems:"</b> on startup</summary>

<br>

The app validates `.env` before doing anything and lists every problem at once:

| Message | Fix |
|---|---|
| `LAT must be set to your latitude...` | `LAT`/`LON` are blank or malformed. See [step 3](#3-find-your-coordinates). |
| `No push target configured` | Set `NTFY_TOPIC`, or both `PUSHOVER_TOKEN` and `PUSHOVER_USER`. |
| `RADIUS_NM must be between 1 and 250` | The upstream API caps at 250 nm. |
| `POLL_SECONDS must be at least 5` | These feeds are volunteer-funded. Leave it at 30. |
| `All alert rules are disabled` | You turned off every `ALERT_*` key, so nothing could ever fire. |

</details>

<details>
<summary><b>The test notification never arrives</b></summary>

<br>

In order of likelihood:

1. **Topic mismatch.** Compare the string in `.env` against the subscription in
   the app, character for character. This is nearly always the cause.
2. **Notification permissions.** Check the ntfy app has permission to notify,
   and is not battery-optimised into silence (Android: Settings → Apps → ntfy →
   Battery → Unrestricted).
3. **An error was printed.** `ntfy HTTP 4xx` in the terminal means the request
   was rejected, not lost. A 403 usually means a topic name that the server is
   reserving or rate-limiting; generate a new one.

</details>

<details>
<summary><b>"poll failed: all ADS-B sources failed"</b></summary>

<br>

Both aggregators were unreachable. The loop retries automatically with
exponential backoff, so this is usually self-healing.

If it persists, check plain connectivity:

```sh
curl -s "https://opendata.adsb.fi/api/v2/lat/38.89/lon/-77.04/dist/20" | head -c 200
```

These are volunteer-run services and do occasionally go down together.

</details>

<details>
<summary><b>Alerts show <code>(UNIDENTIFIED)</code></b></summary>

<br>

The tail database has no row for that hex. Two possibilities:

- **You skipped `npm run update-db`.** Run it.
- **The aircraft genuinely is not catalogued.** The database is
  community-maintained and incomplete, especially for military airframes. The
  alert links to ADSBExchange, which often knows more.

This label is deliberate. An unidentified aircraft is *unknown*, not ordinary —
the rarest thing in the sky can arrive with an empty type field.

</details>

<details>
<summary><b>The same aircraft alerts repeatedly</b></summary>

<br>

It should not. `state.json` remembers what it has told you about, and an
aircraft alerts once until it has been gone for `REVISIT_MINUTES` (default 30).

If you are seeing duplicates, check that `state.json` is writable — the app logs
`[warn] could not write state` if it is not, and without it every restart
forgets everything.

</details>

<details>
<summary><b>Changes to <code>.env</code> do nothing</b></summary>

<br>

`.env` is read once at process start. Restart the app.

If you have an old `npm start` running in another terminal, it is still using
the config from whenever it launched. Check for stray processes:

```powershell
tasklist /FI "IMAGENAME eq node.exe"    # Windows
pgrep -af "node src/index.js"           # Linux/macOS
```

</details>

---

## Stopping and removing it

`Ctrl+C` in the terminal. State is saved on the way out.

Running as a service:

```powershell
schtasks /end /tn "look-up"      # stop now
schtasks /delete /tn "look-up"   # remove the task
```

```sh
sudo systemctl disable --now look-up
```

To reclaim disk, delete `data/` — that is the 31 MB database, and
`npm run update-db` rebuilds it.

Nothing is installed outside the project directory. There is no global state to
clean up.
