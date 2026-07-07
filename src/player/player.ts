// ReviveL Full Player — Complete redesign with menu bar + all popup functions + creative additions
import { 
  resolveLbryUri, extractClaim, getPlayableUrl, searchLbryClaims, 
  getDaemonStatus, setDaemonUrl,
  getWalletBalance, getReceiveAddress, sendLBC, getTransactions, createWallet, closeWallet, deleteWallet, getWalletSeed,
  getClaimTimestamp
} from '../utils/lbryApi.js'

let currentUri = new URLSearchParams(location.search).get('uri') || 'lbry://what'
let initialTitle = new URLSearchParams(location.search).get('title') || null
let currentClaim: any = null
let currentView: string = 'player'
let feedItems: any[] = []
let latestItems: any[] = []
let vault: any[] = []
let history: any[] = []
let daemonConnected = false

// Listen for new blockchain blocks from background to refresh Latest
chrome.runtime.onMessage.addListener((msg: any) => {
  if (msg.type === 'newBlock') {
    console.log('[ReviveL] New block detected:', msg.height)
    // Refresh latest with fresh data
    loadLatest()
  }
})

const videoEl = document.getElementById('video-player') as HTMLVideoElement
let currentStreamUrl: string | null = null

// ===== View Switching =====
function showView(view: string) {
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'))
  const target = document.getElementById(`view-${view}`)
  if (target) target.classList.add('active')

  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.view === view)
  })

  currentView = view

  if (view === 'feed') loadFeed()  // always fetch fresh on switch (and on new blocks)
  if (view === 'latest') loadLatest()  // always fetch fresh on switch (and on new blocks)
  if (view === 'library') loadLibrary()
  if (view === 'wallet') renderWallet()
  if (view === 'settings') renderSettings()
}

// ===== Status =====
async function updateStatus() {
  const dot = document.getElementById('status-dot')!
  const text = document.getElementById('status-text')!

  try {
    const status: any = await getDaemonStatus()
    daemonConnected = !!status?.connected

    if (daemonConnected) {
      dot.className = 'status-dot bg-emerald-400'
      text.textContent = status.isCompanion ? 'Companion' : 'Connected'
      text.className = 'font-medium text-xs tracking-wide text-emerald-400'
    } else {
      dot.className = 'status-dot bg-amber-400'
      text.textContent = status?.using === 'public' ? 'Public Proxy' : 'Offline'
      text.className = 'font-medium text-xs tracking-wide text-amber-400'
    }

    const pill = document.getElementById('status-pill')!
    pill.onclick = () => {
      showView('settings')
    }
  } catch (e) {
    dot.className = 'status-dot bg-red-400'
    text.textContent = 'Error'
  }
}

