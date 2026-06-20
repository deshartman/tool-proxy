// Inspector UI — vanilla JS. Streams frames from /events (SSE).
//   left col:  manifest (with Available Tools) on top + frames log below
//   right col: detail pane — empty until the user clicks a tool or frame.
// Selection is a single piece of state with two shapes; renderDetail() switches
// on it. Frame rows in the log are click-to-select; their body is rendered on
// the right, not inline.

const elStatus = document.getElementById('status');
const elController = document.getElementById('controller-url');
const elIdentity = document.getElementById('identity');
const elHdrName = document.getElementById('hdr-name');
const elHdrId = document.getElementById('hdr-id');
const elHdrEnv = document.getElementById('hdr-env');
const elHdrVer = document.getElementById('hdr-ver');
const elHdrAckAt = document.getElementById('hdr-ack-at');
const elHdrOpenSince = document.getElementById('hdr-open-since');
const elManifestEmpty = document.getElementById('manifest-empty');
const elManifest = document.getElementById('manifest');
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
const elWebhooksEmpty = document.getElementById('webhooks-empty');
const elWebhooksList = document.getElementById('webhooks-list');
const elMcpStatusEmpty = document.getElementById('mcp-status-empty');
const elMcpStatusList = document.getElementById('mcp-status-list');

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

// Reconnect button: disable + show 'reconnecting…' until the SSE stream
// reports a state change away from 'connecting' / 'reconnecting'. The
// previous version reset the label after a hard-coded 1500ms regardless
// of whether the dial succeeded — looked healthy even when the connector
// was hung on a half-open TLS handshake.
const RECONNECT_LABEL_DEFAULT = 'reconnect';
const RECONNECT_LABEL_PENDING = 'reconnecting…';
function setReconnectButtonState(connectionState) {
  // 'connecting' (initial dial) and 'reconnecting' (in backoff window)
  // both keep the button locked; 'open' and 'closed' release it.
  const inFlight = connectionState === 'connecting' || connectionState === 'reconnecting';
  elReconnect.disabled = inFlight;
  elReconnect.textContent = inFlight ? RECONNECT_LABEL_PENDING : RECONNECT_LABEL_DEFAULT;
}
elReconnect.addEventListener('click', async () => {
  elReconnect.disabled = true;
  elReconnect.textContent = RECONNECT_LABEL_PENDING;
  try {
    await fetch('/reconnect', { method: 'POST' });
  } catch { /* ignore — SSE will show terminal state */ }
  // No timer reset: the SSE state event will toggle the label back
  // when the connector emits state=open or state=closed.
});

function setIdentity(identity) {
  if (!elIdentity) return;
  if (!identity) {
    elIdentity.className = 'identity identity-unknown';
    elIdentity.textContent = '…';
    elIdentity.title = '';
    return;
  }
  switch (identity.kind) {
    case 'bound':
      elIdentity.className = 'identity identity-bound';
      elIdentity.textContent = `bound (token len=${identity.tokenLen})`;
      elIdentity.title = 'Connector is bound to a controller record. The registrationToken is persisted in .connector-state.json.';
      break;
    case 'first-connect':
      elIdentity.className = 'identity identity-first';
      elIdentity.textContent = 'first-connect pending';
      elIdentity.title = 'No registrationToken on disk yet. Controller will mint one on the next successful register-ack.';
      break;
    case 'cleared':
      elIdentity.className = 'identity identity-cleared';
      elIdentity.textContent = 'cleared — re-minting';
      elIdentity.title = 'Controller returned unknown_registration_token. The local state file was cleared; auto-reconnect will mint a fresh row on the next attempt.';
      break;
    case 'rejected':
      elIdentity.className = 'identity identity-rejected';
      elIdentity.textContent = `rejected: ${identity.reason}`;
      elIdentity.title = identity.message || `Controller rejected the register frame with code "${identity.reason}". Operator intervention required.`;
      break;
    default:
      elIdentity.className = 'identity identity-unknown';
      elIdentity.textContent = identity.kind;
      elIdentity.title = '';
  }
}

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
  // connectorId / environment / version moved to the page header (HeaderInfo).
  // The manifest block is now purely about servers + their tools.

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
  const collapsed = isServerCollapsed(s.name);
  if (collapsed) card.classList.add('collapsed');
  card.innerHTML = `
    <button type="button" class="server-header" aria-expanded="${!collapsed}">
      <span class="server-toggle" aria-hidden="true">▾</span>
      <span class="server-header-text">
        <span class="server-label">MCP Server</span>
        <span class="server-name">${escapeHtml(s.name)}</span>
        <span class="server-meta">${escapeHtml(s.transport)} · ${countLabel}</span>
      </span>
    </button>
    <div class="tools-section">
      <div class="tools-section-label">Available Tools</div>
    </div>
  `;
  const toolsSection = card.querySelector('.tools-section');
  for (const t of s.tools) {
    toolsSection.appendChild(buildToolRow(s.name, t));
  }
  card.querySelector('.server-header').addEventListener('click', () => {
    const nowCollapsed = !card.classList.contains('collapsed');
    card.classList.toggle('collapsed', nowCollapsed);
    card.querySelector('.server-header').setAttribute('aria-expanded', String(!nowCollapsed));
    setServerCollapsed(s.name, nowCollapsed);
  });
  return card;
}

