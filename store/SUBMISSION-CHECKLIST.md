# Chrome Web Store submission checklist

What the listing needs and where each item lives. A "done" is backed by a command or a file.

## Package

| Item | State | Where |
|---|---|---|
| Manifest V3, module service worker | done | `packages/extension/public/manifest.json` |
| Name without a Google trademark, ≤ 45 characters | done (43) | `_locales/*/messages.json`, D-014 |
| Short description ≤ 132 characters, both locales | done (121 / 124) | `_locales/*/messages.json` |
| 128×128 icon in the package (Corsen AI mark, same files as the company's other connectors) | done | `icons/icon-128.png`, D-018 |
| Version equal across manifest and package | done (0.1.0) | checked by `scripts/package-extension.mjs` |
| No remote code, no `eval`, no obfuscation (unminified) | done | D-010, D-011; scanned by `scripts/verify-extension-zip.mjs` and the E2E hygiene test |
| Frozen permission set, no host permissions | done | D-005; enforced by `scripts/verify-extension-zip.mjs` |
| ZIP from a clean commit, reproducible, SHA-256 recorded | done | `pnpm package:extension` → `release/` (D-015) |
| ZIP read back independently, byte for byte with the build | done | `pnpm verify:extension` |
| Unpacked ZIP passes the real-browser suite | done | `EXTENSION_DIR=<unzipped> pnpm test:e2e` |

## Policy material

| Item | State | Where |
|---|---|---|
| Single purpose | done | `SINGLE-PURPOSE.md` |
| Justification per permission | done | `PERMISSION-JUSTIFICATIONS.md` |
| Data-use disclosures and form answers | done | `DATA-DISCLOSURES.md` |
| Privacy policy text | done | `docs/privacy/index.html` |
| Privacy policy at its public address | to publish | `https://corsen.ai/privacy/universal-ai-agent-connector/` |
| Reviewer instructions | done | `REVIEWER-INSTRUCTIONS.md` |

## Listing

| Item | State | Where |
|---|---|---|
| Title, short and detailed descriptions (en, fr) | done | `LISTING.md` |
| Store icon 128×128 (mark + wordmark) | done | `store-icon-128.png` (D-018) |
| Screenshots 1280×800 (3) | done | `screenshots/` (`ASSETS.md`) |
| Small promo tile 440×280, marquee 1400×560 | done | `promo-*.png` |
| Category: Developer Tools | done | `LISTING.md` |

## Before submitting

- The companion app the listing and the reviewer instructions name runs from the public repository at
  the submitted version: `pnpm install && pnpm build && pnpm connector` on a fresh clone.
- The repository named in the listing is public at that address.
- The privacy policy answers at its public address.
- The dashboard's data-use form is filled from `DATA-DISCLOSURES.md` and reread on submission day.

## After publication

- The listing shows version 0.1.0; the extension installed from the Store pairs and passes the
  reviewer steps once.
