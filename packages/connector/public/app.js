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
const elRescanLocal = document.getElementById('rescan-local');
const elRescanLocalStatus = document.getElementById('rescan-local-status');

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

// Keyboard navigation for the Frames list. ArrowDown/ArrowUp move and select
// (matching click semantics — detail pane updates live). Enter re-scrolls the
// current selection into view if frames have streamed past it. Skips hidden
// heartbeats during navigation. Bails out if the user is typing or has a
// button/link focused so we don't hijack native handlers.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
  const t = e.target;
  const tag = t?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A' || tag === 'SELECT' || t?.isContentEditable) return;

  const visible = [...elFrames.querySelectorAll('.frame-item')].filter((el) => el.style.display !== 'none');
  if (visible.length === 0) return;

  if (e.key === 'Enter') {
    const current = visible.find((el) => el.classList.contains('selected'));
    if (current) current.scrollIntoView({ block: 'nearest' });
    else visible[0].click();
    e.preventDefault();
    return;
  }

  const currentIdx = visible.findIndex((el) => el.classList.contains('selected'));
  let nextIdx;
  if (currentIdx < 0) {
    nextIdx = 0;
  } else if (e.key === 'ArrowDown') {
    nextIdx = Math.min(currentIdx + 1, visible.length - 1);
  } else {
    nextIdx = Math.max(currentIdx - 1, 0);
  }
  if (nextIdx === currentIdx) { e.preventDefault(); return; }
  visible[nextIdx].click();
  visible[nextIdx].scrollIntoView({ block: 'nearest' });
  e.preventDefault();
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

// W-L2: Refresh local MCPs — re-scan ${MCP_DROPIN_DIR} for new drop-in
// folders and reconcile against the supervisor. Loopback-only POST against
// the inspector port (same trust boundary as everything else here).
elRescanLocal?.addEventListener('click', () => void runRescanLocal());

async function runRescanLocal() {
  if (!elRescanLocal) return;
  elRescanLocal.disabled = true;
  elRescanLocalStatus.textContent = 'scanning…';
  elRescanLocalStatus.className = 'muted';
  try {
    const resp = await fetch('/mcp/rescan-local', { method: 'POST' });
    const body = await resp.json().catch(() => ({}));
    if (resp.status >= 400 || body.ok === false) {
      elRescanLocalStatus.textContent = body.error || `HTTP ${resp.status}`;
      elRescanLocalStatus.className = 'mcp-action-status err';
      return;
    }
    const a = (body.added || []).length;
    const r = (body.removed || []).length;
    const e = (body.errors || []).length;
    let msg;
    if (a === 0 && r === 0 && e === 0) msg = 'no changes';
    else msg = `+${a} added · -${r} removed${e ? ` · ${e} error${e === 1 ? '' : 's'}` : ''}`;
    elRescanLocalStatus.textContent = msg;
    elRescanLocalStatus.className = e > 0 ? 'mcp-action-status err' : 'mcp-action-status ok';
  } catch (err) {
    elRescanLocalStatus.textContent = String(err.message || err);
    elRescanLocalStatus.className = 'mcp-action-status err';
  } finally {
    elRescanLocal.disabled = false;
  }
}

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

  if (tool.title) {
    SP(2);
    T('key', 'title');
    T('punct', ':');
    T(null, ' ');
    T('string', jsonStr(tool.title));
    T('punct', ',');
    NL();
  }

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
  // Drop selection if the selected item no longer exists. v1.2 also covers
  // prompt / resource / resourceTemplate selections.
  if (selection?.kind === 'prompt' || selection?.kind === 'resource' || selection?.kind === 'resourceTemplate') {
    setSelection(null);
  }
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
  const promptsCount = (s.prompts || []).length;
  const resourcesCount = (s.resources || []).length + (s.resourceTemplates || []).length;
  const meta = [pluralLabel(s.tools.length, 'tool')];
  if (promptsCount > 0) meta.push(pluralLabel(promptsCount, 'prompt'));
  if (resourcesCount > 0) meta.push(pluralLabel(resourcesCount, 'resource'));
  const collapsed = isServerCollapsed(s.name);
  if (collapsed) card.classList.add('collapsed');
  // W-S5: the grey "MCP Server" label still toggles expand/collapse;
  // clicking the purple <name> selects the right-pane MCP creds view
  // (peer to selecting a tool — no close button, just switch by clicking
  // any tool). Two click targets, two distinct behaviours, the inner
  // <button> stops propagation so a name-click never collapses.
  card.innerHTML = `
    <div class="server-header-row">
      <button type="button" class="server-header" aria-expanded="${!collapsed}">
        <span class="server-toggle" aria-hidden="true">▾</span>
        <span class="server-label">MCP Server</span>
      </button>
      <button type="button" class="server-name-btn${(s.envKeys || []).length > 0 ? ' has-env' : ''}" data-mcp="${escapeHtml(s.name)}"${(s.envKeys || []).length > 0 ? ' title="Click to set environment variables"' : ''}>
        <span class="server-name">${escapeHtml(s.name)}</span>
      </button>
      <span class="server-meta">${escapeHtml(s.transport)} · ${meta.join(' · ')}</span>
    </div>
    <div class="tools-section">
      <div class="tools-section-label">Available Tools</div>
    </div>
  `;
  const toolsSection = card.querySelector('.tools-section');
  for (const t of s.tools) {
    toolsSection.appendChild(buildToolRow(s.name, t));
  }
  // v1.2 — MCP-CLIENT-USE. Prompts and resources, when the server declared
  // them, appear as sibling sections under the same server card. Same
  // collapse/expand semantics as the tools list — operators see one MCP at
  // a time, drill in for capabilities.
  if (promptsCount > 0) {
    const promptsSection = buildSection('Prompts', s.name, (s.prompts || []), buildPromptRow);
    card.appendChild(promptsSection);
  }
  if (resourcesCount > 0) {
    const resourcesSection = document.createElement('div');
    resourcesSection.className = 'tools-section';
    resourcesSection.innerHTML = `<div class="tools-section-label">Resources</div>`;
    for (const r of (s.resources || [])) resourcesSection.appendChild(buildResourceRow(s.name, r, false));
    for (const t of (s.resourceTemplates || [])) resourcesSection.appendChild(buildResourceRow(s.name, t, true));
    card.appendChild(resourcesSection);
  }
  card.querySelector('.server-header').addEventListener('click', () => {
    const nowCollapsed = !card.classList.contains('collapsed');
    card.classList.toggle('collapsed', nowCollapsed);
    card.querySelector('.server-header').setAttribute('aria-expanded', String(!nowCollapsed));
    setServerCollapsed(s.name, nowCollapsed);
  });
  // W-S5: clicking the purple <name> selects the MCP creds view in the
  // right pane — peer to selecting a tool. Switching to any tool
  // restores the tool-shape view automatically (selection is
  // single-valued).
  const nameBtn = card.querySelector('.server-name-btn');
  if (nameBtn) {
    nameBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      setSelection({ kind: 'mcp', key: `mcp:${s.name}`, serverName: s.name });
    });
  }
  return card;
}

