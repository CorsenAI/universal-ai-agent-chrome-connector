# Security policy

The Universal AI Agent Chrome Connector lets local AI agents read and act in tabs of your signed-in
Chrome, and drive web chats on your behalf. What is protected, how, and what is deliberately not is
described in [`docs/SECURITY-MODEL.md`](docs/SECURITY-MODEL.md); the wire protocol is in
[`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Reporting a vulnerability

Open a **private security advisory** on this repository (Security → Report a vulnerability) rather
than a public issue, or write to <hello@corsen.ai>. Never include a pairing code, an API key, page
content or anything from a signed-in site in a report: a description and steps are enough.

Reports are answered within five working days. These are release blockers, fixed before anything
else ships (and credited in the release notes if you wish):

- a web page, another local user or an agent reaching a tab the user did not expose, or changing a
  tab's role;
- the pairing secret or API key becoming readable by a page or a model;
- a password, one-time code, payment field, hidden value or credential header leaving the browser
  as text;
- an action reported as successful when Chrome did not perform it.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x (extension and `@corsen-ai/universal-connector` together) | yes |

The extension and the daemon must speak the same protocol version; a mismatch is refused at the
handshake with a message naming the older side, never worked around.

## Out of scope

- Another extension or a process running as the same OS user: they can already read the browser
  profile and the credentials file. The OS account is the boundary.
- What your agent or model does with content once it has it (including being misled by text in a
  page you exposed: prompt injection). Expose only tabs you would let an assistant read.
- A chat service's terms of use: driving your own account through its web UI is your responsibility.

Unofficial community project by Corsen AI. Not affiliated with, endorsed by, or certified by the
vendors of the supported chat services or agents.
