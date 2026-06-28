function customConfirm(msg, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    const modal  = document.getElementById('confirm-modal');
    const msgEl  = document.getElementById('confirm-msg');
    const okBtn  = document.getElementById('confirm-ok');
    const cancel = document.getElementById('confirm-cancel');
    msgEl.textContent = msg;
    okBtn.textContent = okLabel;
    modal.classList.remove('hidden');
    function done(result) {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      resolve(result);
    }
    const onOk       = () => done(true);
    const onCancel   = () => done(false);
    const onBackdrop = (e) => { if (e.target === modal) done(false); };
    okBtn.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
  });
}

const state = {
  capturing: false,
  monitoring: false,
  autoArmed: false,
  rtlActive: false,
  rtlSignals: [],
  packets: [],
  captures: [],
  loadedCapture: null,
  eventSource: null,
  rssiSamples: [],
  peakRssi: -120,
  activeFolder: "All",
  pendingPreviews: [],
};

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const init = { ...options, headers: { ...(options.headers || {}) } };
  if (init.body && typeof init.body !== "string") {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(init.body);
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function setMessage(id, text, isError = false) {
  const el = $(id);
  el.textContent = text || "";
  el.classList.toggle("error", Boolean(isError));
}

function switchTab(name) {
  document.querySelectorAll(".main-tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === name));
  document.querySelectorAll(".tab-pane").forEach((pane) => pane.classList.toggle("active", pane.id === `tab-${name}`));
  if (name === "library") loadLibrary();
  if (name === "decode") { $("decode-freq").value = $("frequency").value; updateDecodeStatus(); }
}

function setSettingsOpen(open) {
  $("settings-menu").classList.toggle("hidden", !open);
}

function rssiWidth(rssi) {
  const clamped = Math.max(-120, Math.min(0, Number(rssi) || -120));
  return ((clamped + 120) / 120) * 100;
}

function updateRssi(rssi) {
  $("rssi-value").textContent = `${Math.round(rssi)} dBm`;
  if ($("capture-rssi-readout")) $("capture-rssi-readout").textContent = `${Math.round(rssi)} dBm`;
  $("rssi-fill").style.width = `${rssiWidth(rssi)}%`;
}

function drawSignal() {
  const canvas = $("signal-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0b0b10";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = Math.round((i / 4) * h) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  const samples = state.rssiSamples.slice(-w);
  const barW = Math.max(1, Math.floor(w / Math.max(samples.length, 1)));
  samples.forEach((sample, i) => {
    const level = rssiWidth(sample.rssi) / 100;
    const x = w - ((samples.length - i) * barW);
    const barH = Math.max(1, level * h);
    const hot = sample.rssi > -65;
    const warm = sample.rssi > -85;
    ctx.fillStyle = hot ? "#ff5050" : (warm ? "#e8b04f" : "rgba(232,176,79,0.45)");
    ctx.fillRect(x, h - barH, barW, barH);
  });
}

function addRssiSample(rssi) {
  const value = Number(rssi);
  if (!Number.isFinite(value)) return;
  state.rssiSamples.push({ ts: Date.now(), rssi: value });
  if (state.rssiSamples.length > 900) state.rssiSamples.splice(0, state.rssiSamples.length - 900);
  state.peakRssi = Math.max(state.peakRssi, value);
  $("signal-peak").textContent = `Peak ${Math.round(state.peakRssi)} dBm`;
  drawSignal();
}

function setStatus(status) {
  state.capturing = Boolean(status.capturing);
  state.monitoring = Boolean(status.monitoring);
  state.autoArmed = Boolean(status.auto_armed);
  if (status.rtl_active !== undefined) {
    state.rtlActive = Boolean(status.rtl_active);
    updateDecodeStatus();
  }
  const activeRadio = status.capturing || status.monitoring || status.auto_armed;
  const mode = status.chip_ok ? (activeRadio ? "rx" : "idle") : "error-state";
  $("toolbar-state").textContent = status.capturing ? "RX" : (status.auto_armed ? "AUTO" : (status.monitoring ? "MON" : (status.chip_ok ? "IDLE" : "ERROR")));
  $("marcstate").textContent = status.marcstate || "IDLE";
  $("spi-badge").textContent = status.chip_ok ? "SPI OK" : "SPI ERROR";
  $("status-error").textContent = status.error || "";
  $("status-circle").className = `status-circle ${mode}`;
  document.querySelector(".status-dot").className = `status-dot ${mode}`;
  $("start-capture").disabled = state.capturing;
  $("stop-capture").disabled = !state.capturing;
  $("start-monitor").disabled = state.capturing || state.monitoring || state.autoArmed;
  $("stop-monitor").disabled = !state.monitoring;
  $("start-auto").disabled = state.capturing || state.monitoring || state.autoArmed;
  $("stop-auto").disabled = !state.autoArmed;
  $("packet-counter").textContent = `${status.packet_count || state.packets.length} packets`;
  if ($("capture-frequency-readout")) $("capture-frequency-readout").textContent = `${Number($("frequency").value || 433.92).toFixed(2)} MHz`;
  updateRssi(status.rssi ?? -120);
  renderReplayDisabled();
}

async function refreshStatus() {
  try {
    setStatus(await api("/api/status"));
  } catch (err) {
    setStatus({ chip_ok: false, marcstate: "ERROR", capturing: false, rssi: -120, packet_count: state.packets.length, error: err.message });
  }
}

function getConfig() {
  const rateSelect = $("symbol-rate").value;
  return {
    frequency: Number($("frequency").value),
    modulation: $("modulation").value,
    symbol_rate: Number(rateSelect === "custom" ? $("custom-symbol-rate").value : rateSelect),
  };
}

function setActiveFrequencyChip(freq) {
  const rounded = Number(freq).toFixed(2);
  document.querySelectorAll(".mode-chip.preset").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.frequency).toFixed(2) === rounded);
  });
  if ($("capture-frequency-readout")) $("capture-frequency-readout").textContent = `${rounded} MHz`;
}

