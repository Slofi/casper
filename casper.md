type:: project
status:: planning
tags:: #casper #cc1101 #rf #sdr #subghz
updated:: 2026-05-29

# Casper

> Sub-GHz RF capture and replay web app — CC1101 via SPI on Cyberdeck.
> Auto-synced to Logseq · managed by Claude · source: Projects/casper/casper.md

## State

| **Label**   | value |
|-------------|-------|
| Status      | Planning — waiting for replacement CC1101 module |
| Hardware    | CC1101 on /dev/spidev0.0 (Rock 5B SPI0 M2) |
| Port        | :5300 (proposed) |
| Platform    | Cyberdeck (Rock 5B, Armbian GNOME) |
| Style       | Dark/amber — consistent with Banshee + Sonde App |

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

## Pending

- [x] Replacement CC1101 module arrived and verified working (session 328)
- [x] SPI permissions fixed — `/dev/spidev0.0` accessible by `plugdev` group
- [x] Launcher tile added (fa-ghost, port 5300, before Terminal tile)
- [ ] Build app — see Codex Implementation Brief below
- [ ] Wire CC1101 GPS toggle switch on faceplate

## Changelog

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
