# Decisions (append-only)

One decision per entry, dated, with its evidence. Superseding a decision means a new entry that
names the old one; old entries are never edited except to add "Superseded by D-nnn".

## D-001 — MCP SDK v2 instead of `@modelcontextprotocol/sdk` v1 (2026-11-08)

The usual package name is `@modelcontextprotocol/sdk`. That package is the v1 line (1.32.2): it
negotiates up to protocol 2025-11-25 only. The SDK's own README states that v2 (`@modelcontextprotocol/server`
2.4.0, 2026-10-23) is "the stable release line … It replaces the single `@modelcontextprotocol/sdk`
package from v1" and implements spec 2026-07-28 while serving 2025-era clients from the same factory
(`createMcpHandler(..., { legacy: 'stateless' })`, `serveStdio(..., { legacy: 'serve' })`).
Decision: use v2 so both old and new MCP clients work. Sources: ts.sdk.modelcontextprotocol.io/v2
(serving, stdio, tools) and modelcontextprotocol.io/specification/2026-07-28/changelog. Proven by
`packages/daemon/test/integration.test.ts` and `stdio.test.ts`: the official client negotiates both eras.

## D-002 — One daemon owns the port; stdio MCP processes are thin clients (2026-11-08)

Agents spawn one stdio MCP process per session (often several at once, sometimes one-shot). Only one
process can bind 127.0.0.1:43110 and the extension needs one stable reconnect target. Decision: the
long-lived daemon owns HTTP + WebSocket; `universal-connector mcp` is a stdio MCP server whose tools
forward to the daemon over authenticated HTTP and which starts a detached daemon when none answers.
Same conclusion, under the same pressures, as Corsen AI's DeepSeek Harness Connector.

## D-003 — Authentication model (2026-11-08)