async function applyCurrentConfig(silent = false) {
  try {
    await api("/api/config", { method: "POST", body: getConfig() });
    setActiveFrequencyChip($("frequency").value);
    if (!silent) {
      setMessage("config-message", "Config applied");
      setTimeout(() => setMessage("config-message", ""), 2000);
    }
  } catch (err) {
    if (!silent) setMessage("config-message", err.message, true);
    else setMessage("capture-error", err.message, true);
  }
}

async function tuneFrequency(freq) {
  $("frequency").value = Number(freq).toFixed(2);
  if ($("decode-freq")) $("decode-freq").value = $("frequency").value;
  setActiveFrequencyChip(freq);
  await applyCurrentConfig(true);
}

function packetTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function truncateHex(hex) {
  return hex.length > 32 ? `${hex.slice(0, 32)}...` : hex;
}

function simpleDecodePacket(packet) {
  const hex = packet.hex || "";
  if (!hex) return "No payload";
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    const value = parseInt(hex.slice(i, i + 2), 16);
    if (Number.isFinite(value)) bytes.push(value);
  }
  const ascii = bytes.map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : ".")).join("");
  const printable = ascii.replace(/\./g, "").length;
  const repeats = state.packets.filter((pkt) => pkt.hex === hex).length;
  const maxByte = bytes.length ? Math.max(...bytes) : 0;
  const uniqueBytes = new Set(bytes).size;
  const rssi = Number(packet.rssi ?? -120);
  const parts = [];
  if (printable >= Math.max(3, ascii.length * 0.5)) {
    parts.push(`ASCII/text payload`);
    parts.push(`"${ascii.slice(0, 24)}${ascii.length > 24 ? "..." : ""}"`);
  } else if (packet.raw && bytes.length > 32 && uniqueBytes > bytes.length * 0.45) {
    parts.push("Raw/noisy burst");
  } else if (repeats >= 2 && bytes.length <= 16) {
    parts.push("Repeated fixed-code style command");
  } else if (repeats >= 2) {
    parts.push("Repeated payload");
  } else if (bytes.length <= 3) {
    parts.push("Short pulse payload");
  } else {
    parts.push(packet.raw ? "Raw RF burst" : "Binary payload");
  }
  if (maxByte === 0) parts.push("all zeroes");
  if (rssi < -95) parts.push("weak signal");
  if (repeats > 1) parts.push(`seen ${repeats}x`);
  parts.push(`${bytes.length} byte${bytes.length === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function addPacketRow(packet, prepend = true) {
  const tbody = $("packet-table");
  const tr = document.createElement("tr");
  const idx = state.packets.length;
  const rawTag = packet.raw ? ' <span class="badge" style="font-size:0.65rem;padding:1px 4px;">RAW</span>' : '';
  tr.innerHTML = `<td>${idx}</td><td>${packetTime(packet.ts)}</td><td>${Math.round(packet.rssi)}</td><td>${packet.len}${rawTag}</td><td>${simpleDecodePacket(packet)}</td><td title="${packet.hex}">${truncateHex(packet.hex)}</td>`;
  if (prepend) tbody.prepend(tr);
  else tbody.append(tr);
  while (tbody.children.length > 500) tbody.lastElementChild.remove();
  $("packet-counter").textContent = `${state.packets.length} packets`;
}

function startSse() {
  if (state.eventSource) state.eventSource.close();
  state.eventSource = new EventSource("/api/capture/live");
  state.eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "rssi") {
      updateRssi(data.value);
      addRssiSample(data.value);
    }
    if (data.type === "packet") {
      state.packets.push(data);
      addPacketRow(data);
      updateRssi(data.rssi);
      addRssiSample(data.rssi);
    }
    if (data.type === "auto") {
      if (data.state === "tuning") $("auto-status").textContent = "Measuring noise floor...";
      if (data.state === "tuned") $("auto-status").textContent = `Armed: floor ${Math.round(data.floor)} dBm, trigger ${Math.round(data.threshold)} dBm`;
      if (data.state === "triggered") $("auto-status").textContent = `Triggered at ${Math.round(data.rssi)} dBm`;
      if (data.state === "saved") {
        const kind = data.signal_type === "rssi_only" ? "RSSI-only preview" : "Decoded preview";
        $("auto-status").textContent = `${kind} saved ${data.id} (${data.packets} packets, ${data.events || 0} samples)`;
        loadPreviews();
        loadLibrary();
      }
    }
    if (data.type === "error") {
      setMessage("capture-error", data.msg, true);
      setMessage("decode-error", data.msg, true);
      refreshStatus();
    }
    if (data.type === "rtl_signal") {
      state.rtlSignals.push(data.data);
      prependRtlCard(data.data);
      prependCaptureDecodeCard(data.data);
      updateDecodeStatus();
    }
    if (data.type === "rtl_stopped") {
      state.rtlActive = false;
      updateDecodeStatus();
    }
  };
  state.eventSource.onerror = () => setMessage("capture-error", "Live stream disconnected", true);
}

function stopSse() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
}

async function startCapture() {
  setMessage("capture-error", "");
  $("packet-table").innerHTML = "";
  state.packets = [];
  resetCaptureDecodeFeed("Manual capture records packets here; use Decode + Capture to identify known protocols.");
  try {
    await api("/api/capture/start", { method: "POST" });
    startSse();
    await refreshStatus();
  } catch (err) {
    setMessage("capture-error", err.message, true);
    await refreshStatus();
  }
}

async function startMonitor() {
  setMessage("capture-error", "");
  state.rssiSamples = [];
  state.peakRssi = -120;
  drawSignal();
  try {
    await api("/api/monitor/start", { method: "POST" });
    startSse();
    await refreshStatus();
  } catch (err) {
    setMessage("capture-error", err.message, true);
    await refreshStatus();
  }
}

async function stopMonitor() {
  try {
    await api("/api/monitor/stop", { method: "POST" });
  } catch (err) {
    setMessage("capture-error", err.message, true);
  }
  if (!state.capturing) stopSse();
  await refreshStatus();
}

async function startAuto() {
  setMessage("capture-error", "");
  state.rssiSamples = [];
  state.peakRssi = -120;
  $("packet-table").innerHTML = "";
  state.packets = [];
  resetCaptureDecodeFeed("ARM records signal events here; use Decode + Capture to identify known protocols.");
  $("auto-status").textContent = "Auto armed";
  drawSignal();
  try {
    await api("/api/auto/start", {
      method: "POST",
      body: {
        threshold: Number($("auto-threshold").value),
        auto_tune: $("auto-tune").checked,
        margin_db: Number($("auto-margin").value),
        prebuffer_ms: Number($("auto-prebuffer").value),
        quiet_ms: Number($("auto-quiet").value),
      },
    });
    startSse();
    await refreshStatus();
  } catch (err) {
    $("auto-status").textContent = "Auto idle";
    setMessage("capture-error", err.message, true);
    await refreshStatus();
  }
}

async function stopAuto() {
  try {
    await api("/api/auto/stop", { method: "POST" });
    $("auto-status").textContent = "Auto idle";
  } catch (err) {
    setMessage("capture-error", err.message, true);
  }
  stopSse();
  await refreshStatus();
}

async function stopCapture() {
  try {
    await api("/api/capture/stop", { method: "POST" });
  } catch (err) {
    setMessage("capture-error", err.message, true);
  }
  stopSse();
  await refreshStatus();
}

async function saveCapture() {
  const name = $("save-name").value.trim() || "capture";
  try {
    const res = await api("/api/capture/save", { method: "POST", body: { name } });
    setMessage("save-message", `Saved: ${res.id}`);
    $("save-form").classList.add("hidden");
    $("save-name").value = "";
    setTimeout(() => setMessage("save-message", ""), 3000);
  } catch (err) {
    setMessage("save-message", err.message, true);
  }
}

function formatDate(ts) {
  if (!ts) return "Unknown time";
  const d = new Date(ts * 1000);
  const date = d.toISOString().slice(0, 10);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
}

function autoDecodePreview(cap) {
  if (cap.signal_type === 'rssi_only' || !cap.packets || cap.packets.length === 0) return '—';
  // find most-repeated payload
  const freq = {};
  for (const pkt of cap.packets) freq[pkt.hex] = (freq[pkt.hex] || 0) + 1;
  const [topHex] = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
  if (!topHex) return '—';
  // try ASCII
  let ascii = '';
  for (let i = 0; i < topHex.length; i += 2)  {
    const b = parseInt(topHex.slice(i, i + 2), 16);
    ascii += (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.';
  }
  const readable = ascii.replace(/\./g, '').length >= ascii.length * 0.5;
  const label = readable
    ? `"${ascii.length > 18 ? ascii.slice(0, 17) + '…' : ascii}"`
    : `<code>${topHex.length > 20 ? topHex.slice(0, 18) + '…' : topHex}</code>`;
  const rpt = freq[topHex];
  return rpt > 1 ? `${label} ×${rpt}` : label;
}

function qualityBadge(quality = {}) {
  const level = quality.level || "empty";
  const label = quality.label || "Unknown";
  const score = Number.isFinite(quality.score) ? ` ${quality.score}` : "";
  return `<span class="quality-badge ${level}" title="${(quality.reasons || []).join(", ")}">${label}${score}</span>`;
}

function duplicateBadge(cap) {
  const count = Math.max(cap.sighting_count || 0, (cap.duplicate_count || 0) + 1);
  return count > 1
    ? `<span class="quality-badge weak" title="Same signal fingerprint seen before">Seen ${count}x</span>`
    : "";
}

function formatDecode(data) {
  const lines = [];
  lines.push(`${data.name || "capture"} · ${Number(data.frequency).toFixed(2)} MHz · ${data.modulation} · ${data.symbol_rate} baud`);
  lines.push(`${data.packet_count} packets · ${data.events.length} RSSI samples · ${data.unique_payloads} unique payloads · lengths: ${data.lengths.join(", ") || "none"}`);
  if (data.signal_type === "rssi_only") {
    lines.push("RSSI-only activity: signal energy was detected, but no packet payload was decoded. This can be reviewed and kept, but it is not replayable.");
  }
  lines.push("");
  if (!data.packets.length && data.events.length) {
    lines.push("RSSI activity:");
    const base = data.events[0]?.ts || 0;
    data.events.slice(0, 80).forEach((evt, index) => {
      lines.push(`#${index}  +${Math.round((evt.ts - base) * 1000)}ms  ${Math.round(evt.rssi)} dBm`);
    });
    if (data.events.length > 80) lines.push(`... ${data.events.length - 80} more samples not shown`);
    return lines.join("\n");
  }
  if (data.repeats.length) {
    lines.push("Repeated payloads:");
    data.repeats.slice(0, 8).forEach((item) => {
      lines.push(`  x${item.count}  ${truncateHex(item.hex)}  indices ${item.indices.slice(0, 8).join(",")}`);
    });
    lines.push("");
  }
  lines.push("Packets:");
  data.packets.slice(0, 80).forEach((pkt) => {
    lines.push(`#${pkt.index}  +${pkt.offset_ms}ms  ${Math.round(pkt.rssi)} dBm  len ${pkt.len}`);
    lines.push(`HEX   ${pkt.hex}`);
    lines.push(`BITS  ${pkt.bits}`);
    lines.push(`ASCII ${pkt.ascii}`);
    lines.push("");
  });
  if (data.packets.length > 80) lines.push(`... ${data.packets.length - 80} more packets not shown`);
  return lines.join("\n");
}

