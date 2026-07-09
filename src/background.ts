// ReviveL background — real LBRY integration (two-tier: public proxy + local daemon)
// Context menu, omnibox "rev ", lbry:// protocol, messaging + real RPC

const PUBLIC_PROXY = 'https://api.na-backend.odysee.com/api/v1/proxy'

let daemonUrl: string | null = null
let lastKnownBlockHeight = 0

// RPC credentials (user/pass) delivered securely via Native Messaging from the ReviveL Companion.
// Never stored in browser storage; kept in-memory only. Used for Basic Auth on local daemon.
let cachedRpcCredentials: { user: string; pass: string } | null = null

/**
 * Requests RPC credentials from the ReviveL Companion using Native Messaging.
 * Matches the live Companion implementation:
 *   Request:  { type: "get-rpc-credentials" }
 *   Success:  { success: true, user: "<rpcuser>", pass: "<rpcpass>" }
 *   Error:    { success: false, error: "..." }
 *
 * Credentials are used for HTTP Basic Auth on local daemon RPCs.
 * They are kept only in memory (never persisted to browser storage).
 */
async function requestCredentialsFromCompanion(): Promise<{ user: string; pass: string } | null> {
  if (cachedRpcCredentials) {
    return cachedRpcCredentials
  }

  try {
    const response: any = await chrome.runtime.sendNativeMessage(
      'revivel_companion',
      { type: 'get-rpc-credentials' }
    )

    if (response) {
      if (response.success === false) {
        console.warn('[ReviveL] Companion credential error:', response.error || 'unknown error')
        return null
      }

      // Prefer the documented "user"/"pass" fields, with graceful fallback
      const user = response.user || response.rpcuser || response.rpc_user
      const pass = response.pass || response.rpcpass || response.rpc_pass

      if (user && pass) {
        cachedRpcCredentials = { user, pass }
        return cachedRpcCredentials
      }

      // If success true but no creds, or legacy direct object without success flag
      if ((response.user || response.rpcuser) && (response.pass || response.rpcpass)) {
        const u = response.user || response.rpcuser
        const p = response.pass || response.rpcpass
        cachedRpcCredentials = { user: u, pass: p }
        return cachedRpcCredentials
      }
    }
  } catch (err: any) {
    console.warn('[ReviveL] Native messaging for RPC credentials failed:', err?.message || err)
  }

  return null
}

/** Invalidate cached credentials (e.g. when daemon URL changes or on logout) */
function clearRpcCredentials() {
  cachedRpcCredentials = null
}

/**
 * Proxy an RPC call through the ReviveL Companion using Native Messaging.
 * The Companion performs the actual authenticated request to lbrynet.
 */
async function rpcCallViaCompanion(method: string, params: any = {}) {
  try {
    const response: any = await chrome.runtime.sendNativeMessage("revivel_companion", {
      type: "rpc_call",
      method,
      params
    });

    if (response?.error) {
      const msg = typeof response.error === 'string'
        ? response.error
        : (response.error.message || JSON.stringify(response.error));
      throw new Error(msg);
    }

    // Raw lbrynet JSON-RPC response shape: { jsonrpc: "2.0", result: ..., error?: ... }
    if (response && typeof response === 'object' && 'jsonrpc' in response) {
      if (response.error) {
        const err = response.error;
        throw new Error(typeof err === 'string' ? err : (err.message || JSON.stringify(err)));
      }
      return response.result;
    }

    // If Companion returned the inner result directly, or other shape
    if (response && response.result !== undefined) {
      return response.result;
    }

    return response;
  } catch (err: any) {
    throw new Error(`Companion RPC proxy error: ${err.message || err}`);
  }
}

// For tab-following floating player
let currentFloating: { uri: string; title?: string; streamUrl?: string | null; lastTime: number; tabId: number } | null = null
let lastActiveWebTabId: number | null = null

chrome.storage.sync.get(['daemonUrl'], (r: any) => { if (r.daemonUrl) daemonUrl = r.daemonUrl })
chrome.storage.onChanged.addListener((c: any) => {
  if (c.daemonUrl) {
    daemonUrl = c.daemonUrl.newValue
    clearRpcCredentials()
  }
})

// Proactively request credentials from Companion if we have a local daemon configured.
// This uses Native Messaging. Will retry on actual RPC calls if not yet available.
if (daemonUrl && (daemonUrl.includes('127.0.0.1') || daemonUrl.includes('localhost'))) {
  requestCredentialsFromCompanion().catch(() => {
    // Non-fatal; will retry (including explicit retry in makeAuthenticatedRequest)
  })
}

