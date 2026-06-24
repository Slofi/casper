type:: project
status:: planning
tags:: #casper #cc1101 #rf #sdr #subghz
updated:: 2026-06-24

# Casper

> Sub-GHz RF capture and replay web app — CC1101 via SPI on Cyberdeck.
> Auto-synced to Logseq · managed by Claude · source: Projects/casper/casper.md

## State

| **Label**   | value |
|-------------|-------|
| Status      | Built on Testbox; CD deploy paused/offline |
| Hardware    | CC1101 on /dev/spidev0.0 (Rock 5B SPI0 M2) |
| Port        | :5300 |
| Platform    | Cyberdeck (Rock 5B, Armbian GNOME) |
| Style       | Dark/amber — consistent with Banshee + Sonde App |
| UX          | Capture-first handheld flow; auto-classifies saved signals for replay readiness |
| Decode UX   | Capture tab shows simple packet descriptions; Decode tab handles rtl_433 protocol identification |

## Access

| | |
|---|---|
| UI | http://localhost:5300 |
| Service | casper.service (user systemd, on-demand) |
| SSH | ssh slofi@100.97.104.107 |

## Quick Commands

**Start Casper:**
```bash
systemctl --user start casper
```

**Stop Casper:**
```bash
systemctl --user stop casper
```

## Key Paths

| | |
|---|---|
| App | ~/Projects/casper/ |
| Captures | ~/captures/casper/ |
| Service | ~/.config/systemd/user/casper.service |
| GitHub | https://github.com/Slofi/casper |

## Pending

- [x] Replacement CC1101 module arrived and verified working (session 328)
- [x] SPI permissions fixed — `/dev/spidev0.0` accessible by `plugdev` group
- [x] Launcher tile added (fa-ghost, port 5300, before Terminal tile)
- [x] App built by Codex (session 328)
- [x] rtl_433 already installed (v23.11), confirmed working with RTL-SDR
- [x] Add DECODE tab — rtl_433 + CC1101 simultaneous decode+capture
- [x] Add Capture preview table with decoded summary + saved notes
- [x] Capture-first UI: frequency chips, ARM/STOP/SAVE controls, scoped manual tools
- [x] Signal self-inspection: quality labels, replayability, fingerprint, duplicate detection
- [x] Capture tab packet descriptions + mirrored rtl_433 decoded messages during Decode + Capture
- [x] Best Replay recommendation + auto preview duplicate merge by signal fingerprint
- [ ] Re-sync/restart on Cyberdeck when CD is online again
- [ ] Wire CC1101 GPS toggle switch on faceplate

## Changelog

**2026-06-24** — Codex UX/autonomy pass: Capture is now the first screen with handheld-style frequency chips, live tuned/RSSI/buffer readouts, large ARM/STOP/SAVE controls, and manual tools collapsed into an advanced section. Saved signals are now self-inspected server-side with replayability labels (`Replay ready`, `Likely replayable`, `Needs review`, `Signal seen`, `No signal`), quality score, max RSSI, packet/repeat/unique counts, stable fingerprint, and duplicate count for real repeated signals. Library/previews/replay display quality badges; Replay auto-selects the most repeated payload and disables TX for non-replayable energy-only captures. Verified with Python compile, JS syntax check, and Flask test-client `/api/captures` check; live RF hardware path still needs CD validation.
**2026-06-24** — Claude audit follow-up: `/api/replay` now enforces replayability server-side before TX, so browser-side disabling is no longer the only guard.
**2026-06-24** — Capture/Decode UX clarification implemented: Capture tab raw packet buffer now includes a `Packet description` column with safe simple labels such as ASCII/text payload, repeated fixed-code style command, repeated payload, raw RF burst, raw/noisy burst, short pulse payload, weak signal, and byte count. A `Decoded / Identified` panel was added to Capture; rtl_433 messages from Decode Only or Decode + Capture are mirrored there while still appearing on the separate Decode tab. Decode tab remains the deeper protocol-identification view for rtl_433-supported devices.
**2026-06-24** — Best Replay + duplicate handling pass: backend now emits `best_replay` metadata for each capture (`indices`, label, reason) and `/api/replay` uses it by default if no packet selection is supplied. Replay UI selects the recommended payload set and explains why. Auto previews now merge into an existing preview with the same signal fingerprint when still in Previews, recording `sightings` instead of filling the list with duplicate rows; UI shows merged `Seen Nx` badges.
**2026-06-24** — GitHub save checkpoint: rebased over remote `main` checkpoint and pushed to `Slofi/casper` on `main` at commit `2920798` (`Improve capture automation and validation UX`). Working tree clean after push.
**2026-06-08** — Session checkpoint saved on Testbox: Capture tab has Saved Signal Previews table with decoded summary and per-preview notes; Auto Arm saves decoded and RSSI-only previews; Library has folders/notes; DECODE tab implementation is present in working tree. CD went offline during deploy, so re-sync/restart CD when back online. Current save commit pending/pushed from Testbox after this checkpoint.
**2026-06-08** — rtl_433 confirmed installed (v23.11), DECODE tab brief written; custom confirm modal + preview UX polish (session 328)
**2026-06-08** — CC1101 replacement wired + verified, SPI permissions fixed, launcher tile added (session 328)
**2026-05-29** — Project opened, rough spec written (session 314)