async function decodeCapture(capture) {
  try {
    const data = await api(`/api/captures/${encodeURIComponent(capture.id)}/decode`);
    $("decode-title").textContent = `Decode: ${capture.name}`;
    $("decode-output").textContent = formatDecode(data);
    $("decode-panel").classList.remove("hidden");
  } catch (err) {
    alert(err.message);
  }
}

async function keepCapture(capture) {
  if (capture.signal_type === "rssi_only") {
    const ok = await customConfirm("This preview has RSSI activity but no decoded payload, so it cannot be replayed. Keep it in the Library as a signal note?", "Keep");
    if (!ok) return;
  }
  const name = prompt("Save preview as:", capture.name.replace(/^auto_preview/, "capture"));
  if (name === null) return;
  try {
    await api(`/api/captures/${encodeURIComponent(capture.id)}/keep`, { method: "POST", body: { name } });
    await loadPreviews();
    await loadLibrary();
  } catch (err) {
    alert(err.message);
  }
}

async function discardCapture(capture) {
  if (!await customConfirm(`${capture.preview ? "Discard preview" : "Delete capture"} "${capture.name}"?`, capture.preview ? "Discard" : "Delete")) return;
  await api(`/api/captures/${encodeURIComponent(capture.id)}`, { method: "DELETE" });
  await loadPreviews();
  await loadLibrary();
}

