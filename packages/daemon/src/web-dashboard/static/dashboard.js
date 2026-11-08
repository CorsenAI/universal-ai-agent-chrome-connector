// @ts-check
// Corsen Connector local dashboard. Plain ES module, no framework, no inline handlers (strict CSP).
// Every value that can come from a web page (tab titles, URLs, activity details) is written with
// textContent, never innerHTML.

const ROLE_LABEL = { brain: '🧠 LLM Brain', mcp: '🛠️ MCP Target', ignored: '🔒 Ignored' }
const STATUS_ICON = { ok: '✓', error: '✗', running: '…' }
const KIND_ICON = { llm: '🧠', mcp: '🛠️', system: '⚙️', agent: '⚡', security: '🛡️' }

/** @type {Record<string, any>} */
let status = {}

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id))

/**
 * @param {string} tag
 * @param {Record<string, string>} [attrs]
 * @param {(Node | string | null | undefined)[]} [children]
 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = value
    else node.setAttribute(key, value)
  }
  for (const child of children) if (child !== null && child !== undefined) node.append(child)
  return node
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} [body]
 */
async function post(path, body = {}) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-corsen-dashboard': '1' },
    body: JSON.stringify(body),
  })
  const json = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(json?.error?.message ?? `HTTP ${response.status}`)
  return json
}

function setPill(id, state, title) {
  const pill = $(id)
  pill.classList.remove('ok', 'warn')
  if (state !== 'bad') pill.classList.add(state)
  pill.title = title
}

function setSecret(id, value) {
  const node = $(id)
  node.dataset['value'] = value
  if (node.dataset['revealed'] === '1') node.textContent = value
}

function renderStatus() {
  const browser = status.browser ?? {}
  setPill('pill-daemon', 'ok', `Daemon v${status.version} on port ${status.port}`)
  setPill('pill-browser', browser.connected ? 'ok' : 'bad', browser.connected ? `${browser.browserName} · extension ${browser.extensionVersion}` : 'Extension not paired')
  const agents = status.agents ?? []
  const connected = agents.filter((agent) => agent.connected).length
  setPill('pill-agents', connected > 0 ? 'ok' : agents.some((agent) => agent.detected) ? 'warn' : 'bad', `${connected} agent(s) connected`)
  $('pair-status').textContent = browser.connected
    ? `✅ Paired with ${browser.browserName} (extension ${browser.extensionVersion}).`
    : 'Not paired yet: click the Corsen icon on this tab, then ⚡ Pair.'
  setSecret('pairing-code', status.pairingCode ?? '')
  setSecret('api-key', status.apiToken ?? '')
  $('ep-openai').textContent = status.endpoints?.openai ?? ''
  $('ep-anthropic').textContent = status.endpoints?.anthropic ?? ''
  $('ep-mcp').textContent = status.endpoints?.mcp ?? ''
  const models = (status.models ?? []).map((model) => `${model.id}${model.tabs ? ` (${model.tabs})` : ''}`)
  $('models').textContent = models.join(' · ') || '—'
  $('curl-example').textContent = [
    `curl ${status.endpoints?.openai ?? ''}/chat/completions \\`,
    '  -H "Authorization: Bearer $CORSEN_API_KEY" -H "Content-Type: application/json" \\',
    `  -d '{"model":"web-auto","stream":true,"messages":[{"role":"user","content":"Hello!"}]}'`,
  ].join('\n')
  renderAgents(agents)
  renderTabs(status.state)
  renderTotals(status.totals)
}