function pluralLabel(n, noun) {
  return n === 1 ? `1 ${noun}` : `${n} ${noun}s`;
}

function buildSection(label, serverName, items, rowBuilder) {
  const section = document.createElement('div');
  section.className = 'tools-section';
  section.innerHTML = `<div class="tools-section-label">${escapeHtml(label)}</div>`;
  for (const item of items) section.appendChild(rowBuilder(serverName, item));
  return section;
}

function buildPromptRow(serverName, p) {
  const row = document.createElement('div');
  row.className = 'tool-row';
  row.dataset.key = `prompt:${serverName}.${p.name}`;
  row.innerHTML = `
    <span>${escapeHtml(p.name)}</span>
    <span class="verdict ready">Prompt</span>
  `;
  row.addEventListener('click', () => {
    setSelection({ kind: 'prompt', key: row.dataset.key, prompt: p, serverName });
  });
  return row;
}

function buildResourceRow(serverName, r, isTemplate) {
  const row = document.createElement('div');
  row.className = 'tool-row';
  const uri = isTemplate ? r.uriTemplate : r.uri;
  row.dataset.key = `resource:${serverName}.${uri}`;
  row.innerHTML = `
    <span>${escapeHtml(r.name)}</span>
    <span class="verdict ready">${isTemplate ? 'Template' : 'Resource'}</span>
  `;
  row.addEventListener('click', () => {
    setSelection({ kind: isTemplate ? 'resourceTemplate' : 'resource', key: row.dataset.key, resource: r, serverName });
  });
  return row;
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
  // W-S8: per-tool verdict downgrade. If the MCP declared envKeys
  // (ServerDescriptor.envKeys non-empty) AND credsSource is "none",
  // every tool in that MCP is "Awaiting config" rather than "Ready".
  // A creds-eager MCP whose tools register at boot regardless still
  // shows up — but the verdict tells the dev "you can't smoke-test
  // me yet".
  const awaiting = isMcpAwaitingConfig(serverName);
  const verdictClass = awaiting ? 'awaiting' : 'ready';
  const verdictLabel = awaiting ? 'Awaiting config' : 'Ready';
  const labelHtml = t.title
    ? `<span class="tool-label"><span class="tool-title">${escapeHtml(t.title)}</span><span class="tool-name muted">${escapeHtml(t.name)}</span></span>`
    : `<span class="tool-label"><span class="tool-name">${escapeHtml(t.name)}</span></span>`;
  row.innerHTML = `
    ${labelHtml}
    <span class="verdict ${verdictClass}">${verdictLabel}</span>
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
  // W-S5: highlight the purple <name> button when its MCP is selected.
  const mcpName = selection?.kind === 'mcp' ? selection.serverName : null;
  document.querySelectorAll('.server-name-btn').forEach((el) => {
    el.classList.toggle('selected', el.dataset.mcp === mcpName);
  });
  const webhookKey = selection?.kind === 'webhook' ? selection.eventKey : null;
  document.querySelectorAll('.webhook-event').forEach((el) => {
    el.classList.toggle('selected', el.dataset.webhookKey === webhookKey);
  });
}

function buildToolDetail(sel) {
  const qualified = `${sel.serverName}.${sel.tool.name}`;
  elDetailTitle.textContent = sel.tool.title ? `${sel.tool.title} · ${qualified}` : qualified;
  const card = document.createElement('div');
  card.className = 'tool-card selected';
  // W-S8: mirror the verdict downgrade in the right-pane card head.
  const awaiting = isMcpAwaitingConfig(sel.serverName);
  const verdictClass = awaiting ? 'awaiting' : 'ready';
  const verdictLabel = awaiting ? 'Awaiting config' : 'Ready';
  const headName = sel.tool.title
    ? `<span class="name">${escapeHtml(sel.tool.title)}</span><span class="name-qualified muted">${escapeHtml(qualified)}</span>`
    : `<span class="name">${escapeHtml(qualified)}</span>`;
  card.innerHTML = `
    <div class="tool-card-head">
      ${headName}
      <span class="verdict ${verdictClass}">${verdictLabel}</span>
    </div>
    <pre>${renderToolShape(sel.tool)}</pre>
  `;
  card.appendChild(buildToolRunner(sel.serverName, sel.tool));
  return card;
}

function buildPromptDetail(sel) {
  elDetailTitle.textContent = `${sel.serverName}.${sel.prompt.name}`;
  const card = document.createElement('div');
  card.className = 'tool-card selected';
  const argsHtml = (sel.prompt.arguments || []).map((arg) =>
    `<li><code>${escapeHtml(arg.name)}</code>${arg.required ? ' <em>(required)</em>' : ''}${arg.description ? ` — ${escapeHtml(arg.description)}` : ''}</li>`
  ).join('') || '<li class="muted">no arguments</li>';
  card.innerHTML = `
    <div class="tool-card-head">
      <span class="name">${escapeHtml(sel.serverName)}.${escapeHtml(sel.prompt.name)}</span>
      <span class="verdict ready">Prompt</span>
    </div>
    ${sel.prompt.description ? `<div class="muted">${escapeHtml(sel.prompt.description)}</div>` : ''}
    <div class="muted" style="margin-top: 0.5em">arguments:</div>
    <ul>${argsHtml}</ul>
  `;
  return card;
}

function buildResourceDetail(sel) {
  const r = sel.resource;
  const uri = sel.kind === 'resourceTemplate' ? r.uriTemplate : r.uri;
  elDetailTitle.textContent = `${sel.serverName} · ${r.name}`;
  const card = document.createElement('div');
  card.className = 'tool-card selected';
  card.innerHTML = `
    <div class="tool-card-head">
      <span class="name">${escapeHtml(r.name)}</span>
      <span class="verdict ready">${sel.kind === 'resourceTemplate' ? 'Template' : 'Resource'}</span>
    </div>
    <div><code>${escapeHtml(uri)}</code></div>
    ${r.mimeType ? `<div class="muted">mime: <code>${escapeHtml(r.mimeType)}</code></div>` : ''}
    ${r.description ? `<div class="muted">${escapeHtml(r.description)}</div>` : ''}
  `;
  return card;
}

function buildFrameDetailPanel(sel) {
  const tap = sel.tap;
  elDetailTitle.textContent = `${tap.direction === 'out' ? '→' : '←'} ${tap.frame.type}`;
  return renderFrameDetail(tap);
}

function buildMcpDetailPanel(sel) {
  elDetailTitle.textContent = sel.serverName;
  return buildMcpCredsView(sel.serverName);
}

function buildWebhookDetail(sel) {
  const { sid, status } = summarizeEvent(sel.event);
  const heading = formatWebhookHeading(sid, status);
  elDetailTitle.textContent = `${sel.mcp} · ${heading}`;
  const card = document.createElement('div');
  card.className = 'tool-card selected';
  card.innerHTML = `
    <div class="tool-card-head">
      <span class="name">${escapeHtml(sel.mcp)} ← webhook</span>
      <span class="verdict ready">${escapeHtml(formatAge(sel.event.receivedAt))}</span>
    </div>
  `;
  const pre = document.createElement('pre');
  pre.className = 'webhook-event-detail';
  pre.textContent = JSON.stringify({
    body: sel.event.body,
    queryParameters: sel.event.queryParameters,
    headers: sel.event.headers ?? {},
    receivedAt: sel.event.receivedAt,
  }, null, 2);
  card.appendChild(pre);
  return card;
}

const DETAIL_BUILDERS = {
  tool: buildToolDetail,
  prompt: buildPromptDetail,
  resource: buildResourceDetail,
  resourceTemplate: buildResourceDetail,
  frame: buildFrameDetailPanel,
  mcp: buildMcpDetailPanel,
  webhook: buildWebhookDetail,
};

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
  const build = DETAIL_BUILDERS[selection.kind];
  if (build) elDetailContent.appendChild(build(selection));
}

// W-S5: right-pane creds view. Renders:
//   - credsSource pill (controller / controller+session / session /
//     dir/.env / none) sourced from McpStatus
//   - countdown when sessionCredsExpiresAt is set
//   - declared envKeys form (masked inputs, never pre-filled)
//   - Apply / Clear buttons + status line
// Cred-leak guards: form values are only sent on Apply submit; the form
// re-renders empty after Apply (W-S9 L9 — UI never echoes a session-set
// value back); fetching envKeys hits a write-only-no-readback route.
function buildMcpCredsView(name) {
  const wrap = document.createElement('div');
  wrap.className = 'mcp-creds-view';
  const status = mcpStatusByName(name);

  const head = document.createElement('div');
  head.className = 'mcp-creds-head';
  const credsLabel = status?.credsSource || 'unknown';
  const expiresAt = status?.sessionCredsExpiresAt;
  head.innerHTML = `
    <div class="mcp-creds-pill mcp-creds-${escapeHtml(credsLabel)}">${escapeHtml(credsLabel)}</div>
    ${expiresAt ? `<div class="mcp-creds-expiry" data-expires-at="${expiresAt}">session expires in ${escapeHtml(fmtCountdown(expiresAt))}</div>` : ''}
  `;
  wrap.appendChild(head);

  // Note: controller-set creds NEVER appear in the form. The pill above
  // tells the operator what's already in play; the form is for *adding*
  // a session layer (or overriding gaps the controller hasn't filled).
  const note = document.createElement('div');
  note.className = 'mcp-creds-note muted';
  if (credsLabel === 'controller' || credsLabel === 'controller+session') {
    note.textContent = 'Controller-set creds are active and always win per-key. Paste session creds below to fill any gaps for local smoke-testing.';
  } else if (credsLabel === 'session') {
    note.textContent = 'Session creds active. Re-paste to extend the 12h TTL, or click Clear to drop them now.';
  } else {
    note.textContent = 'No creds configured. Paste developer creds below to smoke-test locally — they live in memory only and expire after 12 hours.';
  }
  wrap.appendChild(note);

  const form = document.createElement('form');
  form.className = 'mcp-creds-form';
  const envBody = document.createElement('div');
  envBody.className = 'mcp-creds-fields';
  envBody.innerHTML = `<div class="muted">Loading declared env keys…</div>`;
  form.appendChild(envBody);

  const actions = document.createElement('div');
  actions.className = 'mcp-creds-actions';
  actions.innerHTML = `
    <button type="submit" class="mcp-creds-apply">Apply (session only)</button>
    <button type="button" class="mcp-creds-clear">Clear session creds</button>
    <span class="mcp-creds-status"></span>
  `;
  form.appendChild(actions);
  wrap.appendChild(form);

  const statusEl = actions.querySelector('.mcp-creds-status');

  // Fetch envKeys async; populate form when ready.
  void (async () => {
    try {
      const resp = await fetch(`/mcp/env-keys?mcp=${encodeURIComponent(name)}`);
      const body = await resp.json().catch(() => ({}));
      const keys = (body.ok && Array.isArray(body.envKeys)) ? body.envKeys : [];
      if (keys.length === 0) {
        envBody.innerHTML = `<div class="muted">No declared envKeys for this MCP. (Type 2 / stdio MCPs don't expose them — set creds in the controller UI.)</div>`;
        return;
      }
      envBody.replaceChildren();
      // sessionEnvKeys is the names-only list of keys the supervisor
      // currently has session values for. Use it to render a redacted
      // "•••• (set)" placeholder so the developer sees that the key is
      // already populated without the connector echoing the value back
      // through the loopback UI. Cred-leak contract (W-S9 L9) holds —
      // the placeholder is a literal string, not a re-rendered secret.
      const sessionKeysSet = new Set(mcpStatusByName(name)?.sessionEnvKeys || []);
      for (const k of keys) {
        const row = document.createElement('label');
        row.className = 'mcp-creds-field';
        const isSet = sessionKeysSet.has(k);
        const placeholder = isSet ? '•••••••• (set — leave blank to keep)' : '';
        const setBadge = isSet ? `<span class="mcp-creds-set-badge">set</span>` : '';
        row.innerHTML = `
          <span class="mcp-creds-key">${escapeHtml(k)}${setBadge}</span>
          <input type="password" name="${escapeHtml(k)}" autocomplete="off" data-1p-ignore placeholder="${escapeHtml(placeholder)}">
        `;
        envBody.appendChild(row);
      }
    } catch (e) {
      envBody.innerHTML = `<div class="err">Failed to load envKeys: ${escapeHtml(String(e.message || e))}</div>`;
    }
  })();

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const env = {};
    for (const input of form.querySelectorAll('input[type="password"]')) {
      if (input.value) env[input.name] = input.value;
    }
    if (Object.keys(env).length === 0) {
      // No new values typed in. If at least one key is already set, this
      // is a no-op submit (re-paste extends the TTL only when fresh
      // values arrive — leaving everything blank means "I'm done").
      // Surface the no-op so the dev knows nothing happened.
      const haveAny = (mcpStatusByName(name)?.sessionEnvKeys?.length || 0) > 0;
      statusEl.textContent = haveAny ? 'nothing changed' : 'no values entered';
      statusEl.className = haveAny ? 'mcp-creds-status' : 'mcp-creds-status err';
      return;
    }
    statusEl.textContent = 'applying…';
    statusEl.className = 'mcp-creds-status pending';
    try {
      const resp = await fetch('/mcp/session-creds-apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mcp: name, env }),
      });
      const body = await resp.json().catch(() => ({}));
      if (resp.status >= 400 || body.ok === false) {
        statusEl.textContent = body.error || `HTTP ${resp.status}`;
        statusEl.className = 'mcp-creds-status err';
        return;
      }
      // CRED-LEAK GUARD (W-S9 L9): clear input values after apply so the
      // pasted secret doesn't sit in DOM memory longer than necessary
      // and the next render is empty.
      for (const input of form.querySelectorAll('input[type="password"]')) input.value = '';
      statusEl.textContent = 'applied';
      statusEl.className = 'mcp-creds-status ok';
    } catch (e) {
      statusEl.textContent = String(e.message || e);
      statusEl.className = 'mcp-creds-status err';
    }
  });

  actions.querySelector('.mcp-creds-clear').addEventListener('click', async () => {
    statusEl.textContent = 'clearing…';
    statusEl.className = 'mcp-creds-status pending';
    try {
      const resp = await fetch('/mcp/session-creds-clear', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mcp: name }),
      });
      const body = await resp.json().catch(() => ({}));
      if (resp.status >= 400 || body.ok === false) {
        statusEl.textContent = body.error || `HTTP ${resp.status}`;
        statusEl.className = 'mcp-creds-status err';
        return;
      }
      statusEl.textContent = 'cleared';
      statusEl.className = 'mcp-creds-status ok';
    } catch (e) {
      statusEl.textContent = String(e.message || e);
      statusEl.className = 'mcp-creds-status err';
    }
  });

  return wrap;
}