function reviewCapture(capture) {
  decodeCapture(capture);
  switchTab("library");
}

// ── DECODE TAB ────────────────────────────────────────────────────

const RTL_SKIP_KEYS = new Set(["time", "model", "freq", "freq1", "freq2", "rssi", "snr", "noise", "mod", "ook_symbols", "ook_bitrate"]);

function formatRtlFields(sig) {
  const entries = [];
  for (const [k, v] of Object.entries(sig)) {
    if (k.startsWith("_") || RTL_SKIP_KEYS.has(k)) continue;
    entries.push(`<span class="rtl-card-field"><span class="rtl-card-field-key">${k}:</span> <span class="rtl-card-field-val">${v}</span></span>`);
  }
  return entries.join("");
}

function prependRtlCard(sig) {
  const feed = $("decode-feed");
  const empty = $("decode-empty");
  if (empty) empty.classList.add("hidden");
  const model = sig.model || "Unrecognised";
  const ts = sig.time || new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const rssi = sig.rssi != null ? `${Math.round(sig.rssi)} dBm` : "";
  const freq = sig.freq != null ? `${Number(sig.freq / 1e6).toFixed(2)} MHz` : "";
  const metaParts = [freq, sig.mod || ""].filter(Boolean).join(" · ");
  const card = document.createElement("div");
  card.className = "rtl-card";
  card.innerHTML = `
    <div class="rtl-card-head">
      <span class="rtl-card-model">${model}</span>
      <span class="rtl-card-time">${ts}</span>
      ${rssi ? `<span class="rtl-card-rssi">${rssi}</span>` : ""}
    </div>
    <div class="rtl-card-fields">${formatRtlFields(sig)}</div>
    ${metaParts ? `<div class="rtl-card-meta">${metaParts}</div>` : ""}
    <div class="rtl-card-actions">
      <button class="btn small primary prep-replay">Load for Replay</button>
      <button class="btn small save-one">Save</button>
    </div>`;
  card.querySelector(".prep-replay").addEventListener("click", () => prepRtlForReplay(sig));
  card.querySelector(".save-one").addEventListener("click", async () => {
    try {
      const id = await api("/api/rtl/save", { method: "POST", body: { name: model.replace(/[^\w]/g, "_") } });
      setMessage("decode-error", `Saved: ${id.id}`, false);
      setTimeout(() => setMessage("decode-error", ""), 3000);
    } catch (err) { setMessage("decode-error", err.message, true); }
  });
  feed.prepend(card);
}

