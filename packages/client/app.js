// Demo UI client. Subscribes to /events SSE, renders chat transcript,
// cloud + shim event logs, and animates the firewall column.

const logEls = {
  "main": document.getElementById("log-cloud"),
  "shim-a": document.getElementById("log-shim-a"),
  "shim-b": document.getElementById("log-shim-b"),
};

const transcriptEl = document.getElementById("transcript");
const pulseDownEl = document.getElementById("pulse-down");
const pulseUpEl = document.getElementById("pulse-up");

let activeQueryId = null;
let activeAgentBubble = null;     // DOM node we're streaming tokens into
let activeAgentTextEl = null;     // text span inside the bubble
let activeAgentCursorEl = null;   // blinking cursor span
let streamedText = "";
let lastSeq = -1;
let lastTokenPulseAt = 0;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function pulseFirewall(direction) {
  const el = direction === "down" ? pulseDownEl : pulseUpEl;
  el.classList.remove("active");
  // force reflow so the animation restarts
  void el.offsetWidth;
  el.classList.add("active");
}

function maybeTokenPulse() {
  const now = Date.now();
  if (now - lastTokenPulseAt < 250) return;
  lastTokenPulseAt = now;
  pulseFirewall("up");
}

function formatLocalTimestamp(ms) {
  const d = new Date(ms);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function appendLog(ev) {
  const el = logEls[ev.source];
  if (el) {
    const line = document.createElement("div");
    line.className = "log-line " + (ev.level === "detail" ? "detail" : "");
    const ts = formatLocalTimestamp(ev.ts);
    line.innerHTML = `<span class="ts">${ts}</span>${escapeHtml(ev.message)}`;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  // Cloud-side connection status updates the summary dots.
  if (ev.source === "main") {
    const conn = /shim connected: (shim-[ab])/.exec(ev.message);
    if (conn) document.getElementById(`dot-${conn[1]}`)?.classList.add("connected");
    const disc = /shim disconnected: (shim-[ab])/.exec(ev.message);
    if (disc) document.getElementById(`dot-${disc[1]}`)?.classList.remove("connected");

    // Capture queryId before tokens start arriving.
    const qm = /query started: ([0-9a-f-]+)/.exec(ev.message);
    if (qm) {
      activeQueryId = qm[1];
      streamedText = "";
      lastSeq = -1;
    }

    // Firewall animation: cloud-emitted events that trigger outbound traffic.
    if (/^query started:/.test(ev.message)) pulseFirewall("down");
    if (/^calling ask_procedure/.test(ev.message)) pulseFirewall("down");
    if (/^writing doc/.test(ev.message)) pulseFirewall("down");
    if (/^reading doc/.test(ev.message)) pulseFirewall("down");
    if (/^answer received/.test(ev.message)) pulseFirewall("up");
  }

  // Shim-emitted events ride the inbound side of the tunnel.
  if (ev.source === "shim-a" || ev.source === "shim-b") {
    pulseFirewall("up");
  }
}

function appendToken(tok) {
  if (tok.queryId !== activeQueryId) return;
  if (typeof tok.seq === "number" && tok.seq <= lastSeq) return;
  if (typeof tok.seq === "number") lastSeq = tok.seq;
  streamedText += tok.delta;
  if (activeAgentTextEl) {
    activeAgentTextEl.textContent = streamedText;
  }
  if (tok.done && activeAgentCursorEl) {
    activeAgentCursorEl.remove();
    activeAgentCursorEl = null;
  }
  scrollTranscriptToBottom();
  maybeTokenPulse();
}

function scrollTranscriptToBottom() {
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function addUserBubble(text) {
  const b = document.createElement("div");
  b.className = "bubble user";
  b.textContent = text;
  transcriptEl.appendChild(b);
  scrollTranscriptToBottom();
}

function addAgentBubble() {
  const b = document.createElement("div");
  b.className = "bubble agent";
  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  meta.textContent = "thinking…";
  const text = document.createElement("span");
  const cursor = document.createElement("span");
  cursor.className = "cursor";
  cursor.textContent = "▍";
  b.appendChild(meta);
  b.appendChild(text);
  b.appendChild(cursor);
  transcriptEl.appendChild(b);
  scrollTranscriptToBottom();
  activeAgentBubble = b;
  activeAgentTextEl = text;
  activeAgentCursorEl = cursor;
  return { meta, text, cursor };
}

function setAgentMeta(metaText) {
  const meta = activeAgentBubble?.querySelector(".bubble-meta");
  if (meta) meta.textContent = metaText;
}

function setAgentError(msg) {
  if (!activeAgentBubble) return;
  activeAgentTextEl.textContent = msg;
  activeAgentBubble.style.borderColor = "#a04040";
  if (activeAgentCursorEl) {
    activeAgentCursorEl.remove();
    activeAgentCursorEl = null;
  }
}

// SSE stream
const es = new EventSource("/events");
es.onmessage = (msg) => {
  try {
    const p = JSON.parse(msg.data);
    if (p.kind === "token") appendToken(p);
    else appendLog(p);
  } catch (e) { console.error(e); }
};
es.onerror = (e) => console.warn("SSE error", e);

// Submit a query
const inputEl = document.getElementById("q");
const submitBtn = document.getElementById("submit");
submitBtn.addEventListener("click", submitQuery);

// Shell-style history: ↑/↓ walks past user messages, ESC clears.
// `historyIdx` of -1 means "currently typing a fresh message"; the user's
// in-progress draft is stashed in `draftBuffer` so they don't lose it.
const queryHistory = [];
let historyIdx = -1;
let draftBuffer = "";

function recallHistory(direction) {
  if (queryHistory.length === 0) return;
  if (direction === "up") {
    if (historyIdx === -1) {
      draftBuffer = inputEl.value;
      historyIdx = queryHistory.length - 1;
    } else if (historyIdx > 0) {
      historyIdx--;
    }
    inputEl.value = queryHistory[historyIdx];
  } else {
    if (historyIdx === -1) return;
    if (historyIdx < queryHistory.length - 1) {
      historyIdx++;
      inputEl.value = queryHistory[historyIdx];
    } else {
      historyIdx = -1;
      inputEl.value = draftBuffer;
    }
  }
  // Move caret to end after recall.
  const len = inputEl.value.length;
  inputEl.setSelectionRange(len, len);
}

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitQuery();
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    recallHistory("up");
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    recallHistory("down");
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    inputEl.value = "";
    historyIdx = -1;
    draftBuffer = "";
  }
});

