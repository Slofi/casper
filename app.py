#!/usr/bin/env python3
import glob
import json
import os
import queue
import re
import subprocess
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
    "monitoring": False,
    "auto_armed": False,
    "last_error": "",
}
_capture_thread = None
_capture_running = False
_monitor_thread = None
_monitor_running = False
_auto_thread = None
_auto_running = False
_sse_clients = []


def service_action_soon(action):
    time.sleep(1)
    subprocess.run(
        ["systemctl", "--user", action, "casper.service"],
        cwd=APP_DIR,
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def run_git(args, timeout=20):
    return subprocess.run(
        ["git", *args],
        cwd=APP_DIR,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
    )


def git_version_payload(check_remote=False):
    payload = {"ok": True, "is_git": (APP_DIR / ".git").exists()}
    current = run_git(["rev-parse", "--short", "HEAD"])
    branch = run_git(["rev-parse", "--abbrev-ref", "HEAD"])
    remote = run_git(["config", "--get", "remote.origin.url"])
    payload.update({
        "current": current.stdout.strip() if current.returncode == 0 else "",
        "branch": branch.stdout.strip() if branch.returncode == 0 else "",
        "remote": remote.stdout.strip() if remote.returncode == 0 else "",
    })
    if not payload["is_git"] or current.returncode != 0:
        payload["ok"] = False
        payload["error"] = "Casper directory is not a usable git checkout."
        return payload
    if check_remote:
        ref = payload["branch"] if payload["branch"] and payload["branch"] != "HEAD" else "main"
        latest = run_git(["ls-remote", "origin", ref], timeout=20)
        if latest.returncode == 0 and latest.stdout.strip():
            full = latest.stdout.split()[0]
            payload["latest"] = full[:7]
            payload["up_to_date"] = full.startswith(payload["current"])
        else:
            payload["remote_error"] = latest.stdout.strip() or "Unable to check remote version."
    return payload


def _mod_map():
    if cc1101 is None:
        return {}
    mod = cc1101.ModulationFormat
    ook = getattr(mod, "OOK_ASK", None) or getattr(mod, "ASK_OOK")
    return {
        "OOK": ook,
        "FSK2": mod.FSK2,
        "GFSK": mod.GFSK,
    }


def _sanitize_name(name):
    clean = re.sub(r"[^\w\-]", "_", (name or "capture").strip())
    clean = re.sub(r"_+", "_", clean).strip("_")
    return clean[:48] or "capture"


def _sanitize_folder(folder):
    clean = re.sub(r"[^\w\- ]", "", (folder or "").strip())
    clean = re.sub(r"\s+", " ", clean)
    return clean[:48]


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


def _save_capture_file(name, cfg, packets, preview=False, folder=""):
    ts = int(time.time())
    safe_name = _sanitize_name(name)
    capture_id = f"{safe_name}_{ts}"
    path = CAPTURES_DIR / f"{capture_id}.json"
    _write_capture(path, {
        "name": safe_name,
        "ts": ts,
        "frequency": cfg["frequency"],
        "modulation": cfg["modulation"],
        "symbol_rate": cfg["symbol_rate"],
        "note": "",
        "preview": preview,
        "folder": folder,
        "packets": packets,
    })
    return capture_id


def _decode_payload(hex_payload):
    try:
        raw = bytes.fromhex(hex_payload or "")
    except ValueError:
        raw = b""
    ascii_text = "".join(chr(b) if 32 <= b <= 126 else "." for b in raw)
    bits = " ".join(f"{b:08b}" for b in raw)
    return {
        "hex": hex_payload,
        "bytes": list(raw),
        "bits": bits,
        "ascii": ascii_text,
        "len": len(raw),
    }


def _decode_capture(data):
    packets = data.get("packets", [])
    first_ts = packets[0].get("ts", 0) if packets else 0
    grouped = {}
    decoded_packets = []
    for idx, pkt in enumerate(packets):
        hex_payload = pkt.get("hex", "")
        grouped.setdefault(hex_payload, {"hex": hex_payload, "count": 0, "indices": []})
        grouped[hex_payload]["count"] += 1
        grouped[hex_payload]["indices"].append(idx)
        decoded = _decode_payload(hex_payload)
        decoded_packets.append({
            "index": idx,
            "offset_ms": round((pkt.get("ts", first_ts) - first_ts) * 1000),
            "rssi": pkt.get("rssi", -120),
            **decoded,
        })
    lengths = sorted({pkt.get("len", 0) for pkt in packets})
    repeats = sorted(grouped.values(), key=lambda item: item["count"], reverse=True)
    return {
        "name": data.get("name", ""),
        "frequency": data.get("frequency", 0),
        "modulation": data.get("modulation", ""),
        "symbol_rate": data.get("symbol_rate", 0),
        "packet_count": len(packets),
        "lengths": lengths,
        "unique_payloads": len(grouped),
        "repeats": repeats[:20],
        "packets": decoded_packets,
    }


def _apply_config(t, cfg):
    mods = _mod_map()
    if cfg["modulation"] not in mods:
        raise ValueError(f"unsupported modulation: {cfg['modulation']}")
    t.set_base_frequency_hertz(float(cfg["frequency"]) * 1e6)
    if hasattr(t, "set_modulation_format"):
        t.set_modulation_format(mods[cfg["modulation"]])
    elif hasattr(t, "_set_modulation_format"):
        t._set_modulation_format(mods[cfg["modulation"]])
    else:
        raise RuntimeError("cc1101 modulation setter is unavailable")
    t.set_symbol_rate_baud(int(cfg["symbol_rate"]))


def _enter_receive_mode(t):
    if hasattr(t, "_enable_receive_mode"):
        t._enable_receive_mode()
        return
    strobe = getattr(cc1101.CC1101, "_SPI_COMMAND_STROBE_SRX", None)
    if strobe is None:
        raise RuntimeError("cc1101 receive strobe is unavailable")
    t._command_strobe(strobe)


def _read_rssi_dbm(t):
    if hasattr(t, "get_rssi_dbm"):
        return t.get_rssi_dbm()
    status_registers = getattr(cc1101, "StatusRegisterAddress", None)
    if status_registers is not None and hasattr(t, "_read_status_register"):
        index = t._read_status_register(status_registers.RSSI)
        if index >= 128:
            return (index - 256) / 2 - 74
        return index / 2 - 74
    return -120


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
            _enter_receive_mode(t)
            while _capture_running:
                pkt = t._get_received_packet()
                rssi = _read_rssi_dbm(t)
                with _lock:
                    _state["rssi"] = rssi
                if pkt:
                    payload = pkt.payload
                    pkt_rssi = getattr(pkt, "rssi_dbm", rssi)
                    entry = {
                        "ts": time.time(),
                        "rssi": pkt_rssi,
                        "hex": payload.hex(),
                        "len": len(payload),
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


def _run_monitor(cfg):
    global _monitor_running
    try:
        if cc1101 is None:
            raise RuntimeError(f"cc1101 package unavailable: {CC1101_IMPORT_ERROR}")
        with cc1101.CC1101() as t:
            _apply_config(t, cfg)
            _enter_receive_mode(t)
            while _monitor_running:
                rssi = _read_rssi_dbm(t)
                with _lock:
                    _state["rssi"] = rssi
                _sse_push({"type": "rssi", "value": rssi, "monitoring": True})
                time.sleep(0.1)
    except Exception as exc:
        msg = str(exc)
        with _lock:
            _state["last_error"] = msg
        _sse_push({"type": "error", "msg": msg})
    finally:
        with _lock:
            _state["monitoring"] = False
        _monitor_running = False


def _run_auto_capture(cfg, threshold, quiet_ms, prebuffer_ms, auto_tune, tune_ms, margin_db):
    global _auto_running
    burst_packets = []
    prebuffer = []
    triggered = False
    last_activity = 0
    try:
        if cc1101 is None:
            raise RuntimeError(f"cc1101 package unavailable: {CC1101_IMPORT_ERROR}")
        with cc1101.CC1101() as t:
            _apply_config(t, cfg)
            _enter_receive_mode(t)
            if auto_tune:
                samples = []
                deadline = time.time() + (tune_ms / 1000)
                _sse_push({"type": "auto", "state": "tuning"})
                while _auto_running and time.time() < deadline:
                    rssi = _read_rssi_dbm(t)
                    samples.append(rssi)
                    with _lock:
                        _state["rssi"] = rssi
                    _sse_push({"type": "rssi", "value": rssi, "auto": True})
                    time.sleep(0.1)
                if samples:
                    samples.sort()
                    median = samples[len(samples) // 2]
                    threshold = max(-120, min(0, median + margin_db))
                    _sse_push({
                        "type": "auto",
                        "state": "tuned",
                        "floor": median,
                        "threshold": threshold,
                    })
            while _auto_running:
                now = time.time()
                pkt = t._get_received_packet()
                rssi = _read_rssi_dbm(t)
                active = rssi >= threshold
                with _lock:
                    _state["rssi"] = rssi
                _sse_push({"type": "rssi", "value": rssi, "auto": True})
                if pkt:
                    payload = pkt.payload
                    pkt_rssi = getattr(pkt, "rssi_dbm", rssi)
                    entry = {
                        "ts": now,
                        "rssi": pkt_rssi,
                        "hex": payload.hex(),
                        "len": len(payload),
                    }
                    prebuffer.append(entry)
                    cutoff = now - (prebuffer_ms / 1000)
                    prebuffer = [item for item in prebuffer if item["ts"] >= cutoff]
                    if triggered:
                        burst_packets.append(entry)
                        with _lock:
                            _state["packets"].append(entry)
                        _sse_push({"type": "packet", **entry})
                    active = True
                if active:
                    if not triggered:
                        triggered = True
                        burst_packets = list(prebuffer)
                        if burst_packets:
                            with _lock:
                                _state["packets"].extend(burst_packets)
                            for entry in burst_packets:
                                _sse_push({"type": "packet", **entry})
                        _sse_push({"type": "auto", "state": "triggered", "rssi": rssi})
                    last_activity = now
                if triggered and (now - last_activity) * 1000 >= quiet_ms:
                    if burst_packets:
                        capture_id = _save_capture_file("auto_preview", cfg, burst_packets, preview=True, folder="Previews")
                        _sse_push({
                            "type": "auto",
                            "state": "saved",
                            "id": capture_id,
                            "packets": len(burst_packets),
                        })
                    else:
                        _sse_push({"type": "auto", "state": "quiet"})
                    triggered = False
                    burst_packets = []
                time.sleep(0.05)
    except Exception as exc:
        msg = str(exc)
        with _lock:
            _state["last_error"] = msg
        _sse_push({"type": "error", "msg": msg})
    finally:
        with _lock:
            _state["auto_armed"] = False
        _auto_running = False


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
        monitoring = _state["monitoring"]
        auto_armed = _state["auto_armed"]
        rssi = _state["rssi"]
        packet_count = len(_state["packets"])
        last_error = _state["last_error"]
    chip = {"chip_ok": True, "marcstate": "RX" if capturing or monitoring or auto_armed else "IDLE", "error": ""}
    if not capturing and not monitoring and not auto_armed:
        chip = _status_from_chip()
    if last_error and not chip.get("error"):
        chip["error"] = last_error
    return jsonify({
        "chip_ok": chip["chip_ok"],
        "marcstate": chip["marcstate"],
        "capturing": capturing,
        "monitoring": monitoring,
        "auto_armed": auto_armed,
        "rssi": rssi,
        "packet_count": packet_count,
        "error": chip.get("error", ""),
    })


@app.get("/api/version")
def api_version():
    check_remote = request.args.get("check") in {"1", "true", "yes"}
    return jsonify(git_version_payload(check_remote))


@app.post("/api/update")
def api_update_app():
    with _lock:
        if _state["capturing"] or _state["monitoring"] or _state["auto_armed"]:
            return jsonify({"ok": False, "error": "stop capture, monitor, or auto mode before updating"}), 409
    try:
        result = run_git(["pull", "--ff-only"], timeout=60)
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500
    ok = result.returncode == 0
    changed = ok and "Already up to date." not in result.stdout
    return jsonify({
        "ok": ok,
        "log": result.stdout[-6000:],
        "restart_required": changed,
    }), (200 if ok else 500)


@app.post("/api/service/restart")
def api_restart_service():
    with _lock:
        if _state["capturing"] or _state["monitoring"] or _state["auto_armed"]:
            return jsonify({"ok": False, "error": "stop capture, monitor, or auto mode before restarting"}), 409
    threading.Thread(target=service_action_soon, args=("restart",), daemon=True).start()
    return jsonify({"ok": True, "message": "Restarting Casper service."})


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
        if _state["capturing"] or _state["monitoring"] or _state["auto_armed"]:
            return jsonify({"error": "stop capture, monitor, or auto mode before changing config"}), 409
        _state["config"] = {
            "frequency": frequency,
            "modulation": modulation,
            "symbol_rate": symbol_rate,
        }
        _state["last_error"] = ""
    return jsonify({"ok": True})


@app.post("/api/capture/start")
def api_capture_start():
    global _capture_thread, _capture_running, _monitor_running
    with _lock:
        if _state["capturing"]:
            return jsonify({"error": "already capturing"}), 409
        if _state["auto_armed"]:
            return jsonify({"error": "stop auto mode before manual capture"}), 409
        monitoring = _state["monitoring"]
    if monitoring:
        _monitor_running = False
        thread = _monitor_thread
        if thread and thread.is_alive():
            thread.join(timeout=2)
    with _lock:
        cfg = dict(_state["config"])
        _state["packets"] = []
        _state["rssi"] = -120
        _state["capturing"] = True
        _state["monitoring"] = False
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


@app.post("/api/monitor/start")
def api_monitor_start():
    global _monitor_thread, _monitor_running
    with _lock:
        if _state["capturing"]:
            return jsonify({"error": "stop capture before monitoring"}), 409
        if _state["auto_armed"]:
            return jsonify({"error": "stop auto mode before monitoring"}), 409
        if _state["monitoring"]:
            return jsonify({"error": "already monitoring"}), 409
        cfg = dict(_state["config"])
        _state["monitoring"] = True
        _state["last_error"] = ""
    _monitor_running = True
    _monitor_thread = threading.Thread(target=_run_monitor, args=(cfg,), daemon=True)
    _monitor_thread.start()
    return jsonify({"ok": True})


@app.post("/api/auto/start")
def api_auto_start():
    global _auto_thread, _auto_running
    body = request.get_json(silent=True) or {}
    try:
        threshold = float(body.get("threshold", -85))
        quiet_ms = int(body.get("quiet_ms", 1500))
        prebuffer_ms = int(body.get("prebuffer_ms", 3000))
        tune_ms = int(body.get("tune_ms", 2500))
        margin_db = float(body.get("margin_db", 12))
    except (TypeError, ValueError):
        return jsonify({"error": "invalid auto settings"}), 400
    auto_tune = bool(body.get("auto_tune", True))
    threshold = max(-120, min(0, threshold))
    quiet_ms = max(300, min(10000, quiet_ms))
    prebuffer_ms = max(0, min(10000, prebuffer_ms))
    tune_ms = max(500, min(10000, tune_ms))
    margin_db = max(3, min(40, margin_db))
    with _lock:
        if _state["capturing"] or _state["monitoring"]:
            return jsonify({"error": "stop capture or monitor before auto mode"}), 409
        if _state["auto_armed"]:
            return jsonify({"error": "auto mode already armed"}), 409
        cfg = dict(_state["config"])
        _state["packets"] = []
        _state["auto_armed"] = True
        _state["last_error"] = ""
    _auto_running = True
    _auto_thread = threading.Thread(
        target=_run_auto_capture,
        args=(cfg, threshold, quiet_ms, prebuffer_ms, auto_tune, tune_ms, margin_db),
        daemon=True,
    )
    _auto_thread.start()
    return jsonify({"ok": True})


@app.post("/api/auto/stop")
def api_auto_stop():
    global _auto_running
    _auto_running = False
    thread = _auto_thread
    if thread and thread.is_alive():
        thread.join(timeout=2)
    with _lock:
        _state["auto_armed"] = False
    return jsonify({"ok": True})


@app.post("/api/monitor/stop")
def api_monitor_stop():
    global _monitor_running
    _monitor_running = False
    thread = _monitor_thread
    if thread and thread.is_alive():
        thread.join(timeout=2)
    with _lock:
        _state["monitoring"] = False
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
                            monitoring = _state["monitoring"]
                            auto_armed = _state["auto_armed"]
                        yield f"data: {json.dumps({'type': 'rssi', 'value': rssi, 'capturing': capturing, 'monitoring': monitoring, 'auto_armed': auto_armed})}\n\n"
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
        "preview": False,
        "folder": "",
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
            "preview": bool(data.get("preview", False)),
            "folder": data.get("folder", "Previews" if data.get("preview", False) else ""),
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


@app.post("/api/captures/<capture_id>/folder")
def api_capture_folder(capture_id):
    path, data = _read_capture(capture_id)
    if path is None:
        return jsonify({"error": "capture not found"}), 404
    body = request.get_json(silent=True) or {}
    folder = _sanitize_folder(str(body.get("folder", "")))
    data["folder"] = "" if folder.lower() in {"", "none", "root"} else folder
    _write_capture(path, data)
    return jsonify({"ok": True, "folder": data["folder"]})


@app.post("/api/captures/<capture_id>/keep")
def api_capture_keep(capture_id):
    path, data = _read_capture(capture_id)
    if path is None:
        return jsonify({"error": "capture not found"}), 404
    body = request.get_json(silent=True) or {}
    name = body.get("name")
    if name:
        data["name"] = _sanitize_name(name)
    data["preview"] = False
    if data.get("folder") == "Previews":
        data["folder"] = ""
    _write_capture(path, data)
    return jsonify({"ok": True})


@app.delete("/api/captures/<capture_id>")
def api_capture_delete(capture_id):
    path = _capture_path(capture_id)
    if path is None or not path.exists():
        return jsonify({"error": "capture not found"}), 404
    path.unlink()
    return jsonify({"ok": True})


@app.get("/api/captures/<capture_id>/decode")
def api_capture_decode(capture_id):
    path, data = _read_capture(capture_id)
    if path is None:
        return jsonify({"error": "capture not found"}), 404
    return jsonify(_decode_capture(data))


@app.post("/api/replay")
def api_replay():
    with _lock:
        if _state["capturing"]:
            return jsonify({"error": "stop capture first"}), 409
        if _state["monitoring"] or _state["auto_armed"]:
            return jsonify({"error": "stop monitor or auto mode first"}), 409
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
