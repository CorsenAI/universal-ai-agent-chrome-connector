# Data disclosures

What the extension handles, where it goes and what it does not do, in the terms of the Chrome Web
Store data-use form. Declared conservatively: data that never leaves the user's computer is still
declared when it leaves the browser for the local companion. The public text is
`docs/privacy/index.html`; this file and that page change together.

## Categories declared

| Category | Declared | What exactly |
|---|---|---|
| Website content | yes | Text, accessibility tree, title, address, screenshots, console and network errors, and the page's own JSON/GraphQL calls — of tabs the user gave the MCP role, when an agent asks. Prompts typed into, and answers read from, chat tabs the user gave the LLM role. |
| Web history | yes | Title and address of tabs that have a role (credentials removed from addresses). |
| User activity | yes | Network monitoring of tabs with the MCP role (failed requests, JSON/GraphQL calls), credential headers masked. |
| Personal communications | yes | Prompts and answers of chat tabs with the LLM role. |
| Authentication information | no | Passwords, one-time codes, credential headers and secret fields are masked before leaving the page; cookies are never read. |
| Personally identifiable information | covered by website content | Only as it appears in pages the user exposes. |
| Health, financial and payment, location | no | Card fields are masked; nothing else is collected. |

## Where it goes

From the tab, to the extension, to the companion on `127.0.0.1` (the user's own computer), to the
agent or tool on that computer that asked. Those agents may send tool results to their model
provider under their own configuration; a chat site receives the prompts typed into it under the
user's account. The extension adds no destination, and nothing reaches Corsen AI.

## Form answers

| Question | Answer |
|---|---|
| Collects or uses personal or sensitive user data? | Yes: the categories above, of tabs the user explicitly gives a role, forwarded to the user's own local software. |
| Sold to third parties? | No. |
| Used or transferred for purposes unrelated to the single purpose? | No. |
| Used or transferred to determine creditworthiness or for lending? | No. |
| Transferred to third parties? | Not by the extension. The user's own agents may send it to the model provider the user configured. |
| Remote code? | No. |

## Masking before the data leaves the page

Password and hidden fields; fields the page declares as one-time codes, passwords or card data;
fields whose name or label indicates a password, secret, token, API key, one-time code, card number,
security code, IBAN, SSN or PIN; credential parameters and embedded credentials in addresses;
credential headers and secret-looking keys in captured traffic. Detection relies on the signals a
page gives. Screenshots are pixels and are not masked.