---
---
# ////// FULL REFERENCE //////

## Concept

Banshee-style Flask web UI for CC1101 sub-GHz operations. Capture RF packets from sensors, remotes, and other 433/868 MHz devices — save them — replay them. Runs on the Cyberdeck, uses the CC1101 wired directly to Rock 5B GPIO via SPI.

Scope: tight. Three tabs, no feature creep.

---

## Hardware

- **CC1101 RF module** — SPI, 300–928 MHz, OOK/ASK/FSK/GFSK/MSK
- **SPI bus:** SPI0 M2 → `/dev/spidev0.0`
- **Overlay:** `rockchip-rk3588-spi0-spidev.dtbo` (already compiled + enabled)
- **Pinout (VERIFIED — do not change):**

```
CC1101 pin | Function | Rock 5B pin
-----------|----------|------------
Pin 2      | VCC      | Pin 1 (3.3V)
Pin 1      | GND      | Pin 6
Pin 6      | MOSI     | Pin 19
Pin 5      | SCK      | Pin 23
Pin 7      | MISO     | Pin 21
Pin 4      | CSN      | Pin 24
Pin 3      | GDO0     | not connected
Pin 8      | GDO2     | not connected
```

**CRITICAL: Pin 1 = GND, Pin 2 = VCC. Verify with multimeter before powering.**

---

## Software Stack

- **Backend:** Python Flask
- **CC1101 library:** `cc1101` Python package (v3.0.0, already installed)
- **SPI:** `python3-spidev` (already installed)
- **Style:** dark background, amber accents — same as Banshee + Sonde App
- **Service:** user systemd, on-demand (not autostart)

---

## Planned UI — 3 Tabs

### Tab 1: Config
- Frequency selector (433.92 / 868.35 / custom MHz)
- Modulation selector (OOK, FSK2, GFSK)
- Symbol rate (preset: 1k / 2k / 4k / 38.4k / custom)
- Apply button → writes to CC1101 registers
- Live chip status (PARTNUM, VERSION, MARCSTATE)

### Tab 2: Capture
- Start / Stop capture button
- Live RSSI indicator
- Packet list (timestamp, RSSI, hex payload, length)
- Save button → writes .json to ~/captures/casper/
- Filter by RSSI threshold

### Tab 3: Library
- List all saved captures (filename, timestamp, frequency, packet count)
- Add / edit note per capture (free text)
- Rename capture file
- Delete capture
- Click entry to load into Replay tab

### Tab 4: Replay
- Load saved capture file (dropdown or file picker)
- Select packet(s) to replay
- Transmit button → sends via CC1101
- Repeat count + delay between transmissions
- Confirmation of TX done

---

## Frequency Targets

| Band | Use case |
|------|----------|
| 433.92 MHz | Weather sensors, gate remotes, doorbells, TPMS |
| 868.35 MHz | EU IoT devices, some sensors |
| 315 MHz | US remotes (less relevant in EU) |

---

## Constraints & Notes

