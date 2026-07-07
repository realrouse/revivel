# ReviveL

> Revive the LBRY protocol. Beautifully browse, play, and publish to LBRY from anywhere on the web.

ReviveL is a Manifest V3 browser extension that brings first-class `lbry://` support, right-click uploads, and seamless LBRY experiences into your normal browser.

It follows a practical **two-tier architecture** (inspired by real constraints discussed with the LBRY community):

- **Public / Zero-install tier**: Works immediately using Odysee public APIs. Resolve and play any `lbry://` content.
- **Local daemon tier**: Connect to your own running `lbrynet` for full features (publishing, your own streams, better privacy).

## Features (Current)

- `lbry://` protocol handler + omnibox (`rev ` keyword)
- Right-click any image → "Upload image to ReviveL"
- Beautiful popup with Revival Feed, New content, and local **My Vault**
- Dedicated player page for rich viewing
- Content script that enhances `lbry://` links on any web page + "Revive" hover on images
- Options for connecting a local lbrynet daemon
- All UI matches the original concept designs (dark teal phoenix aesthetic)

## Quick Start (Public Tier — Works Now)

1. Build and load the extension (see below).
2. Click the ReviveL icon or type `rev ` in the address bar + a claim (e.g. `rev @lbry/revival-decentralized`).
3. Right-click images on the web (or Grok generations) and choose **Upload image to ReviveL**.
4. Use the player for `lbry://` links.

No daemon required for discovery and playback.

## For Full Power: Run a Local Daemon

This unlocks real publishing from the extension and direct use of the LBRY network.

### Recommended (Easiest)
- Download **LBRY Desktop** (or the standalone daemon binaries) from the community / official archives.
- Run `lbrynet start` (it listens on http://127.0.0.1:5279 by default).

### Minimal
```bash
# Example (exact binaries and flags depend on your build)
lbrynet start --api 127.0.0.1:5279
```

Then in ReviveL:
- Open options (gear icon) or settings
- Enter `http://127.0.0.1:5279` (or leave blank for public proxy)
- Save

The extension will prefer the daemon when configured and fall back gracefully.

**Status indicators** will show whether you're in public mode or connected to your local node.

See also the excellent **lbry-nova-web** project (React web UI that talks to your daemon):
https://github.com/LBRYFoundation/lbry-nova-web

## Development

### Requirements
- Node 18+
- `npm install`

### Build

```bash
npm run build
```

This runs `tsc` + the post-build script and produces a loadable extension in `dist/`.

### Load Unpacked

**Chrome / Edge / Brave**:
1. Go to `chrome://extensions`
2. Enable "Developer mode"
3. "Load unpacked" → select the `dist/` folder

**Firefox** (developer):
- Use `web-ext` or load as temporary add-on from `about:debugging`.

After loading, pin the extension and try the popup, context menu on images, and `rev ` in the omnibox.

### Project Structure

```
src/
├── background.ts          # Service worker: context menus, RPC, omnibox, protocol
├── content.ts             # Page script: enhance lbry:// links + Revive badges
├── manifest.json
├── utils/lbryApi.ts       # Client for resolve (dual public/daemon)
├── popup/                 # Compact beautiful popup UI + upload flow + vault
├── player/                # Full player page (opened for lbry:// URIs)
└── options/               # Daemon URL settings
```

Icons live in `icons/` (source of truth) and are copied to `public/icons/` and `dist/icons/`.

## Architecture Notes

- All LBRY RPC goes through the background service worker (avoids most CORS issues).
- `resolveLbryUri(uri)` in popup/player talks to background via `chrome.runtime.sendMessage`.
- Background chooses endpoint:
  - If daemon URL configured → `http://127.0.0.1:5279`
  - Else → public Odysee proxy `https://api.na-backend.odysee.com/api/v1/proxy`
- Upload from context menu stores context and opens the popup's publish form.
- Vault is stored locally in `chrome.storage.local` for the demo (real publishes would go to the chain via daemon).

## Publishing (Upload) Status

- **Public mode**: Generates a ready-to-use `lbrynet publish` CLI snippet + button to open Odysee upload page (assisted flow).
- **Daemon mode**: The form can attempt a real `stream_create` / publish RPC (work in progress — requires the daemon + some LBC).

See `plan.md` for the detailed phased roadmap and verification steps.

## Roadmap Highlights (from plan.md)

- [x] Beautiful UI shell + vault + context menu + protocol handler declaration
- [ ] Real resolve against public proxy (in progress)
- [ ] Real daemon status check + connection test
- [ ] Wire player + popup to use live resolve results + streaming_url
- [ ] Assisted publish (CLI + Odysee) + daemon publish attempt
- [ ] Excellent README + onboarding
- [ ] Polish, error states, Firefox testing

## Credits & Inspiration

- LBRY community (Discord discussions on daemon-in-extension realities)
- lbry-nova-web (https://github.com/LBRYFoundation/lbry-nova-web) — the reference pattern for daemon access from web tech
- Existing "Watch on LBRY" / Odysee browser extensions for manifest patterns

## License

MIT

---

**Note**: LBRY is a decentralized protocol. You are responsible for the content you publish. This extension is a community tool and is not affiliated with any former LBRY corporate entity.