// ===== Core Video Playback (60% centered) =====
async function loadVideo(uri: string) {
  currentUri = uri
  const metaEl = document.getElementById('meta')!
  const descEl = document.getElementById('video-desc')!

  // Use initial title immediately if provided (from Companion launch)
  if (initialTitle) {
    metaEl.innerHTML = `
      <div>
        <div style="font-size:1.5rem; font-weight:600; letter-spacing:-0.025em; line-height:1.2;">${initialTitle}</div>
        <div style="font-size:0.875rem; color:#94a3b8; margin-top:4px;">Loading...</div>
        <div style="font-size:10px; font-family:monospace; color:#14b8a6; margin-top:4px;">${uri}</div>
      </div>
    `
    document.title = initialTitle + ' • ReviveL'
  } else {
    metaEl.innerHTML = `<div style="font-size:0.875rem; color:#64748b;">Resolving <span style="font-family:monospace;">${uri}</span>…</div>`
  }
  descEl.textContent = ''

  try {
    const result = await resolveLbryUri(uri)
    const claim = extractClaim(result, uri)
    currentClaim = claim

    if (!claim) {
      metaEl.innerHTML = `<div style="color:#f87171;">Failed to resolve ${uri}</div>`
      showNoStream('Could not load claim')
      return
    }

    const title = claim.title || claim.value?.title || uri
    const channel = claim.signing_channel?.name || claim.channel || '@unknown'
    const desc = claim.value?.description || claim.description || ''

    metaEl.innerHTML = `
      <div>
        <div style="font-size:1.5rem; font-weight:600; letter-spacing:-0.025em; line-height:1.2;">${title}</div>
        <div style="font-size:0.875rem; color:#94a3b8; margin-top:4px;">${channel}</div>
        <div style="font-size:10px; font-family:monospace; color:#14b8a6; margin-top:4px;">${uri}</div>
      </div>
    `
    descEl.textContent = desc.length > 420 ? desc.slice(0, 420) + '…' : desc
    document.title = title + ' • ReviveL'
    initialTitle = null // clear so future navigations use resolved data

    // Total staked = claim amount + supports (per https://lbry.tech/spec/#stakes)
    const stakeEl = document.getElementById('claim-stake-info') as HTMLElement | null;
    if (stakeEl) {
      // Clean up any legacy dynamically-inserted duplicate stake divs from previous loads
      document.querySelectorAll('.revivel-stake-info').forEach(el => el.remove());

      const claimAmt = parseFloat(claim.amount || 0);
      const supportAmt = parseFloat(claim.meta?.support_amount || 0);
      let totalStaked = claimAmt + supportAmt;
      if (!totalStaked && claim.meta?.effective_amount) {
        totalStaked = parseFloat(claim.meta.effective_amount);
      }
      const fee = claim.value?.fee || claim.value?.stream?.fee || null;
      const isLocked = !!(fee && fee.amount && parseFloat(fee.amount) > 0);
      const feeStr = isLocked ? `${parseFloat(fee.amount).toFixed(3)} LBC` : '';

      let html = '';
      if (totalStaked > 0) {
        const formatted = totalStaked.toLocaleString(undefined, { maximumFractionDigits: 2 });
        html += `<div>Total staked: ${formatted} LBC</div>`;
      }
      if (isLocked) {
        html += `<div style="color:#f59e0b;">🔒 Paywall: ${feeStr} to unlock</div>`;
      }
      stakeEl.innerHTML = html;
    }

    let playable = getPlayableUrl(claim)

    if (!playable && daemonConnected) {
      try {
        const streamResp: any = await new Promise(r => chrome.runtime.sendMessage({ type: 'streamGet', uri }, r))
        if (streamResp?.ok) {
          const g = streamResp.result
          playable = g?.streaming_url || g?.file?.streaming_url || g?.value?.streaming_url || g?.stream?.streaming_url
        }
      } catch (_) {}
    }

    if (playable) {
      playVideo(playable)
      addToHistory(uri, title, claim)
    } else {
      const isDirectLaunch = !!new URLSearchParams(location.search).get('uri')
      const msg = isDirectLaunch 
        ? 'This lbry:// link was opened via the ReviveL Companion.<br><br>Start the Companion to stream this content.'
        : 'No direct playable stream found.<br>Connect the ReviveL Companion for full streams.'
      showNoStream(msg)
    }

    await loadMoreToWatch(uri)
  } catch (err: any) {
    metaEl.innerHTML = `<div style="color:#f87171;">Error: ${err.message || err}</div>`
  }
}

function playVideo(src: string) {
  currentStreamUrl = src
  const overlay = document.getElementById('video-overlay')!
  overlay.classList.add('hidden')
  overlay.classList.remove('flex')
  videoEl.style.display = 'block'
  videoEl.src = src
  videoEl.load()
  const p = videoEl.play()
  if (p) p.catch(() => {})
}

function showNoStream(msg: string) {
  const overlay = document.getElementById('video-overlay')!
  overlay.innerHTML = `<div class="text-center px-4">${msg}</div>`
  overlay.classList.remove('hidden')
  overlay.classList.add('flex')
  videoEl.style.display = 'none'
}