function prependCaptureDecodeCard(sig) {
  const feed = $("capture-decode-feed");
  const empty = $("capture-decode-empty");
  const count = $("capture-decode-count");
  if (!feed) return;
  if (empty) empty.classList.add("hidden");
  const model = sig.model || "Unrecognised";
  const ts = sig.time || new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const rssi = sig.rssi != null ? `${Math.round(sig.rssi)} dBm` : "";
  const fields = formatRtlFields(sig);
  const card = document.createElement("div");
  card.className = "rtl-card capture-rtl-card";
  card.innerHTML = `
    <div class="rtl-card-head">
      <span class="rtl-card-model">${model}</span>
      <span class="rtl-card-time">${ts}</span>
      ${rssi ? `<span class="rtl-card-rssi">${rssi}</span>` : ""}
    </div>
    <div class="rtl-card-fields">${fields || '<span class="rtl-card-field"><span class="rtl-card-field-key">decode:</span> <span class="rtl-card-field-val">protocol identified, no extra fields</span></span>'}</div>
    <div class="rtl-card-actions">
      <button class="btn small primary prep-replay">Load Replay</button>
      <button class="btn small save-one">Save</button>
    </div>`;
  card.querySelector(".prep-replay").addEventListener("click", () => prepRtlForReplay(sig));
  card.querySelector(".save-one").addEventListener("click", async () => {
    try {
      const id = await api("/api/rtl/save", { method: "POST", body: { name: model.replace(/[^\w]/g, "_") } });
      setMessage("capture-error", `Decoded session saved: ${id.id}`, false);
      setTimeout(() => setMessage("capture-error", ""), 3000);
    } catch (err) { setMessage("capture-error", err.message, true); }
  });
  feed.prepend(card);
  while (feed.children.length > 20) feed.lastElementChild.remove();
  if (count) count.textContent = `${state.rtlSignals.length} decoded`;
}

function resetCaptureDecodeFeed(message = "Start Decode + Capture to identify known devices here.") {
  const feed = $("capture-decode-feed");
  const empty = $("capture-decode-empty");
  const count = $("capture-decode-count");
  if (feed) feed.innerHTML = "";
  if (empty) {
    empty.textContent = message;
    empty.classList.remove("hidden");
  }
  if (count) count.textContent = "0 decoded";
}

function prepRtlForReplay(sig) {
  const freq = sig.freq != null ? (sig.freq / 1e6) : Number($("decode-freq").value);
  $("frequency").value = freq.toFixed(2);
  $("decode-freq").value = freq.toFixed(2);
  $("modulation").value = "OOK";
  api("/api/config", { method: "POST", body: { frequency: freq, modulation: "OOK", symbol_rate: 4800 } }).catch(() => {});
  if (state.packets.length > 0 && state.loadedCapture === null) {
    loadReplay({ name: sig.model || "rtl_session", frequency: freq, modulation: "OOK", packet_count: state.packets.length, packets: state.packets, rtl_signals: [sig] });
  } else {
    switchTab("config");
    $("apply-config").style.boxShadow = "0 0 0 2px var(--accent)";
    setTimeout(() => { $("apply-config").style.boxShadow = ""; }, 2000);
  }
}

function updateDecodeStatus() {
  const rtlDot = $("rtl-dot");
  const cc1101Dot = $("cc1101-dot");
  const rtlLabel = $("rtl-state-label");
  const cc1101Label = $("cc1101-state-label");
  const stopBtn = $("decode-stop");
  const saveBtn = $("decode-save-session");
  const startBothBtn = $("decode-start-both");
  const startRtlBtn = $("decode-start-rtl");
  if (!rtlDot) return;
  const rtlOn = state.rtlActive;
  const ccOn = state.capturing;
  rtlDot.classList.toggle("active", rtlOn);
  if (rtlLabel) rtlLabel.textContent = rtlOn ? "ACTIVE" : "IDLE";
  cc1101Dot.classList.toggle("active", ccOn);
  if (cc1101Label) cc1101Label.textContent = ccOn ? "CAPTURING" : "IDLE";
  const anyActive = rtlOn || ccOn;
  if (stopBtn) stopBtn.disabled = !anyActive;
  if (startBothBtn) startBothBtn.disabled = anyActive;
  if (startRtlBtn) startRtlBtn.disabled = rtlOn;
  if (saveBtn) saveBtn.disabled = state.rtlSignals.length === 0;
  const count = $("rtl-signal-count");
  if (count) count.textContent = `${state.rtlSignals.length} signal${state.rtlSignals.length === 1 ? "" : "s"} decoded`;
}

async function startDecodeAndCapture() {
  setMessage("decode-error", "");
  state.rtlSignals = [];
  state.packets = [];
  $("decode-feed").innerHTML = "";
  $("packet-table").innerHTML = "";
  resetCaptureDecodeFeed("Listening for known devices...");
  if ($("decode-empty")) $("decode-empty").classList.remove("hidden");
  const freq = Number($("decode-freq").value);
  $("frequency").value = freq.toFixed(2);
  try {
    await api("/api/decode/start", { method: "POST", body: { frequency: freq } });
    startSse();
    await refreshStatus();
    updateDecodeStatus();
  } catch (err) {
    setMessage("decode-error", err.message, true);
    await refreshStatus();
  }
}

