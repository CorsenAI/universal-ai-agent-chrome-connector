# @corsen-ai/universal-connector

Local daemon and CLI of the **Universal AI Agent Chrome Connector — by Corsen AI**: your signed-in
web chats become a local OpenAI/Anthropic-compatible API, the Chrome tabs you choose become an MCP
server, and your agents are configured in one step.

```bash
npx @corsen-ai/universal-connector          # start the daemon + dashboard (127.0.0.1:43110)
npx @corsen-ai/universal-connector setup    # connect Claude Code, Cursor, Windsurf/Devin, Claude Desktop, Cline, Roo, OpenCode
npx @corsen-ai/universal-connector mcp      # MCP stdio server (agents launch this; starts the daemon if needed)
```

Requires Node.js ≥ 22 and the companion Chrome extension. Endpoints: `/v1/chat/completions`,
`/v1/models`, `/v1/messages`, `/v1/messages/count_tokens`, `/mcp` (Streamable HTTP, MCP 2025-11-25
and 2026-07-28). Everything binds to 127.0.0.1 and requires the API key shown by
`universal-connector token --show`.

Full documentation, security model and protocol: see the repository README.

Apache-2.0 · Unofficial community project · No telemetry.
