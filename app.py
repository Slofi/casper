#!/usr/bin/env python3
import glob
import json
import os
import queue
import re
import threading
import time
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, request

try:
    import cc1101
except Exception as exc:
    cc1101 = None
    CC1101_IMPORT_ERROR = str(exc)
else:
    CC1101_IMPORT_ERROR = ""


app = Flask(__name__)

APP_DIR = Path(__file__).resolve().parent
LOCAL_CAPTURES_DIR = APP_DIR / "captures"
CAPTURES_DIR = Path(os.path.expanduser("~/captures/casper"))
for path in (LOCAL_CAPTURES_DIR, CAPTURES_DIR):
    path.mkdir(parents=True, exist_ok=True)

_lock = threading.Lock()
_state = {
    "capturing": False,
    "rssi": -120,
    "packets": [],
    "config": {
        "frequency": 433.92,
        "modulation": "OOK",
        "symbol_rate": 4800,
    },
    "last_error": "",
}
_capture_thread = None
_capture_running = False
_sse_clients = []


def _mod_map():
    if cc1101 is None:
        return {}
    return {
        "OOK": cc1101.ModulationFormat.OOK_ASK,
        "FSK2": cc1101.ModulationFormat.FSK2,
        "GFSK": cc1101.ModulationFormat.GFSK,
    }


def _sanitize_name(name):
    clean = re.sub(r"[^\w\-]", "_", (name or "capture").strip())
    clean = re.sub(r"_+", "_", clean).strip("_")
    return clean[:48] or "capture"


def _capture_path(capture_id):
    safe_id = re.sub(r"[^\w\-.]", "", capture_id or "")
    if not safe_id or safe_id != capture_id or safe_id.endswith(".json"):
        return None
    path = CAPTURES_DIR / f"{safe_id}.json"
    try:
        path.resolve().relative_to(CAPTURES_DIR.resolve())
    except ValueError:
        return None
    return path


def _read_capture(capture_id):
    path = _capture_path(capture_id)
    if path is None or not path.exists():
        return None, None
    with path.open("r", encoding="utf-8") as fh:
        return path, json.load(fh)


def _write_capture(path, data):
    tmp = path.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
    tmp.replace(path)


def _apply_config(t, cfg):
    mods = _mod_map()
    if cfg["modulation"] not in mods:
        raise ValueError(f"unsupported modulation: {cfg['modulation']}")
    t.set_base_frequency_hertz(float(cfg["frequency"]) * 1e6)
    t.set_modulation_format(mods[cfg["modulation"]])
    t.set_symbol_rate_baud(int(cfg["symbol_rate"]))


def _sse_push(data):
    dead = []
    for q in list(_sse_clients):
        try:
            q.put_nowait(data)
        except Exception:
            dead.append(q)
    for q in dead:
        try:
            _sse_clients.remove(q)
        except ValueError:
            pass


def _run_capture(cfg):
    global _capture_running
    try:
        if cc1101 is None:
            raise RuntimeError(f"cc1101 package unavailable: {CC1101_IMPORT_ERROR}")
        with cc1101.CC1101() as t:
            _apply_config(t, cfg)
            t._command_strobe(cc1101.CC1101._SPI_COMMAND_STROBE_SRX)
            while _capture_running:
                pkt = t._get_received_packet()
                rssi = t.get_rssi_dbm()
                with _lock:
                    _state["rssi"] = rssi
                if pkt:
                    entry = {
                        "ts": time.time(),
                        "rssi": pkt.rssi_dbm,
                        "hex": pkt.payload.hex(),
                        "len": len(pkt.payload),
                    }
                    with _lock:
                        _state["packets"].append(entry)
                    _sse_push({"type": "packet", **entry})
                else:
                    _sse_push({"type": "rssi", "value": rssi})
                time.sleep(0.05)
    except Exception as exc:
        msg = str(exc)
        with _lock:
            _state["last_error"] = msg
        _sse_push({"type": "error", "msg": msg})
    finally:
        with _lock:
            _state["capturing"] = False
        _capture_running = False


