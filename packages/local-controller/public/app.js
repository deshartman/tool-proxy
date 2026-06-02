// Local controller UI — vanilla JS, no build step.
//
// Loads SSE from /events, renders the connector registry, lets the user
// select an allowed tool and POST /call to invoke it on the connector.

const elStatus = document.getElementById('status');
const elList = document.getElementById('connectors-list');
const elLog = document.getElementById('log');
const elToolEmpty = document.getElementById('tool-empty');
const elToolForm = document.getElementById('tool-form');
const elToolTitle = document.getElementById('tool-title');
const elToolDescription = document.getElementById('tool-description');
const elToolSchema = document.getElementById('tool-schema');
const elArgs = document.getElementById('args');
const elResponse = document.getElementById('response');
const elCallForm = document.getElementById('call-form');

let registry = [];                 // ConnectorView[]
let selected = null;               // { connectorId, server, tool }

function statusClass(status) {
  return status === 'online' ? 'status-online'
       : status === 'stale'  ? 'status-stale'
       :                       'status-disconnected';
}

function fmtAge(ts) {
  if (!ts) return '—';
  const ageMs = Date.now() - ts;
  if (ageMs < 1000) return '<1s ago';
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s ago`;
  return `${Math.floor(ageMs / 60_000)}m ago`;
}

function render() {
  if (registry.length === 0) {
    elList.classList.add('empty');
    elList.innerHTML = 'No connectors yet. Run <code>./scripts/run-connector.sh</code>.';
    return;
  }
  elList.classList.remove('empty');
  elList.innerHTML = '';
  for (const c of registry) {
    const card = document.createElement('div');
    card.className = 'connector';
    card.innerHTML = `
      <header>
        <h3>${c.connectorId}</h3>
        <span class="status ${statusClass(c.status)}">${c.status}</span>
      </header>
      <div class="meta">
        env=${c.environment} · v${c.version} · last hb ${fmtAge(c.lastHeartbeatTs)}
      </div>
    `;
    for (const s of c.manifest.servers) {
      const block = document.createElement('div');
      block.className = 'server-block';
      block.innerHTML = `<div class="server-name">${s.name} (${s.transport})</div>`;
      const ul = document.createElement('ul');
      ul.className = 'tool-list';
      for (const t of s.tools) {
        const li = document.createElement('li');
        li.className = 'tool-item' + (t.allowed ? '' : ' denied');
        if (selected && selected.connectorId === c.connectorId
            && selected.server === s.name && selected.tool === t.name) {
          li.classList.add('selected');
        }
        li.innerHTML = `
          <span>${t.name}</span>
          ${t.allowed ? '' : '<span class="badge">denied</span>'}
        `;
        if (t.allowed) {
          li.addEventListener('click', () => {
            selected = { connectorId: c.connectorId, server: s.name, tool: t.name };
            showToolForm(c, s, t);
            render();
          });
        }
        ul.appendChild(li);
      }
      block.appendChild(ul);
      card.appendChild(block);
    }
    elList.appendChild(card);
  }
}

function showToolForm(c, s, t) {
  elToolEmpty.hidden = true;
  elToolForm.hidden = false;
  elToolTitle.textContent = `${c.connectorId} → ${s.name}.${t.name}`;
  elToolDescription.textContent = t.description || '(no description)';
  elToolSchema.textContent = JSON.stringify(t.inputSchema, null, 2);
  elArgs.value = sampleArgsFromSchema(t.inputSchema);
  elResponse.textContent = '—';
  elResponse.classList.add('muted');
}

// Pre-fill the args textarea with a JSON object containing each property
// at its default. Best-effort; user can edit freely.
function sampleArgsFromSchema(schema) {
  if (!schema || typeof schema !== 'object' || schema.type !== 'object') return '{}';
  const props = schema.properties ?? {};
  const obj = {};
  for (const [k, p] of Object.entries(props)) {
    if (p && typeof p === 'object') {
      switch (p.type) {
        case 'string': obj[k] = ''; break;
        case 'number': obj[k] = 0; break;
        case 'integer': obj[k] = 0; break;
        case 'boolean': obj[k] = false; break;
        case 'array': obj[k] = []; break;
        case 'object': obj[k] = {}; break;
        default: obj[k] = null;
      }
    }
  }
  return JSON.stringify(obj, null, 2);
}

elCallForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selected) return;
  let args;
  try {
    args = JSON.parse(elArgs.value);
  } catch (err) {
    elResponse.textContent = `arguments must be valid JSON: ${err.message}`;
    elResponse.classList.remove('muted');
    return;
  }
  elResponse.textContent = 'calling…';
  elResponse.classList.add('muted');
  const resp = await fetch('/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      connectorId: selected.connectorId,
      tool: `${selected.server}.${selected.tool}`,
      arguments: args,
    }),
  });
  const text = await resp.text();
  elResponse.textContent = text;
  elResponse.classList.remove('muted');
});

function appendLog(ev) {
  const li = document.createElement('li');
  if (ev.level === 'detail') li.classList.add('detail');
  const ts = new Date(ev.ts).toLocaleTimeString();
  li.innerHTML = `<span class="ts">${ts}</span>${escapeHtml(ev.message)}`;
  elLog.appendChild(li);
  // Keep the log bounded.
  while (elLog.children.length > 250) elLog.removeChild(elLog.firstChild);
  elLog.scrollTop = elLog.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function connectSse() {
  const es = new EventSource('/events');
  es.onopen = () => {
    elStatus.textContent = 'SSE: connected';
    elStatus.className = 'status status-online';
  };
  es.onerror = () => {
    elStatus.textContent = 'SSE: reconnecting…';
    elStatus.className = 'status status-stale';
  };
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.kind === 'registry') {
      registry = ev.connectors;
      // If the previously-selected tool no longer exists, clear selection.
      if (selected) {
        const stillThere = registry.some((c) =>
          c.connectorId === selected.connectorId
          && c.manifest.servers.some((s) =>
              s.name === selected.server
              && s.tools.some((t) => t.name === selected.tool && t.allowed)));
        if (!stillThere) {
          selected = null;
          elToolEmpty.hidden = false;
          elToolForm.hidden = true;
        }
      }
      render();
    } else if (ev.kind === 'log') {
      appendLog(ev);
    }
  };
}

connectSse();
// Re-render every second so heartbeat-age strings stay live.
setInterval(render, 1000);