- One CC1101 = half-duplex. Can't RX and TX simultaneously.
- CD internet during Casper: USB tethering (phone). WiFi adapter exclusively for Banshee when both run.
- GDO0 not connected → interrupt-driven RX not available. Use polling mode.
- `cc1101` Python library `_wait_for_packet()` needs GDO0 — use `_get_received_packet()` polling instead.
- Authorized use only — Filip's own devices and network.

---

## Codex Implementation Brief

**Build the complete Casper Flask app.** Everything below is a spec for Codex — implement it fully, do not leave stubs or placeholders.

---

### 1. File Structure

```
~/Projects/casper/
├── app.py                    ← Flask backend + CC1101 logic (all in one file)
├── templates/
│   └── index.html            ← Single page, all 4 tabs inline
├── static/
│   ├── css/
│   │   └── app.css
│   └── js/
│       └── app.js
└── captures/                 ← Create on startup if missing
```

No build tools. No npm. No bundlers. Plain HTML/CSS/JS, Flask serves everything. Run on port **5300**.

---

### 2. Visual Style — CRITICAL: must match other CD apps exactly

**Read `~/Projects/ops-toc/static/css/app.css` first** and match its style. Copy these CSS variables verbatim:

```css
:root {
  --accent:       #e8b04f;
  --accent-dim:   #33220b;
  --accent-faint: rgba(232,176,79,0.10);
  --accent-mid:   rgba(232,176,79,0.30);
  --accent-bg:    rgba(232,176,79,0.07);
  --accent-muted: #a88449;
  --bg:           #0b0b10;
  --bg2:          #131318;
  --bg3:          #1c1c24;
  --border:       rgba(255,255,255,0.08);
  --text:         #d4dce8;
  --text-muted:   #7a889a;
  --muted:        #7a889a;
  --red:          #ff5050;
  --green:        #4ade80;
  --toolbar-h:    52px;
  --radius:       6px;
}
```

**Layout:** Fixed toolbar (52px), tab bar inside toolbar, scrollable content area fills the rest. No horizontal scroll. Body is `display:grid; grid-template-rows: var(--toolbar-h) 1fr; gap:6px; padding:8px`.

**Toolbar:** dark gradient background, 1px border with `--accent-faint` bottom edge, border-radius 12px. Left: app name **CASPER** in `--accent` color + ghost icon (Unicode 👻 or `fa-ghost` if FA loaded). Right: chip status indicator (colored dot + text: `IDLE` / `RX` / `ERROR`).

**Tabs (4):** `CONFIG` · `CAPTURE` · `LIBRARY` · `REPLAY`. Style: uppercase, 0.7rem, letter-spacing 0.08em. Active tab: `background: var(--accent-bg); border: 1px solid var(--accent-mid); color: var(--accent); border-radius: 6px`. Inactive: dim text, transparent border.

**Buttons:**
```css
.btn { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 14px; cursor: pointer; font: inherit; }
.btn:hover { border-color: var(--accent); color: var(--accent); }
.btn.primary { background: var(--accent); color: #111; border-color: var(--accent); font-weight:600; }
.btn.danger  { border-color: var(--red); color: var(--red); }
.btn:disabled { opacity: 0.35; cursor: not-allowed; }
```

**Cards/panels:** `background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 16px`.

**Inputs/selects:** `background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 10px; font: inherit`. Focus: `border-color: var(--accent); outline: none`.

**Hex data:** monospace font (`font-family: monospace`), `--text-muted` color.

**RSSI bar:** horizontal, `--bg3` track, `--accent` fill, height 8px, border-radius 4px. Value range −120 to 0 dBm. Fill width = `(rssi + 120) / 120 * 100%`.

---

### 3. Backend — app.py

```python
#!/usr/bin/env python3
from flask import Flask, render_template, jsonify, request, Response
import cc1101
import threading, time, json, os, glob

app = Flask(__name__)
CAPTURES_DIR = os.path.expanduser('~/captures/casper')
os.makedirs(CAPTURES_DIR, exist_ok=True)

# ── State ────────────────────────────────────────────────────────────────────
_lock = threading.Lock()
_state = {
    'capturing': False,
    'rssi':      -120,
    'packets':   [],      # current session packets
    'config': {
        'frequency':   433.92,
        'modulation':  'OOK',
        'symbol_rate': 4800,
    },
}
_capture_thread = None
_capture_running = False
_sse_clients = []   # list of queue.Queue for SSE
```

