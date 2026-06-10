// Inspector UI — vanilla JS. Streams frames from /events (SSE).
//   left col:  manifest (with Available Tools) on top + frames log below
//   right col: detail pane — empty until the user clicks a tool or frame.
// Selection is a single piece of state with two shapes; renderDetail() switches
// on it. Frame rows in the log are click-to-select; their body is rendered on
// the right, not inline.

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
const elReconnect = document.getElementById('reconnect');
const elMain = document.getElementById('main');
const elResizer = document.getElementById('col-resizer');
const elDetailTitle = document.getElementById('detail-title');
const elDetailEmpty = document.getElementById('detail-empty');
const elDetailContent = document.getElementById('detail-content');

let showHeartbeats = false;
// selection: null | { kind: 'tool', key, tool, serverName } | { kind: 'frame', tap, frameId }
let selection = null;
let lastManifest = null;
let frameSeq = 0;

elShowHb.addEventListener('change', () => {
  showHeartbeats = elShowHb.checked;
  document.querySelectorAll('.frame-item.heartbeat').forEach((el) => {
    el.style.display = showHeartbeats ? '' : 'none';
  });
});
elClear.addEventListener('click', () => {
  elFrames.replaceChildren();
  elFrames.classList.add('empty');
  const li = document.createElement('li');
  li.className = 'empty-msg';
  li.textContent = 'No frames yet.';
  elFrames.appendChild(li);
  if (selection?.kind === 'frame') setSelection(null);
});

elReconnect.addEventListener('click', async () => {
  elReconnect.disabled = true;
  const original = elReconnect.textContent;
  elReconnect.textContent = 'reconnecting…';
  try {
    await fetch('/reconnect', { method: 'POST' });
  } catch { /* ignore */ }
  setTimeout(() => {
    elReconnect.disabled = false;
    elReconnect.textContent = original;
  }, 1500);
});

function setStatus(state, reconnect) {
  elStatus.className = `status status-${state}`;
  if (state === 'reconnecting' && reconnect) {
    const seconds = (reconnect.nextDelayMs / 1000).toFixed(1);
    elStatus.textContent = `reconnecting in ${seconds}s · attempt ${reconnect.attempt}`;
  } else {
    elStatus.textContent = state;
  }
}

function fmtTs(ts) {
  const d = new Date(ts);
  const ms = d.getMilliseconds().toString().padStart(3, '0');
  return d.toLocaleTimeString(undefined, { hour12: false }) + '.' + ms;
}