// ===== More to Watch — 15 small grid cards =====
async function loadMoreToWatch(excludeUri: string) {
  const grid = document.getElementById('more-grid')!
  grid.innerHTML = `<div class="col-span-full text-xs text-[#64748b]">Loading 15 suggestions…</div>`

  try {
    const [supported, recent] = await Promise.all([
      searchLbryClaims({ claim_type: 'stream', order_by: ['effective_amount'], page_size: 10 }),
      searchLbryClaims({ claim_type: 'stream', order_by: ['release_time'], page_size: 30 })
    ])

    let all = [...(supported.items || []), ...(recent.items || [])]
    const seen = new Set<string>()
    all = all.filter((c: any) => {
      const u = c.canonical_url || `lbry://${c.name}`
      if (u === excludeUri || seen.has(u)) return false
      seen.add(u)
      return true
    })

    // Re-sort the mixed pool by reliable timestamp (getClaimTimestamp).
    // This drops stale items that had bogus high value.release_time (which made the server
    // rank them in the release_time results) and ensures recent content bubbles to the top of More to Watch.
    all = all
      .map((c: any) => ({ c, ts: getClaimTimestamp(c) }))
      // Looser cutoff for suggestions (More to Watch can include older good content)
      .filter((x: any) => x.ts > 1609459200)
      .sort((x: any, y: any) => y.ts - x.ts)
      .slice(0, 15)
      .map((x: any) => x.c)

    grid.innerHTML = ''
    all.forEach((claim: any) => {
      const value = claim.value || {}
      const thumb = value.thumbnail?.url || 'https://picsum.photos/id/1015/160/90'
      const title = value.title || claim.name || 'Untitled'
      const channel = claim.signing_channel?.name || '@unknown'
      const u = claim.canonical_url || `lbry://${claim.name}`
      const timestamp = getClaimTimestamp(claim);
      const uploaded = formatUploadTime(timestamp);

      // Paywall
      const fee = value.fee || value.stream?.fee || null;
      const isLocked = !!(fee && fee.amount && parseFloat(fee.amount) > 0);
      const feeStr = isLocked ? `${parseFloat(fee.amount).toFixed(3)} LBC` : '';

      const metaLine = isLocked 
        ? `🔒 ${feeStr}` 
        : `${channel}${uploaded ? ` • ${uploaded}` : ''}`;

      const card = document.createElement('div')
      card.className = 'small-card'
      card.innerHTML = `
        <img src="${thumb}" alt="">
        <div class="meta">
          <div class="title">${title}</div>
          <div class="channel">${metaLine}</div>
        </div>
      `
      card.onclick = () => { showView('player'); loadVideo(u) }
      grid.appendChild(card)
    })
  } catch {
    grid.innerHTML = `<div class="col-span-full text-xs text-[#64748b]">Could not load suggestions.</div>`
  }
}

// ===== Feed & Latest =====
async function loadFeed() {
  const grid = document.getElementById('feed-grid')!
  grid.innerHTML = `<div class="col-span-full text-xs text-[#64748b]">Loading feed…</div>`

  try {
    // Feed = claims with the highest LBC support (effective_amount = base claim + deposited supports)
    // We fetch with effective_amount and explicitly sort client-side descending to guarantee
    // the highest-supported streams appear first (order_by direction can vary by backend).
    const res = await searchLbryClaims({ claim_type: 'stream', order_by: ['effective_amount'], page_size: 25 })
    let items = res.items || []
    items.sort((a: any, b: any) => {
      const ba = (b.meta?.effective_amount || 0)
      const aa = (a.meta?.effective_amount || 0)
      return ba - aa
    })
    feedItems = items.slice(0, 20)
    renderClaimGrid(feedItems, grid)
  } catch {
    grid.innerHTML = `<div class="text-xs text-[#64748b]">Failed to load.</div>`
  }
}