**Modulation map** (use these exact keys):
```python
import queue
MOD_MAP = {
    'OOK':  cc1101.ModulationFormat.OOK_ASK,
    'FSK2': cc1101.ModulationFormat.FSK2,
    'GFSK': cc1101.ModulationFormat.GFSK,
}
```

**Capture thread** — keep the `with cc1101.CC1101()` context open for the duration:
```python
def _run_capture(cfg):
    global _capture_running
    try:
        with cc1101.CC1101() as t:
            t.set_base_frequency_hertz(cfg['frequency'] * 1e6)
            t.set_modulation_format(MOD_MAP[cfg['modulation']])
            t.set_symbol_rate_baud(int(cfg['symbol_rate']))
            t._command_strobe(cc1101.CC1101._SPI_COMMAND_STROBE_SRX)
            while _capture_running:
                pkt = t._get_received_packet()
                rssi = t.get_rssi_dbm()
                with _lock:
                    _state['rssi'] = rssi
                if pkt:
                    entry = {
                        'ts':   time.time(),
                        'rssi': pkt.rssi_dbm,
                        'hex':  pkt.payload.hex(),
                        'len':  len(pkt.payload),
                    }
                    with _lock:
                        _state['packets'].append(entry)
                    _sse_push({'type': 'packet', **entry})
                else:
                    _sse_push({'type': 'rssi', 'value': rssi})
                time.sleep(0.05)
    except Exception as e:
        _sse_push({'type': 'error', 'msg': str(e)})
    finally:
        _capture_running = False
```

**SSE push helper:**
```python
def _sse_push(data):
    dead = []
    for q in _sse_clients:
        try: q.put_nowait(data)
        except: dead.append(q)
    for q in dead: _sse_clients.remove(q)
```

**Routes — implement all of these:**

`GET /` → `render_template('index.html')`

`GET /api/status` →
```json
{"chip_ok": true, "marcstate": "IDLE", "capturing": false, "rssi": -85, "packet_count": 12}
```
- If `_state['capturing']`: return last known rssi from state, skip opening SPI (avoids conflict with capture thread).
- Otherwise: open a brief SPI context to read MARCSTATE; if SPI fails, return `chip_ok: false`.

`POST /api/config` → body `{"frequency":433.92,"modulation":"OOK","symbol_rate":4800}` → update `_state['config']` → `{"ok":true}`

`POST /api/capture/start` → if already capturing return `{"error":"already capturing"}`. Otherwise: clear `_state['packets']`, set `_capture_running=True`, start daemon thread, return `{"ok":true}`.

`POST /api/capture/stop` → set `_capture_running=False`, join thread (timeout 3s), return `{"ok":true}`.

`GET /api/capture/live` → SSE endpoint. Register a `queue.Queue`, stream events as `data: <json>\n\n`. Also stream RSSI heartbeat every 2s even if no packets. On client disconnect, remove queue.

`POST /api/capture/save` → body `{"name":"label"}` → write `_state['packets']` to `CAPTURES_DIR/<name>_<timestamp>.json` using the capture file format below. Returns `{"ok":true,"id":"<filename_no_ext>"}`.

`GET /api/captures` → list all `.json` files in CAPTURES_DIR, return array sorted newest-first:
```json
[{"id":"garage_1234","name":"garage","ts":1234567890,"frequency":433.92,"modulation":"OOK","packet_count":8,"note":"front door remote"}]
```

`POST /api/captures/<id>/note` → body `{"note":"text"}` → load file, update `note` field, save. Returns `{"ok":true}`.

`DELETE /api/captures/<id>` → delete file. Returns `{"ok":true}`.

`POST /api/replay` → body `{"id":"filename","indices":[0,1,2],"repeat":3,"delay_ms":200}` → load file, transmit selected packets via CC1101. Returns `{"ok":true,"sent":9}` or `{"error":"..."}`. Cannot replay while capturing — check and return error.

**Capture file format:**
```json
{
  "name": "label",
  "ts": 1234567890,
  "frequency": 433.92,
  "modulation": "OOK",
  "symbol_rate": 4800,
  "note": "",
  "packets": [
    {"ts": 1234567890.1, "rssi": -72, "hex": "aabbccdd", "len": 4}
  ]
}
```

