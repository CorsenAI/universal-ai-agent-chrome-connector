# Extension ⇄ daemon protocol

Version **1**. Authoritative definitions: `packages/shared/src/protocol.ts` (frames) and
`packages/shared/src/rpc.ts` (method contracts). Both peers compile against the same schemas.

## Transport

WebSocket at `ws://127.0.0.1:<port>/ws` (default port 43110), text frames only, JSON, at most 24 MiB
per frame. The upgrade is refused unless `Host` is loopback and `Origin` is
`chrome-extension://<extension id>`.

## Handshake

```
daemon → extension   challenge { nonce, protocolVersion, daemonVersion }
extension → daemon   hello     { role:"browser", browserId, browserName, nonce, proof,
                                 protocolVersion, extensionVersion, capabilities[], takeover }
daemon → extension   paired    { proof, protocolVersion, daemonVersion, connectionId }
                or   denied    { code, message }   then close
```

- `proof` = `HMAC-SHA256(pairingSecret, "browser:<browserId>:<serverNonce>")`, lowercase hex.
- daemon `proof` = `HMAC-SHA256(pairingSecret, "daemon:browser:<browserId>:<clientNonce>")`; the
  extension disconnects if it does not verify.
- The pairing secret is the 20-character code (alphabet `34679ACDEFGHJKMNPQRTUVWXY`) shown by the
  daemon; it never crosses the wire.
- `protocolVersion` must be equal; it is checked before the proof so a stale peer gets the real reason.
- `capabilities` lists the daemon→extension methods the extension implements; others are refused
  with `UNSUPPORTED` before dispatch.
- The handshake must complete within 10 s.

## After pairing

| Frame | Direction | Meaning |
|---|---|---|
| `rpc {id, method, params}` | both | request; params validated against the contract |
| `rpc_result {id, ok, result?, error?}` | both | settles one request (`error` exactly when `ok` is false) |
| `rpc_event {id, event}` | both | streaming event for a pending request (LLM deltas) |
| `rpc_cancel {id}` | both | the caller gave up (client disconnected); the callee aborts |
| `state {state}` | extension → daemon | non-ignored tabs + count of hidden tabs, pushed on change |
| `activity {entries, totals}` | daemon → extension | live feed for the side panel |
| `ping {ts}` / `pong {ts}` | extension → daemon / back | every 20 s (keeps the MV3 service worker alive) |

Unknown frame types close the connection (1008). A connection silent for 65 s is closed (4005).

### Daemon → extension methods

| Method | Params | Result |
|---|---|---|
| `targets.list` | — | `{targets[]}` exposed tabs |
| `page.read` | `{tabId, mode: markdown|accessibility, maxChars, scope: full|main}` | `{title, url, mode, content, refCount, truncated, sourceChars, outputChars}` |
| `page.act` | `{tabId, act: {action, ref?, selector?, text?, submit?, clear?, key?, direction?, amount?, value?, url?, timeoutMs?}}` | `{summary, url, title, navigated}` |
| `devtools.errors` | `{tabId, kinds[], sinceId, limit, clear}` | `{entries[], totals, lastId}` |
| `network.capture` | `{tabId, urlContains, method, kind, sinceId, limit, includeBodies, maxBodyChars}` | `{calls[], lastId}` |
| `page.screenshot` | `{tabId, format, quality, fullPage, bringToFront}` | `{mimeType, data, width, height}` |
| `llm.generate` | `{tabId, harnessId, prompt, newChat, timeoutMs}` | `{text, finishReason, url}`; events `{kind:"status"}` / `{kind:"delta", text}` |
| `tabs.setRole` | `{tabId, role}` | `{tab}` (dashboard only) |
| `system.panic` | — | `{detached}` |
| `system.echo` | `{nonce}` | `{nonce, extensionVersion}` (bridge test) |

### Extension → daemon methods (side panel / popup)

`daemon.info`, `daemon.selftest`, `agents.list`, `agents.connect`, `agents.unlink`,
`agents.restore`, `activity.recent`.

## Error codes

`NO_BROWSER`, `NO_TARGET`, `AMBIGUOUS_TARGET`, `TAB_GONE`, `RESTRICTED_PAGE`, `DEBUGGER_DENIED`,
`ACTION_FAILED`, `STALE_REF`, `NOT_FOUND`, `INVALID_ARGUMENT`, `TIMEOUT`, `INTERRUPTED` (dispatched,
outcome unknown), `CANCELLED`, `NO_BRAIN`, `BRAIN_BUSY`, `HARNESS_FAILED`, `UNSUPPORTED`,
`PROTOCOL_VERSION`, `UNAUTHENTICATED`, `SUPERSEDED`, `MALFORMED`, `TOO_LARGE`, `INTERNAL`.
Callers match on the code, never on the message.

## Close codes

| Code | Meaning | Extension behavior |
|---|---|---|
| 4001 | superseded by a newer browser | stop auto-reconnecting until "Use this browser" |
| 4002 | protocol version mismatch | show "update the older side" |
| 4003 | pairing proof refused | stop until a new code is entered |
| 4004 | handshake timeout | reconnect with backoff |
| 4005 | heartbeat timeout | reconnect with backoff |
| 1008 | malformed / policy | reconnect with backoff |

## Changing this protocol

Any change a peer could misread bumps `PROTOCOL_VERSION` in `packages/shared/src/constants.ts`, adds
a mismatch test, and updates this document in the same change.