// Server cards default to collapsed — most operators want a high-level
// list of MCPs first, drilling into a specific server's tools is the
// less-common second step. localStorage stores the EXPANDED state (so
// fresh laptops start fully collapsed without preloading a deny-list of
// every server name).
const EXPAND_KEY_PREFIX = 'inspector.serverExpanded.';
function isServerCollapsed(name) {
  try { return localStorage.getItem(EXPAND_KEY_PREFIX + name) !== '1'; }
  catch { return true; }
}
function setServerCollapsed(name, collapsed) {
  try {
    if (collapsed) localStorage.removeItem(EXPAND_KEY_PREFIX + name);
    else localStorage.setItem(EXPAND_KEY_PREFIX + name, '1');
  } catch { /* private mode etc. */ }
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

// Schema-driven invocation form. Reads inputSchema.properties to render a
// labeled input per top-level field; falls back to a JSON textarea for
// shapes the simple renderer can't handle (nested objects, arrays, etc.).
// POSTs to /tool/call and renders the result as pretty-printed JSON.
function buildToolRunner(serverName, tool) {
  const wrap = document.createElement('div');
  wrap.className = 'tool-runner';

  const schema = tool.inputSchema || { type: 'object', properties: {}, required: [] };
  const props = (schema.type === 'object' && schema.properties) ? schema.properties : null;
  const required = new Set(schema.required ?? []);
  const simple = props && Object.values(props).every(canRenderInline);

  wrap.innerHTML = `
    <div class="tool-runner-head">Run</div>
    <div class="tool-runner-fields"></div>
    <div class="tool-runner-actions">
      <button type="button" class="run-btn">Run</button>
      <span class="run-status"></span>
    </div>
    <pre class="run-result" hidden></pre>
  `;
  const fields = wrap.querySelector('.tool-runner-fields');
  const status = wrap.querySelector('.run-status');
  const result = wrap.querySelector('.run-result');
  const runBtn = wrap.querySelector('.run-btn');

  // Track each field's read-current-value function so we can assemble args
  // on submit without re-querying the DOM by name.
  const readers = [];

  if (simple) {
    for (const [name, spec] of Object.entries(props)) {
      const isReq = required.has(name);
      fields.appendChild(buildField(name, spec, isReq, readers));
    }
  } else {
    appendJsonFallback(fields, required, readers);
  }

  runBtn.addEventListener('click', () => {
    void runOnce({ simple, readers, serverName, tool, runBtn, status, result });
  });

  return wrap;
}

async function runOnce({ simple, readers, serverName, tool, runBtn, status, result }) {
  let args;
  try {
    args = simple ? assembleArgsFromInline(readers) : readers[0]();
  } catch (e) {
    status.textContent = String(e.message || e);
    status.className = 'run-status err';
    return;
  }
  status.textContent = 'running...';
  status.className = 'run-status pending';
  runBtn.disabled = true;
  try {
    const resp = await fetch('/tool/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server: serverName, tool: tool.name, args }),
    });
    const body = await resp.json();
    renderRunResult(body, status, result);
    result.hidden = false;
  } catch (e) {
    status.textContent = String(e.message || e);
    status.className = 'run-status err';
  } finally {
    runBtn.disabled = false;
  }
}

function renderRunResult(body, status, result) {
  if (body.ok) {
    status.textContent = 'ok';
    status.className = 'run-status ok';
    result.textContent = JSON.stringify(body.result, null, 2);
  } else {
    status.textContent = 'error';
    status.className = 'run-status err';
    result.textContent = body.error || '(no error message)';
  }
}

function canRenderInline(spec) {
  if (!spec || typeof spec !== 'object') return false;
  const t = spec.type;
  return t === 'string' || t === 'integer' || t === 'number' || t === 'boolean';
}