Run: `app.run(host='0.0.0.0', port=5300, debug=False, threaded=True)`

---

### 4. Frontend — tab by tab

**Tab 1 — CONFIG**

Two sections side by side (flex row, wrap on narrow):

*Settings card (left):*
- **Frequency** — number input (step 0.01, min 300, max 928), default 433.92. Quick preset buttons: `[433.92]` `[868.35]` `[315.00]` — click fills the input.
- **Modulation** — `<select>`: OOK/ASK · FSK 2-FSK · GFSK (values: `OOK`, `FSK2`, `GFSK`)
- **Symbol rate** — `<select>` presets: 1200 · 2400 · 4800 · 9600 · 38400 baud. Plus a custom number input that appears when "Custom" is selected.
- **[Apply Config]** button (primary) → `POST /api/config` with current values.

*Chip status card (right):*
- Large status circle (40px), green=idle, amber=capturing, red=error.
- `MARCSTATE` value in monospace.
- `SPI OK` / `SPI ERROR` badge.
- Auto-refreshes every 3s via `GET /api/status` when not capturing.

**Tab 2 — CAPTURE**

Top bar: `[▶ Start]` (primary) and `[■ Stop]` buttons. Start disabled while capturing, Stop disabled while not capturing.

RSSI meter: label `RSSI`, live dBm value right-aligned, bar below. Updates from SSE stream.

Packet counter: `N packets` — updates live.

Packet table: columns `#` · `Time` · `RSSI` · `Len` · `Payload (hex)`. New packets prepend to top. Max 500 rows shown. Payload truncated to 32 chars with `…` if longer.

Bottom: `[💾 Save Capture]` button. On click: shows inline input (label text field + `[Save]` confirm). On save: `POST /api/capture/save` → show `"Saved: <id>"` message for 3s. Clears the form.

**SSE connection** — connect `EventSource('/api/capture/live')` when capture starts, close when stopped. On `rssi` event: update bar and value. On `packet` event: prepend row to table. On `error` event: show error in red below the buttons.

**Tab 3 — LIBRARY**

`GET /api/captures` on tab open. Show list of capture cards. Each card:
- Header: **name** (bold) + frequency/modulation badge (small amber pill) + packet count
- Timestamp (dim, formatted as `YYYY-MM-DD HH:MM`)
- Note textarea — `rows=2`, placeholder "Add a note…". Auto-save on `blur` → `POST /api/captures/<id>/note`.
- Two buttons: `[Load for Replay]` (navigates to Replay tab with this capture loaded) · `[Delete]` (danger, confirm before `DELETE /api/captures/<id>`, then remove card from DOM).

Empty state: centered text "No captures saved yet. Go capture something."

Refresh button in tab header to reload list.

**Tab 4 — REPLAY**

If no capture loaded: centered message "← Select a capture from the Library tab."

When loaded:
- **Capture header:** name + frequency + modulation + packet count (read-only info row).
- **Packet list with checkboxes:** each row: checkbox · `#` · time offset (ms from first packet) · RSSI · hex payload. "Select all" / "None" links above.
- **Repeat:** number input (1–99), default 1.
- **Delay between repeats:** number input ms, default 200.
- **[📡 Transmit]** button (primary, large, full width) → `POST /api/replay`. While transmitting: button disabled + spinner. After: show `"Sent N packets"` or error.
- Transmit disabled while capturing (show note: "Stop capture first").

---

### 5. Service File