function renderAgents(agents) {
  const host = $('agents')
  host.replaceChildren()
  for (const agent of agents) {
    const badge = agent.connected ? el('span', { class: 'badge ok', text: 'Connected' }) : el('span', { class: 'badge off', text: agent.detected ? 'Detected' : 'Not found' })
    const actions = el('div', { class: 'actions' })
    const message = el('div', { class: 'message' })
    const run = (action) => async (event) => {
      const button = /** @type {HTMLButtonElement} */ (event.currentTarget)
      button.disabled = true
      try {
        const result = await post(`/api/dashboard/agents/${agent.id}/${action}`)
        message.className = 'message'
        message.textContent = result.message
        await refresh()
      } catch (error) {
        message.className = 'message error'
        message.textContent = String(error instanceof Error ? error.message : error)
      } finally {
        button.disabled = false
      }
    }
    const connect = el('button', { type: 'button', class: 'primary', text: agent.connected ? '↻ Re-connect' : '⚡ Connect' })
    connect.addEventListener('click', run('connect'))
    actions.append(connect)
    if (agent.connected) {
      const unlink = el('button', { type: 'button', text: 'Unlink' })
      unlink.addEventListener('click', run('unlink'))
      actions.append(unlink)
    }
    if (agent.backups > 0) {
      const restore = el('button', { type: 'button', text: 'Restore backup' })
      restore.addEventListener('click', run('restore'))
      actions.append(restore)
    }
    const meta = el('div', { class: 'meta', text: `${agent.method === 'cli' ? 'via CLI · ' : ''}${agent.configPaths.join(', ')}${agent.backups ? ` · ${agent.backups} backup(s)` : ''}` })
    const notes = agent.notes?.length ? el('div', { class: 'meta', text: agent.notes.join(' ') }) : null
    host.append(el('div', { class: 'agent' }, [el('div', { class: 'name' }, [agent.name, badge]), actions, meta, notes, message]))
  }
}

function renderTabs(state) {
  const host = $('tabs')
  host.replaceChildren()
  if (!state) {
    $('tabs-hint').textContent = 'The extension is not connected.'
    return
  }
  $('tabs-hint').textContent = `${state.tabs.length} tab(s) with a role · ${state.hiddenTabCount} private tab(s) not listed. Assign roles from the extension popup.`
  for (const tab of state.tabs) {
    const select = /** @type {HTMLSelectElement} */ (el('select', { 'aria-label': `Role of ${tab.title}` }))
    for (const role of ['brain', 'mcp', 'ignored']) {
      const option = el('option', { value: role, text: ROLE_LABEL[role] })
      if (role === tab.role) option.setAttribute('selected', '')
      select.append(option)
    }
    select.addEventListener('change', async () => {
      try {
        await post(`/api/dashboard/tabs/${tab.tabId}/role`, { role: select.value })
      } catch (error) {
        alert(`Could not change the role: ${error instanceof Error ? error.message : error}`)
      }
      await refresh()
    })
    const info = el('div', {}, [
      el('div', { class: 'title', text: `${tab.title || '(untitled)'}${tab.busy ? ' · generating…' : ''}` }),
      el('div', { class: 'url', text: `${tab.url}${tab.role === 'mcp' ? ` · console errors ${tab.consoleErrors} · failed requests ${tab.networkErrors}` : ''}${tab.harnessId ? ` · ${tab.harnessId}` : ''}` }),
    ])
    host.append(el('div', { class: 'tab' }, [el('span', { class: 'role', text: tab.role === 'brain' ? '🧠' : '🛠️' }), info, select]))
  }
}

function renderTotals(totals) {
  if (!totals) return
  const host = $('totals')
  host.replaceChildren(
    el('span', {}, ['LLM requests ', el('strong', { text: String(totals.llmRequests) })]),
    el('span', {}, ['MCP calls ', el('strong', { text: String(totals.mcpCalls) })]),
    el('span', {}, ['Errors ', el('strong', { text: String(totals.errors) })]),
    el('span', {}, ['Tokens saved ≈ ', el('strong', { text: totals.tokensSaved.toLocaleString() })]),
  )
}

const shown = new Map()