def _status_from_chip():
    if cc1101 is None:
        return {
            "chip_ok": False,
            "marcstate": "NO CC1101",
            "error": CC1101_IMPORT_ERROR or "cc1101 package unavailable",
        }
    try:
        with cc1101.CC1101() as t:
            marcstate = "IDLE"
            if hasattr(t, "get_marc_state"):
                marcstate = str(t.get_marc_state())
            elif hasattr(t, "_get_marc_state"):
                marcstate = str(t._get_marc_state())
            return {"chip_ok": True, "marcstate": marcstate, "error": ""}
    except Exception as exc:
        return {"chip_ok": False, "marcstate": "ERROR", "error": str(exc)}


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/status")
def api_status():
    with _lock:
        capturing = _state["capturing"]
        rssi = _state["rssi"]
        packet_count = len(_state["packets"])
        last_error = _state["last_error"]
    chip = {"chip_ok": True, "marcstate": "RX" if capturing else "IDLE", "error": ""}
    if not capturing:
        chip = _status_from_chip()
    if last_error and not chip.get("error"):
        chip["error"] = last_error
    return jsonify({
        "chip_ok": chip["chip_ok"],
        "marcstate": chip["marcstate"],
        "capturing": capturing,
        "rssi": rssi,
        "packet_count": packet_count,
        "error": chip.get("error", ""),
    })


@app.post("/api/config")
def api_config():
    data = request.get_json(silent=True) or {}
    try:
        frequency = float(data.get("frequency", 433.92))
        modulation = str(data.get("modulation", "OOK"))
        symbol_rate = int(data.get("symbol_rate", 4800))
    except (TypeError, ValueError):
        return jsonify({"error": "invalid config"}), 400
    if not 300 <= frequency <= 928:
        return jsonify({"error": "frequency out of range"}), 400
    if modulation not in ("OOK", "FSK2", "GFSK"):
        return jsonify({"error": "invalid modulation"}), 400
    if symbol_rate <= 0:
        return jsonify({"error": "invalid symbol rate"}), 400
    with _lock:
        if _state["capturing"]:
            return jsonify({"error": "stop capture before changing config"}), 409
        _state["config"] = {
            "frequency": frequency,
            "modulation": modulation,
            "symbol_rate": symbol_rate,
        }
        _state["last_error"] = ""
    return jsonify({"ok": True})


@app.post("/api/capture/start")
def api_capture_start():
    global _capture_thread, _capture_running
    with _lock:
        if _state["capturing"]:
            return jsonify({"error": "already capturing"}), 409
        cfg = dict(_state["config"])
        _state["packets"] = []
        _state["rssi"] = -120
        _state["capturing"] = True
        _state["last_error"] = ""
    _capture_running = True
    _capture_thread = threading.Thread(target=_run_capture, args=(cfg,), daemon=True)
    _capture_thread.start()
    return jsonify({"ok": True})


@app.post("/api/capture/stop")
def api_capture_stop():
    global _capture_running
    _capture_running = False
    thread = _capture_thread
    if thread and thread.is_alive():
        thread.join(timeout=3)
    with _lock:
        _state["capturing"] = False
    return jsonify({"ok": True})


@app.get("/api/capture/live")
def api_capture_live():
    q = queue.Queue(maxsize=50)
    _sse_clients.append(q)

    def stream():
        try:
            last_heartbeat = 0
            while True:
                try:
                    data = q.get(timeout=0.5)
                    yield f"data: {json.dumps(data)}\n\n"
                except queue.Empty:
                    now = time.time()
                    if now - last_heartbeat >= 2:
                        with _lock:
                            rssi = _state["rssi"]
                            capturing = _state["capturing"]
                        yield f"data: {json.dumps({'type': 'rssi', 'value': rssi, 'capturing': capturing})}\n\n"
                        last_heartbeat = now
        finally:
            try:
                _sse_clients.remove(q)
            except ValueError:
                pass

    return Response(stream(), mimetype="text/event-stream")