// === Tab-following floating player support ===
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  // Track last active web tab for reliable re-attach
  chrome.tabs.get(tabId, (t) => {
    if (t && t.url && /^https?:\/\//.test(t.url) && !t.url.startsWith('chrome-extension://')) {
      lastActiveWebTabId = tabId;
    }
  });

  if (!currentFloating || currentFloating.tabId === tabId) return;

  const oldTabId = currentFloating.tabId;
  const time = currentFloating.lastTime || 0;
  const data = {
    uri: currentFloating.uri,
    title: currentFloating.title,
    streamUrl: currentFloating.streamUrl,
    startTime: time
  };

  // Remove floating from the old tab
  try {
    await chrome.scripting.executeScript({
      target: { tabId: oldTabId },
      world: 'ISOLATED',
      func: () => { const el = document.getElementById('revivel-floating'); if (el) el.remove(); }
    });
  } catch (_) { /* tab may be closed or restricted */ }

  // Inject into the newly active tab if allowed
  try {
    const t = await chrome.tabs.get(tabId);
    const u = t.url || '';
    const restricted = u.startsWith('chrome://') || u.startsWith('brave://') || u.startsWith('edge://') ||
                       u.startsWith('opera://') || u.startsWith('about:') || u.startsWith('chrome-extension://');
    if (!restricted && t.id) {
      // Wait a bit + for tab to be complete so content script is definitely ready
      await new Promise(r => setTimeout(r, 120));
      try {
        await new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(tabId, {
            type: 'showFloatingPlayer',
            uri: data.uri,
            title: data.title,
            streamUrl: data.streamUrl,
            startTime: data.startTime || 0,
            fromTabSwitch: true
          }, (resp) => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve(resp);
          });
        });
        currentFloating.tabId = tabId;
      } catch (sendErr) {
        // Fallback to direct scripting injection
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            world: 'ISOLATED',
            func: createFloatingPlayer,
            args: [data]
          });
          currentFloating.tabId = tabId;
        } catch (_) {
          currentFloating = null;
        }
      }
    } else {
      currentFloating = null;
    }
  } catch (_) {
    currentFloating = null;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (currentFloating && currentFloating.tabId === tabId) {
    currentFloating = null;
  }
});

// Active block height poller for real-time new block detection
setInterval(async () => {
  try {
    const status = await getStatusViaRpc()
    // The height check and broadcast happens inside getStatusViaRpc
  } catch (e) {
    // ignore poll errors
  }
}, 15000) // poll every 15s

function getRpcEndpoint(): string {
  // Prefer local daemon (Companion) if configured or auto-detected
  return daemonUrl || PUBLIC_PROXY
}

/**
 * Fallback direct fetch helper (used when NM rpc_call is not available).
 * Adds HTTP Basic Auth when we have credentials from get-rpc-credentials.
 */
async function makeAuthenticatedRequest(endpoint: string, body: any) {
  const isLocalDaemon = endpoint.includes('127.0.0.1') || endpoint.includes('localhost')

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Origin': 'http://localhost'
  }

  if (isLocalDaemon) {
    let creds = await requestCredentialsFromCompanion()
    if (!creds) {
      // Retry once in case credentials became available (Companion just started)
      clearRpcCredentials()
      creds = await requestCredentialsFromCompanion()
    }

    if (creds) {
      const auth = btoa(`${creds.user}:${creds.pass}`)
      headers['Authorization'] = `Basic ${auth}`
    } else {
      // No credentials; direct call may fail auth on secured Companion (will 401).
    }
  }

  return fetch(endpoint, {
    method: 'POST',
    mode: 'cors',
    cache: 'no-store',
    headers,
    body: JSON.stringify(body)
  })
}

async function rpcCall(method: string, params: any = {}) {
  const endpoint = getRpcEndpoint()
  const isLocalDaemon = !!daemonUrl && (daemonUrl.includes('127.0.0.1') || daemonUrl.includes('localhost'))

  if (isLocalDaemon) {
    try {
      // Prefer routing through Companion Native Messaging proxy (Companion handles auth + request)
      return await rpcCallViaCompanion(method, params)
    } catch (e: any) {
      // Fallback to direct fetch (for non-Companion local daemons or if NM proxy fails)
      console.warn('[ReviveL] rpc_call via Companion failed, falling back to direct:', e?.message || e)
    }
  }

  try {
    const res = await makeAuthenticatedRequest(endpoint, { method, params })
    if (!res.ok) {
      if (res.status === 403) {
        throw new Error(`RPC HTTP 403 (Forbidden). The daemon may need to be started with --allowed-origin flag.`)
      }
      if (res.status === 401) {
        throw new Error(`RPC HTTP 401 (Unauthorized). Companion not providing credentials. Make sure the ReviveL Companion is installed, running, and has delivered user/pass via Native Messaging.`)
      }
      throw new Error(`RPC HTTP ${res.status}`)
    }
    const json = await res.json()
    if (json.error) {
      throw new Error(json.error.message || JSON.stringify(json.error))
    }
    return json.result
  } catch (err: any) {
    // If using daemon and it failed, surface clearly
    const isDaemon = !!daemonUrl
    throw new Error(`${isDaemon ? 'Daemon' : 'Public proxy'} error: ${err.message || err}`)
  }
}

async function resolveViaRpc(uri: string) {
  const result = await rpcCall('resolve', { urls: [uri] })
  return result
}

// Browser detection for potential future differences (Brave vs Chrome)
const detectedBrowser = (() => {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  if (ua.includes('Brave')) return 'brave';
  if (ua.includes('Edg')) return 'edge';
  if (ua.includes('OPR') || ua.includes('Opera')) return 'opera';
  if (ua.includes('Chrome')) return 'chrome';
  return 'other';
})();

