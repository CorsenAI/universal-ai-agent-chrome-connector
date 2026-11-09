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

## Promotional tiles and icons

The tiles are HTML rendered by the same Chromium at the Store's exact sizes: the Corsen AI mark
(`brand/corsen-mark.png`, the company's own artwork), the product name and "by Corsen AI" on the
brand's dark gradient; the marquee adds one line. No third-party marks, no interface mock-up.
`store-icon-128.png` is the Store icon Corsen AI's connectors share (the mark with the wordmark);
the package's own icons (`packages/extension/public/icons/`) are the mark as the company's other
connectors ship it, `icon-32.png` being derived from the 128-pixel file (D-018).

## Files, generated on 2026-11-09

| File | Size | Bytes | SHA-256 |
|---|---|---|---|
| `store-icon-128.png` | 128×128 | 15492 | `50d498c65573e7fa74b638858dd300f685d5bfdbd20ad346a807a2d2cc14ebbf` |
| `screenshots/01-connect.png` | 1280×800 | 238910 | `e784ebf182f07cc0ebfbed8ae06f0d497c3fd19ab03b781fdb84dc2595357e89` |
| `screenshots/02-tab-roles.png` | 1280×800 | 116170 | `f206956c4091386206c19b13a451b7be81e7b9bf88ef9c8b1373158716b4da80` |
| `screenshots/03-agent-view.png` | 1280×800 | 128198 | `dcfe6aa1de1a33c85626d2d23685012efc7ab741abb5493225fe8d0ef3c81fda` |
| `promo-small-440x280.png` | 440×280 | 83520 | `90e2fe3d84dbd551b40682f819b5084155708a9680e714022e1ea72a59035cda` |
| `promo-marquee-1400x560.png` | 1400×560 | 319170 | `e695008808f6afb605c9ff4953832390fbec0ab9d1f9a1a40b5dff6a54c57212` |
| `brand/corsen-mark.png` | 344×373 | 146349 | `dc328f34079643ad2ff76ebd98aeab5299ac9d20dc6305ffd7b953164a191854` |

Environment: Linux, Chrome for Testing 156 (Playwright 1.65), Node 26. Fonts come from the system,
so a run on another system can differ in glyph rendering; the loopback port in screenshot 3 differs
on every run.

## Reproduce

```bash
pnpm install && pnpm build
pnpm store:assets
```
