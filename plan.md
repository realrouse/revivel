# ReviveL (Revivel) LBRY Browser Extension - Planning & Feasibility

## Context

**Telegram (2026-05-10)** + **Discord chat (same day + follow-up)**:
- Idea: browser extension ("ReviveL" / "Revivel Extension") that connects normal browsing to LBRY protocol content.
- Key wanted features:
  - `lbry://` URLs work in the browser address bar / links: paste or click → instantly resolves + plays.
  - Right-click anywhere (especially images, including Grok gens) → "upload to ReviveL".
  - General seamless LBRY functions during web experience (upload found content easily).
- Follow-up Discord discussion (key technical clarifications):
  - Community (moderators pcfreak30, Ben, etc.): Full LBRY daemon (lbrynet + lbcd) cannot run inside a Manifest V3 extension. MV3 removes persistent background processes; full node requires raw TCP/UDP + block sync (webtransport/quic not widely available for P2P chains). "No, you can't run the daemon in the browser."
  - **But**: lbrynet **exposes HTTP JSON-RPC** (localhost:5279) + media CDN. This *is* reachable from an extension.
  - "Any browser extension can connect through RPC to a local lbrynet daemon."
  - CORS is the practical hurdle for page scripts; background/service worker fetches often succeed against localhost.
  - Related project highlighted: **lbry-nova-web** (LBRYFoundation) — a web UI (React/Vite/Express) that talks to a running daemon via `/api/rpc` and `/api/proxy` relays. See https://github.com/LBRYFoundation/lbry-nova-web. "Access the LBRY network using your browser."
  - User (rouse): "We don't need to run LBRY daemon inside the browser... Easy instructions for the user to download and run lbrynet and lbcd (or SPV + LBRYnet API). Extension with a lot of permissions, like changing CORS."
  - Goal remains productive: build something useful that gives LBRY protocol power inside Chrome/Brave etc. browsing.

**Project location**: Working directory `~/AI/grokbuild/revivel` (empty at planning time; `/root/AI/grokbuild/revivel` in this env). The extension code will live here (or a clear `extension/` subdir if other pieces added later).

This is the **planning phase**: incorporate both Telegram vision + Discord technical reality, produce actionable feasibility + implementation plan. Current workspace has no LBRY/extension code (unrelated trading/Grok tools only).

## Research Summary & Feasibility

### LBRY Protocol Status (as of 2026-06)
- Decentralized: LBRY blockchain (claims/naming for metadata + payments) + BitTorrent-like P2P blobs for content.
- LBRY Inc dissolved after SEC action; protocol continues community-driven. Odysee (separate) is the dominant frontend/client.
- Content still resolvable via explorer.lbry.com and public APIs. Availability depends on seeders/reflectors.
- `lbry://` scheme is the native URI (e.g. `lbry://@channel/claim`, `lbry://claim`).
- Publishing = "claim" on-chain (small LBC bid + tx) + upload blobs. Requires LBC and infrastructure.

Key sources explored: lbry.com/faq, lbry.tech (spec + SDK), OdyseeTeam GitHub (odysee-frontend, odysee-api, player-server), existing extensions ("Watch on LBRY", Watch-on-Odysee), public discussions.

### Core Technical Feasibility (Updated with Discord Insights)
**Two-Tier Architecture (Strongly Recommended)**
1. **Public / Zero-Install Tier** (HIGH feasibility): Use Odysee's public SDK proxy for resolve/play. Works immediately, no daemon.
2. **Local Daemon Tier** (MEDIUM-HIGH, the "real" power): Connect extension to a user-run `lbrynet` (and optionally `lbcd`) on localhost:5279. This unlocks full resolve, publish, streaming from the user's own daemon, better privacy, and true LBRY network participation.

**Resolve + Playback**
- Public: `POST https://api.na-backend.odysee.com/api/v1/proxy` with `{ "method": "resolve", "params": { "urls": ["lbry://..."] } }`. Returns metadata + streaming info. Already used by scrapers/Kodi.
- Local daemon: Same JSON-RPC shape, pointed at `http://localhost:5279`. Background service worker can `fetch` it directly. Content scripts talk via `chrome.runtime.sendMessage`.
- Playback: `streaming_url` + `<video>`, or Odysee embed, or daemon's own media reflector.
- lbry-nova-web precedent: Its server does exactly `/api/rpc?url=...` and `/api/proxy` forwarding to the daemon URL. We can model messaging or even optionally embed/similar patterns.