console.log('[ReviveL] Detected browser:', detectedBrowser);

// Self-contained function injected into the page (ISOLATED world) to create a floating overlay.
// The actual <video> lives inside an extension-owned iframe so the host page (google.com etc.)
// is not blamed for accessing local services / localhost streams.
function createFloatingPlayer(data: { uri: string; title?: string; streamUrl?: string; startTime?: number; fromTabSwitch?: boolean }) {
  const existing = document.getElementById('revivel-floating');
  if (existing) existing.remove();

  const container = document.createElement('div');
  container.id = 'revivel-floating';
  // Larger size for better video experience (nearly double previous)
  container.style.cssText = `
    position:fixed; right:20px; bottom:20px; 
    width:min(420px, 42vw); min-width:300px; 
    height: 300px; min-height:260px; max-height:65vh;
    background:#0f172a; color:#e2e8f0; 
    border:1px solid #334155; border-radius:16px; 
    box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.5), 0 10px 10px -6px rgb(0 0 0 / 0.4);
    z-index:2147483647; overflow:hidden; font-family:system-ui, -apple-system, sans-serif;
    font-size:13px; display:flex; flex-direction:column; resize: both;
  `;

  const header = document.createElement('div');
  header.style.cssText = `
    background:#1e2937; padding:6px 10px; display:flex; align-items:center; 
    justify-content:space-between; cursor:grab; user-select:none; font-size:12px; flex-shrink:0;
  `;
  header.innerHTML = `
    <div style="display:flex; align-items:center; gap:6px; max-width:70%; overflow:hidden;">
      <span style="opacity:.6">▶</span>
      <span style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${data.title || 'LBRY Player'}</span>
    </div>
    <div style="display:flex; gap:5px; align-items:center;">
      <button id="rf-fullplayer" title="Open Full Player" style="background:#14b8a6; border:none; color:#fff; font-size:12px; padding:4px 10px; border-radius:6px; cursor:pointer; font-weight:600; display:flex; align-items:center; gap:4px; line-height:1;">↗ Full Player</button>
      <button id="rf-detach" title="Detach to persistent window (follows tabs)" style="background:#334155; border:none; color:#94a3b8; font-size:11px; padding:3px 6px; border-radius:6px; cursor:pointer;">Detach</button>
      <button id="rf-full" title="Fullscreen this overlay" style="background:#334155; border:none; color:#94a3b8; font-size:13px; padding:3px 7px; border-radius:6px; cursor:pointer;">⛶</button>
      <button id="rf-close" title="Close" style="background:transparent; border:none; color:#64748b; font-size:20px; line-height:1; padding:0 3px; cursor:pointer;">×</button>
    </div>
  `;

  // The iframe points to an extension page. All media / localhost requests originate from the
  // extension origin (chrome-extension://...), not from the host page. This avoids the
  // "google.com is asking you to access other apps..." permission prompt.
  const iframe = document.createElement('iframe');
  const q = new URLSearchParams();
  q.set('uri', data.uri);
  if (data.streamUrl) q.set('streamUrl', data.streamUrl);
  if (data.title) q.set('title', data.title);
  if (data.startTime && data.startTime > 0) q.set('startTime', String(data.startTime));
  const overlaySrc = (chrome as any).runtime.getURL('overlay.html') + '?' + q.toString();
  iframe.src = overlaySrc;
  iframe.style.cssText = 'flex:1; width:100%; height:100%; border:0; background:#000; display:block;';
  iframe.setAttribute('allowfullscreen', 'true');
  iframe.setAttribute('allow', 'fullscreen');

  container.append(header, iframe);
  document.body.appendChild(container);

  if (data.fromTabSwitch) {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position:absolute; bottom:8px; left:50%; transform:translateX(-50%);
      background:#1e2937; color:#94a3b8; font-size:10px; padding:4px 8px;
      border-radius:6px; border:1px solid #334155; z-index:10; white-space:nowrap;
      box-shadow:0 2px 8px rgba(0,0,0,0.3);
    `;
    toast.innerHTML = `Tab switched — <span style="color:#14b8a6; cursor:pointer; text-decoration:underline;">Detach</span> to keep playing`;
    container.appendChild(toast);
    const detachSpan = toast.querySelector('span')!;
    detachSpan.onclick = () => {
      chrome.runtime.sendMessage({ type: 'detachFloating', uri: data.uri, title: data.title, streamUrl: data.streamUrl });
      container.remove();
    };
    setTimeout(() => toast.remove(), 6000);
  }

  // Custom visible high-contrast resize grips (larger, whiter) - bottom-right + top-left
  container.style.resize = 'none';
  const makeGrip = (isTopLeft) => {
    const grip = document.createElement('div');
    grip.style.cssText = `
      position:absolute; ${isTopLeft ? 'top:2px; left:2px;' : 'bottom:2px; right:2px;'}
      width:20px; height:20px; background:#fff; border:2px solid #111;
      border-radius:4px; cursor:${isTopLeft ? 'nw-resize' : 'se-resize'};
      z-index:2147483647; box-shadow:0 1px 4px rgba(0,0,0,0.6);
      display:flex; align-items:center; justify-content:center; font-size:11px; color:#111; font-weight:bold;
      user-select:none;
    `;
    grip.textContent = isTopLeft ? '↖' : '↘';
    container.appendChild(grip);
    return grip;
  };
  const gripTL = makeGrip(true);
  const gripBR = makeGrip(false);

  function attachResize(gripEl, isTL) {
    gripEl.addEventListener('mousedown', (e) => {
      e.stopImmediatePropagation();
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const r = container.getBoundingClientRect();
      const startW = r.width;
      const startH = r.height;
      const startR = parseFloat(container.style.right) || (window.innerWidth - r.right);
      const startB = parseFloat(container.style.bottom) || (window.innerHeight - r.bottom);

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (isTL) {
          const newW = Math.max(300, startW - dx);
          const newH = Math.max(200, startH - dy);
          const dW = startW - newW;
          const dH = startH - newH;
          container.style.width = newW + 'px';
          container.style.height = newH + 'px';
          container.style.right = (startR + dW) + 'px';
          container.style.bottom = (startB + dH) + 'px';
        } else {
          const newW = Math.max(300, startW + dx);
          const newH = Math.max(200, startH + dy);
          container.style.width = newW + 'px';
          container.style.height = newH + 'px';
        }
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp, {once: true});
    });
  }
  attachResize(gripTL, true);
  attachResize(gripBR, false);

  // Close
  header.querySelector('#rf-close')!.addEventListener('click', () => {
    try { chrome.runtime.sendMessage({ type: 'floatingClosed', uri: data.uri }); } catch (_) {}
    container.remove();
  });

  // Fullscreen the whole floating container
  const fullBtn = header.querySelector('#rf-full') as HTMLElement;
  fullBtn.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      (container.requestFullscreen || (container as any).webkitRequestFullscreen)?.call(container);
    }
  });

  // "Full player" button — opens the same video in the premium full tab player
  const fullPlayerBtn = header.querySelector('#rf-fullplayer') as HTMLElement;
  fullPlayerBtn.addEventListener('click', (e) => {
    e.stopImmediatePropagation();
    chrome.runtime.sendMessage({ 
      type: 'openFullPlayer', 
      uri: data.uri, 
      title: data.title 
    });
    container.remove(); // close the floating overlay
  });

  // Detach for hybrid solution
  const detachBtn = header.querySelector('#rf-detach') as HTMLElement | null;
  detachBtn?.addEventListener('click', (e) => {
    e.stopImmediatePropagation();
    chrome.runtime.sendMessage({
      type: 'detachFloating',
      uri: data.uri,
      title: data.title,
      streamUrl: data.streamUrl
    });
    container.remove();
  });

  // Dragging (same behavior as before)
  let dragging = false, sx = 0, sy = 0, sr = 0, sb = 0;
  header.addEventListener('mousedown', (e) => {
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    const r = container.getBoundingClientRect();
    sr = window.innerWidth - r.right;
    sb = window.innerHeight - r.bottom;
    header.style.cursor = 'grabbing';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    container.style.right = (sr - (e.clientX - sx)) + 'px';
    container.style.bottom = (sb - (e.clientY - sy)) + 'px';
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
    header.style.cursor = 'grab';
  });

  // Double-click header or the iframe area to fullscreen
  header.addEventListener('dblclick', () => fullBtn.click());
  iframe.addEventListener('dblclick', () => fullBtn.click());
}

async function getStatusViaRpc() {
  const LOCALHOST = 'http://127.0.0.1:5279'

  // Robust detection: always probe localhost first for Companion
  let localStatusResult = null
  let probeSucceeded = false

  // Prefer Companion NM proxy for status to avoid direct HTTP from extension
  try {
    const statusResult = await rpcCallViaCompanion('status', {})
    localStatusResult = statusResult
    probeSucceeded = true
    if (!daemonUrl || daemonUrl !== LOCALHOST) {
      daemonUrl = LOCALHOST
      chrome.storage.sync.set({ daemonUrl: LOCALHOST })
    }
  } catch (e) {
    // Companion NM not available or failed — fall back to direct probe (for plain lbrynet or older setups)
  }

  if (!probeSucceeded) {
    try {
      const probeRes = await makeAuthenticatedRequest(LOCALHOST, { method: 'status', params: {} })

      if (probeRes.ok) {
        const probeJson = await probeRes.json()
        if (probeJson) {
          // Accept either full envelope or direct result
          localStatusResult = probeJson.result || probeJson
          probeSucceeded = true
          if (!daemonUrl || daemonUrl !== LOCALHOST) {
            daemonUrl = LOCALHOST
            chrome.storage.sync.set({ daemonUrl: LOCALHOST })
          }
        }
      }
    } catch (e) {
      // ignore, will fall through
    }
  }

  try {
    if (probeSucceeded && localStatusResult) {
      const fullStatus = localStatusResult
      const wallet = fullStatus.wallet || {}
      const blockchain = fullStatus.blockchain || {}
      const connection = fullStatus.connection_status || {}

      const currentHeight = blockchain.blocks || blockchain.height || wallet.blocks || 0
      if (currentHeight > lastKnownBlockHeight) {
        lastKnownBlockHeight = currentHeight
        chrome.runtime.sendMessage({ type: 'newBlock', height: currentHeight }).catch(() => {})
      }

      const walletReady = !!(wallet.available_servers || wallet.connected === true || (typeof wallet.blocks_behind === 'number' && wallet.blocks_behind <= 0))

      return {
        connected: true,
        endpoint: LOCALHOST,
        isCompanion: true,
        walletReady,
        blocks: blockchain.blocks || blockchain.height || wallet.blocks || 0,
        blocksBehind: typeof wallet.blocks_behind === 'number' ? wallet.blocks_behind : 0,
        bestBlockhash: blockchain.best_blockhash || '',
        spvServer: wallet.server || connection.server || fullStatus.spv || 's1.lbry.network:50001',
        using: 'daemon',
        hasCredentials: !!cachedRpcCredentials,
        rawStatus: fullStatus
      }
    } else if (daemonUrl) {
      // Fallback to configured daemon
      const fullStatus = await rpcCall('status', {})
      const wallet = fullStatus.wallet || {}
      const blockchain = fullStatus.blockchain || {}
      const connection = fullStatus.connection_status || {}

      const currentHeight = blockchain.blocks || blockchain.height || wallet.blocks || 0
      if (currentHeight > lastKnownBlockHeight) {
        lastKnownBlockHeight = currentHeight
        chrome.runtime.sendMessage({ type: 'newBlock', height: currentHeight }).catch(() => {})
      }

      const walletReady = !!(wallet.available_servers || wallet.connected === true || (typeof wallet.blocks_behind === 'number' && wallet.blocks_behind <= 0))

      return {
        connected: true,
        endpoint: daemonUrl,
        isCompanion: daemonUrl.includes('127.0.0.1') || daemonUrl.includes('localhost'),
        walletReady,
        blocks: blockchain.blocks || blockchain.height || wallet.blocks || 0,
        blocksBehind: typeof wallet.blocks_behind === 'number' ? wallet.blocks_behind : 0,
        bestBlockhash: blockchain.best_blockhash || '',
        spvServer: wallet.server || connection.server || 'unknown',
        using: 'daemon',
        hasCredentials: !!cachedRpcCredentials,
        rawStatus: fullStatus
      }
    } else {
      // Public proxy - make safe
      try {
        await rpcCall('resolve', { urls: ['lbry://what'] })
      } catch (_) {
        // even if public fails, treat as public mode
      }
      return { connected: false, using: 'public', isCompanion: false }
    }
  } catch (e: any) {
    const errStr = String(e)
    // Only return error if we were trying a daemon
    if (daemonUrl || probeSucceeded) {
      let friendly = errStr
      if (errStr.includes('403')) {
        friendly = 'RPC HTTP 403 Forbidden. The daemon may need the --allowed-origin flag for the extension.'
      }
      if (errStr.includes('401')) {
        friendly = 'RPC HTTP 401 Unauthorized. Companion not providing credentials. Ensure the ReviveL Companion is installed and running (it must deliver user/pass via Native Messaging).'
      }
      return { 
        connected: false, 
        error: friendly, 
        using: 'daemon',
        endpoint: daemonUrl || LOCALHOST,
        rawError: errStr
      }
    } else {
      return { connected: false, using: 'public', isCompanion: false }
    }
  }
}

// Helper to get default account_id for SPV wallet commands (per INTEGRATION.md)
async function getDefaultAccountId(): Promise<string | null> {
  if (!daemonUrl) return null
  try {
    const result = await rpcCall('account_list', {})
    if (Array.isArray(result) && result.length > 0) {
      // Prefer the default account if marked, else first one
      const def = result.find((a: any) => a.default) || result[0]
      return def.id || def.name || null
    }
  } catch (e) {
    console.warn('[ReviveL] account_list failed', e)
  }
  return null
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'revivel-upload-image', title: 'Upload image to ReviveL', contexts: ['image'] })
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'revivel-upload-image' && info.srcUrl) {
    await chrome.storage.local.set({
      lastUploadContext: { srcUrl: info.srcUrl, suggestedName: info.srcUrl.split('/').pop() || 'image.jpg', pageUrl: tab?.url }
    })
    chrome.action.openPopup()
  }
})

// Helper: open the full player for a URI, focusing an existing tab if one is already open for it
//
// Native Messaging integration with ReviveL Companion:
// - "get-rpc-credentials": returns { success: true, user, pass } for direct fallback mode
// - "rpc_call": preferred path for local Companion. Extension sends { type: "rpc_call", method, params }
//   Companion forwards with proper auth and returns the raw lbrynet response { jsonrpc, result } or error.
// - This avoids the extension directly talking to lbrynet (reduces need for --allowed-origin on main path).

// We also accept the same message via chrome.runtime.sendMessage for flexibility.
// Host manifest will be provided by the Companion installer.
async function openOrFocusPlayer(uri: string, title?: string) {
  const playerBase = chrome.runtime.getURL('player.html')
  const targetUrl = playerBase + '?uri=' + encodeURIComponent(uri) + (title ? '&title=' + encodeURIComponent(title) : '')

  // Look for an existing player tab with this exact URI
  const tabs = await chrome.tabs.query({ url: playerBase + '*' })
  for (const tab of tabs) {
    if (tab.url) {
      try {
        const tabUrl = new URL(tab.url)
        const tabUri = tabUrl.searchParams.get('uri')
        if (tabUri === uri || decodeURIComponent(tabUri || '') === uri) {
          if (tab.id) {
            if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true })
            await chrome.tabs.update(tab.id, { active: true })
            return
          }
        }
      } catch (_) {}
    }
  }

  // No existing tab found — create a new one
  chrome.tabs.create({ url: targetUrl })
}

// Omnibox: type "rev something"
chrome.omnibox.onInputEntered.addListener((text) => {
  const uri = text.startsWith('lbry://') ? text : `lbry://${text}`
  openOrFocusPlayer(uri)
})