function escapeHtml(s) {
  return String(s).replaceAll(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function jsonStr(v) { return JSON.stringify(v); }

function zodExpr(prop) {
  if (!prop || typeof prop !== 'object') return 'z.unknown()';
  if (Array.isArray(prop.enum)) {
    return `z.enum([${prop.enum.map(jsonStr).join(', ')}])`;
  }
  switch (prop.type) {
    case 'string':  return 'z.string()';
    case 'number':  return 'z.number()';
    case 'integer': return 'z.number().int()';
    case 'boolean': return 'z.boolean()';
    case 'array':
      return `z.array(${zodExpr(prop.items ?? {})})`;
    case 'object':  return 'z.object({ ... })';
    default:        return 'z.unknown()';
  }
}

function appendSchemaTokens(tokens, schema, indent) {
  const T = (cls, text) => tokens.push([cls, text]);
  const NL = () => tokens.push([null, '\n']);
  const SP = (n) => tokens.push([null, ' '.repeat(n)]);

  if (schema?.type !== 'object' || !schema.properties) {
    T('punct', '{}');
    return;
  }
  const props = Object.entries(schema.properties);
  if (props.length === 0) { T('punct', '{}'); return; }
  const required = new Set(schema.required ?? []);

  T('punct', '{');
  NL();
  props.forEach(([k, v], i) => {
    SP((indent + 1) * 2);
    T('key', k);
    T('punct', ':');
    T(null, ' ');
    let expr = zodExpr(v);
    if (!required.has(k)) expr += '.optional()';
    T('zod', expr);
    if (i < props.length - 1) T('punct', ',');
    NL();
  });
  SP(indent * 2);
  T('punct', '}');
}

function renderToolShape(tool) {
  const tokens = [];
  const T = (cls, text) => tokens.push([cls, text]);
  const NL = () => tokens.push([null, '\n']);
  const SP = (n) => tokens.push([null, ' '.repeat(n)]);

  T('string', jsonStr(tool.name));
  T('punct', ',');
  NL();
  T('punct', '{');
  NL();

  SP(2);
  T('key', 'description');
  T('punct', ':');
  T(null, ' ');
  T('string', jsonStr(tool.description ?? ''));
  T('punct', ',');
  NL();

  SP(2);
  T('key', 'inputSchema');
  T('punct', ':');
  T(null, ' ');
  appendSchemaTokens(tokens, tool.inputSchema, 1);
  T('punct', ',');
  NL();

  T('punct', '}');

  return tokens.map(([cls, text]) => {
    const escaped = escapeHtml(text);
    return cls ? `<span class="${cls}">${escaped}</span>` : escaped;
  }).join('');
}

function renderManifest(m) {
  lastManifest = m;
  if (!m) {
    elManifest.hidden = true;
    elManifestEmpty.hidden = false;
    elMServers.replaceChildren();
    if (selection?.kind === 'tool') setSelection(null);
    return;
  }
  elManifest.hidden = false;
  elManifestEmpty.hidden = true;
  elMConnector.textContent = m.connectorId;
  elMEnv.textContent = m.environment;
  elMVer.textContent = m.version;

  elMServers.replaceChildren();
  for (const s of m.servers) {
    elMServers.appendChild(buildServerCard(s));
  }
  // Drop selection if the selected tool no longer exists.
  if (selection?.kind === 'tool') {
    const stillThere = m.servers.some(
      (s) => s.name === selection.serverName && s.tools.some((t) => t.name === selection.tool.name)
    );
    if (stillThere) applySelectionHighlight();
    else setSelection(null);
  }
}

function buildServerCard(s) {
  const card = document.createElement('div');
  card.className = 'server-card';
  const count = s.tools.length;
  const countLabel = count === 1 ? '1 tool' : `${count} tools`;
  card.innerHTML = `
    <div class="server-label">MCP Server</div>
    <div class="server-name">${escapeHtml(s.name)}</div>
    <div class="server-meta">${escapeHtml(s.transport)} · ${countLabel}</div>
    <div class="tools-section">
      <div class="tools-section-label">Available Tools</div>
    </div>
  `;
  const toolsSection = card.querySelector('.tools-section');
  for (const t of s.tools) {
    toolsSection.appendChild(buildToolRow(s.name, t));
  }
  return card;
}

function buildToolRow(serverName, t) {
  const row = document.createElement('div');
  row.className = 'tool-row';
  row.dataset.key = `${serverName}.${t.name}`;
  row.innerHTML = `
    <span>${escapeHtml(t.name)}</span>
    <span class="verdict ready">Ready</span>
  `;
  row.addEventListener('click', () => {
    setSelection({ kind: 'tool', key: row.dataset.key, tool: t, serverName });
  });
  return row;
}

function setSelection(next) {
  selection = next;
  applySelectionHighlight();
  renderDetail();
}

function applySelectionHighlight() {
  const toolKey = selection?.kind === 'tool' ? selection.key : null;
  document.querySelectorAll('.tool-row').forEach((el) => {
    el.classList.toggle('selected', el.dataset.key === toolKey);
  });
  const frameId = selection?.kind === 'frame' ? selection.frameId : null;
  document.querySelectorAll('.frame-item').forEach((el) => {
    el.classList.toggle('selected', Number(el.dataset.frameId) === frameId);
  });
}

function renderDetail() {
  if (!selection) {
    elDetailContent.hidden = true;
    elDetailEmpty.hidden = false;
    elDetailTitle.textContent = 'Detail';
    elDetailContent.replaceChildren();
    return;
  }
  elDetailEmpty.hidden = true;
  elDetailContent.hidden = false;
  elDetailContent.replaceChildren();

  if (selection.kind === 'tool') {
    elDetailTitle.textContent = `${selection.serverName}.${selection.tool.name}`;
    const card = document.createElement('div');
    card.className = 'tool-card selected';
    card.innerHTML = `
      <div class="tool-card-head">
        <span class="name">${escapeHtml(selection.serverName)}.${escapeHtml(selection.tool.name)}</span>
        <span class="verdict ready">Ready</span>
      </div>
      <pre>${renderToolShape(selection.tool)}</pre>
    `;
    elDetailContent.appendChild(card);
    return;
  }

  if (selection.kind === 'frame') {
    const tap = selection.tap;
    elDetailTitle.textContent = `${tap.direction === 'out' ? '→' : '←'} ${tap.frame.type}`;
    elDetailContent.appendChild(renderFrameDetail(tap));
  }
}

function renderFrameDetail(tap) {
  const wrap = document.createElement('div');
  wrap.className = 'detail-frame';

  const head = document.createElement('div');
  head.className = 'detail-head';
  head.innerHTML = `
    <span class="frame-ts">${fmtTs(tap.ts)}</span>
    <span class="frame-dir ${tap.direction}">${tap.direction === 'out' ? '→' : '←'}</span>
    <span class="frame-type ${tap.frame.type}">${escapeHtml(tap.frame.type)}</span>
    <span class="frame-summary">${escapeHtml(summarizeFrame(tap.frame))}</span>
  `;
  wrap.appendChild(head);

  if (tap.frame.type === 'rpc') {
    const rpc = renderRpcDetail(tap.frame.payload);
    if (rpc) wrap.appendChild(rpc);
  }

  const pre = document.createElement('pre');
  pre.className = 'detail-json';
  pre.textContent = JSON.stringify(tap.frame, null, 2);
  wrap.appendChild(pre);

  return wrap;
}

// Per-type detail renderer for `rpc` frames. Surfaces the JSON-RPC structure
// — request: method + qualified tool name + arguments; response: result body
// or error code/kind/message — above the raw JSON dump rendered below.
function renderRpcDetail(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const box = document.createElement('div');
  box.className = 'detail-rpc';

  if ('method' in payload) {
    const params = payload.params ?? {};
    const toolName = typeof params.name === 'string' ? params.name : null;
    box.innerHTML = `
      <div class="kv"><span class="k">method</span><code class="v">${escapeHtml(payload.method)}</code></div>
      <div class="kv"><span class="k">id</span><code class="v">${escapeHtml(String(payload.id ?? ''))}</code></div>
      ${toolName ? `<div class="kv"><span class="k">tool</span><code class="v">${escapeHtml(toolName)}</code></div>` : ''}
      ${params.arguments === undefined ? '' : `<div class="kv block"><span class="k">arguments</span><pre class="v">${escapeHtml(JSON.stringify(params.arguments, null, 2))}</pre></div>`}
    `;
    return box;
  }
  if ('result' in payload) {
    box.innerHTML = `
      <div class="kv"><span class="k">id</span><code class="v">${escapeHtml(String(payload.id ?? ''))}</code></div>
      <div class="kv block"><span class="k">result</span><pre class="v">${escapeHtml(JSON.stringify(payload.result, null, 2))}</pre></div>
    `;
    return box;
  }
  if ('error' in payload) {
    const err = payload.error ?? {};
    box.innerHTML = `
      <div class="kv"><span class="k">id</span><code class="v">${escapeHtml(String(payload.id ?? ''))}</code></div>
      <div class="kv"><span class="k">code</span><code class="v">${escapeHtml(String(err.code ?? ''))}</code></div>
      ${err.data?.kind ? `<div class="kv"><span class="k">kind</span><code class="v">${escapeHtml(err.data.kind)}</code></div>` : ''}
      <div class="kv"><span class="k">message</span><code class="v">${escapeHtml(err.message ?? '')}</code></div>
    `;
    return box;
  }
  return null;
}

function summarizeRpcFrame(p) {
  if (!p || typeof p !== 'object') return 'rpc';
  if ('method' in p) {
    const params = p.params;
    const name = params && typeof params === 'object' && 'name' in params ? `(${params.name})` : '';
    return `${p.method}${name} id=${p.id}`;
  }
  if ('result' in p) return `result id=${p.id}`;
  if ('error' in p)  return `error id=${p.id} ${p.error?.data?.kind ?? p.error?.message ?? ''}`;
  return 'rpc';
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
    case 'rpc':
      return summarizeRpcFrame(frame.payload);
    default:
      return '';
  }
}

function appendFrame(tap) {
  if (elFrames.classList.contains('empty')) {
    elFrames.classList.remove('empty');
    elFrames.replaceChildren();
  }
  const li = document.createElement('li');
  const frameId = ++frameSeq;
  li.dataset.frameId = String(frameId);
  li.className = `frame-item ${tap.frame.type}`;
  if (tap.frame.type === 'heartbeat' && !showHeartbeats) li.style.display = 'none';
  li.innerHTML = `
    <div class="frame-head">
      <span class="frame-ts">${fmtTs(tap.ts)}</span>
      <span class="frame-dir ${tap.direction}">${tap.direction === 'out' ? '→' : '←'}</span>
      <span class="frame-type ${tap.frame.type}">${tap.frame.type}</span>
      <span class="frame-summary">${escapeHtml(summarizeFrame(tap.frame))}</span>
    </div>
  `;
  li.addEventListener('click', () => {
    setSelection({ kind: 'frame', tap, frameId });
  });
  elFrames.insertBefore(li, elFrames.firstChild);
  while (elFrames.children.length > 500) elFrames.lastChild?.remove();
}

function applySnapshot(s) {
  elController.textContent = s.controllerUrl;
  setStatus(s.state, s.reconnect);
  renderManifest(s.manifest);
  elFrames.replaceChildren();
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
  // SSE reconnect: any selected frame is from a prior snapshot — drop it.
  if (selection?.kind === 'frame') setSelection(null);
}

function connectSse() {
  const es = new EventSource('/events');
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    switch (ev.kind) {
      case 'snapshot': applySnapshot(ev); break;
      case 'state':    setStatus(ev.state, ev.reconnect); break;
      case 'manifest': renderManifest(ev.manifest); break;
      case 'frame':    appendFrame(ev.tap); break;
    }
  };
  es.onerror = () => { /* EventSource auto-retries */ };
}