async function loadLatest() {
  const grid = document.getElementById('latest-grid')!
  grid.innerHTML = `<div class="col-span-full text-xs text-[#64748b]">Loading latest…</div>`

  latestItems = []  // clear any previous to avoid stale data from prior sessions/configs

  try {
    // Use order_by release_time to get a recency-biased candidate set (this is the variant
    // the public proxy responds to with recent items on top). We then heavily post-process
    // with getClaimTimestamp (meta.creation_timestamp preferred + sanitization) to remove
    // any claims that have bogus value.release_time (the cause of old "It's time" etc. videos
    // appearing in Latest). Works the same whether on Companion daemon or public proxy.
    const res = await searchLbryClaims({ claim_type: 'stream', order_by: ['release_time'], page_size: 50 })
    let candidates = (res.items || [])

    // Post-process with reliable timestamp (prefers meta.creation_timestamp, sanitizes bad release_time).
    // This is the main fix for intermittent stale 2023-era videos (e.g. "It's time" with bogus value.release_time)
    // appearing in Latest. We use a strict recent window for the dedicated Latest tab.
    const nowSec = Math.floor(Date.now() / 1000)
    const minLatestTs = nowSec - (86400 * 400) // ~13 months; keeps only truly recent for "Latest"
    candidates = candidates
      .map((c: any) => ({ c, ts: getClaimTimestamp(c) }))
      .filter((x: any) => x.ts > minLatestTs)
      .sort((x: any, y: any) => y.ts - x.ts)
      .slice(0, 20)
      .map((x: any) => x.c)

    latestItems = candidates
    renderClaimGrid(latestItems, grid)
  } catch {
    grid.innerHTML = `<div class="text-xs text-[#64748b]">Failed to load.</div>`
  }
}

function formatUploadTime(timestamp: number): string {
  if (!timestamp) return '';
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  const minute = 60;
  const hour = minute * 60;
  const day = hour * 24;
  const week = day * 7;

  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.floor(diff / minute)} min ago`;
  if (diff < day) return `${Math.floor(diff / hour)} hour${Math.floor(diff / hour) > 1 ? 's' : ''} ago`;
  if (diff < week * 4) {
    const weeks = Math.floor(diff / week);
    return `${weeks} week${weeks > 1 ? 's' : ''} ago`;
  }

  const date = new Date(timestamp * 1000);
  const dayNum = date.getDate();
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = monthNames[date.getMonth()];
  const year = date.getFullYear();
  return `${dayNum} ${month} ${year}`;
}

function renderClaimGrid(items: any[], container: HTMLElement) {
  container.innerHTML = ''
  items.forEach((claim: any) => {
    const value = claim.value || {}
    const thumb = value.thumbnail?.url || 'https://picsum.photos/id/1015/160/90'
    const title = value.title || claim.name || 'Untitled'
    const channel = claim.signing_channel?.name || '@unknown'
    const u = claim.canonical_url || `lbry://${claim.name}`
    const timestamp = getClaimTimestamp(claim);
    const uploaded = formatUploadTime(timestamp);

    // Paywall
    const fee = value.fee || value.stream?.fee || null;
    const isLocked = !!(fee && fee.amount && parseFloat(fee.amount) > 0);
    const feeStr = isLocked ? `${parseFloat(fee.amount).toFixed(3)} LBC` : '';

    const metaLine = isLocked 
      ? `🔒 ${feeStr}` 
      : `${channel}${uploaded ? ` • ${uploaded}` : ''}`;

    // Total staked for this claim (for Feed etc.)
    const cAmt = parseFloat(claim.amount || 0);
    const sAmt = parseFloat(claim.meta?.support_amount || 0);
    let staked = cAmt + sAmt;
    if (!staked && claim.meta?.effective_amount) staked = parseFloat(claim.meta.effective_amount);
    const stakedLine = staked > 0.01 
      ? `<div class="text-[10px] text-emerald-400 mt-0.5">${staked.toLocaleString(undefined, {maximumFractionDigits: 0})} LBC staked</div>` 
      : '';

    const card = document.createElement('div')
    card.className = 'claim-card'
    card.innerHTML = `
      <img src="${thumb}">
      <div class="p-3">
        <div class="text-sm font-semibold leading-tight line-clamp-2">${title}</div>
        <div class="text-xs text-[#64748b] mt-1">${metaLine}</div>
        ${stakedLine}
      </div>
    `
    card.onclick = () => { showView('player'); loadVideo(u) }
    container.appendChild(card)
  })
}