async function submitQuery() {
  const q = inputEl.value.trim();
  if (!q) return;
  submitBtn.disabled = true;
  inputEl.value = "";

  // Record in shell-style history (skip immediate duplicates of the last entry).
  if (queryHistory.at(-1) !== q) queryHistory.push(q);
  historyIdx = -1;
  draftBuffer = "";

  addUserBubble(q);
  addAgentBubble();

  activeQueryId = null;
  streamedText = "";
  lastSeq = -1;

  try {
    const res = await fetch("/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q }),
    });
    const data = await res.json();
    if (!res.ok) {
      setAgentError(`Error: ${data.error ?? "unknown"}`);
    } else {
      setAgentMeta(`via ${data.shimId} / ${data.procedureId}`);
      // If streaming didn't populate, fall back to the full answer.
      if (!streamedText && activeAgentTextEl) {
        activeAgentTextEl.textContent = data.answer;
        if (activeAgentCursorEl) {
          activeAgentCursorEl.remove();
          activeAgentCursorEl = null;
        }
      }
    }
  } catch (e) {
    setAgentError(`Network error: ${e.message}`);
  } finally {
    submitBtn.disabled = false;
    inputEl.focus();
  }
}

// Change-document toggle: each click asks the shim to swap step 1 between
// two predefined variants. Button label and a small badge reflect the
// resulting active variant.
function setVariantUi(shim, source, variant) {
  const btn = document.querySelector(`.btn-change-doc[data-shim="${shim}"][data-source="${source}"]`);
  const badge = document.querySelector(`.doc-variant[data-shim="${shim}"][data-source="${source}"]`);
  if (!btn || !badge) return;
  if (variant === "alternate") {
    btn.textContent = "Restore original";
    badge.textContent = "(alternate active)";
    badge.classList.add("alternate");
  } else {
    btn.textContent = "Set alternate";
    badge.textContent = "(original)";
    badge.classList.remove("alternate");
  }
}

document.querySelectorAll(".btn-change-doc").forEach((btn) => {
  // Initial label until the first click resolves with server-known state.
  btn.textContent = "Change document";
  btn.addEventListener("click", async () => {
    const shim = btn.dataset.shim;
    const source = btn.dataset.source;
    btn.disabled = true;
    try {
      // No body = toggle. The shim flips to whichever variant is not active.
      const res = await fetch(`/docs/${shim}/${source}/change`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        alert(`Change failed: ${data.error ?? res.statusText}`);
        return;
      }
      setVariantUi(shim, source, data.variant);
    } finally {
      btn.disabled = false;
    }
  });
});

// Column resizers: drag to set --col-chat / --col-shims as pixel values on
// <main>. The middle (cloud) column absorbs slack via its 1fr default.
// Direction "forward" means the column is to the LEFT of the resizer
// (drag right grows it). "reverse" means it's to the RIGHT (drag right
// shrinks it).
function bindResizer(handle) {
  const targetVar = handle.dataset.target;
  const direction = handle.dataset.direction;
  const main = document.querySelector("main");

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    document.body.classList.add("col-resizing");

    // Capture the column's current pixel width as the drag-start baseline so
    // the cursor stays under the handle even if --col-* was previously a fr.
    let colSelector = null;
    if (targetVar === "--col-chat") colSelector = ".col.chat";
    else if (targetVar === "--col-shims") colSelector = ".col.shims";
    const colEl = colSelector ? document.querySelector(colSelector) : null;
    const startWidth = colEl ? colEl.getBoundingClientRect().width : 240;
    const startX = e.clientX;

    const minWidth = 200;
    const maxWidth = window.innerWidth - 320;

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      let next = direction === "forward" ? startWidth + dx : startWidth - dx;
      next = Math.max(minWidth, Math.min(maxWidth, next));
      main.style.setProperty(targetVar, `${next}px`);
    };
    const onUp = () => {
      handle.releasePointerCapture(e.pointerId);
      handle.classList.remove("dragging");
      document.body.classList.remove("col-resizing");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  });
}

document.querySelectorAll(".resizer").forEach(bindResizer);
