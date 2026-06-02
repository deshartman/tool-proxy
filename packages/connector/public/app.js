// Inspector UI — vanilla JS. Streams frames from /events (SSE).
// Renders the connector's WS state, the current ToolManifest, and a live
// frame log of every byte going out to the controller and coming back.

const elStatus = document.getElementById('status');
const elController = document.getElementById('controller-url');
const elManifestEmpty = document.getElementById('manifest-empty');
const elManifest = document.getElementById('manifest');
const elMConnector = document.getElementById('m-connector');
const elMEnv = document.getElementById('m-env');
const elMVer = document.getElementById('m-ver');
const elMServers = document.getElementById('m-servers');
const elFrames = document.getElementById('frames');
const elShowHb = document.getElementById('show-heartbeats');
const elClear = document.getElementById('clear');

let showHeartbeats = false;
elShowHb.addEventListener('change', () => {
  showHeartbeats = elShowHb.checked;
  document.querySelectorAll('.frame-item.heartbeat').forEach((el) => {
    el.style.display = showHeartbeats ? '' : 'none';
  });
});
elClear.addEventListener('click', () => {
  elFrames.innerHTML = '';
  elFrames.classList.add('empty');
  const li = document.createElement('li');
  li.className = 'empty-msg';
  li.textContent = 'No frames yet.';
  elFrames.appendChild(li);
});

function setStatus(state) {
  elStatus.className = `status status-${state}`;
  elStatus.textContent = state;
}

function fmtTs(ts) {
  const d = new Date(ts);
  const ms = d.getMilliseconds().toString().padStart(3, '0');
  return d.toLocaleTimeString(undefined, { hour12: false }) + '.' + ms;
}

function renderManifest(m) {
  if (!m) {
    elManifest.hidden = true;
    elManifestEmpty.hidden = false;
    return;
  }
  elManifest.hidden = false;
  elManifestEmpty.hidden = true;
  elMConnector.textContent = m.connectorId;
  elMEnv.textContent = m.environment;
  elMVer.textContent = m.version;
  elMServers.innerHTML = '';
  for (const s of m.servers) {
    const card = document.createElement('div');
    card.className = 'server-card';
    const allowedCount = s.tools.filter((t) => t.allowed).length;
    card.innerHTML = `
      <div class="server-name">${escapeHtml(s.name)}</div>
      <div class="server-meta">${escapeHtml(s.transport)} · ${allowedCount}/${s.tools.length} allowed</div>
    `;
    for (const t of s.tools) {
      const row = document.createElement('div');
      row.className = 'tool-row' + (t.allowed ? '' : ' denied');
      row.innerHTML = `
        <span>${escapeHtml(t.name)}</span>
        ${t.allowed ? '' : '<span class="badge">denied</span>'}
      `;
      card.appendChild(row);
    }
    elMServers.appendChild(card);
  }
}

function summarizeFrame(frame) {
  switch (frame.type) {
    case 'register':
      return `manifest with ${frame.manifest.servers.reduce((n, s) => n + s.tools.length, 0)} tools`;
    case 'manifest-delta':
      return `+${frame.delta.added.length} / -${frame.delta.removed.length} / ~${frame.delta.changed.length}`;
    case 'heartbeat':
      return `ts=${frame.ts}`;
    case 'goodbye':
      return frame.reason ?? '';
    case 'rpc': {
      const p = frame.payload;
      if (p && typeof p === 'object') {
        if ('method' in p) {
          const params = p.params;
          const name = params && typeof params === 'object' && 'name' in params ? `(${params.name})` : '';
          return `${p.method}${name} id=${p.id}`;
        }
        if ('result' in p) return `result id=${p.id}`;
        if ('error' in p)  return `error id=${p.id} ${p.error?.data?.kind ?? p.error?.message ?? ''}`;
      }
      return 'rpc';
    }
    default:
      return '';
  }
}

function appendFrame(tap) {
  if (elFrames.classList.contains('empty')) {
    elFrames.classList.remove('empty');
    elFrames.innerHTML = '';
  }
  const li = document.createElement('li');
  li.className = `frame-item ${tap.frame.type}`;
  if (tap.frame.type === 'heartbeat' && !showHeartbeats) li.style.display = 'none';
  li.innerHTML = `
    <div class="frame-head">
      <span class="frame-ts">${fmtTs(tap.ts)}</span>
      <span class="frame-dir ${tap.direction}">${tap.direction === 'out' ? '→' : '←'}</span>
      <span class="frame-type ${tap.frame.type}">${tap.frame.type}</span>
      <span class="frame-summary">${escapeHtml(summarizeFrame(tap.frame))}</span>
    </div>
    <div class="frame-body"><pre></pre></div>
  `;
  li.querySelector('.frame-body pre').textContent = JSON.stringify(tap.frame, null, 2);
  li.querySelector('.frame-head').addEventListener('click', () => {
    li.classList.toggle('expanded');
  });
  elFrames.insertBefore(li, elFrames.firstChild);
  // Keep the list bounded in the DOM.
  while (elFrames.children.length > 500) elFrames.removeChild(elFrames.lastChild);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function applySnapshot(s) {
  elController.textContent = s.controllerUrl;
  setStatus(s.state);
  renderManifest(s.manifest);
  // Replay frames oldest-first so the visual matches subsequent live order.
  elFrames.innerHTML = '';
  elFrames.classList.add('empty');
  if (s.frames && s.frames.length > 0) {
    elFrames.classList.remove('empty');
    for (const tap of s.frames) appendFrame(tap);
  } else {
    const li = document.createElement('li');
    li.className = 'empty-msg';
    li.textContent = 'No frames yet.';
    elFrames.appendChild(li);
  }
}

function connectSse() {
  const es = new EventSource('/events');
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    switch (ev.kind) {
      case 'snapshot': applySnapshot(ev); break;
      case 'state':    setStatus(ev.state); break;
      case 'manifest': renderManifest(ev.manifest); break;
      case 'frame':    appendFrame(ev.tap); break;
    }
  };
  es.onerror = () => { /* EventSource auto-retries */ };
}

connectSse();
