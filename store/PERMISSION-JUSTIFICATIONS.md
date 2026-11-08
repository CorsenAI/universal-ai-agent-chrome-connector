# Permission justifications

One entry per permission in `packages/extension/public/manifest.json`, in the words given to the
Chrome Web Store review form. Each maps to the single purpose in `SINGLE-PURPOSE.md`. The set is
frozen: `scripts/verify-extension-zip.mjs` refuses a package with any other.

## `debugger`

The extension reads and acts in the tabs the user explicitly gives a role, through the Chrome
DevTools Protocol: real (trusted) clicks and typing, the page's text and accessibility tree, console
and network errors, the page's own JSON and GraphQL calls, and screenshots. For a chat tab used as a
model, it types the prompt and reads the answer the same way. It attaches only to a tab that has a
role, and only when a request needs it; Chrome's "started debugging this browser" bar stays visible
the whole time, and cancelling it makes the tab private again. Chrome does not allow `debugger` as an
optional permission.

## `tabs`

The side panel lists open tabs (title and address) so the user can choose which ones get a role, and
the extension recognizes supported chat sites by their address. The list stays in the panel: only
tabs with a role are reported to the local companion.

## `sidePanel`

The side panel is the main interface: connection status, one-click agent setup, the tab roles, the
live activity feed and the Panic stop button.

## `storage`

Keeps, in this browser profile, the pairing code, a random installation identifier, the companion's
port and the chat selectors the user calibrated. Tab roles are kept in session storage, so a browser
restart makes every tab private again. No page content is stored.

## `activeTab` and `scripting`

One-click pairing: when the user clicks the toolbar button on the companion's local dashboard tab,
the popup reads the pairing code that page displays, once, with `chrome.scripting.executeScript`. No
host permission is requested for it.

## `alarms`

Chrome stops an idle service worker. A 30-second alarm wakes it to reconnect to the local companion
when the companion was not running, so agents' requests are not lost.

## Permissions not requested

| Permission | Why not |
|---|---|
| Host permissions, `<all_urls>`, content scripts | Page access goes through `debugger`, only on tabs with a role. |
| `cookies` | Signed-in sessions are used by operating the page the user already has open, never by reading credentials. |
| `webRequest`, `declarativeNetRequest` | Network data comes from the debugged tab only, and is redacted. |
| `nativeMessaging` | The companion is reached over a local WebSocket after an HMAC handshake. |
| `history`, `bookmarks`, `downloads`, `clipboardRead` | Outside the purpose. |

## Remote code

None. Every line of code ships in the package; the extension loads no external script and evaluates
no string as code. Its only network destination is the companion on `127.0.0.1`.