// ===== Search =====
function setupSearch() {
  const input = document.getElementById('search-input') as HTMLInputElement
  const global = document.getElementById('global-search') as HTMLInputElement
  const grid = document.getElementById('search-grid')!
  const statusEl = document.getElementById('search-status')!

  let t: any
  const run = async (q: string) => {
    if (!q || q.length < 2) { grid.innerHTML = ''; statusEl.textContent = 'Enter 2+ characters'; return }
    statusEl.textContent = 'Searching…'
    grid.innerHTML = ''
    try {
      const res = await searchLbryClaims({ text: q, claim_type: 'stream', page_size: 18 })
      const items = res.items || []
      statusEl.textContent = `${items.length} results`
      renderClaimGrid(items, grid)
    } catch { statusEl.textContent = 'Search error' }
  }

  input.oninput = () => { clearTimeout(t); t = setTimeout(() => run(input.value.trim()), 280) }

  global.onkeydown = (e) => {
    if (e.key === 'Enter') {
      const v = global.value.trim()
      if (v.startsWith('lbry://')) { showView('player'); loadVideo(v); global.value = ''; return }
      showView('search')
      input.value = v
      setTimeout(() => run(v), 40)
      global.value = ''
    }
  }
}

// ===== Library =====
async function loadVault() {
  const d = await chrome.storage.local.get('revivel_vault')
  vault = (d.revivel_vault as any[]) || []
}
async function saveVault() { await chrome.storage.local.set({ revivel_vault: vault }) }

async function loadHistory() {
  const d = await chrome.storage.local.get('revivel_history')
  history = (d.revivel_history as any[]) || []
}
async function addToHistory(uri: string, title: string, claim?: any) {
  await loadHistory()
  history = history.filter((h: any) => h.uri !== uri)
  history.unshift({ uri, title, time: Date.now(), channel: claim?.signing_channel?.name })
  history = history.slice(0, 30)
  await chrome.storage.local.set({ revivel_history: history })
}

function renderLibrary() {
  const vEl = document.getElementById('library-vault')!
  const hEl = document.getElementById('library-history')!

  vEl.innerHTML = vault.length ? '' : `<div class="text-xs text-[#64748b]">No saved items. Use the bookmark button.</div>`
  vault.forEach((it: any) => {
    const d = document.createElement('div')
    d.className = 'p-2 bg-[#111114] border border-[#27272a] rounded-xl flex justify-between text-sm cursor-pointer'
    d.innerHTML = `<div class="truncate">${it.title}</div><button class="text-xs bg-[#14b8a6] px-2 rounded">▶</button>`
    d.onclick = () => { showView('player'); loadVideo(it.uri) }
    vEl.appendChild(d)
  })

  hEl.innerHTML = history.length ? '' : `<div class="text-xs text-[#64748b]">No recent plays.</div>`
  history.slice(0, 10).forEach((it: any) => {
    const d = document.createElement('div')
    d.className = 'p-2 bg-[#111114] border border-[#27272a] rounded-xl flex justify-between text-sm cursor-pointer'
    d.innerHTML = `<div><div class="truncate">${it.title}</div><div class="text-[10px] text-[#64748b]">${new Date(it.time).toLocaleDateString()}</div></div><button class="text-xs bg-[#334155] px-2 rounded">▶</button>`
    d.onclick = () => { showView('player'); loadVideo(it.uri) }
    hEl.appendChild(d)
  })
}