Create `~/.config/systemd/user/casper.service`:
```ini
[Unit]
Description=Casper RF App
After=network.target

[Service]
ExecStart=/usr/bin/python3 /home/slofi/Projects/casper/app.py
WorkingDirectory=/home/slofi/Projects/casper
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

After creating: `systemctl --user daemon-reload` (do not auto-enable or auto-start — on-demand only).

---

### 6. Critical Gotchas

1. **Context manager required.** Always `with cc1101.CC1101() as t:`. Never instantiate without it — SPI fd stays closed until `__enter__`.

2. **No `_wait_for_packet()`.** GDO0 is not connected. This method blocks forever. Use `_get_received_packet()` which returns `None` immediately if no packet available.

3. **SPI is exclusive.** Only one context open at a time. `/api/status` must NOT open SPI while capture thread holds it. Check `_state['capturing']` first.

4. **Thread safety.** Flask is multi-threaded. All reads/writes to `_state['packets']`, `_state['capturing']`, `_state['rssi']` must be inside `with _lock`.

5. **Frequency in Hz.** `set_base_frequency_hertz()` takes Hz not MHz. `config['frequency'] * 1e6`.

6. **Start RX after config.** After applying settings, issue: `t._command_strobe(cc1101.CC1101._SPI_COMMAND_STROBE_SRX)`.

7. **SPI device path.** `/dev/spidev0.0`. User `slofi` is in group `plugdev`. Permissions set by udev rule. No sudo needed.

8. **Replay transmit.** To send a raw packet: `t.transmit(bytes.fromhex(pkt['hex']))`. Re-apply config before transmitting (same flow as capture: set freq/mod/rate, then strobe STX or use `transmit()`).

9. **SSE client cleanup.** SSE clients disconnect silently. Catch all exceptions when pushing to a queue and remove dead clients. Use `maxsize=50` on each queue to prevent memory growth.

10. **Captures directory.** `~/captures/casper/` — `os.makedirs(..., exist_ok=True)` at startup. File IDs are filenames without `.json`. Sanitise the `name` field before using it in a filename: `re.sub(r'[^\w\-]', '_', name)`.

---

## DECODE Tab — rtl_433 + CC1101 Integration Brief

**Goal:** Add a 5th tab **DECODE** (between CAPTURE and LIBRARY). It runs `rtl_433` via subprocess to identify signals using the RTL-SDR, while optionally running CC1101 capture simultaneously. rtl_433 tells you WHAT the signal is; CC1101 captures the raw bytes for replay. One button arms both at once.

This is an additive change — do not break any existing functionality.

---

### Hardware facts (do not change)
- `rtl_433` binary: `/usr/bin/rtl_433`, version 23.11, confirmed working
- RTL-SDR is **separate hardware** from the CC1101 (SPI). They can run **simultaneously** — this is the whole point.
- rtl_433 uses RTL-SDR; CC1101 uses `/dev/spidev0.0`. No conflict between them.
- User: `slofi`. No sudo needed for either.

---

### 1. Tab structure change

Add **DECODE** as the 4th tab. New order: `CONFIG · CAPTURE · DECODE · LIBRARY · REPLAY`

In `index.html`, add:
```html
<button class="main-tab" data-tab="decode">DECODE</button>
```
(between CAPTURE and LIBRARY)

---

### 2. Backend additions — app.py

**New state fields** (add to `_state` dict):
```python
'rtl_active':  False,
'rtl_signals': [],      # decoded signals from current session
```

**New module-level vars:**
```python
_rtl_proc    = None
_rtl_thread  = None
_rtl_running = False
```

**rtl_433 thread:**
```python
def _run_rtl433(freq_mhz):
    global _rtl_running, _rtl_proc
    cmd = ['rtl_433', '-f', f'{freq_mhz}M', '-F', 'json', '-F', 'log', '-M', 'time:utc']
    try:
        _rtl_proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1
        )
        for line in _rtl_proc.stdout:
            if not _rtl_running:
                break
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
                with _lock:
                    _state['rtl_signals'].append(data)
                _sse_push({'type': 'rtl_signal', 'data': data})
            except json.JSONDecodeError:
                pass
    except Exception as exc:
        _sse_push({'type': 'error', 'msg': f'rtl_433: {exc}'})
    finally:
        if _rtl_proc:
            try:
                _rtl_proc.terminate()
                _rtl_proc.wait(timeout=3)
            except Exception:
                pass
        _rtl_running = False
        with _lock:
            _state['rtl_active'] = False
        _sse_push({'type': 'rtl_stopped'})
