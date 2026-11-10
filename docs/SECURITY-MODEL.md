# Security model

Version 0.1. Each statement names the code that enforces it and the test that proves it.

## Assets

1. The user's signed-in sessions (cookies, tokens) in Chrome — never read by the connector.
2. Page content of tabs the user exposed (text, form values, network bodies, pixels).
3. Prompts and answers flowing through the user's web chats.
4. The pairing secret and the API key (`~/.corsen-connector/credentials.json`).
5. The user's agent configuration files.

## Actors and trust

| Actor | Trust | Can reach the daemon? |
|---|---|---|
| The user (popup, side panel, dashboard) | trusted | yes, authenticated |
| Local agents (Claude Code, Cursor…) | trusted to use exposed tabs only | yes, with the API key |
| Web pages in the user's browser | **untrusted** | yes — loopback is reachable from any page |
| DNS-rebinding pages | **untrusted** | they can make requests look same-origin |
| Other OS users on the machine | **untrusted** | yes — 127.0.0.1 is shared |
| Processes / extensions of the same OS user | out of scope | they can read the profile and the credentials |
| Page content and web-LLM answers | **untrusted data** | — |

## Controls

### Tabs are private by default
- A tab has a role only after an explicit user action (popup, side panel, authenticated dashboard).
  Roles are kept in `chrome.storage.session`: a browser restart makes every tab Ignored again.
  (`packages/extension/src/background/storage.ts`, `controller.ts#setRole`)