**`lbry://` Protocol Handling (MEDIUM-HIGH)**
- Manifest `protocol_handlers` (FF solid; Chromium experimental flag per recent changes).
- Fallbacks: omnibox, popup paste, content-script link rewriting.
- Route to internal player page. Desktop app will still compete for the scheme (user choice).

**Upload to ReviveL (Context Menu) — Now Clearer Path**
- Menu on images easy.
- Fetch blob in background.
- **With local daemon (primary target for good UX)**: Use the `publish` / `stream_create` RPC. Daemon handles signing, LBC, reflector upload. Extension only orchestrates (sends file data or path if possible; typically stream the blob or use temp handling).
- **Public tier**: Assisted only (download + CLI snippet + Odysee web link) because public proxy is read-only.
- CORS: Primarily a *page* problem. Background fetch to localhost:5279 usually succeeds for extensions. If needed, use declarativeNetRequest to relax headers or document `--disable-web-security` for testing (not for users). lbrynet can be started with appropriate `--api` / CORS flags in some builds.
- lbrynet speaks plain HTTP JSON-RPC — no raw sockets required from the *client* side for most operations.

**lbry-nova-web Synergy (High Priority Reference)**
- https://github.com/LBRYFoundation/lbry-nova-web : Official-ish LBRYFoundation project. React + Vite frontend + small Express server with `/api/rpc` and `/api/proxy` that forward to a user-supplied daemon URL. Perfect model for how web code safely reaches lbrynet.
- ReviveL role: the **extension glue layer** the ecosystem lacks — protocol handler, right-click everywhere, address bar `lbry://`, seamless web-to-LBRY actions.
- During implementation: clone and run lbry-nova-web locally alongside daemon for reference UI/flows. Consider "Open in lbry-nova-web" button or shared components later.
- Its server.ts proxy is ~40 lines — directly adaptable for any needed relay inside the extension background.

**Other**
- Easy user instructions: "Download official LBRY Desktop (or just the daemon binaries), run `lbrynet start`, point ReviveL at it (or auto-detect)."
- SPV/light clients mentioned in discussion — worth investigating if lighter than full lbrynet for some users.
- Content scripts, popup, options: all straightforward.

**Permissions Needed**: `contextMenus`, `storage`, `downloads`, `tabs`/`activeTab`, host permissions for the Odysee API + (optionally) `http://localhost/*` or `<all_urls>` with care. For CORS bypass on pages if required: `declarativeNetRequest`.