```

**New routes:**

`POST /api/rtl/start` — body: `{"frequency": 433.92}` (optional, defaults to current config freq)
- If already running: `{"error": "already running"}`
- Clear `_state['rtl_signals']`, set `_state['rtl_active'] = True`, start daemon thread
- Returns `{"ok": true}`

`POST /api/rtl/stop`
- Set `_rtl_running = False`, terminate `_rtl_proc`, join thread (timeout 3s)
- Set `_state['rtl_active'] = False`
- Returns `{"ok": true}`

`POST /api/decode/start` — **the main "Decode + Capture" combined route**
- Starts rtl_433 (`/api/rtl/start` logic)
- AND starts CC1101 capture (`/api/capture/start` logic) simultaneously
- Both run in parallel — this is valid since they use separate hardware
- Returns `{"ok": true, "rtl": true, "cc1101": true}` or partial success with error info if one fails

`POST /api/decode/stop` — stops both rtl_433 and CC1101 capture
- Returns `{"ok": true}`

`POST /api/rtl/save` — save current rtl session signals to library
- body: `{"name": "label"}`
- Saves a capture file with `signal_type: "rtl_decoded"`, packets from rtl signals (empty), plus `rtl_signals` array in a new top-level field
- Returns `{"ok": true, "id": "..."}`

`GET /api/status` — **extend existing response** to include:
```json
{"rtl_active": false, "rtl_count": 0, ...existing fields...}
```

---

### 3. Capture file format — extend for decoded signals

When saving an rtl_433 session, use this format (extends existing format):
```json
{
  "name": "garage_remote",
  "ts": 1234567890,
  "frequency": 433.92,
  "modulation": "OOK",
  "symbol_rate": 4800,
  "note": "",
  "signal_type": "rtl_decoded",
  "rtl_signals": [
    {
      "time": "2026-06-08 12:00:00",
      "model": "Nexus-TH",
      "id": 42,
      "channel": 1,
      "temperature_C": 21.4,
      "humidity": 65,
      "freq": 433.92,
      "rssi": -72.4
    }
  ],
  "packets": []
}
```

When **combined decode+capture** saves, it has BOTH `rtl_signals` AND `packets` populated — this is the richest capture type.

---

### 4. DECODE tab — index.html

Add a new `<section id="tab-decode" class="tab-pane">` with this structure:

**Top controls panel:**
```
[▶ Decode + Capture]   [◉ Decode Only]   [■ Stop]   Freq: [433.92] MHz
```
- "Decode + Capture" = runs rtl_433 + CC1101 simultaneously (the main button, `primary` style)
- "Decode Only" = runs rtl_433 alone (no CC1101)
- "Stop" = stops everything
- Freq input synced with CONFIG tab value

**Status row:**
```
RTL-SDR: [● ACTIVE] / [○ IDLE]    CC1101: [● CAPTURING] / [○ IDLE]    N signals decoded
```
Dots are colored: green=active, dim=idle.

**Signal feed** — scrollable list of decoded signal cards. New signals prepend to top.

Each signal card:
```
┌──────────────────────────────────────────────────────────────┐
│ [model name in accent color, bold]        [time, dim]  [RSSI]│
│ field1: value  field2: value  field3: value  ...             │
│ Freq: 433.92 MHz · OOK                                       │
│         [Load for Replay ↗]  [Save]                          │
└──────────────────────────────────────────────────────────────┘
```
- Model in `--accent` color, bold
- All decoded fields shown as `key: value` pairs (skip internal rtl_433 fields starting with `_`)
- `freq` field shown if present
- **[Load for Replay]** — sets CC1101 config to this signal's frequency, switches to REPLAY tab (or CONFIG tab if no CC1101 capture yet), and pre-fills a replay session with this decode metadata
- **[Save]** — saves just this one signal to library

**If model is "unknown" or not present:** show hex data if available, or "Unrecognised signal" in muted text.

**Empty state:** "No signals decoded yet. Press Decode to start listening."

**[Save Session]** button at bottom of panel — saves all signals in current session to one library entry.

---

### 5. LIBRARY tab — show decoded signal info

In `loadLibrary()`, detect `signal_type === 'rtl_decoded'` and show a different card format:
- Badge: `RTL DECODED` (blue pill) instead of the usual packet count
- Show model names from `rtl_signals` array (e.g. "Nexus-TH × 3")
- Still has [Load for Replay], [Decode], [Delete] buttons
- No [Keep] button (these are already saved, not previews)

In the Decode panel (`decodeCapture`), if `rtl_signals` present: render each rtl signal's fields as a formatted table above the usual hex decode output.

---

### 6. REPLAY tab — show decode context

When a capture loaded for replay has `rtl_signals` populated:
- Show a "Decoded as:" info block above the packet list
- Format: `Nexus-TH — 21.4°C, 65% humidity` (summarise the first/most common signal)
- This tells the user WHAT they're about to replay

---

### 7. app.js additions

**State additions:**
```js
rtlActive:   false,
rtlSignals:  [],
```

**SSE handler additions** (in the existing `onmessage` handler):
```js
case 'rtl_signal':  handleRtlSignal(data.data); break;
case 'rtl_stopped': setRtlActive(false); break;
```

**`handleRtlSignal(sig)`:**
- Push to `state.rtlSignals`
- Prepend a card to `#decode-signal-feed`
- Update signal counter
- If `sig.model` matches something in `state.captures` → highlight (nice-to-have, skip if complex)

