const state = {
  capturing: false,
  packets: [],
  captures: [],
  loadedCapture: null,
  eventSource: null,
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
}

function rssiWidth(rssi) {
  const clamped = Math.max(-120, Math.min(0, Number(rssi) || -120));
  return ((clamped + 120) / 120) * 100;
}

function updateRssi(rssi) {
  $("rssi-value").textContent = `${Math.round(rssi)} dBm`;
  $("rssi-fill").style.width = `${rssiWidth(rssi)}%`;
}

function setStatus(status) {
  state.capturing = Boolean(status.capturing);
  const mode = status.chip_ok ? (status.capturing ? "rx" : "idle") : "error-state";
  $("toolbar-state").textContent = status.capturing ? "RX" : (status.chip_ok ? "IDLE" : "ERROR");
  $("marcstate").textContent = status.marcstate || "IDLE";
  $("spi-badge").textContent = status.chip_ok ? "SPI OK" : "SPI ERROR";
  $("status-error").textContent = status.error || "";
  $("status-circle").className = `status-circle ${mode}`;
  document.querySelector(".status-dot").className = `status-dot ${mode}`;
  $("start-capture").disabled = state.capturing;
  $("stop-capture").disabled = !state.capturing;
  $("packet-counter").textContent = `${status.packet_count || state.packets.length} packets`;
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

function packetTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function truncateHex(hex) {
  return hex.length > 32 ? `${hex.slice(0, 32)}...` : hex;
}

function addPacketRow(packet, prepend = true) {
  const tbody = $("packet-table");
  const tr = document.createElement("tr");
  const idx = state.packets.length;
  tr.innerHTML = `<td>${idx}</td><td>${packetTime(packet.ts)}</td><td>${Math.round(packet.rssi)}</td><td>${packet.len}</td><td title="${packet.hex}">${truncateHex(packet.hex)}</td>`;
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
    if (data.type === "rssi") updateRssi(data.value);
    if (data.type === "packet") {
      state.packets.push(data);
      addPacketRow(data);
      updateRssi(data.rssi);
    }
    if (data.type === "error") {
      setMessage("capture-error", data.msg, true);
      refreshStatus();
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
  try {
    await api("/api/capture/start", { method: "POST" });
    startSse();
    await refreshStatus();
  } catch (err) {
    setMessage("capture-error", err.message, true);
    await refreshStatus();
  }
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

async function loadLibrary() {
  const list = $("library-list");
  const empty = $("library-empty");
  list.innerHTML = "";
  try {
    state.captures = await api("/api/captures");
  } catch (err) {
    empty.textContent = err.message;
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.toggle("hidden", state.captures.length !== 0);
  for (const cap of state.captures) {
    const card = document.createElement("article");
    card.className = "panel capture-card";
    card.innerHTML = `
      <div class="capture-card-head">
        <span class="capture-name">${cap.name}</span>
        <span class="badge">${Number(cap.frequency).toFixed(2)} MHz · ${cap.modulation}</span>
        <span class="badge">${cap.packet_count} packets</span>
      </div>
      <div class="capture-time">${formatDate(cap.ts)}</div>
      <textarea rows="2" placeholder="Add a note...">${cap.note || ""}</textarea>
      <div class="inline">
        <button class="btn primary load">Load for Replay</button>
        <button class="btn danger delete">Delete</button>
      </div>`;
    card.querySelector("textarea").addEventListener("blur", async (event) => {
      try {
        await api(`/api/captures/${encodeURIComponent(cap.id)}/note`, { method: "POST", body: { note: event.target.value } });
        cap.note = event.target.value;
      } catch (err) {
        alert(err.message);
      }
    });
    card.querySelector(".load").addEventListener("click", () => loadReplay(cap));
    card.querySelector(".delete").addEventListener("click", async () => {
      if (!confirm(`Delete ${cap.name}?`)) return;
      await api(`/api/captures/${encodeURIComponent(cap.id)}`, { method: "DELETE" });
      await loadLibrary();
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
  const firstTs = capture.packets[0]?.ts || 0;
  const packetList = $("replay-packets");
  packetList.innerHTML = "";
  capture.packets.forEach((pkt, index) => {
    const offset = Math.round(((pkt.ts || firstTs) - firstTs) * 1000);
    const row = document.createElement("label");
    row.className = "replay-row";
    row.innerHTML = `<input type="checkbox" value="${index}" checked><span>#${index}</span><span>${offset} ms</span><span>${Math.round(pkt.rssi)} dBm</span><span class="hex" title="${pkt.hex}">${truncateHex(pkt.hex)}</span>`;
    packetList.append(row);
  });
  switchTab("replay");
  renderReplayDisabled();
}

function selectedReplayIndices() {
  return [...document.querySelectorAll("#replay-packets input:checked")].map((el) => Number(el.value));
}

function renderReplayDisabled() {
  const tx = $("transmit");
  const disabled = state.capturing || !state.loadedCapture;
  tx.disabled = disabled;
  $("replay-capture-note").textContent = state.capturing ? "Stop capture first" : "";
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

async function restartApp() {
  if (!confirm("Restart Casper now? The page will reload after the service comes back.")) return;
  const btn = $("restart-app");
  btn.disabled = true;
  setMessage("update-status", "Restarting Casper service...");
  try {
    await api("/api/service/restart", { method: "POST" });
    setTimeout(() => window.location.reload(), 3500);
  } catch (err) {
    btn.disabled = false;
    setMessage("update-status", `Restart failed: ${err.message}`, true);
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
document.querySelectorAll(".preset").forEach((btn) => btn.addEventListener("click", () => { $("frequency").value = btn.dataset.frequency; }));
$("symbol-rate").addEventListener("change", () => $("custom-symbol-rate").classList.toggle("hidden", $("symbol-rate").value !== "custom"));
$("apply-config").addEventListener("click", async () => {
  try {
    await api("/api/config", { method: "POST", body: getConfig() });
    setMessage("config-message", "Config applied");
    setTimeout(() => setMessage("config-message", ""), 2000);
  } catch (err) {
    setMessage("config-message", err.message, true);
  }
});
$("start-capture").addEventListener("click", startCapture);
$("stop-capture").addEventListener("click", stopCapture);
$("show-save").addEventListener("click", () => $("save-form").classList.toggle("hidden"));
$("save-capture").addEventListener("click", saveCapture);
$("refresh-library").addEventListener("click", loadLibrary);
$("select-all").addEventListener("click", () => document.querySelectorAll("#replay-packets input").forEach((el) => { el.checked = true; }));
$("select-none").addEventListener("click", () => document.querySelectorAll("#replay-packets input").forEach((el) => { el.checked = false; }));
$("transmit").addEventListener("click", transmitReplay);
$("check-update").addEventListener("click", () => loadVersionStatus(true));
$("update-app").addEventListener("click", updateApp);
$("restart-app").addEventListener("click", restartApp);

refreshStatus();
loadVersionStatus(false);
setInterval(refreshStatus, 3000);