async function loadLibrary() {
  await loadVault()
  await loadHistory()
  renderLibrary()
}

async function resetViewData() {
  // Clear in-memory caches for this player instance (eliminates any prior merge/stale lists)
  feedItems = [];
  latestItems = [];
  vault = [];
  history = [];

  // Clear persistent storage for vault and history (shared with popup)
  await chrome.storage.local.remove(['revivel_vault', 'revivel_history']);

  // Always force fresh fetches for dynamic lists so Latest/Feed grids are updated
  // even if you are currently on Player or Settings view. This ensures reset actually
  // purges stale latest from earlier extension builds/configs.
  await loadFeed();
  await loadLatest();

  if (currentView === 'library') {
    await loadLibrary();
  } else if (currentView === 'wallet') {
    renderWallet();
  }

  // Notify popup side indirectly via storage clear (next open will be fresh)
  alert('View data and caches have been reset (fresh Latest/Feed fetched).\n\nIf you still see old items, fully reload the extension at chrome://extensions then reload this page.');
}

function renderWallet() {
  const balanceEl = document.getElementById('wallet-balance')!
  const recvInput = document.getElementById('wallet-receive-addr') as HTMLInputElement
  const copyAddr = document.getElementById('wallet-copy-addr')!
  const genAddr = document.getElementById('wallet-gen-addr')!
  const lastRecv = document.getElementById('wallet-last-received')!
  const sendAddr = document.getElementById('wallet-send-addr') as HTMLInputElement
  const sendAmt = document.getElementById('wallet-send-amount') as HTMLInputElement
  const sendBtn = document.getElementById('wallet-send-btn')!
  const feeEl = document.getElementById('wallet-tx-fee')!
  const lastSent = document.getElementById('wallet-last-sent')!
  const histEl = document.getElementById('wallet-history')!

  // Balance
  getWalletBalance().then((bal: any) => {
    balanceEl.textContent = `${bal.available || bal.total || '0'} LBC`
  }).catch(() => { balanceEl.textContent = '—' })

  // Receive
  async function loadRecv() {
    try {
      const addr = await getReceiveAddress()
      const addrStr = typeof addr === 'string' ? addr : (addr?.address || '')
      if (recvInput) recvInput.value = addrStr
    } catch { if (recvInput) recvInput.value = '—' }
  }
  loadRecv()

  if (copyAddr) copyAddr.addEventListener('click', () => {
    if (recvInput?.value) navigator.clipboard.writeText(recvInput.value)
  })
  if (genAddr) genAddr.addEventListener('click', loadRecv)

  // Send
  feeEl.textContent = '0.0001 LBC (est)'
  if (sendBtn) sendBtn.addEventListener('click', async () => {
    if (!sendAddr.value || !sendAmt.value) return
    try {
      await sendLBC(sendAddr.value, sendAmt.value)
      alert('Transaction submitted!')
      loadWalletData()
    } catch (e: any) { alert('Send failed: ' + (e.message || e)) }
  })

  // History & last tx
  loadWalletData()
}

async function loadWalletData() {
  const lastRecv = document.getElementById('wallet-last-received')!
  const lastSent = document.getElementById('wallet-last-sent')!
  const histEl = document.getElementById('wallet-history')!

  try {
    const txs = await getTransactions()
    const items = txs.items || txs || []

    const received = items.filter((t: any) => (t.type === 'received' || t.received)).slice(0, 3)
    lastRecv.innerHTML = received.length ? received.map((t:any) => `${t.amount} LBC @ ${t.txid?.slice(0,8)}`).join('<br>') : 'None'

    const sent = items.filter((t: any) => (t.type === 'spend' || t.sent)).slice(0, 3)
    lastSent.innerHTML = sent.length ? sent.map((t:any) => `${t.amount} LBC @ ${t.txid?.slice(0,8)}`).join('<br>') : 'None'

    const list = items.slice(0,10).map((t:any) => `${t.txid?.slice(0,10)}... ${t.amount || '?'} LBC`).join('<br>')
    histEl.innerHTML = list || 'No transactions yet'
  } catch (e) {
    lastRecv.textContent = lastSent.textContent = '—'
    histEl.textContent = 'Failed to load history (SPV wallet required)'
  }
}

