import { PRODUCT_FULL_NAME, VERSION, formatPairingCode } from '@corsen-ai/shared'

/**
 * Server-rendered shells of the local dashboard. No inline script (strict CSP): behavior lives in
 * /assets/dashboard.js. The pairing code is exposed in a <meta> only on the authenticated page, so
 * the extension popup can read it under activeTab when the user clicks "Pair" (D-004).
 */

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
}

const HEAD = (title: string, extra = ''): string => `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/assets/logo.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/dashboard.css">
${extra}
</head>`

export function dashboardPage(options: { pairingSecret: string; port: number }): string {
  const meta = [
    `<meta name="corsen-pairing" content="${escapeHtml(formatPairingCode(options.pairingSecret))}">`,
    `<meta name="corsen-port" content="${options.port}">`,
    `<meta name="corsen-version" content="${escapeHtml(VERSION)}">`,
  ].join('\n')
  return `${HEAD(`Corsen Connector — Dashboard`, meta)}
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="topbar">
  <div class="brand"><img src="/assets/logo.svg" alt="" width="28" height="28"><div><strong>Universal AI Agent Connector</strong><span>by Corsen AI · v${escapeHtml(VERSION)}</span></div></div>
  <nav class="pills" aria-label="Status">
    <span class="pill" id="pill-daemon"><i></i>Daemon</span>
    <span class="pill" id="pill-browser"><i></i>Extension</span>
    <span class="pill" id="pill-agents"><i></i>Agents</span>
  </nav>
  <button class="danger" id="panic" type="button" title="Detach every debugger session and reset all tabs to Ignored">⏻ Panic stop</button>
</header>
<main id="main" class="grid">
  <section class="card" id="card-pair" aria-labelledby="h-pair">
    <h2 id="h-pair">1 · Pair your browser</h2>
    <p class="muted" id="pair-status">Waiting for the extension…</p>
    <ol class="steps">
      <li>Install the Chrome extension (<code>packages/extension/dist</code> → <em>Load unpacked</em>).</li>
      <li>On <strong>this tab</strong>, click the Corsen icon in the toolbar, then <strong>⚡ Pair</strong>. Done.</li>
    </ol>
    <details><summary>Manual pairing code</summary><p class="code-row"><code id="pairing-code" class="secret">••••-••••-••••-••••-••••</code><button type="button" data-reveal="pairing-code">Show</button><button type="button" data-copy="pairing-code">Copy</button></p></details>
  </section>
  <section class="card" id="card-agents" aria-labelledby="h-agents">
    <h2 id="h-agents">2 · Connect your agents in 1 click</h2>
    <p class="muted">Detected on this machine. Every change makes a timestamped <code>.bak</code> first and can be undone.</p>
    <div id="agents" class="agents" aria-live="polite"></div>
  </section>
  <section class="card" id="card-endpoints" aria-labelledby="h-endpoints">
    <h2 id="h-endpoints">3 · Local endpoints</h2>
    <dl class="kv">
      <dt>OpenAI base URL</dt><dd><code id="ep-openai"></code><button type="button" data-copy="ep-openai">Copy</button></dd>
      <dt>Anthropic base URL</dt><dd><code id="ep-anthropic"></code><button type="button" data-copy="ep-anthropic">Copy</button></dd>
      <dt>MCP (Streamable HTTP)</dt><dd><code id="ep-mcp"></code><button type="button" data-copy="ep-mcp">Copy</button></dd>
      <dt>API key</dt><dd><code id="api-key" class="secret">csk_••••••••</code><button type="button" data-reveal="api-key">Show</button><button type="button" data-copy="api-key">Copy</button></dd>
      <dt>Models</dt><dd id="models" class="muted">—</dd>
    </dl>
    <details><summary>Try it with curl</summary><pre id="curl-example"></pre></details>
    <button type="button" id="selftest">🧪 Test the bridge now</button>
    <ul id="selftest-result" class="checks" aria-live="polite"></ul>
  </section>
  <section class="card wide" id="card-tabs" aria-labelledby="h-tabs">
    <h2 id="h-tabs">Tabs (Brain &amp; Hands)</h2>
    <p class="muted" id="tabs-hint">Assign roles from the extension popup or side panel. Private (Ignored) tabs are never listed here.</p>
    <div id="tabs" class="tabs"></div>
  </section>
  <section class="card wide" id="card-activity" aria-labelledby="h-activity">
    <h2 id="h-activity">Live activity</h2>
    <p class="totals" id="totals"></p>
    <ol id="activity" class="activity" aria-live="polite"></ol>
  </section>
</main>
<footer class="foot">Unofficial community project · Local only · No telemetry · <a href="https://github.com/CorsenAI" rel="noreferrer">Corsen AI</a></footer>
<script src="/assets/dashboard.js" type="module"></script>
</body>
</html>`
}

export function loginPage(options: { error?: string | undefined }): string {
  return `${HEAD(`${PRODUCT_FULL_NAME} — Sign in`)}
<body class="login">
<main class="card narrow">
  <img src="/assets/logo.svg" alt="" width="48" height="48">
  <h1>Corsen Connector</h1>
  <p class="muted">Open the dashboard from your terminal with <code>npx @corsen-ai/universal-connector dashboard</code>, or paste the API key it prints.</p>
  ${options.error !== undefined ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>` : ''}
  <form method="post" action="/login">
    <label for="token">API key</label>
    <input id="token" name="token" type="password" autocomplete="off" spellcheck="false" placeholder="csk_…" required>
    <button type="submit">Sign in</button>
  </form>
</main>
</body>
</html>`
}