async function startDecodeOnly() {
  setMessage("decode-error", "");
  state.rtlSignals = [];
  $("decode-feed").innerHTML = "";
  resetCaptureDecodeFeed("Decode Only is active; identified messages appear here and on the Decode tab.");
  if ($("decode-empty")) $("decode-empty").classList.remove("hidden");
  const freq = Number($("decode-freq").value);
  $("frequency").value = freq.toFixed(2);
  try {
    await api("/api/rtl/start", { method: "POST", body: { frequency: freq } });
    startSse();
    await refreshStatus();
    updateDecodeStatus();
  } catch (err) {
    setMessage("decode-error", err.message, true);
  }
}

async function stopDecode() {
  try {
    await api("/api/decode/stop", { method: "POST" });
  } catch (err) {
    setMessage("decode-error", err.message, true);
  }
  await refreshStatus();
  updateDecodeStatus();
}

async function saveDecodeSession() {
  const name = `rtl_${Number($("decode-freq").value).toFixed(2).replace(".", "_")}`;
  try {
    const res = await api("/api/rtl/save", { method: "POST", body: { name } });
    setMessage("decode-error", `Session saved: ${res.id}`, false);
    setTimeout(() => setMessage("decode-error", ""), 3000);
    await loadLibrary();
  } catch (err) { setMessage("decode-error", err.message, true); }
}