// ===== Actions + Popout =====
function setupPlayerActions() {
  document.getElementById('copy-btn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(currentUri)
    const b = document.getElementById('copy-btn')!; const o = b.innerHTML; b.innerHTML = '✓'; setTimeout(() => b.innerHTML = o, 1200)
  })

  document.getElementById('copy-odysee-btn')?.addEventListener('click', () => {
    const raw = currentClaim?.canonical_url || currentUri
    const link = typeof raw === 'string' ? raw.replace('lbry://', 'https://odysee.com/') : currentUri
    navigator.clipboard.writeText(link)
    const b = document.getElementById('copy-odysee-btn')!; const o = b.innerHTML; b.innerHTML = '✓'; setTimeout(() => b.innerHTML = o, 1200)
  })

  document.getElementById('bookmark-btn')?.addEventListener('click', async () => {
    await loadVault()
    if (!vault.find((v: any) => v.uri === currentUri)) {
      vault.unshift({ uri: currentUri, title: currentClaim?.title || currentUri })
      await saveVault()
    }
    const b = document.getElementById('bookmark-btn')!; const o = b.innerHTML; b.innerHTML = '✓ Saved'; setTimeout(() => b.innerHTML = o, 1200)
  })

  document.getElementById('support-btn')?.addEventListener('click', () => alert('Support/tips requires wallet in Companion (coming soon).'))
  document.getElementById('popout-btn')?.addEventListener('click', () => {
    if (videoEl) {
      videoEl.pause()
    }
    const currentTime = videoEl ? videoEl.currentTime : 0
    chrome.runtime.sendMessage({ 
      type: 'detachFloating', 
      uri: currentUri, 
      title: currentClaim?.title || currentUri,
      streamUrl: currentStreamUrl,
      startTime: currentTime
    })
  })
  document.getElementById('download-btn')?.addEventListener('click', () => {
    if (currentStreamUrl) {
      const a = document.createElement('a')
      a.href = currentStreamUrl
      a.download = (currentClaim?.title || 'lbry-video').replace(/[^a-z0-9]/gi, '_') + '.mp4'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } else {
      alert('No stream URL available for download.')
    }
  })
  document.getElementById('refresh-more')?.addEventListener('click', () => loadMoreToWatch(currentUri))
  document.getElementById('get-companion-btn')?.addEventListener('click', () => window.open('https://github.com/yourorg/revivel-companion', '_blank'))
}

