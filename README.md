# ReviveL

> Revive the LBRY protocol. Beautifully browse, play, and publish to LBRY from anywhere on the web.

**[⬇️ Download the latest release](https://revivel.app/#downloads)**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-blue?logo=google-chrome)](https://chrome.google.com/webstore)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)](https://developer.chrome.com/docs/extensions/mv3/)

ReviveL is a modern **Manifest V3** browser extension that brings first-class `lbry://` support, right-click uploads, and a great LBRY experience directly into your normal browser.

It uses a practical **two-tier architecture**:

- **Public / Zero-install tier** — Works immediately using Odysee public APIs. No setup required.
- **Local daemon tier** — Connect to your own `lbrynet` (via the ReviveL Companion) for full features like publishing and better privacy.

---

## ✨ Features

- `lbry://` protocol handler + omnibox support (`rev ` keyword)
- Right-click any image → "Upload image to ReviveL"
- Beautiful popup with:
  - Revival Feed & Latest content
  - Local My Vault
  - Full **Wallet** tab (balance, send/receive, history)
- Dedicated full player page (`player.html`)
- Hybrid floating player (in-page overlay + detachable persistent popup window)
- Content script enhancements for `lbry://` links on any website
- Wallet support (SPV via local daemon)
- Settings for connecting a local lbrynet daemon
- Dark teal aesthetic matching the original concept designs

## 🚀 Quick Start (Public Tier)

1. Build and load the extension (see Development section below).
2. Click the ReviveL icon or type `rev ` in the address bar followed by a claim.
3. Right-click images anywhere on the web and choose **Upload image to ReviveL**.
4. Enjoy `lbry://` links and the full player.

No local daemon is required for browsing and playback.

## 🛠 For Full Power: Local Daemon + ReviveL Companion

For real publishing, your own streams, and wallet features, connect to a local daemon.

### Easiest Way
1. Run `lbrynet start` (or use LBRY Desktop).
2. In ReviveL → Settings → set `http://127.0.0.1:5279`
3. Save and enjoy full features.

See the [plan.md](./plan.md) for more technical details.

## 💻 Development

### Requirements
- Node.js 18+
- npm

### Build

```bash
npm install
npm run build
```

This produces a ready-to-load extension in the `dist/` folder.

### Load the Extension

**Chrome / Edge / Brave**:
1. Go to `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select the `dist/` folder

After loading, try the popup, the context menu on images, and typing `rev ` in the address bar.

## 📁 Project Structure

```
src/
├── background.ts          # Service worker (RPC, context menus, omnibox, protocol handling)
├── content.ts             # Enhances lbry:// links + image revive badges
├── manifest.json
├── utils/lbryApi.ts
├── popup/                 # Extension popup UI (Feed, Vault, Wallet)
├── player/                # Full-featured player page
├── overlay/               # Floating player (iframe + detached popup)
└── options/               # Settings page
```

## 🏗 Architecture

- All LBRY RPC calls go through the background service worker.
- Supports both public Odysee proxy and local `lbrynet` daemon.
- The floating player uses a hybrid model (in-page overlay + detachable always-available popup window).
- Wallet features require a local daemon with SPV wallet support.

## 🤝 Contributing

Contributions are welcome! Feel free to open issues or pull requests.

1. Fork the repo
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

Please read the existing code style and try to follow the patterns used in the popup and player components.

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

**Note**: LBRY is a decentralized protocol. You are responsible for the content you publish and for running your own infrastructure when using the local daemon tier.

Not affiliated with any former LBRY corporate entity. Built for the community.