const LEFT_COL_KEY = 'inspector.leftColPx';
const LEFT_COL_MIN = 280;
const LEFT_COL_MAX_FRAC = 0.7;

function applyLeftColWidth(px) {
  const clamped = Math.max(LEFT_COL_MIN, Math.min(px, window.innerWidth * LEFT_COL_MAX_FRAC));
  elMain.style.setProperty('--left-col', `${clamped}px`);
  return clamped;
}

const savedWidth = Number(localStorage.getItem(LEFT_COL_KEY));
if (savedWidth > 0) applyLeftColWidth(savedWidth);

elResizer.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  elResizer.setPointerCapture(e.pointerId);
  elResizer.classList.add('dragging');
  document.body.classList.add('col-resizing');

  const onMove = (ev) => {
    const next = applyLeftColWidth(ev.clientX);
    localStorage.setItem(LEFT_COL_KEY, String(Math.round(next)));
  };
  const onUp = (ev) => {
    elResizer.releasePointerCapture(ev.pointerId);
    elResizer.classList.remove('dragging');
    document.body.classList.remove('col-resizing');
    elResizer.removeEventListener('pointermove', onMove);
    elResizer.removeEventListener('pointerup', onUp);
    elResizer.removeEventListener('pointercancel', onUp);
  };
  elResizer.addEventListener('pointermove', onMove);
  elResizer.addEventListener('pointerup', onUp);
  elResizer.addEventListener('pointercancel', onUp);
});

window.addEventListener('resize', () => {
  const current = Number.parseInt(getComputedStyle(elMain).getPropertyValue('--left-col'), 10) || 0;
  if (current > 0) applyLeftColWidth(current);
});

// Collapsible left-pane sections — click the header to toggle. State persists
// per section via localStorage so the layout you set sticks across reloads.
// Stops propagation from inner controls (heartbeats checkbox, reconnect/clear
// buttons) so clicking those doesn't collapse the section.
const COLLAPSE_KEY = 'inspector.collapsed';
function loadCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]')); }
  catch { return new Set(); }
}
function saveCollapsed(set) {
  localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));
}
const collapsed = loadCollapsed();
document.querySelectorAll('.collapsible').forEach((sec) => {
  const key = sec.dataset.key;
  if (collapsed.has(key)) sec.classList.add('collapsed');
  const head = sec.querySelector('.section-head');
  head.addEventListener('click', (e) => {
    if (e.target.closest('.controls')) return;
    sec.classList.toggle('collapsed');
    if (sec.classList.contains('collapsed')) collapsed.add(key);
    else collapsed.delete(key);
    saveCollapsed(collapsed);
  });
});

connectSse();