// ===== Settings View (dedicated page) =====
function renderSettings() {
  const statusBox = document.getElementById('settings-status')!
  const daemonInput = document.getElementById('settings-daemon-input') as HTMLInputElement

  // Load current value
  chrome.storage.sync.get(['daemonUrl'], (r: any) => {
    if (r.daemonUrl) daemonInput.value = r.daemonUrl
  })

  updateSettingsStatus(statusBox)

  // Wire buttons (idempotent)
  const refreshBtn = document.getElementById('settings-refresh-btn')!
  const detectBtn = document.getElementById('settings-detect-btn')!
  const saveBtn = document.getElementById('settings-save-btn')!

  refreshBtn.onclick = () => updateSettingsStatus(statusBox)

  saveBtn.onclick = async () => {
    await setDaemonUrl(daemonInput.value.trim() || null)
    await updateStatus()
    updateSettingsStatus(statusBox)
  }

  detectBtn.onclick = async () => {
    const orig = detectBtn.textContent
    detectBtn.textContent = 'Detecting…'
    const s: any = await getDaemonStatus()
    if (s?.endpoint) {
      daemonInput.value = s.endpoint
      await setDaemonUrl(s.endpoint)
    }
    detectBtn.textContent = orig || 'Re-Detect Companion'
    await updateStatus()
    updateSettingsStatus(statusBox)
  }

  // Wallet config buttons
  const createBtn = document.getElementById('wallet-create-btn')!
  const closeBtn = document.getElementById('wallet-close-btn')!
  const deleteBtn = document.getElementById('wallet-delete-btn')!
  const seedDisplay = document.getElementById('wallet-seed-display')!
  const confirmDelete = document.getElementById('wallet-delete-confirm')!

  createBtn.onclick = async () => {
    try {
      const res = await createWallet()
      // Per INTEGRATION.md: wallet_create does NOT return the seed. Call wallet_seed after.
      try {
        const seedRes = await getWalletSeed()
        seedDisplay.textContent = (seedRes && seedRes.seed) ? seedRes.seed : 'Wallet created (seed not auto-returned; use getWalletSeed or Companion)'
        seedDisplay.classList.remove('hidden')
      } catch (seedErr) {
        seedDisplay.textContent = 'Wallet created. Fetch seed via wallet_seed or check Companion.'
        seedDisplay.classList.remove('hidden')
      }
    } catch(e: any) { alert('Create failed: ' + e.message) }
  }

  closeBtn.onclick = async () => {
    try {
      await closeWallet()
      alert('Wallet closed.')
    } catch(e: any) { alert('Close failed: ' + e.message) }
  }

  let deleteConfirmed = false
  deleteBtn.onclick = async () => {
    if (!deleteConfirmed) {
      confirmDelete.classList.remove('hidden')
      deleteConfirmed = true
      return
    }
    try {
      await deleteWallet()
      alert('Wallet deleted.')
      confirmDelete.classList.add('hidden')
      deleteConfirmed = false
    } catch(e: any) { alert('Delete failed: ' + e.message) }
  }

  // Reset view data / caches button
  const resetBtn = document.getElementById('reset-data-btn')!
  if (resetBtn) {
    resetBtn.onclick = async () => {
      if (!confirm('Reset all view data and caches? This will clear feeds, vault, and history. You may need to reload the tab.')) return;
      await resetViewData();
    }
  }
}

async function updateSettingsStatus(box: HTMLElement) {
  const s: any = await getDaemonStatus()
  if (s.connected) {
    box.innerHTML = `
      <div><span class="text-emerald-400 font-semibold">Connected</span></div>
      <div class="mt-1 text-xs">Endpoint: ${s.endpoint || '—'}</div>
      <div class="text-xs mt-0.5">Blocks: ${s.blocks || 0} (behind by ${s.blocksBehind || 0})</div>
    `
  } else {
    box.innerHTML = `
      <div><span class="text-amber-400 font-semibold">Public Proxy Only</span></div>
      <div class="text-xs mt-2 leading-relaxed">For full streams and publishing, start the ReviveL Companion and click "Re-Detect Companion".</div>
    `
  }
}

// ===== Boot =====
function setupNav() {
  document.querySelectorAll('.nav-tab').forEach(b => b.addEventListener('click', () => showView((b as HTMLElement).dataset.view!)))
  document.addEventListener('keydown', e => {
    if (e.key === '/' && (document.activeElement as HTMLElement)?.tagName !== 'INPUT') {
      e.preventDefault(); (document.getElementById('global-search') as HTMLInputElement).focus()
    }
  })
}

async function init() {
  setupNav()
  setupPlayerActions()
  setupSearch()
  await updateStatus()
  await loadVault()
  await loadHistory()

  // Explicit clear on every full page load (in case of any module-level retention or prior bundle)
  feedItems = []
  latestItems = []

  await loadVideo(currentUri)
  loadFeed(); loadLatest()
  showView('player')
}

init()