function fmtCountdown(epochMs) {
  const remaining = Math.max(0, epochMs - Date.now());
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
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
  pre.textContent = JSON.stringify(redactFrameForDisplay(tap.frame), null, 2);
  wrap.appendChild(pre);

  return wrap;
}

// Inspector binds to 127.0.0.1, but the rendered JSON ends up on screens,
// in screen-shares, and in screenshots. Mask credential VALUES in
// creds-response / creds-update before stringify; keep key names visible
// because operators need to know which keys are populated. See
// .claude/plans/CREDS-ENCRYPTION.md for the wire-level encryption work
// that supersedes this redaction once shipped.
function redactFrameForDisplay(frame) {
  if (!frame || typeof frame !== 'object') return frame;
  if (frame.type !== 'creds-response' && frame.type !== 'creds-update') return frame;
  if (!frame.env || typeof frame.env !== 'object') return frame;
  const redactedEnv = {};
  for (const [key, value] of Object.entries(frame.env)) {
    const len = typeof value === 'string' ? value.length : 0;
    redactedEnv[key] = `<redacted, len=${len}>`;
  }
  return { ...frame, env: redactedEnv };
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
    const toolRowHtml = renderRpcToolKv(toolName);
    box.innerHTML = `
      <div class="kv"><span class="k">method</span><code class="v">${escapeHtml(payload.method)}</code></div>
      <div class="kv"><span class="k">id</span><code class="v">${escapeHtml(String(payload.id ?? ''))}</code></div>
      ${toolRowHtml}
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

function lookupToolTitle(qualified) {
  if (!lastManifest || typeof qualified !== 'string') return null;
  const dot = qualified.indexOf('.');
  if (dot < 0) return null;
  const serverName = qualified.slice(0, dot);
  const toolName = qualified.slice(dot + 1);
  const server = lastManifest.servers?.find((s) => s.name === serverName);
  const tool = server?.tools?.find((t) => t.name === toolName);
  return tool?.title ?? null;
}

function renderRpcToolKv(toolName) {
  if (!toolName) return '';
  const title = lookupToolTitle(toolName);
  const valueHtml = title
    ? `${escapeHtml(toolName)} <span class="muted">· ${escapeHtml(title)}</span>`
    : escapeHtml(toolName);
  return `<div class="kv"><span class="k">tool</span><code class="v">${valueHtml}</code></div>`;
}

function summarizeRpcFrame(p) {
  if (!p || typeof p !== 'object') return 'rpc';
  if ('method' in p) {
    const params = p.params;
    const toolName = params && typeof params === 'object' && typeof params.name === 'string' ? params.name : null;
    const title = toolName ? lookupToolTitle(toolName) : null;
    let name = '';
    if (toolName) name = title ? `(${toolName} · ${title})` : `(${toolName})`;
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
    case 'manifest-delta': {
      // Tools-only counts stay primary; prompts/resources counts append
      // when present (v1.2). An older controller showing the same line
      // sees the same counts; the new fields default to 0.
      const tools = `+${frame.delta.added.length} / -${frame.delta.removed.length} / ~${frame.delta.changed.length}`;
      const prompts = (frame.delta.addedPrompts?.length ?? 0) + (frame.delta.removedPrompts?.length ?? 0) + (frame.delta.changedPrompts?.length ?? 0);
      const resources = (frame.delta.addedResources?.length ?? 0) + (frame.delta.removedResources?.length ?? 0) + (frame.delta.changedResources?.length ?? 0);
      const extra = [];
      if (prompts > 0) extra.push(`${prompts} prompt change(s)`);
      if (resources > 0) extra.push(`${resources} resource change(s)`);
      return extra.length > 0 ? `${tools} · ${extra.join(', ')}` : tools;
    }
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
    case 'creds-request':
      return `mcp=${frame.mcp} keys=${(frame.envKeys ?? []).length}`;
    case 'creds-response': {
      const keys = frame.env ? Object.keys(frame.env) : [];
      return `keys=[${keys.join(',')}] source=${frame.source ?? '?'}`;
    }
    case 'creds-update': {
      const keys = frame.env ? Object.keys(frame.env) : [];
      return `mcp=${frame.mcp} keys=[${keys.join(',')}] source=${frame.source ?? '?'}`;
    }
    case 'mcp-notification': {
      const method = frame.payload && typeof frame.payload === 'object' ? frame.payload.method : '?';
      return `server=${frame.server} method=${method ?? '?'}`;
    }
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

// W-S5: keep the latest mcpStatuses snapshot for the right-pane creds
// view. Indexed by name for O(1) lookup when rendering. Refreshed on every
// `mcpStatuses` SSE event AND on the initial snapshot.
let lastMcpStatuses = null;
function mcpStatusByName(name) {
  if (!lastMcpStatuses) return undefined;
  return lastMcpStatuses.find((s) => s.name === name);
}

// W-S7/W-S8: an MCP is "awaiting config" when it declared envKeys (so it
// expects creds at runtime) AND no creds source is active. Drives both
// the MCP Status panel badge AND the per-tool verdict downgrade.
// MCPs that declare no envKeys (e.g. mcp/local/sample/{now,uuid}) are
// never marked awaiting — they don't need creds.
function isMcpAwaitingConfig(name) {
  const status = mcpStatusByName(name);
  if (!status) return false;
  if (status.credsSource && status.credsSource !== 'none') return false;
  const server = (lastManifest?.servers || []).find((s) => s.name === name);
  const declared = (server?.envKeys || []).length;
  return declared > 0;
}

function renderMcpStatuses(list) {
  lastMcpStatuses = list || null;
  // W-S5: if the right-pane creds view is open and the underlying status
  // changed (creds applied / cleared / TTL expired), re-render so the
  // expiry countdown and credsSource pill stay live.
  if (selection?.kind === 'mcp') renderDetail();
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
  // W-E6 / W-L1: source badge — three values:
  //   "yaml"              — bundled (Twilio-shipped) entry from connector.yaml
  //   "local"             — customer-authored drop-in folder under MCP_DROPIN_DIR
  //   "controller-config" — controller-pushed 3rd-party MCP
  // mcpId is the controller-minted opaque key, surfaced for operator-side
  // correlation with the controller's row.
  let sourceLabel = 'yaml';
  if (s.source === 'controller-config') sourceLabel = 'controller';
  else if (s.source === 'local') sourceLabel = 'local';
  const sourceBadge = `<span class="mcp-source-badge mcp-source-${s.source || 'yaml'}">${escapeHtml(sourceLabel)}</span>`;
  const mcpIdLine = s.mcpId
    ? `<div><span class="muted">mcpId:</span> <code>${escapeHtml(s.mcpId)}</code></div>`
    : '';
  // W-S7: "Awaiting config" pill when the MCP declared envKeys but no
  // creds are active. Same predicate as the per-tool verdict downgrade.
  const awaitingBadge = isMcpAwaitingConfig(s.name)
    ? `<span class="mcp-awaiting-badge">Awaiting config</span>`
    : '';
  li.innerHTML = `
    <div class="mcp-status-head">
      <span class="mcp-status-name">${escapeHtml(s.name)}</span>
      ${sourceBadge}
      ${awaitingBadge}
      <span class="mcp-status-state">${escapeHtml(s.process)}</span>
    </div>
    <div class="mcp-status-meta">
      <div><span class="muted">creds:</span> ${escapeHtml(credsLine)}</div>
      <div><span class="muted">tools:</span> ${s.toolsCount}</div>
      <div><span class="muted">restarts:</span> ${escapeHtml(restartLine)}</div>
      ${mcpIdLine}
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

// Mirror of the SID/Status keys the apis MCP's status-callback helper uses;
// we sniff the same fields so a Twilio webhook renders as "SM… status" rather
// than "(payload)". Anything not in this list falls back to "webhook".
const WEBHOOK_SID_KEYS = ['MessageSid', 'CallSid', 'RecordingSid', 'ConferenceSid', 'FaxSid', 'RoomSid'];
const WEBHOOK_STATUS_KEYS = ['MessageStatus', 'CallStatus', 'RecordingStatus', 'ConferenceStatus', 'FaxStatus', 'RoomStatus'];

function readField(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  }
  return undefined;
}

