# Instructions for the Chrome Web Store reviewer

The extension is one half of a local tool: it needs its open-source companion app (the "daemon"),
which runs on the same computer. These steps show it working in a few minutes, without any account.

## Setup (about five minutes)

You need Node.js 22 or newer.

```bash
npx @corsen-ai/universal-connector start
```

(From source instead: `git clone https://github.com/CorsenAI/universal-ai-agent-chrome-connector`,
then `pnpm install && pnpm build && node packages/daemon/dist/index.js start`.)

The daemon starts on `127.0.0.1:43110` and opens its local dashboard in the browser.

1. Load the submitted package (unzipped) with **Load unpacked**, or install it from the Store.
2. On the dashboard tab, click the extension's toolbar button, then **⚡ Pair with this Connector**.
   The side panel and the dashboard both show **Connected**.

## See the agent side without an agent

Any ordinary page works; `https://example.com` is enough.

1. Open the page, click the toolbar button and choose **🛠️ Expose to MCP**. Chrome shows its
   "started debugging this browser" bar: this is expected and stays visible.
2. In a terminal, read the API key and call two tools the way an agent would:

```bash
KEY=$(npx @corsen-ai/universal-connector token --show | sed -n 's/^API key: *//p')
curl -s http://127.0.0.1:43110/api/tools/call -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -d '{"name":"browser_list_targets","arguments":{}}'
curl -s http://127.0.0.1:43110/api/tools/call -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -d '{"name":"browser_read_page","arguments":{}}'
```

The second call returns the page as Markdown with `[ref=eN]` handles. The side panel's **Live
activity** tab lists both calls.

## What to check

- **Private by default.** Set the tab back to **🔒 Ignored**, or open another tab: the same calls
  answer `NO_TARGET`. Nothing is read from a tab without a role.
- **Masking.** On any login page exposed to MCP, `browser_read_page` shows the password field's
  value as `••••••••`. Screenshots are pixels and are not masked (said in the tool description).
- **Panic stop.** The side panel's Panic stop detaches every tab and resets all roles.
- **No external traffic.** The service worker talks only to `ws://127.0.0.1:43110/ws`.
- **Readable package.** The JavaScript is not minified; there is no remote code and no `eval`.

## The LLM role

The LLM role needs a chat site the user is signed in to. On such a tab, choose **🧠 Use as LLM**,
then send `POST http://127.0.0.1:43110/v1/chat/completions` with the same key and
`{"model":"web-auto","messages":[{"role":"user","content":"Hello"}]}`: the prompt is typed into the
page and the answer comes back as JSON. A site the extension does not know can be calibrated from
the side panel (**Calibrate**: click the input, the send button, then one answer).

## Source

https://github.com/CorsenAI/universal-ai-agent-chrome-connector — the submitted ZIP is produced by
`scripts/package-extension.mjs` from a tagged commit and read back by
`scripts/verify-extension-zip.mjs`; its SHA-256 is in the release notes.

## Contact

Corsen AI — hello@corsen.ai. Unofficial community project, not affiliated with the chat services
it works with.