// Fallback when inputSchema isn't a flat object: render one big JSON
// textarea pre-populated with a stub of required keys. Operator edits the
// raw JSON; on submit we parse it.
function appendJsonFallback(fields, required, readers) {
  const stub = required.size > 0
    ? Object.fromEntries([...required].map((k) => [k, '']))
    : {};
  const ta = document.createElement('textarea');
  ta.className = 'run-json';
  ta.rows = 6;
  ta.value = JSON.stringify(stub, null, 2);
  const lbl = document.createElement('label');
  lbl.className = 'field';
  lbl.innerHTML = `<span class="field-name">arguments (JSON)</span>`;
  lbl.appendChild(ta);
  fields.appendChild(lbl);
  readers.push(() => {
    const trimmed = ta.value.trim();
    if (!trimmed) return {};
    try { return JSON.parse(trimmed); }
    catch (e) { throw new Error(`arguments JSON is invalid: ${e.message}`); }
  });
}

function buildField(name, spec, required, readers) {
  const lbl = document.createElement('label');
  lbl.className = 'field';
  const desc = spec.description ? `<span class="field-desc">${escapeHtml(spec.description)}</span>` : '';
  const reqMark = required ? '<span class="field-req">*</span>' : '';
  lbl.innerHTML = `<span class="field-name">${escapeHtml(name)}${reqMark}</span>${desc}`;

  const read = appendInputForType(lbl, name, spec);
  readers.push(read);
  return lbl;
}

function appendInputForType(lbl, name, spec) {
  if (spec.type === 'boolean') {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    if (spec.default === true) cb.checked = true;
    lbl.appendChild(cb);
    return () => ({ name, value: cb.checked, present: true });
  }
  if (spec.type === 'integer' || spec.type === 'number') {
    const inp = document.createElement('input');
    inp.type = 'number';
    if (spec.type === 'integer') inp.step = '1';
    if (spec.default !== undefined) inp.value = String(spec.default);
    if (typeof spec.minimum === 'number') inp.min = String(spec.minimum);
    if (typeof spec.maximum === 'number') inp.max = String(spec.maximum);
    lbl.appendChild(inp);
    return () => ({ name, value: coerceNumber(inp.value, spec.type), present: inp.value !== '' });
  }
  const inp = document.createElement('input');
  inp.type = 'text';
  if (spec.default !== undefined) inp.value = String(spec.default);
  lbl.appendChild(inp);
  return () => ({ name, value: inp.value, present: inp.value !== '' });
}

function coerceNumber(raw, jsonType) {
  if (raw === '') return undefined;
  if (jsonType === 'integer') return Number.parseInt(raw, 10);
  return Number(raw);
}