// Messages from popup / player / content
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type === 'getDaemonStatus') {
    getStatusViaRpc().then(sendResponse)
    return true
  }
  if (msg.type === 'setDaemonUrl') {
    daemonUrl = msg.url || null
    clearRpcCredentials()
    chrome.storage.sync.set({ daemonUrl })
    sendResponse({ ok: true })
    return true
  }
  if (msg.type === 'resolve') {
    resolveViaRpc(msg.uri)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }))
    return true
  }
  if (msg.type === 'openPlayer') {
    const data = { uri: msg.uri, title: msg.uri };
    chrome.tabs.query({active: true, currentWindow: true}, async (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) return;
      const tabUrl = tab.url || '';
      const isRestricted = tabUrl.startsWith('chrome://') ||
                           tabUrl.startsWith('brave://') ||
                           tabUrl.startsWith('edge://') ||
                           tabUrl.startsWith('opera://') ||
                           tabUrl.startsWith('about:') ||
                           tabUrl.startsWith('chrome-extension://');

      if (isRestricted) {
        openOrFocusPlayer(data.uri);
        return;
      }

      const startTime = currentFloating && currentFloating.uri === data.uri ? currentFloating.lastTime : 0;
      const injectData = { ...data, startTime };
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'ISOLATED',
          func: createFloatingPlayer,
          args: [injectData]
        });
        currentFloating = {
          uri: data.uri,
          title: data.title,
          streamUrl: null,
          lastTime: startTime || 0,
          tabId: tab.id
        };
      } catch (injectErr) {
        currentFloating = null;
        openOrFocusPlayer(data.uri);
      }
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'openFullPlayer' || msg.type === 'open-lbry-uri') {
    // Support direct lbry:// launches (from Companion via URL or future native messaging)
    openOrFocusPlayer(msg.uri, msg.title);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'playInOverlay') {
    const uri = msg.uri;

    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) return;

      // Resolve to get title (and streamUrl if available from resolve)
      let title = uri;
      let streamUrl = null;
      try {
        const resolveResp = await new Promise<any>(r => chrome.runtime.sendMessage({ type: 'resolve', uri }, r));
        if (resolveResp && resolveResp.ok) {
          const result = resolveResp.result;
          const claim = result && (result[uri] || Object.values(result)[0]);
          if (claim) {
            title = claim.title || claim.value?.title || uri;
            streamUrl = claim.streaming_url || claim.value?.streaming_url || null;
          }
        }
      } catch (e) {}

      // For public mode, do NOT pre-acquire streamUrl here (the URL from 'get' can be short-lived and 401 later).
      // Let the overlay do a fresh tryAcquireStream() right when it's ready to play.
      // Only pre-acquire if we have a local daemon (more reliable URLs).

      const status = await new Promise<any>(r => chrome.runtime.sendMessage({ type: 'getDaemonStatus' }, r));
      const hasDaemon = status && status.connected;

      if (hasDaemon && !streamUrl) {
        try {
          const getResp = await new Promise<any>(r => chrome.runtime.sendMessage({ type: 'streamGet', uri }, r));
          if (getResp && getResp.ok) {
            const g = getResp.result;
            const gotUrl = g?.streaming_url || 
                           g?.file?.streaming_url || 
                           g?.stream?.streaming_url || 
                           (g?.value && g.value.streaming_url) ||
                           g?.result?.streaming_url ||
                           null;
            if (gotUrl) {
              streamUrl = gotUrl;
            }
            if (!title && g) {
              title = g.title || g.value?.title || uri;
            }
          }
        } catch (e) {}
      }

      const data = {
        uri,
        title,
        streamUrl
      };

      let targetTab = tab;
      const tabUrl = tab.url || '';
      const isRestricted = tabUrl.startsWith('chrome://') ||
                           tabUrl.startsWith('brave://') ||
                           tabUrl.startsWith('edge://') ||
                           tabUrl.startsWith('opera://') ||
                           tabUrl.startsWith('about:') ||
                           tabUrl.startsWith('chrome-extension://');
      const isPlayerTab = tabUrl.includes('player.html');

      if (isRestricted || isPlayerTab) {
        // Find a suitable web tab to inject the floating player into (e.g. when Float is clicked from the player tab itself)
        const allTabs = await chrome.tabs.query({});
        const suitableTab = allTabs.find(t =>
          t.id !== tab.id &&
          t.url &&
          (t.url.startsWith('http:') || t.url.startsWith('https:')) &&
          !t.url.startsWith('chrome-extension:')
        );
        if (suitableTab?.id) {
          targetTab = suitableTab;
        } else {
          // No suitable tab found, fallback
          openOrFocusPlayer(data.uri, data.title);
          return;
        }
      }

      const startTime = currentFloating && currentFloating.uri === data.uri ? currentFloating.lastTime : 0;
      const injectData = { ...data, startTime };

      try {
        await chrome.scripting.executeScript({
          target: { tabId: targetTab.id! },
          world: 'ISOLATED',
          func: createFloatingPlayer,
          args: [injectData]
        });
        // Track for tab following
        currentFloating = {
          uri: data.uri,
          title: data.title,
          streamUrl: data.streamUrl,
          lastTime: startTime || 0,
          tabId: targetTab.id!
        };
        lastActiveWebTabId = targetTab.id!;
      } catch (injectErr) {
        // Fallback to full player tab
        currentFloating = null;
        openOrFocusPlayer(data.uri, data.title);
      }
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'floatingTimeUpdate') {
    if (currentFloating && currentFloating.uri === msg.uri) {
      currentFloating.lastTime = msg.time || currentFloating.lastTime;
    }
    return true;
  }

  if (msg.type === 'floatingClosed') {
    if (currentFloating && currentFloating.uri === msg.uri) {
      currentFloating = null;
    }
    return true;
  }

  if (msg.type === 'detachFloating') {
    // Create a standalone popup window for persistent playback across tabs
    const time = msg.startTime || (currentFloating && currentFloating.uri === msg.uri ? currentFloating.lastTime : 0);
    const q = new URLSearchParams();
    q.set('uri', msg.uri);
    if (msg.title) q.set('title', msg.title);
    if (msg.streamUrl) q.set('streamUrl', msg.streamUrl);
    if (time > 0) q.set('startTime', String(time));
    q.set('standalone', '1');

    chrome.windows.create({
      url: chrome.runtime.getURL('overlay.html') + '?' + q.toString(),
      type: 'popup',
      width: 520,
      height: 450
    });

    // Remove any in-page floating on the current tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab?.id) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'ISOLATED',
          func: () => { document.getElementById('revivel-floating')?.remove(); }
        }).catch(() => {});
      }
    });

    currentFloating = null;
    return true;
  }

  if (msg.type === 'reattachFloating') {
    // Re-create in-page floating on current tab from the standalone popup
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      let tab = tabs[0];
      let tabId = tab?.id;

      const tabUrl = tab?.url || '';
      let isRestricted = tabUrl.startsWith('chrome://') || tabUrl.startsWith('brave://') ||
                         tabUrl.startsWith('edge://') || tabUrl.startsWith('opera://') ||
                         tabUrl.startsWith('about:') || tabUrl.startsWith('chrome-extension://');

      if (isRestricted || !tabId) {
        // Fallback to last known web tab (important when re-attach clicked from popup window, which takes focus)
        if (lastActiveWebTabId) {
          try {
            const t = await chrome.tabs.get(lastActiveWebTabId);
            if (t && t.url && /^https?:\/\//.test(t.url) && !t.url.startsWith('chrome-extension://')) {
              tab = t;
              tabId = t.id;
              isRestricted = false;
            }
          } catch (_) {}
        }
      }

      if (!tabId || isRestricted) return;

      const data = {
        uri: msg.uri,
        title: msg.title,
        streamUrl: msg.streamUrl,
        startTime: msg.startTime || 0
      };

      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'ISOLATED',
          func: createFloatingPlayer,
          args: [data]
        });
        currentFloating = {
          uri: msg.uri,
          title: msg.title,
          streamUrl: msg.streamUrl,
          lastTime: msg.startTime || 0,
          tabId
        };
        lastActiveWebTabId = tabId;
      } catch (_) {}
    });
    return true;
  }

  if (msg.type === 'setFloatingSession') {
    // Update or init session from content creation
    if (!currentFloating || currentFloating.uri !== msg.uri) {
      currentFloating = {
        uri: msg.uri,
        title: msg.title,
        streamUrl: msg.streamUrl,
        lastTime: msg.lastTime || 0,
        tabId: -1 // will be set on next activate or known
      };
    } else {
      currentFloating.lastTime = msg.lastTime || currentFloating.lastTime;
    }
    // Try to find current tab id
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id && currentFloating) currentFloating.tabId = tabs[0].id;
    });
    return true;
  }

  // Future: publish stub
  if (msg.type === 'publish') {
    // Real publish when daemon with wallet is available
    if (!daemonUrl) {
      sendResponse({ ok: false, error: 'No local daemon connected. Start ReviveL Companion.' })
      return true
    }
    // For now, forward the params (user of Companion is expected to have files accessible or use path)
    // In practice for browser uploads we may need to save temp file first.
    rpcCall('stream_create', msg.params || {})
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }))
    return true
  }

  if (msg.type === 'getWalletBalance') {
    if (!daemonUrl) {
      sendResponse({ ok: false, error: 'No daemon' })
      return true
    }
    getDefaultAccountId().then(accountId => {
      const params = accountId ? { account_id: accountId } : {}
      rpcCall('account_balance', params)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) => sendResponse({ ok: false, error: err.message }))
    }).catch(() => {
      rpcCall('account_balance', {})
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) => sendResponse({ ok: false, error: err.message }))
    })
    return true
  }

  if (msg.type === 'claimSearch') {
    rpcCall('claim_search', msg.params || {})
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }))
    return true
  }

  if (msg.type === 'streamGet') {
    // Use 'get' to start acquiring the stream and obtain streaming_url (works with local daemon)
    rpcCall('get', { uri: msg.uri, save_file: false })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }))
    return true
  }

  // Wallet / SPV functions
  // Per INTEGRATION.md from ReviveL Companion:
  // - For Companion-managed local daemon: prefer "rpc_call" via Native Messaging (Companion proxies with auth)
  // - Fallback: direct to 127.0.0.1:5279 (using get-rpc-credentials + Basic Auth if available)
  // - Start with account_list to get default account_id
  // - Use list for addresses in wallet_send (not map)
  // - wallet_create does NOT return seed; call wallet_seed after
  // - Use wallet_remove for delete
  // - txo_list for history
  // See INTEGRATION.md for full details.
  if (msg.type === 'getReceiveAddress') {
    if (!daemonUrl) {
      sendResponse({ ok: false, error: 'No daemon' })
      return true
    }
    getDefaultAccountId().then(accountId => {
      const params = accountId ? { account_id: accountId } : {}
      rpcCall('address_unused', params)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) => sendResponse({ ok: false, error: err.message }))
    }).catch(() => {
      rpcCall('address_unused', {})
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) => sendResponse({ ok: false, error: err.message }))
    })
    return true
  }

  if (msg.type === 'sendLBC') {
    if (!daemonUrl) {
      sendResponse({ ok: false, error: 'No daemon' })
      return true
    }
    getDefaultAccountId().then(accountId => {
      const sendParams: any = {
        amount: msg.amount,
        addresses: [msg.address],  // per INTEGRATION.md: use list, not map
      }
      if (accountId) sendParams.account_id = accountId
      if (msg.fee) sendParams.fee = msg.fee
      rpcCall('wallet_send', sendParams)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) => sendResponse({ ok: false, error: err.message }))
    }).catch(() => {
      const sendParams: any = {
        amount: msg.amount,
        addresses: [msg.address],
      }
      if (msg.fee) sendParams.fee = msg.fee
      rpcCall('wallet_send', sendParams)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) => sendResponse({ ok: false, error: err.message }))
    })
    return true
  }

  if (msg.type === 'getTransactions') {
    if (!daemonUrl) {
      sendResponse({ ok: false, error: 'No daemon' })
      return true
    }
    getDefaultAccountId().then(accountId => {
      // per INTEGRATION.md: use txo_list with type array for history
      const txParams: any = {
        page_size: msg.page_size || 20,
        resolve: false,
        type: ["spend", "support", "purchase", "received"]  // adjust as needed
      }
      if (accountId) txParams.account_id = accountId
      if (msg.type_filter) txParams.type = [msg.type_filter]
      rpcCall('txo_list', txParams)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) => sendResponse({ ok: false, error: err.message }))
    }).catch(() => {
      const txParams: any = { page_size: msg.page_size || 20, resolve: false, type: ["spend", "support", "purchase", "received"] }
      rpcCall('txo_list', txParams)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) => sendResponse({ ok: false, error: err.message }))
    })
    return true
  }

  if (msg.type === 'createWallet') {
    if (!daemonUrl) {
      sendResponse({ ok: false, error: 'No daemon' })
      return true
    }
    // Per INTEGRATION.md:
    // wallet_create does NOT return the seed. We auto-call wallet_seed after for convenience.
    // Use create_account: true
    rpcCall('wallet_create', {
      wallet_id: 'default',
      create_account: true
    })
      .then(async (createResult) => {
        try {
          const seedResult = await rpcCall('wallet_seed', { wallet_id: 'default' })
          sendResponse({ ok: true, result: { ...createResult, seed: seedResult.seed || seedResult } })
        } catch (seedErr) {
          sendResponse({ ok: true, result: createResult })  // still success, but no seed
        }
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }))
    return true
  }

  if (msg.type === 'closeWallet') {
    if (!daemonUrl) {
      sendResponse({ ok: false, error: 'No daemon' })
      return true
    }
    // Per INTEGRATION.md: wallet_close is internal/not commonly used for user-facing "close wallet".
    // We return wallet_status as a proxy for "status after close attempt".
    // For real close, user may need to stop the Companion.
    rpcCall('wallet_status', {})
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }))
    return true
  }

  if (msg.type === 'deleteWallet') {
    if (!daemonUrl) {
      sendResponse({ ok: false, error: 'No daemon' })
      return true
    }
    // Per INTEGRATION.md: use wallet_remove (not wallet_delete)
    // Real delete may also require cleaning data dir.
    rpcCall('wallet_remove', { wallet_id: 'default' })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }))
    return true
  }

  if (msg.type === 'getWalletSeed') {
    if (!daemonUrl) {
      sendResponse({ ok: false, error: 'No daemon' })
      return true
    }
    rpcCall('wallet_seed', {})
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }))
    return true
  }
})