async function loadPreviews() {
  const tbody = $("preview-table");
  const empty = $("preview-empty");
  if (!tbody) return;
  try {
    const captures = await api("/api/captures");
    state.pendingPreviews = captures.filter((cap) => cap.preview);
  } catch (err) {
    empty.textContent = `Preview load failed: ${err.message}`;
    return;
  }
  tbody.innerHTML = "";
  empty.classList.toggle("hidden", state.pendingPreviews.length !== 0);
  for (const [i, cap] of state.pendingPreviews.entries()) {
    const maxRssi = Number(cap.max_rssi ?? -120);
    const typeLabel = cap.signal_type === "rssi_only" ? "RSSI-only" : "Decoded";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="row-num">${i + 1}</td>
      <td>${formatDate(cap.ts)}</td>
      <td>${qualityBadge(cap.quality)} ${duplicateBadge(cap)}</td>
      <td>${Math.round(maxRssi)} dBm</td>
      <td>${typeLabel}: ${cap.packet_count || cap.event_count}</td>
      <td>${Number(cap.frequency).toFixed(2)}</td>
      <td class="decoded-cell">${autoDecodePreview(cap)}</td>
      <td><input class="preview-note" type="text" value="${cap.note || ""}" placeholder="note"></td>
      <td><div class="inline">
        <button class="btn small review">Review</button>
        <button class="btn small primary keep">Keep</button>
        <button class="btn small danger discard">Discard</button>
      </div></td>`;
    tr.querySelector(".preview-note").addEventListener("blur", async (event) => {
      try {
        await api(`/api/captures/${encodeURIComponent(cap.id)}/note`, { method: "POST", body: { note: event.target.value } });
        cap.note = event.target.value;
      } catch (err) {
        alert(err.message);
      }
    });
    tr.querySelector(".review").addEventListener("click", () => reviewCapture(cap));
    tr.querySelector(".keep").addEventListener("click", () => keepCapture(cap));
    tr.querySelector(".discard").addEventListener("click", () => discardCapture(cap));
    tbody.append(tr);
  }
}

async function loadLibrary() {
  const list = $("library-list");
  const empty = $("library-empty");
  const foldersEl = $("folder-tabs");
  list.innerHTML = "";
  try {
    state.captures = await api("/api/captures");
  } catch (err) {
    empty.textContent = err.message;
    empty.classList.remove("hidden");
    return;
  }
  const folders = ["All", "Previews", ...new Set(state.captures.map((cap) => cap.folder || "Unfiled").filter((name) => name !== "Previews"))];
  if (!folders.includes(state.activeFolder)) state.activeFolder = "All";
  foldersEl.innerHTML = "";
  folders.forEach((folder) => {
    const btn = document.createElement("button");
    btn.className = `folder-tab${state.activeFolder === folder ? " active" : ""}`;
    btn.textContent = folder;
    btn.addEventListener("click", () => {
      state.activeFolder = folder;
      loadLibrary();
    });
    foldersEl.append(btn);
  });
  const visible = state.captures.filter((cap) => {
    const folder = cap.preview ? "Previews" : (cap.folder || "Unfiled");
    return state.activeFolder === "All" || state.activeFolder === folder;
  });
  empty.classList.toggle("hidden", visible.length !== 0);
  for (const cap of visible) {
    const card = document.createElement("article");
    card.className = `panel capture-card${cap.preview ? " preview" : ""}`;
    const isRtl = cap.signal_type === "rtl_decoded";
    const rtlModels = isRtl && cap.rtl_signals?.length
      ? [...new Set(cap.rtl_signals.map(s => s.model || "?"))].slice(0, 3).join(", ")
      : null;
    card.innerHTML = `
      <div class="capture-card-head">
        <span class="capture-name">${cap.name}</span>
        ${cap.preview ? '<span class="badge preview-badge">PREVIEW</span>' : ""}
        ${isRtl ? '<span class="badge rtl">RTL DECODED</span>' : ""}
        ${qualityBadge(cap.quality)}
        ${duplicateBadge(cap)}
        <span class="badge">${Number(cap.frequency).toFixed(2)} MHz · ${cap.modulation}</span>
        ${isRtl ? `<span class="badge">${cap.rtl_count || 0} signals</span>` : `<span class="badge">${cap.packet_count} packets</span>`}
      </div>
      ${rtlModels ? `<div class="rtl-summary">${rtlModels}</div>` : ""}
      <div class="capture-time">${formatDate(cap.ts)}</div>
      <label class="folder-field">Folder <input class="folder-input" type="text" value="${cap.folder || ""}" placeholder="Unfiled"></label>
      <label class="note-field">Note <textarea rows="2" placeholder="Add a note...">${cap.note || ""}</textarea></label>
      <div class="inline">
        ${cap.preview ? '<button class="btn primary keep">Keep</button>' : '<button class="btn primary load">Load for Replay</button>'}
        <button class="btn decode">Decode</button>
        <button class="btn danger delete">${cap.preview ? "Discard" : "Delete"}</button>
      </div>`;
    card.querySelector("textarea").addEventListener("blur", async (event) => {
      try {
        await api(`/api/captures/${encodeURIComponent(cap.id)}/note`, { method: "POST", body: { note: event.target.value } });
        cap.note = event.target.value;
      } catch (err) {
        alert(err.message);
      }
    });
    card.querySelector(".folder-input").addEventListener("blur", async (event) => {
      try {
        await api(`/api/captures/${encodeURIComponent(cap.id)}/folder`, { method: "POST", body: { folder: event.target.value } });
        await loadLibrary();
      } catch (err) {
        alert(err.message);
      }
    });
    const loadBtn = card.querySelector(".load");
    const keepBtn = card.querySelector(".keep");
    if (loadBtn) loadBtn.addEventListener("click", () => loadReplay(cap));
    if (keepBtn) keepBtn.addEventListener("click", () => keepCapture(cap));
    card.querySelector(".decode").addEventListener("click", () => decodeCapture(cap));
    card.querySelector(".delete").addEventListener("click", async () => {
      await discardCapture(cap);
    });
    list.append(card);
  }
}

function loadReplay(capture) {
  state.loadedCapture = capture;
  $("replay-empty").classList.add("hidden");
  $("replay-panel").classList.remove("hidden");
  $("replay-name").textContent = capture.name;
  $("replay-meta").textContent = `${Number(capture.frequency).toFixed(2)} MHz · ${capture.modulation} · ${capture.packet_count} packets`;
  const quality = capture.quality || {};
  // Show RTL decode context if available
  let ctx = $("replay-decode-context");
  if (!ctx) {
    ctx = document.createElement("div");
    ctx.id = "replay-decode-context";
    ctx.className = "decode-context hidden";
    $("replay-packets").before(ctx);
  }
  if (capture.rtl_signals?.length) {
    const sig = capture.rtl_signals[0];
    const fields = Object.entries(sig).filter(([k]) => !["time","model","freq","freq1","freq2","rssi","snr","noise","mod","ook_symbols","ook_bitrate"].includes(k) && !k.startsWith("_")).map(([k,v]) => `${k}: ${v}`).join("  ·  ");
    ctx.innerHTML = `<span class="decode-context-label">Decoded as:</span>${sig.model || "?"} — ${fields}`;
    ctx.classList.remove("hidden");
  } else {
    ctx.classList.add("hidden");
  }
  const firstTs = capture.packets[0]?.ts || 0;
  const packetList = $("replay-packets");
  packetList.innerHTML = "";
  const bestReplay = capture.best_replay || {};
  const bestIndices = new Set(bestReplay.indices || []);
  capture.packets.forEach((pkt, index) => {
    const offset = Math.round(((pkt.ts || firstTs) - firstTs) * 1000);
    const row = document.createElement("label");
    row.className = "replay-row";
    const checked = bestIndices.size ? bestIndices.has(index) : true;
    row.innerHTML = `<input type="checkbox" value="${index}" ${checked ? "checked" : ""}><span>#${index}</span><span>${offset} ms</span><span>${Math.round(pkt.rssi)} dBm</span><span class="hex" title="${pkt.hex}">${truncateHex(pkt.hex)}</span>`;
    packetList.append(row);
  });
  $("replay-capture-note").innerHTML = quality.replayable
    ? `${qualityBadge(quality)} ${bestReplay.label || "Recommended replay"}: ${bestReplay.reason || (quality.reasons || []).join(" · ")}`
    : `${qualityBadge(quality)} Not replayable until payload packets are decoded.`;
  switchTab("replay");
  renderReplayDisabled();
}

function selectedReplayIndices() {
  return [...document.querySelectorAll("#replay-packets input:checked")].map((el) => Number(el.value));
}

function renderReplayDisabled() {
  const tx = $("transmit");
  const replayable = Boolean(state.loadedCapture?.quality?.replayable ?? state.loadedCapture?.packets?.length);
  const disabled = state.capturing || !state.loadedCapture || !replayable;
  tx.disabled = disabled;
  if (state.capturing) $("replay-capture-note").textContent = "Stop capture first";
}