function assembleArgsFromInline(readers) {
  const out = {};
  for (const read of readers) {
    const { name, value, present } = read();
    if (present) out[name] = value;
  }
  return out;
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
    card.appendChild(buildToolRunner(selection.serverName, selection.tool));
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
    case 'webhook-allocate':
      return `mcp=${frame.mcp}`;
    case 'webhook-allocate-ack':
      return frame.error ? `${frame.mcp} error=${frame.error.code}` : `${frame.mcp} url=${frame.url ?? '?'}`;
    case 'webhook':
      return `mcp=${frame.mcp}`;
    case 'webhook-revoke':
      return `mcp=${frame.mcp}`;
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

// Operator-facing header info (connector name+id, last register-ack,
// tunnel-open-since). Optional fields render as em-dash when absent so the
// layout doesn't shift between unbound and bound states. Timestamps come
// in as ISO strings; we prettify locally — keep millisecond resolution
// off for readability.
function setHeader(h) {
  if (!h) return;
  if (h.connectorName !== undefined) elHdrName.textContent = h.connectorName || '—';
  if (h.connectorId !== undefined) elHdrId.textContent = h.connectorId || '—';
  if (h.environment !== undefined) elHdrEnv.textContent = h.environment || '—';
  if (h.version !== undefined) elHdrVer.textContent = h.version || '—';
  if (h.lastRegisterAckAt !== undefined) elHdrAckAt.textContent = fmtIso(h.lastRegisterAckAt);
  if (h.tunnelOpenSinceAt !== undefined) elHdrOpenSince.textContent = fmtIso(h.tunnelOpenSinceAt);
}

function fmtIso(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}

function applySnapshot(s) {
  elController.textContent = s.controllerUrl;
  setStatus(s.state, s.reconnect);
  setReconnectButtonState(s.state);
  setIdentity(s.identity);
  setHeader(s.header);
  renderManifest(s.manifest);
  renderWebhooks(s.webhooks);
  renderMcpStatuses(s.mcpStatuses);
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

function renderMcpStatuses(list) {
  if (!list || list.length === 0) {
    elMcpStatusList.hidden = true;
    elMcpStatusList.replaceChildren();
    elMcpStatusEmpty.hidden = false;
    return;
  }
  elMcpStatusEmpty.hidden = true;
  elMcpStatusList.hidden = false;
  elMcpStatusList.replaceChildren();
  for (const status of list) {
    elMcpStatusList.appendChild(buildMcpStatusRow(status));
  }
}

function buildMcpStatusRow(s) {
  const li = document.createElement('li');
  li.className = `mcp-status-row mcp-status-${s.process}`;
  const credsLine = s.credsLastUpdated
    ? `${s.credsSource} · ${fmtAgo(s.credsLastUpdated)}`
    : s.credsSource;
  const restartLine = s.restartCount === 0
    ? 'no restarts'
    : `${s.restartCount} restart${s.restartCount === 1 ? '' : 's'}` + (s.lastRestartReason ? ` (${s.lastRestartReason})` : '');
  li.innerHTML = `
    <div class="mcp-status-head">
      <span class="mcp-status-name">${escapeHtml(s.name)}</span>
      <span class="mcp-status-state">${escapeHtml(s.process)}</span>
    </div>
    <div class="mcp-status-meta">
      <div><span class="muted">creds:</span> ${escapeHtml(credsLine)}</div>
      <div><span class="muted">tools:</span> ${s.toolsCount}</div>
      <div><span class="muted">restarts:</span> ${escapeHtml(restartLine)}</div>
    </div>
    <div class="mcp-status-actions">
      <button type="button" class="mcp-action-reload" data-mcp="${escapeHtml(s.name)}">Reload creds</button>
      <button type="button" class="mcp-action-restart" data-mcp="${escapeHtml(s.name)}">Restart</button>
      <span class="mcp-action-status"></span>
    </div>
  `;
  const reload = li.querySelector('.mcp-action-reload');
  const restart = li.querySelector('.mcp-action-restart');
  const status = li.querySelector('.mcp-action-status');
  reload.addEventListener('click', () => void invokeMcpAction('/mcp/reload-creds', s.name, status));
  restart.addEventListener('click', () => void invokeMcpAction('/mcp/restart', s.name, status));
  return li;
}

async function invokeMcpAction(path, mcp, status) {
  status.textContent = 'working…';
  status.className = 'mcp-action-status pending';
  try {
    const resp = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mcp }),
    });
    const body = await resp.json().catch(() => ({}));
    if (resp.status >= 400 || body.ok === false) {
      status.textContent = body.error || `HTTP ${resp.status}`;
      status.className = 'mcp-action-status err';
      return;
    }
    status.textContent = 'sent';
    status.className = 'mcp-action-status ok';
  } catch (e) {
    status.textContent = String(e.message || e);
    status.className = 'mcp-action-status err';
  }
}

function fmtAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) {
    const seconds = Math.max(0, Math.round(diff / 1000));
    return `${seconds}s ago`;
  }
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3_600_000)}h ago`;
}

function renderWebhooks(list) {
  if (!list || list.length === 0) {
    elWebhooksList.hidden = true;
    elWebhooksList.replaceChildren();
    elWebhooksEmpty.hidden = false;
    return;
  }
  elWebhooksEmpty.hidden = true;
  elWebhooksList.hidden = false;
  elWebhooksList.replaceChildren();
  for (const w of list) {
    const li = document.createElement('li');
    li.className = 'webhook-row';
    const url = w.url ?? '(allocating…)';
    li.innerHTML = `
      <div class="webhook-mcp">${escapeHtml(w.mcp)}</div>
      <div class="webhook-url"><code>${escapeHtml(url)}</code></div>
      <div class="webhook-meta">${w.listeners} listener${w.listeners === 1 ? '' : 's'}</div>
    `;
    if (w.url) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'webhook-copy';
      btn.textContent = 'copy';
      btn.addEventListener('click', () => {
        navigator.clipboard?.writeText(w.url).then(() => {
          const original = btn.textContent;
          btn.textContent = 'copied';
          setTimeout(() => { btn.textContent = original; }, 1200);
        });
      });
      li.appendChild(btn);
    }
    elWebhooksList.appendChild(li);
  }
}

function connectSse() {
  const es = new EventSource('/events');
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    switch (ev.kind) {
      case 'snapshot': applySnapshot(ev); break;
      case 'state':
        setStatus(ev.state, ev.reconnect);
        setReconnectButtonState(ev.state);
        break;
      case 'identity': setIdentity(ev.identity); break;
      case 'header':   setHeader(ev.header); break;
      case 'manifest': renderManifest(ev.manifest); break;
      case 'frame':    appendFrame(ev.tap); break;
      case 'webhooks': renderWebhooks(ev.webhooks); break;
      case 'mcpStatuses': renderMcpStatuses(ev.mcpStatuses); break;
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