**`setRtlActive(bool)`:** updates RTL status dot + disables/enables buttons

**Tab switch:** when switching TO decode tab, update status display. When switching FROM decode tab while active, do NOT stop rtl_433 (let it keep running).

---

### 8. CSS additions

Signal card:
```css
.rtl-card {
  background: var(--bg2);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius);
  padding: 10px 14px;
  margin-bottom: 8px;
}
.rtl-card-model { color: var(--accent); font-weight: 600; font-size: 0.9rem; }
.rtl-card-fields { font-size: 0.82rem; color: var(--text); margin: 6px 0; display: flex; flex-wrap: wrap; gap: 8px 16px; }
.rtl-card-field-key { color: var(--text-muted); }
.rtl-card-meta { font-size: 0.75rem; color: var(--text-muted); }
.rtl-card-actions { display: flex; gap: 8px; margin-top: 8px; }
```

Status dots:
```css
.hw-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border); display: inline-block; }
.hw-dot.active { background: var(--green); box-shadow: 0 0 5px rgba(74,222,128,0.5); }
```

Badge for library:
```css
.badge.rtl { background: rgba(88,166,255,0.12); color: #58a6ff; border-color: rgba(88,166,255,0.3); }
```

---

### 9. Critical notes for Codex

1. **rtl_433 and CC1101 are independent hardware** — they MUST be allowed to run simultaneously. Do not add mutual exclusion between them.

2. **rtl_433 process cleanup** — always call `proc.terminate()` + `proc.wait(timeout=3)` when stopping. If it doesn't exit, call `proc.kill()`. Zombie rtl_433 processes will block the RTL-SDR.

3. **rtl_433 JSON output** — each decoded signal is one JSON object per line on stdout. The `-F json` flag enables this. The `-F log` flag sends rtl_433's own messages to stderr (which we discard with `stderr=subprocess.DEVNULL`). Do not try to parse stderr.

4. **rtl_433 `-M time:utc`** — adds a `time` field to every decoded signal. Always include this flag.

5. **Frequency sync** — the DECODE tab frequency input and the CONFIG tab frequency input should stay in sync. When user changes one, update the other. Use a shared JS variable `state.config.frequency`.

6. **[Load for Replay]** button logic:
   - Set `state.config.frequency` to signal's `freq` field (if present) or current decode freq
   - Set CC1101 modulation to OOK (most 433 MHz devices)
   - Call `POST /api/config` with the values
   - If there are CC1101 packets in the session: load them into the REPLAY tab and switch there
   - If no CC1101 packets yet: switch to CONFIG tab, flash the Apply button to prompt the user

7. **SSE already running** — the existing SSE `EventSource('/api/capture/live')` is always open (it reconnects). The new `rtl_signal` and `rtl_stopped` event types just need to be handled in the existing `onmessage` handler. Do not create a second SSE connection.

8. **rtl_433 may not decode everything** — some signals are unrecognised. rtl_433 still outputs them as `{"model": "unknown", ...}` with pulse analysis. Show these too, marked as "Unrecognised" in muted text.

9. **`_rtl_proc` cleanup on Flask shutdown** — add a signal handler or `atexit` handler that terminates `_rtl_proc` if it's running when the service stops.

10. **Do not rename or restructure existing tabs/routes.** This is purely additive. All existing functionality stays intact.