Loopback is not a trust boundary (any local process and any web page can reach it).
- Extension link: mutual, role-bound HMAC-SHA256 challenge/response over the pairing secret (the
  handshake of Corsen AI's Hermes Connector and DeepSeek Harness Connector); the secret never crosses the wire; `Origin` must be
  `chrome-extension://…` (precondition, not identity).
- HTTP API and MCP HTTP: bearer API token (what OpenAI/Anthropic/MCP clients can send), and any request
  with a foreign `Origin` is refused (browser CSRF), Host must be loopback (DNS rebinding).
- Dashboard: one-time login code printed/opened by the CLI → `HttpOnly; SameSite=Strict` cookie, plus
  same-origin and custom-header checks on its API calls. The URL in browser history only holds a used code.
- Secrets live in `~/.corsen-connector/credentials.json` with mode 0600 inside a 0700 directory.

## D-004 — Pairing: popup reads the open dashboard; manual code as fallback (2026-11-08)

A Chrome extension cannot read a file, so the secret must reach it through the user. Decision: the
authenticated dashboard page carries the pairing code in a `<meta>`; when the user clicks the toolbar
icon on that tab, the popup offers "Pair", which reads the code with `chrome.scripting.executeScript`
under `activeTab` (no host permission, explicit gesture). Fallback: paste the code in the side panel.
The handshake then proves both sides know it. The secret is kept in `chrome.storage.local` so pairing
survives browser restarts (same trade-off as the DSH Connector: a loopback-only secret).

## D-005 — CDP-first page access, isolated world, no host permissions (2026-11-08)

All reads and actions on Brain/MCP tabs go through `chrome.debugger` (protocol 1.3): trusted input
events, network and console domains, accessibility tree. In-page code runs in an isolated world created
with `Page.createIsolatedWorld`, so page scripts cannot tamper with it. No `host_permissions` and no
static content scripts are needed. Permissions: `debugger` (cannot be optional), `tabs` (titles/URLs for
the tab manager), `sidePanel`, `storage`, `activeTab` + `scripting` (pairing read, D-004), `alarms`
(reconnect wake-ups while the daemon is down).

## D-006 — Element refs `e<N>` are unique per tab for the whole attachment (2026-11-08)

Agents work best with short refs (`[ref=e12]`). Reusing indexes per snapshot lets an agent click the wrong
element. Decision: refs come from one per-tab counter that never restarts while the tab is attached
(across snapshots and navigations); an element keeps its ref across snapshots; a ref whose element is
gone or belongs to a previous document fails with `STALE_REF`.

## D-007 — Web-LLM capture by DOM observation with block-safe commits (2026-11-08)

`Network.eventSourceMessageReceived` only covers `EventSource`; the target chat sites stream with
`fetch()` bodies whose formats differ per site and cannot be verified without signed-in accounts.
Decision for v0.1: observe the assistant message in the page (isolated world, polled every ~150 ms),
convert it to Markdown, and stream only completed blocks (plus the stable prefix of a growing
paragraph) so code fences and lists are never emitted half-formed. A site-specific network tap can be
added later behind the same harness interface.

## D-008 — Tool-calling shim format: fenced `tool_calls` JSON block (2026-11-08)

Raw XML tags are escaped, stripped or rendered differently by each chat UI's Markdown renderer; code
blocks are preserved verbatim. Decision: the model is asked to answer a tool call with exactly one
fenced block, language `tool_calls`, holding `{"tool_calls":[{"name":…,"arguments":{…}}]}`. The parser
also accepts the same JSON in a `json`/unlabelled fence, or between `<tool_calls>` tags, and validates
names against the declared tools. Tool results are rendered back as labelled text sections.

## D-009 — One active browser connection (2026-11-08)

Tab ids are only unique within one browser. Decision: the newest authenticated extension connection
becomes active; the previous one receives `SUPERSEDED` and stops auto-reconnecting until its user asks
("Use this browser"). MCP `target_id` is the Chrome tab id as a string.

## D-010 — No eval-capable code in the extension (2026-11-08)

Zod 4 compiles schemas with `new Function` when allowed. Extension pages forbid eval (CSP), and a
Store package should not carry dead eval code paths a reviewer has to reason about. Decision: `z.config({ jitless: true })` is set before any
parse (`src/zod-setup.ts`; Zod 4.6.7 then skips its eval probe, verified in `zod/v4/core/util.js`), and
a Vite plugin removes the two dead eval code paths at build time, failing the build if Zod changes them.
Evidence: the E2E hygiene test and `scripts/verify-extension-zip.mjs` scan every shipped script.

## D-011 — Unminified extension build (2026-11-08)

Chrome Web Store policy allows minification and forbids obfuscation; readable code keeps review
straightforward, and the serialized in-page functions stay debuggable. Decision: `build.minify: false`. Size 1.1 MB, acceptable.

## D-012 — Base styles outside Tailwind layers (2026-11-08)

Measured in Chromium: extension pages get an injected, unlayered stylesheet with `body { font-size:
75% }`, which beats any rule inside `@layer base` (body computed 9.75 px instead of 13 px). Decision:
`html` / `html body` base styles are unlayered in `src/shared-ui/styles.css`.

## D-013 — Tests never see the developer's real agent configs (2026-11-08)

Configurator tests use a temporary `HOME`; the E2E daemon is started with `HOME`, `USERPROFILE`,
`APPDATA` and `XDG_CONFIG_HOME` pointing into a temporary directory (fake agent folders can be seeded
for screenshots). A real `setup` is always the user's own action.

## D-014 — Store name without the Google trademark (2026-11-08)

The Chrome Web Store branding guidelines say "Don't use any Google trademarks or any confusingly
similar marks as the name of your extension"; compatibility may only be stated as "for", "for use
with" or "compatible with" Google Chrome™ (developer.chrome.com/docs/webstore/branding). Decision: the
extension is named **Universal AI Agent Connector — by Corsen AI** (43 characters, the name the side
panel and the dashboard already show); the repository keeps its descriptive name.
`scripts/verify-extension-zip.mjs` refuses a manifest name containing "Chrome" or "Google".

## D-015 — Reproducible Store package, read back independently (2026-11-08)

The zip uploaded to the Store must be exactly the tested build. Decision: `scripts/package-extension.mjs`
rebuilds the extension, packs `packages/extension/dist` and nothing else, refuses a dirty tree, sorts
entries and dates them with the commit (same commit, same bytes), and writes a SHA-256 sidecar — with
zero dependencies (zlib plus a small zip writer, the container rules of Corsen AI WebMCP Explorer's
packer). `scripts/verify-extension-zip.mjs` re-reads the archive through its central directory,
compares every entry with `dist/` byte for byte and checks the file allowlist, the manifest (version,
locales, name and description lengths, icons, frozen permission set, CSP) and every script (no eval,
no remote code, no source map, no local path). The E2E suite runs on the unpacked zip with
`EXTENSION_DIR`.

## D-016 — Answers exclude code-block chrome (2026-11-08)

Chat UIs draw a header row around code blocks — language label, "Copy", "Download" — inside or
outside the `<pre>`, as `<button>` or `div[role=button]`, sometimes without `<code>`, sometimes with
line-number gutters. Read as text, it would pollute answers and could break a `tool_calls` JSON
block. Decision: answer extraction skips controls (`button`, roles `button`, `toolbar`, `menu`,
`menuitem`, `tooltip`); a container holding one `<pre>`, controls and at most a short label is read as
that fence, the label becoming its language; code text skips gutters (class or `user-select: none`)
and turns one-div-per-line editors into lines. Proven by `packages/extension/test/distiller.test.ts`
(five header shapes, gutters, prose kept) and by the E2E chat fixture, whose blocks carry such chrome.

## D-017 — Store icon padding (2026-11-08)

The Store takes its icon from the package's 128-pixel icon, whose artwork "should be 96x96 for square
icons, with 16 px transparent padding per side" (developer.chrome.com/docs/webstore/images).
Decision: `scripts/generate-icons.py` draws the 128-pixel icon at 96 pixels on a transparent canvas;
the toolbar sizes (16, 32, 48) stay full-bleed.
