// Inspector UI — vanilla JS. Streams frames from /events (SSE) and renders:
//   left col:  manifest (with Allow List) on top + frames log below
//   right col: each tool's MCP-shape card (registerTool-style) stacked vertically
// Clicking a row in the Allow List highlights the matching tool card on the
// right and scrolls it into view.

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
const elToolsEmpty = document.getElementById('tools-empty');
const elToolsList = document.getElementById('tools-list');

let showHeartbeats = false;
let selectedToolKey = null;     // `${server}.${tool}`

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

function escapeHtml(s) {
  return String(s).replaceAll(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function jsonStr(v) { return JSON.stringify(v); }

// JSON Schema property → Zod-like syntax.
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
      return prop.items ? `z.array(${zodExpr(prop.items)})` : 'z.array(z.unknown())';
    case 'object':  return 'z.object({ ... })';
    default:        return 'z.unknown()';
  }
}

// Token-based rendering: each token is [cssClass | null, text].
// At the end we map to escaped HTML, so source text never goes through innerHTML
// without escaping.
function appendSchemaTokens(tokens, schema, indent) {
  const T = (cls, text) => tokens.push([cls, text]);
  const NL = () => tokens.push([null, '\n']);
  const SP = (n) => tokens.push([null, ' '.repeat(n)]);

  if (!schema || schema.type !== 'object' || !schema.properties) {
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
  if (!m) {
    elManifest.hidden = true;
    elManifestEmpty.hidden = false;
    renderTools(null);
    return;
  }
  elManifest.hidden = false;
  elManifestEmpty.hidden = true;
  elMConnector.textContent = m.connectorId;
  elMEnv.textContent = m.environment;
  elMVer.textContent = m.version;

  elMServers.replaceChildren();
  for (const s of m.servers) {
    const card = buildServerCard(s);
    elMServers.appendChild(card);
  }
  renderTools(m);
  applySelection();
}

function buildServerCard(s) {
  const card = document.createElement('div');
  card.className = 'server-card';
  const allowedCount = s.tools.filter((t) => t.allowed).length;
  card.innerHTML = `
    <div class="server-label">MCP Server</div>
    <div class="server-name">${escapeHtml(s.name)}</div>
    <div class="server-meta">${escapeHtml(s.transport)} · ${allowedCount}/${s.tools.length} allowed</div>
    <div class="allow-section">
      <div class="allow-label">Allow List</div>
    </div>
  `;
  const allowSection = card.querySelector('.allow-section');
  for (const t of s.tools) {
    allowSection.appendChild(buildAllowRow(s.name, t));
  }
  return card;
}

function buildAllowRow(serverName, t) {
  const row = document.createElement('div');
  row.className = 'allow-row';
  row.dataset.key = `${serverName}.${t.name}`;
  row.innerHTML = `
    <span>${escapeHtml(t.name)}</span>
    <span class="verdict ${t.allowed ? 'allowed' : 'not-allowed'}">${t.allowed ? 'Allowed' : 'Not Allowed'}</span>
  `;
  row.addEventListener('click', () => {
    selectedToolKey = row.dataset.key;
    applySelection();
    const card = document.querySelector(`.tool-card[data-key="${CSS.escape(selectedToolKey)}"]`);
    card?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  return row;
}

function renderTools(m) {
  if (!m || m.servers.every((s) => s.tools.length === 0)) {
    elToolsEmpty.hidden = false;
    elToolsList.replaceChildren();
    return;
  }
  elToolsEmpty.hidden = true;
  elToolsList.replaceChildren();
  for (const s of m.servers) {
    for (const t of s.tools) {
      elToolsList.appendChild(buildToolCard(s.name, t));
    }
  }
}

function buildToolCard(serverName, t) {
  const key = `${serverName}.${t.name}`;
  const card = document.createElement('div');
  card.className = 'tool-card' + (t.allowed ? '' : ' denied');
  card.dataset.key = key;
  card.innerHTML = `
    <div class="tool-card-head">
      <span class="name">${escapeHtml(serverName)}.${escapeHtml(t.name)}</span>
      <span class="verdict ${t.allowed ? 'allowed' : 'not-allowed'}">${t.allowed ? 'Allowed' : 'Not Allowed'}</span>
    </div>
    <pre>${renderToolShape(t)}</pre>
  `;
  return card;
}

function applySelection() {
  document.querySelectorAll('.allow-row').forEach((el) => {
    el.classList.toggle('selected', el.dataset.key === selectedToolKey);
  });
  document.querySelectorAll('.tool-card').forEach((el) => {
    el.classList.toggle('selected', el.dataset.key === selectedToolKey);
  });
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
  while (elFrames.children.length > 500) elFrames.lastChild?.remove();
}

function applySnapshot(s) {
  elController.textContent = s.controllerUrl;
  setStatus(s.state);
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