### Key Obstacles & Risks (Discord-Informed)
1. **No full daemon in the extension**: Confirmed. MV3 + networking walls make WASM full node impractical. **Must document clearly**: users run lbrynet locally for full features.
2. **Localhost RPC + CORS**: Background scripts usually reach `http://127.0.0.1:5279`. Content/popup scripts may hit CORS — solve with runtime messaging to background or a small relay pattern (inspired by lbry-nova-web's `/api/rpc`).
3. **Protocol handler UX**: Still inconsistent (flags, competing desktop app registration). Provide multiple entry points.
4. **Daemon setup friction**: Users must download/run lbrynet + (optionally) lbcd. Provide dead-simple instructions + auto-detect + status in UI. SPV/light options worth exploring.
5. **Upload still non-trivial**: Requires running daemon + LBC + the file reaching the daemon. Extension can orchestrate but can't do magic. "Assisted" public path remains useful for quick image saves.
6. **API / infrastructure dependency**: Public proxy is convenient fallback; prefer daemon. lbry-nova-web shows a healthy pattern for web <-> daemon.
7. **Content seeding**: Same P2P reality.
8. **MV3 + permissions**: Service worker, host perms for localhost (tricky in stores sometimes), declarativeNetRequest for header work if needed. Never handle keys.
9. **Legal/ecosystem**: Same as before — copyright on uploads, smaller audience, LBC costs.
10. **Playback**: Rely on daemon or Odysee transcodes for quality.

**Overall Feasibility Verdict (Updated)**: 
**Very feasible and valuable as a hybrid extension**:
- Public proxy path → instant gratification, zero setup, great for discovery + `lbry://` resolution + basic "upload assist".
- Local daemon path (with clear onboarding) → the real power users and Discord community want: full publish, better streams, decentralized.
lbry-nova-web proves the daemon-from-browser pattern works; ReviveL adds the *browser integration layer* the community is missing (global right-click, protocol handler, everywhere context).
This directly addresses the original Telegram request while respecting the hard technical limits discussed in Discord. Incremental, honest scope. High chance of being genuinely useful.

## Recommended Approach

**Two-Tier Design (Core of the Plan)**
- **Tier 1 (Public proxy)**: Always works. Resolve/play via Odysee API. Assisted upload (download + CLI / Odysee link). Great onboarding.
- **Tier 2 (Local daemon)**: User runs lbrynet (easy instructions). Full JSON-RPC (resolve, publish, streams). This is what makes ReviveL powerful per Discord feedback. Detect status, allow override of daemon URL.

**MVP Scope (focused & shippable)**
- Manifest V3 (Chrome + Firefox first).
- `lbry://` resolution + play using public proxy (with clear "for more, run daemon" messaging).
- Popup + player page for URI entry / resolve / metadata + video.
- Omnibox + protocol handler declaration + fallbacks.
- Right-click image "Upload to ReviveL": download + metadata form → "Copy ready lbrynet publish command" + "Open Odysee upload" + (if daemon connected) attempt direct publish path.
- Basic daemon connection UI (status, URL field in options/popup). Background fetch to localhost:5279.
- Settings for API choice / daemon host.
- Clean README with:
  - Quick start (public tier).
  - "For full features" section: how to run lbrynet + lbcd.
  - Link to lbry-nova-web.
- Zero external backend.

**Phased Roadmap**
1. Skeleton + public proxy resolve/play in popup/player.
2. Protocol handler + omnibox + basic `lbry://` flow.
3. Context menu + assisted upload flow (always) + daemon-aware publish attempt.
4. Daemon status, auto-detect, improved error/CORS handling, content script prototypes.
5. Polish, docs, icons, store prep.
6. Post-MVP: deeper publish (file streaming to daemon), lbry-nova-web integration ideas, subscriptions sidebar, etc.

**Tech Stack**
- TypeScript + Vite + `@crxjs/vite-plugin` (or Plasmo) — best for MV3 + dual browser builds.
- UI: React (or Preact) for forms/player (lbry-nova-web uses React; consistency helpful).
- Minimal deps.
- Background service worker + message passing for RPC.
- For daemon RPC: simple typed client that can target either public proxy or `http://127.0.0.1:5279`.

**Architecture Highlights**
- `background.ts`: contextMenus, onClicked (image handling + downloads), daemon RPC helper (fetch wrapper), omnibox, protocol coordination, message listener (for popup/content to request RPC).
- `popup/`: fast entry (paste URI, quick resolve, upload form, daemon status badge).
- `player/`: rich resolver/player view. Handles incoming URIs. Uses same RPC util.
- `utils/lbryApi.ts`: `resolve(uri, {daemonUrl?})`, `publish(...)`, helpers. Detects/configures endpoint.
- Messaging: chrome.runtime for crossing contexts safely.
- Storage: preferred mode (public | daemon), daemonUrl, recent claims, etc.
- Protocol: manifest entry + internal routing.
- CORS handling: prefer background fetches + messages. declarativeNetRequest only if strictly necessary for page-level.

**Project Layout (in working dir)**
```
AI/grokbuild/revivel/          # or revivel-extension/ subdir
├── package.json
├── vite.config.ts
├── src/
│   ├── manifest.json
│   ├── background.ts
│   ├── popup/
│   ├── player/
│   ├── options/
│   ├── content.ts (future)
│   └── utils/lbryApi.ts
├── public/icons/
├── README.md  (include Discord/Telegram context + daemon setup guide)
└── ...
```

**Inspiration & Reuse**
- Watch-on-Odysee (manifest, structure, content scripts, multi-browser).
- lbry-nova-web (proxy patterns for daemon, React UI ideas, `/api/rpc` shape). https://github.com/LBRYFoundation/lbry-nova-web — study the server.ts proxy and frontend.
- Official LBRY SDK docs (daemon methods: resolve, publish, claim_search, etc.).
- MDN webextensions samples for contextMenus + downloads + localhost patterns.

**Permissions (target minimal)**
- `contextMenus`, `storage`, `downloads`, `tabs`.
- Host: `https://api.na-backend.odysee.com/*`, `https://odysee.com/*`, `http://127.0.0.1/*` (or broader for flexibility; document).
- `protocol_handlers`.
- `declarativeNetRequest` (optional, for CORS/header work).

**User Onboarding (Critical)**
- First run / options: big callout "For full LBRY power (uploads, your own node): run lbrynet".
- One-click links to official downloads + copy-paste `lbrynet start` instructions.
- Status indicator everywhere: "Public mode (limited)" vs "Connected to local daemon".
- Mention lbry-nova-web as complementary web UI.

## Critical Files (New Project)
- `AI/grokbuild/revivel/src/manifest.json`
- `AI/grokbuild/revivel/src/background.ts`
- `AI/grokbuild/revivel/src/utils/lbryApi.ts` (the dual-endpoint RPC client)
- `AI/grokbuild/revivel/src/popup/*` + `player/*`
- `AI/grokbuild/revivel/README.md` (daemon setup guide + lbry-nova-web reference is mandatory)
- Vite config + icons.

## Phased Development Roadmap (High Level)
1. **Setup & Skeleton** (1-2 days): package, manifest (with protocol_handlers + contextMenus), basic popup + background that registers menu (no-op), TypeScript build that loads unpacked.
2. **Resolve Core** (2-3 days): lbryApi util + popup "resolve & preview" for pasted URIs. Display title/desc/thumbnail. Play button using video or embed.
3. **Protocol + Omnibox** (1-2 days): wire protocol handler (document flag for Chrome), omnibox, route to player page. Test address bar + popup.
4. **Context Menu Upload Assist** (2 days): image menu, download + form in popup or dedicated panel. Generate CLI / Odysee prep.
5. **Polish & Options** (2-3 days): error states, loading, settings (API override), nice player UI, content script prototype for link enhancement.
6. **Validation + Docs** (ongoing): README with screenshots, feasibility notes, publish to Chrome/Firefox stores (review times).
7. **Future (post-MVP)**: daemon direct publish, backend option, full content script features, rewards/tips UI.

## Verification (End-to-End Testing)
1. **Environment**: `cd AI/grokbuild/revivel`; npm/pnpm install + build.
2. **Load unpacked** (Chrome + Firefox via web-ext).
3. **Public Tier (no daemon)**:
   - Popup + address bar + player: resolve a public lbry:// URI.
   - Video plays or embed works. Metadata matches Odysee.
4. **Context Menu (assisted)**:
   - Right-click image → menu → form appears → "Copy lbrynet..." and "Open Odysee" both work.
5. **Daemon Tier**:
   - User starts lbrynet locally (follow README).
   - In extension: set/connect to localhost:5279.
   - Verify status shows "connected".
   - Resolve same URI via daemon (should be identical or richer).
   - If possible in MVP: attempt a small publish (test claim) via the RPC path.
6. **CORS / Messaging**: Content script (if present) or popup successfully triggers background RPC.
7. **Protocol + Omnibox**: Multiple entry points all land in player with correct content.
8. **Cross checks**: No errors, settings saved, Firefox works, graceful public-mode degradation.
9. **Manual end-to-end**: Follow daemon instructions in README → full publish from extension context menu succeeds and appears on explorer/odysee.

Automate smoke tests later. Scripts modeled after Watch-on-Odysee + lbry-nova-web.

## Open Questions / Tradeoffs (Post-Discord)
- Daemon onboarding priority: How much hand-holding / one-click launcher scripts in v1?
- lbry-nova-web relationship: Pure inspiration, optional "launch web UI" button, or deeper embedding?
- CORS strategy depth: messaging-only vs. declarativeNetRequest vs. document tradeoffs.
- Stack: Confirm React (alignment with lbry-nova-web) or keep ultra-light.
- Future backend? Only if community demands seamless no-daemon uploads.
- Name spelling + branding.
- Additional early features (search in popup? channel quick switch?).

## Summary
ReviveL is a practical hybrid browser companion that respects real technical constraints discussed in the Discord (no in-extension full node) while delivering the Telegram-requested experience:

- Instant `lbry://` resolution + play (public proxy first).
- Right-click upload anywhere, with a clear path to full power once the user runs lbrynet.
- Leverages lbry-nova-web patterns and the HTTP nature of the daemon RPC.

The two-tier design (public for zero-friction + daemon for real capability) + excellent onboarding docs is the way to make it useful and community-aligned. The plan is now updated with all provided conversation logs and research.

Ready for approval and execution.