async function loadVersionStatus(checkRemote = false) {
  const btn = $("check-update");
  if (btn) btn.disabled = true;
  if (checkRemote) $("version-summary").textContent = "Checking GitHub version...";
  try {
    const data = await api(`/api/version${checkRemote ? "?check=1" : ""}`);
    const parts = [];
    parts.push(`Current: ${data.current || "unknown"}`);
    if (data.branch) parts.push(`Branch: ${data.branch}`);
    if (data.latest) parts.push(`Latest: ${data.latest}`);
    if (data.latest) parts.push(data.up_to_date ? "Up to date" : "Update available");
    $("version-summary").textContent = parts.join(" · ");
    if (data.remote_error) setMessage("update-status", `Version check warning: ${data.remote_error}`, true);
    else if (checkRemote) setMessage("update-status", data.up_to_date ? "Already up to date." : "Update available.");
  } catch (err) {
    $("version-summary").textContent = "Version unavailable.";
    setMessage("update-status", `Version check failed: ${err.message}`, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function updateApp() {
  const btn = $("update-app");
  btn.disabled = true;
  $("restart-app").classList.add("hidden");
  setMessage("update-status", "Updating from GitHub...");
  $("update-log").hidden = true;
  $("update-log").textContent = "";
  try {
    const data = await api("/api/update", { method: "POST" });
    $("update-log").textContent = data.log || "";
    $("update-log").hidden = !data.log;
    setMessage("update-status", data.restart_required ? "Update applied. Restart Casper to run the new version." : "Already up to date.");
    if (data.restart_required) $("restart-app").classList.remove("hidden");
    await loadVersionStatus(false);
  } catch (err) {
    setMessage("update-status", `Update failed: ${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

function showServiceSplash(mode) {
  const el = $("service-splash");
  if (!el) return;
  el.dataset.mode = mode || 'restart';
  el.removeAttribute('hidden');
}

async function restartApp() {
  if (!await customConfirm("Restart Casper now? The page will reload after the service comes back.", "Restart")) return;
  showServiceSplash('restart');
  try {
    await api("/api/service/restart", { method: "POST" });
  } catch (err) {
    /* service restarting, ignore */
  }
}

async function transmitReplay() {
  if (!state.loadedCapture) return;
  $("transmit").disabled = true;
  $("transmit").textContent = "Transmitting...";
  setMessage("replay-message", "");
  try {
    const res = await api("/api/replay", {
      method: "POST",
      body: {
        id: state.loadedCapture.id,
        indices: selectedReplayIndices(),
        repeat: Number($("repeat-count").value),
        delay_ms: Number($("delay-ms").value),
      },
    });
    setMessage("replay-message", `Sent ${res.sent} packets`);
  } catch (err) {
    setMessage("replay-message", err.message, true);
  } finally {
    $("transmit").textContent = "Transmit";
    renderReplayDisabled();
  }
}

document.querySelectorAll(".main-tab").forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));
$("settings-toggle").addEventListener("click", () => setSettingsOpen($("settings-menu").classList.contains("hidden")));
document.addEventListener("click", (event) => {
  if (!$("settings-wrap").contains(event.target)) setSettingsOpen(false);
});
document.querySelectorAll(".preset").forEach((btn) => btn.addEventListener("click", () => tuneFrequency(btn.dataset.frequency)));
document.querySelectorAll(".mode-chip[data-tab]").forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));
$("symbol-rate").addEventListener("change", () => $("custom-symbol-rate").classList.toggle("hidden", $("symbol-rate").value !== "custom"));
$("apply-config").addEventListener("click", () => applyCurrentConfig(false));
$("decode-start-both").addEventListener("click", startDecodeAndCapture);
$("decode-start-rtl").addEventListener("click", startDecodeOnly);
$("decode-stop").addEventListener("click", stopDecode);
$("decode-save-session").addEventListener("click", saveDecodeSession);
$("decode-freq").addEventListener("change", () => { $("frequency").value = $("decode-freq").value; });
$("frequency").addEventListener("change", () => { $("decode-freq").value = $("frequency").value; setActiveFrequencyChip($("frequency").value); });
$("start-capture").addEventListener("click", startCapture);
$("stop-capture").addEventListener("click", stopCapture);
$("start-monitor").addEventListener("click", startMonitor);
$("stop-monitor").addEventListener("click", stopMonitor);
$("start-auto").addEventListener("click", startAuto);
$("stop-auto").addEventListener("click", stopAuto);
$("show-save").addEventListener("click", () => $("save-form").classList.toggle("hidden"));
$("save-capture").addEventListener("click", saveCapture);
$("refresh-library").addEventListener("click", loadLibrary);
$("refresh-previews").addEventListener("click", loadPreviews);
$("clear-previews").addEventListener("click", async () => {
  if (!state.pendingPreviews.length) return;
  if (!await customConfirm(`Discard all ${state.pendingPreviews.length} saved previews?`, "Discard All")) return;
  await Promise.all(state.pendingPreviews.map((cap) => api(`/api/captures/${encodeURIComponent(cap.id)}`, { method: "DELETE" }).catch(() => {})));
  await loadPreviews();
});
$("close-decode").addEventListener("click", () => $("decode-panel").classList.add("hidden"));
$("select-all").addEventListener("click", () => document.querySelectorAll("#replay-packets input").forEach((el) => { el.checked = true; }));
$("select-none").addEventListener("click", () => document.querySelectorAll("#replay-packets input").forEach((el) => { el.checked = false; }));
$("transmit").addEventListener("click", transmitReplay);
$("check-update").addEventListener("click", () => loadVersionStatus(true));
$("update-app").addEventListener("click", updateApp);
$("restart-app").addEventListener("click", restartApp);

refreshStatus();
setActiveFrequencyChip($("frequency").value);
drawSignal();
loadPreviews();
loadVersionStatus(false);
setInterval(refreshStatus, 3000);