@app.post("/api/capture/save")
def api_capture_save():
    data = request.get_json(silent=True) or {}
    name = _sanitize_name(data.get("name"))
    ts = int(time.time())
    capture_id = f"{name}_{ts}"
    path = CAPTURES_DIR / f"{capture_id}.json"
    with _lock:
        cfg = dict(_state["config"])
        packets = list(_state["packets"])
    payload = {
        "name": name,
        "ts": ts,
        "frequency": cfg["frequency"],
        "modulation": cfg["modulation"],
        "symbol_rate": cfg["symbol_rate"],
        "note": "",
        "packets": packets,
    }
    _write_capture(path, payload)
    return jsonify({"ok": True, "id": capture_id})


@app.get("/api/captures")
def api_captures():
    items = []
    for filename in glob.glob(str(CAPTURES_DIR / "*.json")):
        path = Path(filename)
        try:
            with path.open("r", encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception:
            continue
        items.append({
            "id": path.stem,
            "name": data.get("name", path.stem),
            "ts": data.get("ts", 0),
            "frequency": data.get("frequency", 0),
            "modulation": data.get("modulation", ""),
            "symbol_rate": data.get("symbol_rate", 0),
            "packet_count": len(data.get("packets", [])),
            "note": data.get("note", ""),
            "packets": data.get("packets", []),
        })
    items.sort(key=lambda item: item.get("ts", 0), reverse=True)
    return jsonify(items)


@app.post("/api/captures/<capture_id>/note")
def api_capture_note(capture_id):
    path, data = _read_capture(capture_id)
    if path is None:
        return jsonify({"error": "capture not found"}), 404
    body = request.get_json(silent=True) or {}
    data["note"] = str(body.get("note", ""))[:2000]
    _write_capture(path, data)
    return jsonify({"ok": True})


@app.delete("/api/captures/<capture_id>")
def api_capture_delete(capture_id):
    path = _capture_path(capture_id)
    if path is None or not path.exists():
        return jsonify({"error": "capture not found"}), 404
    path.unlink()
    return jsonify({"ok": True})


@app.post("/api/replay")
def api_replay():
    with _lock:
        if _state["capturing"]:
            return jsonify({"error": "stop capture first"}), 409
    if cc1101 is None:
        return jsonify({"error": f"cc1101 package unavailable: {CC1101_IMPORT_ERROR}"}), 503

    body = request.get_json(silent=True) or {}
    capture_id = body.get("id", "")
    path, capture = _read_capture(capture_id)
    if path is None:
        return jsonify({"error": "capture not found"}), 404
    packets = capture.get("packets", [])
    indices = body.get("indices", [])
    try:
        selected = [packets[int(idx)] for idx in indices]
        repeat = max(1, min(99, int(body.get("repeat", 1))))
        delay_ms = max(0, int(body.get("delay_ms", 200)))
    except (IndexError, TypeError, ValueError):
        return jsonify({"error": "invalid replay request"}), 400
    if not selected:
        return jsonify({"error": "no packets selected"}), 400

    cfg = {
        "frequency": float(capture.get("frequency", 433.92)),
        "modulation": capture.get("modulation", "OOK"),
        "symbol_rate": int(capture.get("symbol_rate", 4800)),
    }
    sent = 0
    try:
        with cc1101.CC1101() as t:
            _apply_config(t, cfg)
            for _ in range(repeat):
                for pkt in selected:
                    t.transmit(bytes.fromhex(pkt["hex"]))
                    sent += 1
                if delay_ms:
                    time.sleep(delay_ms / 1000)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500
    return jsonify({"ok": True, "sent": sent})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5300, debug=False, threaded=True)