function summarizeEvent(event) {
  const sid = readField(event.body, WEBHOOK_SID_KEYS) ?? readField(event.queryParameters, WEBHOOK_SID_KEYS);
  const status = readField(event.body, WEBHOOK_STATUS_KEYS) ?? readField(event.queryParameters, WEBHOOK_STATUS_KEYS);
  return { sid, status };
}

function formatAge(receivedAt) {
  const seconds = Math.max(0, Math.round((Date.now() - receivedAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function shortSid(sid) {
  if (!sid) return '';
  if (sid.length <= 10) return sid;
  return `${sid.slice(0, 8)}…`;
}

function formatWebhookLabel(sid, status) {
  if (sid && status) return `${shortSid(sid)} ${status}`;
  if (sid) return shortSid(sid);
  return status ?? 'webhook';
}

function formatWebhookHeading(sid, status) {
  if (sid && status) return `${shortSid(sid)} · ${status}`;
  return sid ?? status ?? 'webhook';
}

function webhookEventKey(mcp, event) {
  // Stable per-event identifier for selection highlighting. receivedAt is
  // controller-stamped and sufficiently unique within a connector lifetime;
  // pairing with mcp avoids collisions across MCPs.
  return `${mcp}:${event.receivedAt}`;
}

function renderWebhookEvents(mcp, events) {
  if (!events || events.length === 0) return null;
  const wrap = document.createElement('div');
  wrap.className = 'webhook-events';
  for (const event of events) {
    const { sid, status } = summarizeEvent(event);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'webhook-event';
    row.dataset.webhookKey = webhookEventKey(mcp, event);
    const label = formatWebhookLabel(sid, status);
    row.innerHTML = `
      <span class="webhook-event-label">${escapeHtml(label)}</span>
      <span class="webhook-event-age">${escapeHtml(formatAge(event.receivedAt))}</span>
    `;
    row.addEventListener('click', () => {
      setSelection({ kind: 'webhook', mcp, event, eventKey: webhookEventKey(mcp, event) });
    });
    wrap.appendChild(row);
  }
  return wrap;
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
    const events = renderWebhookEvents(w.mcp, w.recentEvents);
    if (events) li.appendChild(events);
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

// ─── Tunnel panel (Step 9b) ─────────────────────────────────────
// Renders the top-of-left-col Tunnel panel that lets operators configure
// / edit / force-reregister the controller tunnel from the inspector UI.
// Backend: /internal/tunnel/* routes (wired only under CONNECTOR_CREDS_SOURCE=db).
//
// State is fetched with GET /internal/tunnel/config on init and re-fetched
// after every successful mutation. A 404 on that route means the connector
// is running under env mode — the panel renders a legacy banner instead
// of the form.
//
// Never renders decrypted secrets — the readout uses presence badges
// (set / not set), matching §"Write-only for secrets" in the plan.

const elTunnelLoading    = document.getElementById('tunnel-loading');
const elTunnelEnvMode    = document.getElementById('tunnel-env-mode');
const elTunnelEmpty      = document.getElementById('tunnel-empty');
const elTunnelConfigured = document.getElementById('tunnel-configured');
const elTunnelModeBadge  = document.getElementById('tunnel-mode-badge');
const elTunnelConfigureBtn = document.getElementById('tunnel-configure-btn');
const elTunnelEditBtn      = document.getElementById('tunnel-edit-btn');
const elTunnelForceBtn     = document.getElementById('tunnel-force-btn');
const elTunnelActionStatus = document.getElementById('tunnel-action-status');
const elTunnelRUrl       = document.getElementById('tunnel-r-url');
const elTunnelRName      = document.getElementById('tunnel-r-name');
const elTunnelREnv       = document.getElementById('tunnel-r-env');
const elTunnelRMode      = document.getElementById('tunnel-r-mode');
const elTunnelRBearerLabel = document.getElementById('tunnel-r-bearer-label');
const elTunnelRBearer    = document.getElementById('tunnel-r-bearer');
const elTunnelRReg       = document.getElementById('tunnel-r-reg');
const elTunnelRConnected = document.getElementById('tunnel-r-connected');
const elTunnelRDiscLabel = document.getElementById('tunnel-r-disc-label');
const elTunnelRDisc      = document.getElementById('tunnel-r-disc');

const elTunnelModal      = document.getElementById('tunnel-modal');
const elTunnelModalTitle = document.getElementById('tunnel-modal-title');
const elTunnelForm       = document.getElementById('tunnel-form');
const elTunnelFormError  = document.getElementById('tunnel-form-error');
const elTunnelFormSubmit = document.getElementById('tunnel-form-submit');
const elTunnelStaticFields = document.getElementById('tunnel-static-fields');
const elTunnelOauthFields  = document.getElementById('tunnel-oauth-fields');
const elTunnelTokenHint    = document.getElementById('tunnel-token-hint');
const elTunnelSecretHint   = document.getElementById('tunnel-secret-hint');

// null → not fetched yet; false → env mode; null-configured → empty; object → row summary
let tunnelState = { mode: 'loading', row: null };

function showTunnelView(view) {
  elTunnelLoading.hidden    = view !== 'loading';
  elTunnelEnvMode.hidden    = view !== 'env-mode';
  elTunnelEmpty.hidden      = view !== 'empty';
  elTunnelConfigured.hidden = view !== 'configured';
  elTunnelModeBadge.hidden  = view === 'loading';
  if (view === 'env-mode') { elTunnelModeBadge.textContent = 'env mode'; }
  else if (view === 'empty' || view === 'configured') { elTunnelModeBadge.textContent = 'db mode'; }
}

function setTunnelActionStatus(text, ok) {
  if (!text) { elTunnelActionStatus.hidden = true; return; }
  elTunnelActionStatus.hidden = false;
  elTunnelActionStatus.textContent = text;
  elTunnelActionStatus.className = 'tunnel-action-status ' + (ok ? 'ok' : 'err');
}

function relativeTime(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  const now = Date.now();
  const secs = Math.max(0, Math.floor((now - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return new Date(iso).toLocaleString();
}

function renderTunnelConfigured(row) {
  elTunnelRUrl.textContent = row.controllerUrl;
  elTunnelRName.textContent = row.connectorName;
  elTunnelREnv.textContent = row.environment || '—';
  elTunnelRMode.textContent = row.authMode;

  // Auth-mode-conditional badge label
  if (row.authMode === 'static-bearer') {
    elTunnelRBearerLabel.textContent = 'Bearer';
    elTunnelRBearer.textContent = row.hasTunnelAuthToken ? 'set' : 'not set';
    elTunnelRBearer.className = 'tunnel-badge ' + (row.hasTunnelAuthToken ? 'set' : 'unset');
  } else {
    elTunnelRBearerLabel.textContent = 'OAuth secret';
    elTunnelRBearer.textContent = row.hasOauthClientSecret ? 'set' : 'not set';
    elTunnelRBearer.className = 'tunnel-badge ' + (row.hasOauthClientSecret ? 'set' : 'unset');
  }

  if (row.hasRegistrationToken) {
    elTunnelRReg.textContent = `bound (len=${row.registrationTokenLen ?? '?'})`;
    elTunnelRReg.className = 'tunnel-badge set';
  } else {
    elTunnelRReg.textContent = 'not registered';
    elTunnelRReg.className = 'tunnel-badge unset';
  }

  elTunnelRConnected.textContent = relativeTime(row.lastConnectedAt);

  if (row.lastDisconnectReason) {
    elTunnelRDiscLabel.hidden = false;
    elTunnelRDisc.hidden = false;
    elTunnelRDisc.textContent = row.lastDisconnectReason;
  } else {
    elTunnelRDiscLabel.hidden = true;
    elTunnelRDisc.hidden = true;
  }
}

async function fetchTunnelConfig() {
  try {
    const resp = await fetch('/internal/tunnel/config');
    if (resp.status === 404) {
      tunnelState = { mode: 'env', row: null };
      showTunnelView('env-mode');
      return;
    }
    const body = await resp.json().catch(() => ({}));
    if (resp.status >= 400 || body.ok === false) {
      tunnelState = { mode: 'error', row: null };
      showTunnelView('empty');
      setTunnelActionStatus(body.error || `HTTP ${resp.status}`, false);
      return;
    }
    if (!body.configured) {
      tunnelState = { mode: 'empty', row: null };
      showTunnelView('empty');
      return;
    }
    tunnelState = { mode: 'configured', row: body.row };
    renderTunnelConfigured(body.row);
    showTunnelView('configured');
  } catch (err) {
    tunnelState = { mode: 'error', row: null };
    showTunnelView('empty');
    setTunnelActionStatus(String(err.message || err), false);
  }
}

// Modal open/close ────────────────────────────────────────────
function openTunnelModal(mode /* 'configure' | 'edit' */) {
  elTunnelModalTitle.textContent = mode === 'edit' ? 'Edit tunnel' : 'Configure tunnel';
  elTunnelFormSubmit.textContent = mode === 'edit' ? 'Save & reconnect' : 'Save & connect';
  elTunnelFormError.hidden = true;
  elTunnelForm.reset();

  const editing = mode === 'edit' && tunnelState.row;
  if (editing) {
    const r = tunnelState.row;
    elTunnelForm.name.value = r.name;
    elTunnelForm.controllerUrl.value = r.controllerUrl;
    elTunnelForm.connectorName.value = r.connectorName;
    elTunnelForm.environment.value = r.environment ?? '';
    const modeRadio = elTunnelForm.querySelector(`input[name="authMode"][value="${r.authMode}"]`);
    if (modeRadio) modeRadio.checked = true;
    if (r.authMode === 'oauth2-cc') {
      elTunnelForm.oauthClientId.value = r.oauthClientId ?? '';
      elTunnelForm.oauthTokenUrl.value = r.oauthTokenUrl ?? '';
    }
    // Show "leave blank to keep existing" hints when a secret is already set
    elTunnelTokenHint.hidden = !r.hasTunnelAuthToken;
    elTunnelSecretHint.hidden = !r.hasOauthClientSecret;
  } else {
    elTunnelTokenHint.hidden = true;
    elTunnelSecretHint.hidden = true;
  }
  applyAuthModeToggle();
  elTunnelModal.hidden = false;
  // Focus the first input for keyboard workflow
  const first = elTunnelForm.querySelector('input[name="name"]');
  if (first) setTimeout(() => first.focus(), 0);
}

function closeTunnelModal() {
  elTunnelModal.hidden = true;
  elTunnelForm.reset();
  elTunnelFormError.hidden = true;
}

elTunnelModal.addEventListener('click', (e) => {
  if (e.target?.dataset?.close === '1') closeTunnelModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !elTunnelModal.hidden) closeTunnelModal();
});

// Auth-mode radio toggles which fieldset is visible
function applyAuthModeToggle() {
  const mode = elTunnelForm.authMode.value;
  elTunnelStaticFields.hidden = mode !== 'static-bearer';
  elTunnelOauthFields.hidden  = mode !== 'oauth2-cc';
}
elTunnelForm.querySelectorAll('input[name="authMode"]').forEach((r) => {
  r.addEventListener('change', applyAuthModeToggle);
});

// Buttons ─────────────────────────────────────────────────────
elTunnelConfigureBtn?.addEventListener('click', () => openTunnelModal('configure'));
elTunnelEditBtn?.addEventListener('click', () => openTunnelModal('edit'));
elTunnelForceBtn?.addEventListener('click', () => void handleForceReregister());

async function handleForceReregister() {
  if (!confirm('Force re-registration? This clears the current registration token and redials the tunnel — the controller will mint a fresh one on next register-ack.')) return;
  elTunnelForceBtn.disabled = true;
  elTunnelEditBtn.disabled = true;
  setTunnelActionStatus('re-registering…', true);
  try {
    const resp = await fetch('/internal/tunnel/force-reregister', { method: 'POST' });
    const body = await resp.json().catch(() => ({}));
    if (resp.status >= 400 || body.ok === false) {
      setTunnelActionStatus(body.error || `HTTP ${resp.status}`, false);
    } else {
      setTunnelActionStatus('re-registration triggered', true);
      await fetchTunnelConfig();
    }
  } catch (err) {
    setTunnelActionStatus(String(err.message || err), false);
  } finally {
    elTunnelForceBtn.disabled = false;
    elTunnelEditBtn.disabled = false;
  }
}

// Form submit ─────────────────────────────────────────────────
elTunnelForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  elTunnelFormError.hidden = true;

  const fd = new FormData(elTunnelForm);
  const authMode = String(fd.get('authMode') || 'static-bearer');
  const payload = {
    name: String(fd.get('name') || '').trim(),
    controllerUrl: String(fd.get('controllerUrl') || '').trim(),
    connectorName: String(fd.get('connectorName') || '').trim(),
    environment: String(fd.get('environment') || '').trim() || null,
    authMode,
  };

  const editing = tunnelState.mode === 'configured' && tunnelState.row;

  if (authMode === 'static-bearer') {
    const token = String(fd.get('tunnelAuthToken') || '');
    // Edit mode + blank token + existing secret → skip so server keeps sealed value.
    // First-configure with a blank token is a validation error surfaced by the server.
    if (token) payload.tunnelAuthToken = token;
    else if (!editing || !tunnelState.row?.hasTunnelAuthToken) {
      elTunnelFormError.textContent = 'Tunnel auth token is required for the static-bearer posture.';
      elTunnelFormError.hidden = false;
      return;
    }
  } else {
    const clientId = String(fd.get('oauthClientId') || '').trim();
    const clientSecret = String(fd.get('oauthClientSecret') || '');
    const tokenUrl = String(fd.get('oauthTokenUrl') || '').trim();
    if (!clientId || !tokenUrl) {
      elTunnelFormError.textContent = 'OAuth Client ID and Token URL are required.';
      elTunnelFormError.hidden = false;
      return;
    }
    payload.oauthClientId = clientId;
    payload.oauthTokenUrl = tokenUrl;
    if (clientSecret) payload.oauthClientSecret = clientSecret;
    else if (!editing || !tunnelState.row?.hasOauthClientSecret) {
      elTunnelFormError.textContent = 'OAuth Client Secret is required.';
      elTunnelFormError.hidden = false;
      return;
    }
  }

  elTunnelFormSubmit.disabled = true;
  const originalLabel = elTunnelFormSubmit.textContent;
  elTunnelFormSubmit.textContent = editing ? 'Saving & reconnecting…' : 'Saving & connecting…';

  try {
    const resp = await fetch('/internal/tunnel/creds', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await resp.json().catch(() => ({}));
    if (resp.status >= 400 || body.ok === false) {
      elTunnelFormError.textContent = body.error || `HTTP ${resp.status}`;
      elTunnelFormError.hidden = false;
      return;
    }
    // Success
    closeTunnelModal();
    setTunnelActionStatus(editing ? 'reconnected with new credentials' : 'connected', true);
    await fetchTunnelConfig();
  } catch (err) {
    elTunnelFormError.textContent = String(err.message || err);
    elTunnelFormError.hidden = false;
  } finally {
    elTunnelFormSubmit.disabled = false;
    elTunnelFormSubmit.textContent = originalLabel;
  }
});

// Boot ────────────────────────────────────────────────────────
void fetchTunnelConfig();

connectSse();
