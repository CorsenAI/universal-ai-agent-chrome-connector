# Single purpose

Chrome Web Store policy requires a single, narrow, easy-to-understand purpose. This is ours, stated
once; every permission and feature maps back to it.

## The purpose

**Connect the browser tabs the user explicitly chooses to the AI agents running on the user's own
computer, so those agents can use them: as pages to read and act in, or as a signed-in chat that
answers them.**

## In practice

The user runs AI agents and tools on their computer (Claude Code, Cursor, Cline, scripts…). The
extension lets the user give a tab one of two roles: **MCP** (the agents may read the page and act in
it) or **LLM** (the tools may send a prompt to that chat page and read the answer). Every tab starts
with no role. The local companion app (`@corsen-ai/universal-connector`) carries the requests between
the agents and the extension, on `127.0.0.1`.

## Outside the purpose

- Any tab the user did not give a role: nothing is read from it and nothing happens in it.
- The cookie store, history, bookmarks, saved passwords: not read; the permissions are not requested.
  Cookie headers seen in the captured traffic of an exposed tab are masked.
- Any communication with Corsen AI: there is no Corsen server.
- Acting without a request: the extension does nothing on its own initiative.

## How the purpose is enforced

- Roles change only through the user's own interfaces (toolbar popup, side panel, the local
  dashboard behind a one-time login). No agent-facing tool can change a role.
- Every request is checked against the tab's current role in the extension; a tab without the
  matching role fails the request with `NO_TARGET`, never a fallback to another tab.
- The set of tools is fixed and declared: six MCP tools and one generation method; anything else is
  refused.
