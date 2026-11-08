# Chrome Web Store assets

Every image here is produced by `e2e/store-assets.e2e.ts` (`pnpm store:assets`) from the built
extension and daemon, so the set is regenerated for each release rather than drawn once. Nothing is
a mock-up or hand-edited.

## How the screenshots are made

Chromium (Playwright) loads the unpacked build, the real daemon runs in a temporary home with a fake
user directory (no personal configuration is visible), and the extension is paired through the real
HMAC handshake. Two invented pages are served on loopback: **Northwind Ops — Orders**
(`e2e/fixtures/demo-orders.html`, under `northwind.localhost`) gets the MCP role, and a demo chat
(`e2e/fixtures/demo-chat.html`) is calibrated and gets the LLM role. An MCP client then calls four
tools and one chat completion is requested, so the activity feed shows real calls.

Each screenshot places a capture of a page (879×800) and of the extension's own side panel page
(400×800) side by side on a 1280×800 canvas, with a one-pixel divider, the way Chrome lays out a side
panel beside a page:

| File | Left | Right |
|---|---|---|
| `screenshots/01-connect.png` | local dashboard (pairing, one-click agents) | Quick Connect |
| `screenshots/02-tab-roles.png` | the Northwind page | Tabs (roles per tab) |
| `screenshots/03-agent-view.png` | the actual `browser_read_page` result an agent received, rendered as text | Live activity |

The script refuses to write screenshot 3 unless the page's webhook secret is masked in that result.
Every image is checked for the Store's format (exact size, 24-bit RGB without alpha) and for a
repeated band (a stale capture).

## Promotional tiles and icon

The tiles are HTML rendered by the same Chromium at the Store's exact sizes: the extension's logo
(`packages/daemon/src/web-dashboard/static/logo.svg`), the product name and "by Corsen AI" on the
brand's dark gradient; the marquee adds one line. No third-party marks, no interface mock-up.
`store-icon-128.png` is the package's own 128-pixel icon: 96-pixel artwork with 16 pixels of
transparent padding per side (`scripts/generate-icons.py`).

## Files, generated on 2026-11-08

| File | Size | Bytes | SHA-256 |
|---|---|---|---|
| `store-icon-128.png` | 128×128 | 8163 | `8b152ce2916d7d81035e48b0a63d181848a2a824b625d2e3ce0db22e67f41f6f` |
| `screenshots/01-connect.png` | 1280×800 | 231296 | `3a0d724474d55dc1aed90da7ec84dba0b52d21b22a1894a3b6b2e30caa598be1` |
| `screenshots/02-tab-roles.png` | 1280×800 | 115548 | `4a691b7e09c25c573b8c506db0e095557d483a1360c5b3e125d104f2b7b5524a` |
| `screenshots/03-agent-view.png` | 1280×800 | 128215 | `07e56d04e3390ed574abd0fd839bcfb8c2d47db0e4412b0646d013bcbea246e4` |
| `promo-small-440x280.png` | 440×280 | 57900 | `28946b803e64b0bb777f696225fbdf20cb590132e80ba11d343209d678ce8bd1` |
| `promo-marquee-1400x560.png` | 1400×560 | 250047 | `9e022ff6673931ad8444a0b226b871cd7d2cd3bf6e13bf570817e8e44454178d` |

Environment: Linux, Chrome for Testing 156 (Playwright 1.65), Node 26. Fonts come from the system,
so a run on another system can differ in glyph rendering; the loopback port in screenshot 3 differs
on every run.

## Reproduce

```bash
pnpm install && pnpm build
pnpm store:assets
```