function renderEntry(entry) {
  const list = $('activity')
  const time = new Date(entry.ts).toLocaleTimeString([], { hour12: false })
  const extra = [entry.model, entry.targetId ? `tab ${entry.targetId}` : null, entry.durationMs !== undefined ? `${entry.durationMs} ms` : null, entry.tokensSaved ? `−${entry.tokensSaved} tokens` : null]
    .filter(Boolean)
    .join(' · ')
  const item = el('li', {}, [
    el('time', { text: time }),
    el('span', { text: KIND_ICON[entry.kind] ?? '•', 'aria-hidden': 'true' }),
    el('span', { class: entry.status === 'error' ? 'error' : '', text: `${STATUS_ICON[entry.status]} ${entry.title}` }),
    el('span', { class: 'muted', text: extra }),
    entry.detail ? el('span', { class: 'detail', text: entry.detail }) : null,
  ])
  const previous = shown.get(entry.id)
  if (previous) previous.replaceWith(item)
  else list.prepend(item)
  shown.set(entry.id, item)
  while (list.children.length > 200) {
    const last = list.lastElementChild
    if (!last) break
    last.remove()
  }
}

async function refresh() {
  const response = await fetch('/api/dashboard/status', { credentials: 'same-origin' })
  if (response.status === 401) {
    location.reload()
    return
  }
  status = await response.json()
  renderStatus()
}

async function loadActivity() {
  const response = await fetch('/api/dashboard/activity?limit=100', { credentials: 'same-origin' })
  if (!response.ok) return
  const body = await response.json()
  for (const entry of body.entries) renderEntry(entry)
  renderTotals(body.totals)
}

function connectEvents() {
  const source = new EventSource('/api/dashboard/events')
  source.addEventListener('activity', (event) => {
    const data = JSON.parse(/** @type {MessageEvent} */ (event).data)
    renderEntry(data.entry)
    renderTotals(data.totals)
  })
  source.addEventListener('state', () => void refresh())
  source.addEventListener('error', () => setPill('pill-daemon', 'warn', 'Reconnecting to the daemon…'))
  source.addEventListener('open', () => setPill('pill-daemon', 'ok', 'Daemon connected'))
}

document.addEventListener('click', async (event) => {
  const target = /** @type {HTMLElement} */ (event.target)
  const copyId = target.getAttribute('data-copy')
  if (copyId) {
    const node = $(copyId)
    const value = node.dataset['value'] ?? node.textContent ?? ''
    try {
      await navigator.clipboard.writeText(value)
      target.textContent = 'Copied ✓'
    } catch {
      target.textContent = 'Select & copy'
    }
    setTimeout(() => (target.textContent = 'Copy'), 1500)
  }
  const revealId = target.getAttribute('data-reveal')
  if (revealId) {
    const node = $(revealId)
    const revealed = node.dataset['revealed'] === '1'
    node.dataset['revealed'] = revealed ? '0' : '1'
    node.textContent = revealed ? '••••••••' : (node.dataset['value'] ?? '')
    target.textContent = revealed ? 'Show' : 'Hide'
  }
})

$('panic').addEventListener('click', async () => {
  if (!confirm('Detach every chrome.debugger session and reset all tabs to Ignored?')) return
  try {
    const result = await post('/api/dashboard/panic')
    alert(`Panic stop: ${result.detached} session(s) detached.`)
  } catch (error) {
    alert(`Panic stop failed: ${error instanceof Error ? error.message : error}`)
  }
  await refresh()
})

$('selftest').addEventListener('click', async (event) => {
  const button = /** @type {HTMLButtonElement} */ (event.currentTarget)
  const list = $('selftest-result')
  button.disabled = true
  list.replaceChildren(el('li', { class: 'muted', text: 'Testing…' }))
  try {
    const result = await post('/api/dashboard/selftest')
    list.replaceChildren(...result.steps.map((step) => el('li', { class: step.ok ? '' : 'error', text: `${step.ok ? '✅' : '❌'} ${step.name} — ${step.detail} (${step.ms} ms)` })))
  } catch (error) {
    list.replaceChildren(el('li', { class: 'error', text: String(error instanceof Error ? error.message : error) }))
  } finally {
    button.disabled = false
  }
})

await refresh()
await loadActivity()
connectEvents()
setInterval(() => void refresh(), 15_000)