- No MCP tool can change a role; the extension re-checks the role on every call and fails with
  `NO_TARGET` otherwise (`controller.ts#requireRole`). The daemon also fails closed on target
  resolution (`mcp-server/executor.ts#resolveTarget`). Proven: `e2e/connector.e2e.ts` ("keeps an
  ignored tab private"), `test/integration.test.ts` ("fails closed on a tab that is not exposed").
- Ignored tabs are never sent to the daemon (only their count): `controller.ts#browserState`.
- A role belongs to the tab, not to the site: when the user or an agent opens another address in an
  exposed tab, that page is exposed too until the user sets the tab back to Ignored. Navigating to a
  page Chrome protects (Web Store, `chrome://`) resets the tab to Ignored (`background/index.ts`).
- Chrome's "is debugging this browser" banner is shown on controlled tabs; cancelling it detaches
  and resets the tab to Ignored (`onDetach` reason `canceled_by_user`). Panic stop detaches every
  session and clears all roles (proven in E2E).

### Extension ⇄ daemon link
- Mutual HMAC-SHA256 challenge/response, role-bound messages
  (`browser:<id>:<serverNonce>` / `daemon:browser:<id>:<clientNonce>`), secret never transmitted,
  constant-time comparison (`daemon/src/auth/hmac.ts`, `extension/src/background/crypto.ts`).
  The extension refuses a daemon that cannot prove the secret (port squatting).
- WebSocket upgrades require `Origin: chrome-extension://<32 a-p chars>` and a loopback `Host`
  (`ws-hub/hub.ts`, `http/server.ts`). Protocol versions must be equal.
- Frames are size-bounded (24 MiB) and Zod-validated; unknown types close the connection.
- Proven: `test/integration.test.ts` (wrong secret → `UNAUTHENTICATED`, old protocol →
  `PROTOCOL_VERSION`, web origin → HTTP 403, supersede → close 4001).

### HTTP surface
- Bound to 127.0.0.1 only. `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (plus explicit
  `--allow-host` values) — defeats DNS rebinding (`http/guards.ts#hostGuard`).
- API routes (`/v1/*`, `/mcp`, `/api/tools/*`, `/api/admin/*`) refuse any request with a foreign
  `Origin` (CSRF from pages), require the API key (`Authorization: Bearer` or `x-api-key`, compared in
  constant time) and `application/json` bodies (`http/guards.ts#apiGuard`).
- Dashboard: one-time login codes (10 min, single use) exchanged for an `HttpOnly; SameSite=Strict`
  session cookie; state-changing calls need the dashboard origin and `X-Corsen-Dashboard: 1`;
  strict CSP, `X-Frame-Options: DENY`, no inline script; the pairing meta exists only on the
  authenticated page. Proven: `test/dashboard.test.ts`.
- Secrets: `credentials.json` written 0600 inside a 0700 directory, atomically; a malformed file is a
  hard error, never a silent re-pair (`auth/credentials.ts`).

### Redaction before the trust boundary
- In the page: password/hidden inputs, `autocomplete` secrets (passwords, one-time codes, card
  data), fields whose name/label looks secret, secret URL parameters (`access_token`, `code`, …).
  Rules ported from the Corsen DSH Connector (`shared/src/redact.ts`, `extension/src/inpage/distiller.ts`).
- In the network tap: credential headers (`authorization`, `cookie`, `set-cookie`, `x-api-key`,
  anything with `token`/`secret`/`session`/…), secret JSON keys in captured bodies, and the secret
  parameters of `application/x-www-form-urlencoded` bodies (a failed form login, an OAuth code
  exchange). A request body Chrome can only give as base64 (not UTF-8) is left out. A JSON body
  with nothing to mask is kept as captured, so integers above 2^53 keep their digits.
- In the DevTools feed: addresses written in console messages, exceptions and log lines go through
  the address rules (`scrubAddressesInText`).
- In the daemon, again (`mcp-server/second-pass.ts`): addresses, header maps, captured bodies,
  addresses in DevTools messages and stack frames, and Markdown link and image targets are masked
  a second time before an agent receives them, so a faulty or outdated extension cannot hand a
  credential to an agent. Every rule is idempotent: data the extension already masked is unchanged.
- Proven: `test/distiller.test.ts`, `shared/test/redact.test.ts`, `extension/test/network-tap.test.ts`,
  `daemon/test/second-pass.test.ts`, the daemon integration test (an extension that skips masking),
  E2E (no `hunter2`, `p4ss`, `f0rm-p4ss`, `SECRET123`, `xyz-secret-token`, OAuth code or console key in
  agent-visible output).
- **Not redacted**: screenshots (pixels), page text that has no signal (an API key printed in a
  paragraph), and `multipart/form-data` bodies. Documented in the tool description.

### Honest results
- Actions use trusted CDP input; a confirm/prompt dialog opened by an action is cancelled and the
  action fails (`cdp/input.ts`); stale refs fail with `STALE_REF`; missing elements with `NOT_FOUND`.
- A web chat that does not accept the prompt or never answers fails with `HARNESS_FAILED`.

### Agent configuration
- Edits never touch an unparsable file, preserve comments, are atomic, follow symlinks, and are
  preceded by a timestamped backup recorded in `backups.json` (`agent-configurator/json-config.ts`).
- Tool approvals are left off (`autoApprove: []`, `alwaysAllow: []`).
- Claude Code is configured through its own CLI, which receives exactly the environment the
  configurator used to compute, back up and verify the file (`$CLAUDE_CONFIG_DIR/.claude.json` when
  that variable is set, `~/.claude.json` otherwise).
- Tests run on a temporary `HOME`; the E2E daemon gets a fake user home, without the variables that
  point agents at config files elsewhere (`CLAUDE_CONFIG_DIR`, `CLINE_MCP_SETTINGS_PATH`). Published
  screenshots are refused when the captured page shows a path of the machine.

### Supply chain and packaging
- No remote code, no CDN, no telemetry. Zod's JIT (`new Function`) is disabled at runtime and its
  code removed at build time (`packages/extension/vite.config.ts`); the packaged extension is
  checked for `eval`/`new Function` in E2E, and the Store zip is read back by
  `scripts/verify-extension-zip.mjs` (byte-for-byte with the build, file allowlist, manifest, scripts).
- Permissions are the minimum the features need; no host permissions, no content scripts.
- Extension pages talk to no host but the local daemon: `connect-src` lists only loopback addresses
  and `img-src` only the package and inline images (tab favicons are shown only when inline), checked
  by `scripts/verify-extension-zip.mjs`.
- The package ships `THIRD_PARTY_LICENSES.txt`, generated at build time from the module graph, with
  the license notice of every bundled third-party package.

## Residual risks

- Prompt injection: an exposed page can address the agent in its text. The connector labels page
  content as untrusted in every tool description; the agent remains responsible.
- Same-OS-user malware can read the credentials and the browser profile (out of scope).
- Web chats' terms of service: the user's responsibility.
