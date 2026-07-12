// ReviveL Full Player — Complete redesign with menu bar + all popup functions + creative additions
import { 
  resolveLbryUri, extractClaim, getPlayableUrl, buildPublicStreamUrl, getOdyseeEmbedUrl, searchLbryClaims, 
  getDaemonStatus, setDaemonUrl,
  getWalletBalance, getReceiveAddress, sendLBC, getTransactions, createWallet, closeWallet, deleteWallet, getWalletSeed,
  getClaimTimestamp, getRandomSearchWords, dedupClaims, WORD_LIBRARY_LABELS, getLibraryWords, isFutureDatedClaim
} from '../utils/lbryApi.js'

const urlParams = new URLSearchParams(location.search)
let currentUri = urlParams.get('uri') || 'lbry://what'
let initialTitle = urlParams.get('title') || null
const openedWithSpecificVideo = !!urlParams.get('uri')
let currentClaim: any = null
let currentView: string = openedWithSpecificVideo ? 'player' : 'feed'
let feedItems: any[] = []
let latestItems: any[] = []
let searchItems: any[] = []
let vault: any[] = []
let history: any[] = []
let daemonConnected = false
let prevDaemonConnected = false

// Pagination + load-more state (Feed/Search always stake sorted; Latest only date sorted)
let feedPage = 1
let latestPage = 1
let searchPage = 1
let feedHasMore = true
let latestHasMore = true
let searchHasMore = true
let isLoadingMoreFeed = false
let isLoadingMoreLatest = false
let isLoadingMoreSearch = false
let currentFeedFilter: 'all' | 'month' | 'week' | 'random' = 'all'
let currentRandomTopN: 100 | 500 | 1000 | 5000 = 100
let randomFeedPool: any[] = []
let currentWordLibrary = 'general'
let historyLoaded: any[] = []

// View mode for list grids (applies to Feed, Latest, Search)
let listViewMode: 'list' | 'details' | 'small' | 'medium' | 'big' | 'huge' = 'medium'

// Whether to show NSFW/adult content in lists
let showNSFW = false

// Fetch IDs to discard results from stale/older concurrent fetches (prevents videos from old public fetches
// overwriting fresh Companion results or vice versa when mode switches).
let feedFetchId = 0
let latestFetchId = 0
let searchFetchId = 0

// Prefetch state for instant scroll experience (after first 20, background load next 20)
let feedPrefetchedItems: any[] = []
let feedPrefetchPage = 0
let isPrefetchingFeed = false

function randomSample<T>(arr: T[], k: number): T[] {
  const copy = [...arr]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, k)
}

// Listen for new blockchain blocks from background to refresh Latest
chrome.runtime.onMessage.addListener((msg: any) => {
  if (msg.type === 'newBlock') {
    console.log('[ReviveL] New block detected:', msg.height)
    // Refresh Latest top page (real-time new videos). Do not sort by stake ever.
    latestPage = 1
    latestHasMore = true
    loadLatest(true /* replace top */)
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

  if (view === 'player' && !currentClaim && !openedWithSpecificVideo) {
    // Lazily load the default demo video now that the user has switched to the Player tab.
    // We pass true for autoPlay because the tab is now visible.
    loadVideo('lbry://what', true)
  }

  if (view === 'feed') {
    feedPage = 1; feedHasMore = true; isLoadingMoreFeed = false; currentFeedFilter = 'all'; currentRandomTopN = 100; randomFeedPool = []
    feedPrefetchedItems = []
    feedPrefetchPage = 0
    loadFeed()
  }
  if (view === 'latest') {
    latestPage = 1; latestHasMore = true; isLoadingMoreLatest = false
    loadLatest(true)
  }
  if (view === 'search') {
    // keep searchItems; user types to (re)search
    // ensure words are shown on search sides (full load)
    renderFeedSideWords()
    wireFeedFilters()  // wire the search filters + lib btn if needed
  }
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
    const wasConnected = daemonConnected
    let useD = !!status?.connected;
    const usingD = (status as any)?.using === 'daemon' || (status as any)?.isCompanion;
    const ep = String((status as any)?.endpoint || '');
    if (usingD || /127\.0\.0\.1|localhost/.test(ep)) useD = true;
    try {
      const cfg: any = await chrome.storage.sync.get(['daemonUrl']);
      const du = String(cfg?.daemonUrl || '');
      if (du.includes('127.0.0.1') || du.includes('localhost')) useD = true;
    } catch (_) {}
    daemonConnected = useD;

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

    // If Companion was just activated while we had public lists, clear stale data
    // and refresh Feed/Latest with the daemon-backed results (e.g. highest support for Feed).
    if (daemonConnected && !wasConnected) {
      feedItems = []
      latestItems = []
      feedFetchId++
      latestFetchId++
      if (currentView === 'feed') {
        loadFeed()
      } else if (currentView === 'latest') {
        loadLatest()
      }
    }
    prevDaemonConnected = daemonConnected
  } catch (e) {
    dot.className = 'status-dot bg-red-400'
    text.textContent = 'Error'
  }
}

// ===== Core Video Playback (60% centered) =====
async function loadVideo(uri: string, autoPlay: boolean = true) {
  currentUri = uri

  // Always clear previous media synchronously. This prevents the old video/embed
  // from being visible when we switch into the Player tab from a list.
  clearPlayerMedia()

  // Give immediate visual feedback in the player area itself (before the async resolve finishes)
  const overlayForLoading = document.getElementById('video-overlay')!
  overlayForLoading.innerHTML = `<div class="text-center px-4 text-sm">Loading video…</div>`

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

    // In public mode, skip direct streaming attempts (they 401 or fail CORS).
    // Only use direct video if we have a local daemon (Companion mode).
    if (!playable && daemonConnected) {
      try {
        const streamResp: any = await new Promise(r => chrome.runtime.sendMessage({ type: 'streamGet', uri }, r))
        if (streamResp?.ok) {
          const g = streamResp.result
          playable = g?.streaming_url || 
                     g?.file?.streaming_url || 
                     g?.stream?.streaming_url || 
                     (g?.value && g.value.streaming_url) ||
                     g?.result?.streaming_url ||
                     null
        }
      } catch (_) {}
    }

    if (playable && daemonConnected) {
      currentStreamUrl = playable
      const overlay = document.getElementById('video-overlay')!
      overlay.classList.add('hidden')
      overlay.classList.remove('flex')
      videoEl.style.display = 'block'

      if (autoPlay) {
        const isLikelyHls = playable.includes('.m3u8') || playable.includes('/streams/') || playable.includes('odycdn.com');
        if (isLikelyHls && typeof (window as any).Hls === 'undefined') {
          const script = document.createElement('script');
          script.src = 'https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js';
          script.onload = () => {
            const hls = new (window as any).Hls({ enableWorker: false, lowLatencyMode: true });
            hls.loadSource(playable);
            hls.attachMedia(videoEl);
            hls.on((window as any).Hls.Events.MANIFEST_PARSED, () => {
              const p = videoEl.play(); if (p) p.catch(() => {});
            });
          };
          script.onerror = () => {
            videoEl.src = playable;
            videoEl.load();
            const p = videoEl.play(); if (p) p.catch(() => {});
          };
          document.head.appendChild(script);
        } else {
          const isHls = playable.includes('.m3u8') || playable.includes('/streams/') || playable.includes('odycdn.com');
          if (isHls && (window as any).Hls && (window as any).Hls.isSupported()) {
            const hls = new (window as any).Hls({ enableWorker: false, lowLatencyMode: true });
            hls.loadSource(playable);
            hls.attachMedia(videoEl);
            hls.on((window as any).Hls.Events.MANIFEST_PARSED, () => {
              const p = videoEl.play(); if (p) p.catch(() => {});
            });
          } else {
            videoEl.src = playable;
            videoEl.load();
            const p = videoEl.play(); if (p) p.catch(() => {});
          }
        }
        addToHistory(uri, title, claim)
      } else {
        // Load but do not auto-play (for default video when starting on Feed tab)
        videoEl.src = playable;
        videoEl.load();
        // leave paused; user can switch to Player tab and play manually
      }
    } else if (!daemonConnected) {
      if (autoPlay) {
        // Public mode: 100% use Odysee embed for reliable playback (bypasses all direct video issues)
        const embedUrl = getOdyseeEmbedUrl(claim)
        if (embedUrl) {
          showEmbed(embedUrl)
        } else {
          // fallback to constructing from uri if claim ids missing
          const clean = uri.replace('lbry://', '');
          const embedUrlFallback = `https://odysee.com/$/embed/${clean}`;
          showEmbed(embedUrlFallback);
        }
      } else {
        // Default load without ?uri= : populate meta but do not auto-embed/play
        const overlay = document.getElementById('video-overlay')!
        overlay.innerHTML = `<div class="text-center px-4">Default video loaded.<br>Switch to the Player tab to watch.</div>`
        overlay.classList.remove('hidden')
        overlay.classList.add('flex')
        videoEl.style.display = 'none'
      }
    } else {
      const isDirectLaunch = !!new URLSearchParams(location.search).get('uri')
      const msg = isDirectLaunch 
        ? 'This lbry:// link was opened via the ReviveL Companion.<br><br>Start the Companion for more reliable streams.'
        : 'No playable stream URL found.<br>Connect the ReviveL Companion for full playback support.'
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

  const isLikelyHls = src.includes('.m3u8') || src.includes('/streams/') || src.includes('odycdn.com');

  if (isLikelyHls && typeof (window as any).Hls === 'undefined') {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js';
    script.onload = () => initPlayerVideo(src);
    script.onerror = () => {
      videoEl.src = src;
      videoEl.load();
      const p = videoEl.play(); if (p) p.catch(() => {});
    };
    document.head.appendChild(script);
  } else {
    initPlayerVideo(src);
  }

  // Error recovery for public streams
  videoEl.onerror = () => {
    console.warn('Full player video error for', src);
    // Could add limited retry here if wanted, but for full player show the message
  };
}

function initPlayerVideo(src: string) {
  const isHls = src.includes('.m3u8') || src.includes('/streams/') || src.includes('odycdn.com');
  if (isHls && (window as any).Hls && (window as any).Hls.isSupported()) {
    const hls = new (window as any).Hls({ enableWorker: false, lowLatencyMode: true });
    hls.loadSource(src);
    hls.attachMedia(videoEl);
    hls.on((window as any).Hls.Events.MANIFEST_PARSED, () => {
      const p = videoEl.play(); if (p) p.catch(() => {});
    });
  } else {
    videoEl.src = src;
    videoEl.load();
    const p = videoEl.play(); if (p) p.catch(() => {});
  }
}

function showNoStream(msg: string) {
  const overlay = document.getElementById('video-overlay')!
  overlay.innerHTML = `<div class="text-center px-4">${msg}</div>`
  overlay.classList.remove('hidden')
  overlay.classList.add('flex')
  videoEl.style.display = 'none'
}

function showEmbed(embedUrl: string) {
  const overlay = document.getElementById('video-overlay')!
  overlay.innerHTML = ''
  overlay.classList.remove('hidden')
  overlay.classList.add('flex')
  videoEl.style.display = 'none'

  // Ensure the container has size even when video is hidden (absolute overlay depends on it)
  const relative = document.querySelector('.video-container .relative') as HTMLElement;
  if (relative) {
    relative.style.height = '60vh';
    relative.style.minHeight = '360px';
  }
  const vc = document.querySelector('.video-container') as HTMLElement;
  if (vc) {
    vc.style.minHeight = '360px';
  }

  const iframe = document.createElement('iframe')
  iframe.src = embedUrl
  iframe.style.cssText = 'width:100%; height:100%; border:0; background:#000;'
  iframe.allow = 'fullscreen; autoplay'
  iframe.setAttribute('allowfullscreen', 'true')
  overlay.style.background = 'black';
  overlay.appendChild(iframe)
}

// Immediately clear any previously playing video, HLS source, or embedded iframe.
// Call this before revealing the player view when switching to a *different* video
// so the user never sees the old content flash.
function clearPlayerMedia() {
  const video = document.getElementById('video-player') as HTMLVideoElement | null
  const overlay = document.getElementById('video-overlay') as HTMLElement | null

  if (video) {
    try { video.pause() } catch (_) {}
    video.removeAttribute('src')
    // Force the media element to drop its current resource
    try { video.load() } catch (_) {}
    video.style.display = 'none'
  }

  if (overlay) {
    overlay.innerHTML = ''
    overlay.style.background = ''
    overlay.classList.remove('hidden')
    overlay.classList.add('flex')
  }

  currentStreamUrl = null
}

// ===== More to Watch — mix of (random 16 from top ~300 staked via multi-page, 16 from word-matched, 16 from recent) =====
async function loadMoreToWatch(excludeUri: string) {
  const grid = document.getElementById('more-grid')!
  grid.innerHTML = `<div class="col-span-full text-xs text-[#64748b]">Loading mixed suggestions…</div>`

  try {
    // Determine if companion for appropriate filters (but More to Watch mixes regardless)
    let useCompanion = false
    try {
      const cfg: any = await chrome.storage.sync.get(['daemonUrl'])
      const du = String(cfg?.daemonUrl || '')
      if (du.includes('127.0.0.1') || du.includes('localhost')) useCompanion = true
    } catch (_) {}
    if (!useCompanion) {
      try {
        const st: any = await getDaemonStatus().catch(() => ({}))
        const ep = String((st as any)?.endpoint || '')
        if ((st as any)?.connected || (st as any)?.isCompanion || /127\.0\.0\.1|localhost/.test(ep)) useCompanion = true
      } catch (_) {}
    }

    const base = { claim_type: 'stream', stream_types: ['video'], has_source: true, page_size: 50 }
    const pubFilters = useCompanion ? {} : { fee_amount: '<=0', ...(showNSFW ? {} : { not_tags: ['mature', 'nsfw'] }) }

    const nowSec = Math.floor(Date.now() / 1000)
    const maxReleaseTime = nowSec + 86400 * 2

    // 1) Fetch a broad top-staked pool by accumulating multiple pages (to reach beyond the ~40 >100k videos
    // and get true variety from the top ~300 highest staked, including many below 100k).
    // Single large page_size may be capped by the public proxy; pagination gets the next in effective_amount order.
    let topStaked: any[] = []
    const seenStake = new Set<string>()
    for (let p = 1; p <= 6; p++) {  // up to ~300
      const pageParams: any = { ...base, ...pubFilters, order_by: ['effective_amount'], page: p, page_size: 50 }
      try {
        const stakeRes = await searchLbryClaims(pageParams)
        const pageItems = (stakeRes.items || [])
        for (const c of pageItems) {
          const u = c.canonical_url || `lbry://${c.name}`
          if (!seenStake.has(u)) {
            seenStake.add(u)
            topStaked.push(c)
          }
        }
        if (pageItems.length < 50) break
      } catch (_) {
        break
      }
    }

    // 2) Last ~100 by time (latest videos) - only non-future release_time so we get actual recent
    const timeParams: any = { ...base, ...pubFilters, order_by: ['release_time'], page_size: 100 }
    timeParams.release_time = `<=${maxReleaseTime}`
    const timeRes = await searchLbryClaims(timeParams)
    let lastVideos = (timeRes.items || []).slice(0, 100)

    // 3) Pick a random popular word and get top staked matching it
    const libWords = getLibraryWords(currentWordLibrary)
    const randomWord = libWords[Math.floor(Math.random() * libWords.length)] || 'news'
    const wordRes = await searchLbryClaims({ text: randomWord, ...base, ...pubFilters, order_by: ['effective_amount'], page_size: 30 })
    let wordStaked = (wordRes.items || []).slice(0, 30)

    // Client clean + timestamp sanitize + dedup across pools
    const seen = new Set<string>()
    const clean = (list: any[]) => list.filter((c: any) => {
      const u = c.canonical_url || `lbry://${c.name}`
      if (u === excludeUri || seen.has(u)) return false
      const tags = ((c.value || {}).tags || []).map((t: string) => (t || '').toLowerCase())
      if (!showNSFW && tags.some((t: string) => t === 'mature' || t === 'nsfw')) return false
      if (isFutureDatedClaim(c)) return false
      seen.add(u)
      return true
    })

    topStaked = clean(topStaked)
    lastVideos = clean(lastVideos)
    wordStaked = clean(wordStaked)

    // Ensure relevance for the random word category
    const lowerWord = randomWord.toLowerCase()
    wordStaked = wordStaked.filter((c: any) => {
      const t = (c.value?.title || '').toLowerCase()
      const d = (c.value?.description || '').toLowerCase()
      return t.includes(lowerWord) || d.includes(lowerWord)
    })

    // Ensure top staked and word sections are sorted by stake desc (in case cleaning or fetch order needs it)
    topStaked = topStaked.sort((a, b) => {
      const be = parseFloat(b.meta?.effective_amount || 0) + parseFloat(b.amount || 0)
      const ae = parseFloat(a.meta?.effective_amount || 0) + parseFloat(a.amount || 0)
      return be - ae
    })
    wordStaked = wordStaked.sort((a, b) => {
      const be = parseFloat(b.meta?.effective_amount || 0) + parseFloat(b.amount || 0)
      const ae = parseFloat(a.meta?.effective_amount || 0) + parseFloat(a.amount || 0)
      return be - ae
    })

    // For latest pool use date sort (never stake)
    lastVideos = lastVideos
      .map((c: any) => ({ c, ts: getClaimTimestamp(c) }))
      .sort((a: any, b: any) => b.ts - a.ts)
      .map(x => x.c)

    grid.innerHTML = ''
    grid.style.display = 'block'  // ensure categories stack as rows, not grid columns

    // Helper to render a categorized section
    function renderSection(title: string, claims: any[], n: number) {
      const toShow = claims.slice(0, n)
      const header = document.createElement('div')
      header.className = 'text-xs text-[#64748b] mb-1 mt-2 font-medium'
      header.textContent = `${title} (${toShow.length} videos)`
      grid.appendChild(header)

      const sub = document.createElement('div')
      sub.className = 'grid-more'
      toShow.forEach((claim: any) => {
        const value = claim.value || {}
        const thumb = value.thumbnail?.url || 'https://picsum.photos/id/1015/160/90'
        const title = value.title || claim.name || 'Untitled'
        const channel = claim.signing_channel?.name || '@unknown'
        const u = claim.canonical_url || `lbry://${claim.name}`
        const timestamp = getClaimTimestamp(claim)
        const uploaded = formatUploadTime(timestamp)
        const fee = value.fee || value.stream?.fee || null
        const isLocked = !!(fee && fee.amount && parseFloat(fee.amount) > 0)
        const feeStr = isLocked ? `${parseFloat(fee.amount).toFixed(3)} LBC` : ''
        const metaLine = isLocked ? `🔒 ${feeStr}` : `${channel}${uploaded ? ` • ${uploaded}` : ''}`

        const cAmt = parseFloat(claim.amount || 0)
        const sAmt = parseFloat(claim.meta?.support_amount || 0)
        let stk = cAmt + sAmt || parseFloat(claim.meta?.effective_amount || 0)
        const stkLine = stk > 0.01 
          ? `<div class="text-[9px] text-emerald-400 mt-0.5">${stk.toLocaleString(undefined, {maximumFractionDigits: 0})} LBC staked</div>` 
          : '';

        const card = document.createElement('div')
        card.className = 'small-card'
        card.innerHTML = `
          <img src="${thumb}" alt="">
          <div class="meta">
            <div class="title">${title}</div>
            <div class="channel">${metaLine}</div>
            ${stkLine}
          </div>
        `
        card.onclick = () => { initialTitle = title; clearPlayerMedia(); showView('player'); loadVideo(u) }
        sub.appendChild(card)
      })
      grid.appendChild(sub)
    }

    // For "From Top 300": randomly sample 16 from the (cleaned) accumulated top ~300 staked pool (via pagination).
    // This reaches lower-stake videos (below 100k) that a single capped page_size would miss.
    function randomSample(arr: any[], k: number): any[] {
      const copy = [...arr]
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[copy[i], copy[j]] = [copy[j], copy[i]]
      }
      return copy.slice(0, k)
    }
    const highStakedSample = topStaked.length > 16 ? randomSample(topStaked, 16) : topStaked

    renderSection('From Top 300', highStakedSample, 16)
    renderSection(`Related to "${randomWord}" (high support matches)`, wordStaked, 16)
    renderSection('Latest Uploads', lastVideos, 16)
  } catch (e) {
    console.warn('More to watch mix failed', e)
    grid.innerHTML = `<div class="col-span-full text-xs text-[#64748b]">Could not load suggestions.</div>`
  }
}

// ===== Feed (always highest LBC staked, supports page + load more on scroll + customize filters) =====
async function loadFeed(replace = true) {
  const grid = document.getElementById('feed-grid')!
  const statusEl = document.getElementById('feed-more-status')!
  if (replace) {
    grid.innerHTML = `<div class="col-span-full text-xs text-[#64748b]">Loading top staked…</div>`
    feedItems = []
    feedPage = 1
    feedHasMore = true
    randomFeedPool = []
    feedPrefetchedItems = []
    feedPrefetchPage = 0
    if (currentFeedFilter !== 'random') {
      randomFeedPool = []
    }
  }
  statusEl.textContent = ''

  const myId = ++feedFetchId
  try {
    let useCompanion = false
    try {
      const cfg: any = await chrome.storage.sync.get(['daemonUrl'])
      if (String(cfg?.daemonUrl || '').includes('127.0.0.1') || String(cfg?.daemonUrl || '').includes('localhost')) useCompanion = true
    } catch (_) {}
    if (!useCompanion) {
      try {
        const st: any = await getDaemonStatus().catch(() => ({}))
        const ep = String((st as any)?.endpoint || '')
        if (st?.connected || st?.isCompanion || /127\.0\.0\.1|localhost/.test(ep)) useCompanion = true
      } catch (_) {}
    }

    let items: any[] = []
    let lastFetchCount = 20
    const isRandom = currentFeedFilter === 'random'

    // Base params (used for random pagination and normal feed)
    const baseParams: any = {
      claim_type: 'stream',
      stream_types: ['video'],
      has_source: true,
      order_by: ['effective_amount'],
    }
    if (!useCompanion) {
      baseParams.fee_amount = '<=0'
      if (!showNSFW) {
        baseParams.not_tags = ['mature', 'nsfw']
      }
    }

    if (isRandom) {
      if (replace) {
        // For random replace: collect the full top currentRandomTopN staked items via BATCHED concurrent pagination.
        // Then shuffle the pool. "More" will consume from the remaining shuffled pool.
        const targetN = currentRandomTopN
        let collected: any[] = []
        const seenPool = new Set<string>()
        const cps = useCompanion ? 100 : 50
        const maxPages = Math.ceil(targetN / cps) + 10
        const batchSize = 5
        for (let startP = 1; startP <= maxPages; startP += batchSize) {
          const batchPromises: Promise<any>[] = []
          for (let i = 0; i < batchSize && (startP + i) <= maxPages; i++) {
            const p = startP + i
            const cpparams: any = { ...baseParams, page: p, page_size: cps }
            batchPromises.push(
              searchLbryClaims(cpparams).catch(() => ({ items: [] }))
            )
          }
          const results = await Promise.all(batchPromises)
          let addedInBatch = 0
          for (const cres of results) {
            let citems = (cres.items || [])
            if (!showNSFW) {
              citems = citems.filter((c: any) => {
                const tags = ((c.value || {}).tags || []).map((t: string) => (t || '').toLowerCase())
                return !tags.some(t => t === 'mature' || t === 'nsfw')
              })
            }
            citems = citems.sort((a: any, b: any) => {
              const be = parseFloat(b.meta?.effective_amount || 0) + parseFloat(b.amount || 0)
              const ae = parseFloat(a.meta?.effective_amount || 0) + parseFloat(a.amount || 0)
              return be - ae
            })
            for (const c of citems) {
              const u = c.canonical_url || `lbry://${c.name}`
              if (!seenPool.has(u)) {
                seenPool.add(u)
                collected.push(c)
                addedInBatch++
                if (collected.length >= targetN) break
              }
            }
            if (collected.length >= targetN) break
          }
          lastFetchCount = addedInBatch
          if (addedInBatch < 10) break
          if (collected.length >= targetN) break
        }
        // final sort
        collected.sort((a: any, b: any) => {
          const be = parseFloat(b.meta?.effective_amount || 0) + parseFloat(b.amount || 0)
          const ae = parseFloat(a.meta?.effective_amount || 0) + parseFloat(a.amount || 0)
          return be - ae
        })
        let pool = collected.slice(0, targetN)
        randomFeedPool = randomSample(pool, pool.length)  // full shuffle for random order
        items = randomFeedPool.splice(0, 20)
      } else {
        // append: take next chunk from the pre-shuffled remaining pool
        items = randomFeedPool.splice(0, 20)
        lastFetchCount = items.length
      }
    } else {
      // Normal (non-random) path: fetch current page from server
      const params: any = {
        ...baseParams,
        page: feedPage,
        page_size: 20,
      }

      const res = await searchLbryClaims(params)
      items = (res.items || [])
      if (!showNSFW) {
        items = items.filter((c: any) => {
          const tags = ((c.value || {}).tags || []).map((t: string) => (t || '').toLowerCase())
          return !tags.some(t => t === 'mature' || t === 'nsfw')
        })
      }
      items = items.sort((a: any, b: any) => {
        const be = parseFloat(b.meta?.effective_amount || 0) + parseFloat(b.amount || 0)
        const ae = parseFloat(a.meta?.effective_amount || 0) + parseFloat(a.amount || 0)
        return be - ae
      })
      lastFetchCount = (res.items || []).length
    }

    // Apply time-based customize filter (only for non-random; random already drew from the pool)
    if (!isRandom) {
      const now = Math.floor(Date.now() / 1000)
      const day = 86400
      items = items.filter((c: any) => {
        const ts = getClaimTimestamp(c)
        const stk = parseFloat(c.meta?.effective_amount || 0) + parseFloat(c.amount || 0)
        if (currentFeedFilter === 'month') return ts > now - (30 * day)
        if (currentFeedFilter === 'week') return ts > now - (7 * day)
        return true
      })
    }

    if (myId !== feedFetchId) return

    if (replace) {
      if (isRandom) {
        feedItems = items
      } else {
        feedItems = items.slice(0, 20)
      }
    } else {
      if (isRandom) {
        feedItems = feedItems.concat(items)
      } else {
        feedItems = dedupClaims(feedItems, items)
      }
    }

    // Re-sort only for non-random (random keeps the shuffled order)
    if (!isRandom) {
      feedItems = feedItems.sort((a, b) => (b.staked || 0) - (a.staked || 0))
    }

    // Render
    renderClaimGrid(feedItems, grid)

    // Update hasMore and status
    if (isRandom) {
      feedHasMore = randomFeedPool.length > 0
      const endMsg = feedHasMore ? `Scroll for more random from top ${currentRandomTopN}` : `End of random sample from top ${currentRandomTopN}`
      statusEl.textContent = feedHasMore ? `Scroll for more random from top ${currentRandomTopN}` : endMsg
    } else {
      feedHasMore = lastFetchCount >= 20
      statusEl.textContent = feedHasMore ? 'Scroll for more staked claims…' : 'End of feed results.'
    }

    // Wire customize buttons (once)
    wireFeedFilters()
    updateWordLibraryButton()
    // Render side random words (left + right) - 60 words, current library, sticky
    renderFeedSideWords()

    // Prefetch only for non-random
    if (replace && feedPage === 1 && !isPrefetchingFeed && !isRandom) {
      prefetchNextFeedItems()
    }
  } catch (e) {
    if (myId === feedFetchId) {
      grid.innerHTML = `<div class="text-xs text-[#64748b]">Failed to load Feed.</div>`
    }
  }
}

function wireFeedFilters() {
  // Wire feed customize
  wireFilterContainer('feed-customize', () => loadFeed(true))

  // Wire search customize (same filters, re-run search if query present)
  wireFilterContainer('search-customize', () => {
    const inp = document.getElementById('search-input') as HTMLInputElement | null
    const q = (inp && inp.value.trim()) || ''
    if (q.length >= 2) {
      // re-trigger search (uses currentFeedFilter in search logic? we can extend)
      const run = (window as any).__revivelRunSearch
      if (run) run(q, true)
    } else {
      // if no query, perhaps do nothing or load initial
    }
  })

  // Wire random dropdown options (hover dropdown on Random button)
  document.querySelectorAll('.random-option').forEach((opt: any) => {
    if (!opt._wired) {
      opt._wired = true
      opt.addEventListener('click', (e: Event) => {
        e.stopImmediatePropagation()
        const n = parseInt(opt.dataset.n || '100', 10) as any
        currentRandomTopN = n
        currentFeedFilter = 'random'
        // trigger reload for current view
        if (currentView === 'feed') {
          loadFeed(true)
        } else if (currentView === 'search') {
          const inp = document.getElementById('search-input') as HTMLInputElement | null
          const q = (inp && inp.value.trim()) || ''
          if (q.length >= 2) {
            const run = (window as any).__revivelRunSearch
            if (run) run(q, true)
          }
        }
        // optionally hide dropdown by moving mouse, but hover will handle
      })
    }
    // always update active
    const n = parseInt(opt.dataset.n || '0', 10)
    opt.classList.toggle('active', currentFeedFilter === 'random' && n === currentRandomTopN)
  })
}

function wireFilterContainer(containerId: string, onFilter: () => void) {
  const container = document.getElementById(containerId)
  if (!container) return
  container.querySelectorAll('.feed-filter-btn').forEach((btn: any) => {
    btn.classList.toggle('active', btn.dataset.filter === currentFeedFilter)
    if ((btn as any)._wired) return
    ;(btn as any)._wired = true
    btn.addEventListener('click', () => {
      const f = (btn.dataset.filter || 'all') as 'all' | 'month' | 'week' | 'random'
      if (f === currentFeedFilter) return
      if (f !== 'random') {
        randomFeedPool = []
      }
      currentFeedFilter = f
      onFilter()
    })
  })
}

function renderFeedSideWords() {
  // Render full 60 words at once to feed sides
  renderWordsToContainers('feed-left-words', 'feed-right-words')

  // Also render to search sides if present
  renderWordsToContainers('search-left-words', 'search-right-words')
}

function renderWordsToContainers(leftId: string, rightId: string) {
  const left = document.getElementById(leftId)
  const right = document.getElementById(rightId)
  if (!left && !right) return

  const wordsL = getRandomSearchWords(60, currentWordLibrary)
  const wordsR = getRandomSearchWords(60, currentWordLibrary)

  const make = (w: string) => {
    const s = document.createElement('span')
    s.className = 'feed-word'
    s.textContent = w
    s.onclick = () => {
      showView('search')
      setTimeout(() => {
        const inp = document.getElementById('search-input') as HTMLInputElement | null
        const g = document.getElementById('global-search') as HTMLInputElement | null
        if (inp) { inp.value = w; inp.dispatchEvent(new Event('input', { bubbles: true })) }
        if (g) g.value = ''
      }, 30)
    }
    return s
  }

  if (left) {
    left.innerHTML = ''
    wordsL.forEach(w => left.appendChild(make(w)))
  }
  if (right) {
    right.innerHTML = ''
    wordsR.forEach(w => right.appendChild(make(w)))
  }
}

function updateWordLibraryButton() {
  const label = WORD_LIBRARY_LABELS[currentWordLibrary] || 'General'
  const text = `📚 Word Library: ${label}`
  const btn1 = document.getElementById('word-library-btn') as HTMLButtonElement | null
  if (btn1) btn1.textContent = text
  const btn2 = document.getElementById('search-word-library-btn') as HTMLButtonElement | null
  if (btn2) btn2.textContent = text
}

function showWordLibrarySelector() {
  // Remove any existing selector
  document.querySelectorAll('.word-lib-selector').forEach(el => el.remove())

  const container = document.createElement('div')
  container.className = 'word-lib-selector'
  container.style.cssText = `
    position:absolute; z-index:9999; background:#111114; border:1px solid #27272a; 
    border-radius:10px; padding:8px; font-size:11px; box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.4);
    max-width:240px; display:flex; flex-wrap:wrap; gap:4px;
  `

  const keys = Object.keys(WORD_LIBRARY_LABELS)

  keys.forEach(key => {
    const b = document.createElement('button')
    b.className = 'action-btn text-xs px-2 py-0.5'
    b.style.fontSize = '10px'
    b.textContent = WORD_LIBRARY_LABELS[key]
    if (key === currentWordLibrary) {
      b.style.background = '#14b8a6'
      b.style.borderColor = '#14b8a6'
      b.style.color = 'white'
    }
    b.onclick = () => {
      currentWordLibrary = key
      chrome.storage.local.set({ revivel_word_library: key })
      container.remove()
      updateWordLibraryButton()
      if (currentView === 'feed') {
        renderFeedSideWords()
      }
    }
    container.appendChild(b)
  })

  // Position near the button
  const btn = document.getElementById('word-library-btn')
  if (btn) {
    const rect = btn.getBoundingClientRect()
    container.style.top = (rect.bottom + window.scrollY + 4) + 'px'
    container.style.left = (rect.left + window.scrollX) + 'px'
  } else {
    container.style.top = '120px'
    container.style.left = '50%'
    container.style.transform = 'translateX(-50%)'
  }

  document.body.appendChild(container)

  // Click outside to close
  setTimeout(() => {
    document.addEventListener('click', function handler(ev) {
      if (!container.contains(ev.target as Node)) {
        container.remove()
        document.removeEventListener('click', handler)
      }
    }, { once: true })
  }, 10)
}

async function loadMoreFeed() {
  if (!feedHasMore || isLoadingMoreFeed || currentView !== 'feed') return

  // If we have prefetched the next page, use it immediately for instant scroll (skip for random)
  if (feedPrefetchedItems.length > 0 && feedPrefetchPage === feedPage + 1 && currentFeedFilter !== 'random') {
    isLoadingMoreFeed = true
    const statusEl = document.getElementById('feed-more-status')!
    feedItems = dedupClaims(feedItems, feedPrefetchedItems)
    // Always re-sort by staked desc to guarantee Feed is 100% sorted by LBC staked
    feedItems = feedItems.sort((a, b) => (b.staked || 0) - (a.staked || 0));
    renderClaimGrid(feedItems, document.getElementById('feed-grid')!)
    feedPage = feedPrefetchPage
    feedPrefetchedItems = []
    feedPrefetchPage = 0
    statusEl.textContent = feedHasMore ? 'Scroll for more staked claims…' : 'End of feed results.'
    isLoadingMoreFeed = false
    // Background load the next 20
    prefetchNextFeedItems()
    return
  }

  isLoadingMoreFeed = true
  const statusEl = document.getElementById('feed-more-status')!
  statusEl.textContent = 'Loading more…'

  if (currentFeedFilter === 'random') {
    const more = randomFeedPool.splice(0, 20)
    if (more.length > 0) {
      feedItems = feedItems.concat(more)
      renderClaimGrid(feedItems, document.getElementById('feed-grid')!)
    }
    feedHasMore = randomFeedPool.length > 0
    const endMsg = feedHasMore ? `Scroll for more random from top ${currentRandomTopN}` : `End of random sample from top ${currentRandomTopN}`
    statusEl.textContent = endMsg
    isLoadingMoreFeed = false
    return
  }

  feedPage += 1
  try {
    await loadFeed(false /* append */)
    // After using, background prefetch next
    prefetchNextFeedItems()
  } finally {
    isLoadingMoreFeed = false
  }
}

async function prefetchNextFeedItems() {
  if (isPrefetchingFeed || !feedHasMore || feedPrefetchedItems.length > 0 || currentFeedFilter === 'random') return
  isPrefetchingFeed = true
  const nextPage = feedPage + 1
  try {
    // Minimal duplicate of load logic for prefetch (no render, no filters for simplicity, just raw next page)
    let useCompanion = false
    try {
      const cfg: any = await chrome.storage.sync.get(['daemonUrl'])
      if (String(cfg?.daemonUrl || '').includes('127.0.0.1') || String(cfg?.daemonUrl || '').includes('localhost')) useCompanion = true
    } catch (_) {}
    if (!useCompanion) {
      try {
        const st: any = await getDaemonStatus().catch(() => ({}))
        const ep = String((st as any)?.endpoint || '')
        if (st?.connected || st?.isCompanion || /127\.0\.0\.1|localhost/.test(ep)) useCompanion = true
      } catch (_) {}
    }

    const params: any = {
      claim_type: 'stream',
      stream_types: ['video'],
      has_source: true,
      page: nextPage,
      page_size: 20,
      order_by: ['effective_amount'],
    }
    if (!useCompanion) {
      params.fee_amount = '<=0'
      if (!showNSFW) {
        params.not_tags = ['mature', 'nsfw']
      }
    }

    const res = await searchLbryClaims(params)
    let items = (res.items || [])
    if (!showNSFW) {
      items = items.filter((c: any) => {
        const tags = ((c.value || {}).tags || []).map((t: string) => (t || '').toLowerCase())
        return !tags.some(t => t === 'mature' || t === 'nsfw')
      })
    }
    items = items.sort((a: any, b: any) => {
      const be = parseFloat(b.meta?.effective_amount || 0) + parseFloat(b.amount || 0)
      const ae = parseFloat(a.meta?.effective_amount || 0) + parseFloat(a.amount || 0)
      return be - ae
    })

    // Apply current customize filter also for prefetched (so filtered more appear correctly)
    const now = Math.floor(Date.now() / 1000)
    const day = 86400
    items = items.filter((c: any) => {
      const ts = getClaimTimestamp(c)
      const stk = parseFloat(c.meta?.effective_amount || 0) + parseFloat(c.amount || 0)
      if (currentFeedFilter === 'month') return ts > now - (30 * day)
      if (currentFeedFilter === 'week') return ts > now - (7 * day)
      return true
    })

    feedPrefetchedItems = items
    feedPrefetchPage = nextPage
    feedHasMore = (res.items || []).length >= 20
  } catch (e) {
    // silent prefetch fail ok
  } finally {
    isPrefetchingFeed = false
  }
}

// ===== Latest (NEVER stake sort; ONLY date sorted + real-time on newBlock + load more) =====
async function loadLatest(replace = true) {
  const grid = document.getElementById('latest-grid')!
  const statusEl = document.getElementById('feed-more-status')! // reuse for simplicity (or could add separate)
  if (replace) {
    grid.innerHTML = `<div class="col-span-full text-xs text-[#64748b]">Loading latest…</div>`
    latestItems = []
    latestPage = 1
    latestHasMore = true
  }

  const myId = ++latestFetchId
  try {
    let useCompanion = false
    try {
      const cfg: any = await chrome.storage.sync.get(['daemonUrl'])
      if (String(cfg?.daemonUrl || '').includes('127.0.0.1') || String(cfg?.daemonUrl || '').includes('localhost')) useCompanion = true
    } catch (_) {}
    if (!useCompanion) {
      try {
        const st: any = await getDaemonStatus().catch(() => ({}))
        const ep = String((st as any)?.endpoint || '')
        if (st?.connected || st?.isCompanion || /127\.0\.0\.1|localhost/.test(ep)) useCompanion = true
      } catch (_) {}
    }

    const params: any = {
      claim_type: 'stream',
      stream_types: ['video'],
      has_source: true,
      page: latestPage,
      page_size: 40,
      order_by: ['release_time'],   // time order from server
    }
    const nowSecForLatest = Math.floor(Date.now() / 1000)
    params.release_time = `<=${nowSecForLatest + 86400 * 2}`
    // Do not apply fee/not_tags for Latest to get more recent uploads (even in public mode)

    const res = await searchLbryClaims(params)
    let candidates = (res.items || [])
    if (!showNSFW) {
      candidates = candidates.filter((c: any) => {
        const tags = ((c.value || {}).tags || []).map((t: string) => (t || '').toLowerCase())
        return !tags.some(t => t === 'mature' || t === 'nsfw')
      })
    }
    // Filter out claims with future release_time (e.g. bogus year 8878 claims)
    candidates = candidates.filter((c: any) => !isFutureDatedClaim(c))

    // STRICT: only date sort. Never touch stake ordering for Latest.
    // Use reliable timestamp, drop obvious garbage AND future timestamps.
    const nowSec = Math.floor(Date.now() / 1000)
    candidates = candidates
      .map((c: any) => ({ c, ts: getClaimTimestamp(c) }))
      .filter((x: any) => x.ts > nowSec - 86400 * 90 && x.ts <= nowSec + 86400 * 2)
      .sort((x: any, y: any) => y.ts - x.ts)
      .map(x => x.c)

    if (myId !== latestFetchId) return

    if (replace) {
      latestItems = candidates.slice(0, 20)
    } else {
      latestItems = dedupClaims(latestItems, candidates)
    }

    renderClaimGrid(latestItems, grid)

    latestHasMore = (res.items || []).length >= 35
    // no dedicated status element in latest view; scroll hint is implicit
  } catch {
    if (myId === latestFetchId) {
      grid.innerHTML = `<div class="text-xs text-[#64748b]">Failed to load Latest.</div>`
    }
  }
}

async function loadMoreLatest() {
  if (!latestHasMore || isLoadingMoreLatest || currentView !== 'latest') return
  isLoadingMoreLatest = true
  latestPage += 1
  try {
    await loadLatest(false)
  } finally {
    isLoadingMoreLatest = false
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
  // Apply view mode class for CSS styling
  container.classList.remove('view-mode-list', 'view-mode-details', 'view-mode-small', 'view-mode-medium', 'view-mode-big', 'view-mode-huge')
  container.classList.add(`view-mode-${listViewMode}`)
  container.innerHTML = ''

  items.forEach((claim: any, idx: number) => {
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

    let imgHtml = ''
    const priority = idx < 2 ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"'

    if (listViewMode === 'list') {
      // Compact list row
      imgHtml = `<img src="${thumb}" ${priority} style="width:64px;height:36px;aspect-ratio:16/9;" class="flex-shrink-0 rounded">`
      card.innerHTML = `
        <div class="flex gap-2 p-2 items-center">
          ${imgHtml}
          <div class="min-w-0 flex-1">
            <div class="text-sm font-semibold leading-tight line-clamp-1">${title}</div>
            <div class="text-[10px] text-[#64748b] mt-0.5 truncate">${metaLine} ${stakedLine ? ' • ' + stakedLine.replace(/<[^>]+>/g,'') : ''}</div>
          </div>
        </div>
      `
    } else if (listViewMode === 'details') {
      // Details: smaller thumbnails + more detailed info
      imgHtml = `<img src="${thumb}" ${priority} style="width:120px;height:67.5px;aspect-ratio:16/9;" class="flex-shrink-0 rounded">`
      const desc = (value.description || '').slice(0, 200) + ((value.description || '').length > 200 ? '…' : '')
      card.innerHTML = `
        <div class="flex gap-3 p-3">
          ${imgHtml}
          <div class="min-w-0 flex-1">
            <div class="text-sm font-semibold leading-tight line-clamp-2">${title}</div>
            <div class="text-xs text-[#64748b] mt-1">${metaLine}</div>
            ${stakedLine}
            ${desc ? `<div class="text-[10px] text-[#64748b] mt-1.5 line-clamp-3">${desc}</div>` : ''}
          </div>
        </div>
      `
    } else {
      // Icon modes (small/medium/big/huge) use vertical card
      // Let CSS grid control size, force 16:9
      imgHtml = `<img src="${thumb}" ${priority} style="width:100%; height:auto; aspect-ratio:16/9;">`
      card.innerHTML = `
        ${imgHtml}
        <div class="p-3">
          <div class="text-sm font-semibold leading-tight line-clamp-2">${title}</div>
          <div class="text-xs text-[#64748b] mt-1">${metaLine}</div>
          ${stakedLine}
        </div>
      `
    }

    card.onclick = () => { initialTitle = title; clearPlayerMedia(); showView('player'); loadVideo(u) }
    container.appendChild(card)
  })
}

// ===== Search (ALWAYS sorted by LBC staked + top 20 + load more on scroll) =====
function setupSearch() {
  const input = document.getElementById('search-input') as HTMLInputElement
  const global = document.getElementById('global-search') as HTMLInputElement
  const grid = document.getElementById('search-grid')!
  const statusEl = document.getElementById('search-status')!

  let t: any
  const run = async (q: string, replace = true) => {
    if (!q || q.length < 2) {
      if (replace) { grid.innerHTML = ''; statusEl.textContent = 'Enter 2+ characters' }
      return
    }
    if (replace) {
      statusEl.textContent = 'Searching (by LBC staked)…'
      grid.innerHTML = ''
      searchItems = []
      searchPage = 1
      searchHasMore = true
    }
    const myId = ++searchFetchId
    try {
      // ALWAYS stake sorted for Search tab (per spec), public filters only if no daemon
      let useCompanion = false
      try {
        const cfg: any = await chrome.storage.sync.get(['daemonUrl'])
        if (String(cfg?.daemonUrl || '').includes('127.0.0.1') || String(cfg?.daemonUrl || '').includes('localhost')) useCompanion = true
      } catch (_) {}
      if (!useCompanion) {
        try {
          const st: any = await getDaemonStatus().catch(() => ({}))
          const ep = String((st as any)?.endpoint || '')
          if (st?.connected || st?.isCompanion || /127\.0\.0\.1|localhost/.test(ep)) useCompanion = true
        } catch (_) {}
      }

      const sparams: any = {
        text: q,
        claim_type: 'stream',
        stream_types: ['video'],
        has_source: true,
        page: searchPage,
        page_size: 30,
        order_by: ['effective_amount'],   // ALWAYS staked for Search
      }
      if (!useCompanion) {
        sparams.fee_amount = '<=0'
        if (!showNSFW) {
          sparams.not_tags = ['mature', 'nsfw']
        }
      }

      const res = await searchLbryClaims(sparams)
      let items = res.items || []
      if (!showNSFW) {
        items = items.filter((c: any) => {
          const tags = ((c.value || {}).tags || []).map((t: string) => (t || '').toLowerCase())
          return !tags.some(t => t === 'mature' || t === 'nsfw')
        })
      }

      // Ensure client sort by stake
      items = items.sort((a: any, b: any) => {
        const be = parseFloat(b.meta?.effective_amount || 0) + parseFloat(b.amount || 0)
        const ae = parseFloat(a.meta?.effective_amount || 0) + parseFloat(a.amount || 0)
        return be - ae
      })

      // Apply current feed filter also to search results (since filters are present on search tab)
      const now = Math.floor(Date.now() / 1000)
      const day = 86400
      items = items.filter((c: any) => {
        const ts = getClaimTimestamp(c)
        const stk = parseFloat(c.meta?.effective_amount || 0) + parseFloat(c.amount || 0)
        if (currentFeedFilter === 'month') return ts > now - (30 * day)
        if (currentFeedFilter === 'week') return ts > now - (7 * day)
        return true
      })

      if (myId !== searchFetchId) return

      if (replace) {
        searchItems = items.slice(0, 20)
      } else {
        searchItems = dedupClaims(searchItems, items)
      }

      statusEl.textContent = `${searchItems.length} results (staked order)`
      renderClaimGrid(searchItems, grid)

      searchHasMore = (res.items || []).length >= 25
    } catch {
      if (replace) statusEl.textContent = 'Search error'
    }
  }

  input.oninput = () => { clearTimeout(t); t = setTimeout(() => run(input.value.trim(), true), 280) }

  global.onkeydown = (e) => {
    if (e.key === 'Enter') {
      const v = global.value.trim()
      if (v.startsWith('lbry://')) { clearPlayerMedia(); showView('player'); loadVideo(v); global.value = ''; return }
      showView('search')
      input.value = v
      setTimeout(() => run(v, true), 40)
      global.value = ''
    }
  }

  // expose for external trigger
  ;(window as any).__revivelRunSearch = run
}

async function loadMoreSearch() {
  if (!searchHasMore || isLoadingMoreSearch || currentView !== 'search') return
  const inp = document.getElementById('search-input') as HTMLInputElement | null
  const q = (inp && inp.value.trim()) || ''
  if (!q) return
  isLoadingMoreSearch = true
  searchPage += 1
  try {
    const run = (window as any).__revivelRunSearch
    if (run) await run(q, false)
  } finally {
    isLoadingMoreSearch = false
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
    d.onclick = () => { initialTitle = it.title; clearPlayerMedia(); showView('player'); loadVideo(it.uri) }
    vEl.appendChild(d)
  })

  hEl.innerHTML = history.length ? '' : `<div class="text-xs text-[#64748b]">No recent plays.</div>`
  history.slice(0, 10).forEach((it: any) => {
    const d = document.createElement('div')
    d.className = 'p-2 bg-[#111114] border border-[#27272a] rounded-xl flex justify-between text-sm cursor-pointer'
    d.innerHTML = `
      <div class="flex items-center gap-2 flex-1 min-w-0">
        <button class="play-btn text-xs bg-[#14b8a6] px-2 rounded">▶</button>
        <div class="min-w-0 flex-1">
          <div class="truncate">${it.title}</div>
          <div class="text-[10px] text-[#64748b]">${new Date(it.time).toLocaleDateString()}</div>
        </div>
      </div>
      <button class="del-btn text-xs text-[#f87171] hover:text-red-400 px-1">×</button>
    `
    d.querySelector('.play-btn')!.addEventListener('click', e => { e.stopPropagation(); initialTitle = it.title; clearPlayerMedia(); showView('player'); loadVideo(it.uri) })
    d.querySelector('.del-btn')!.addEventListener('click', e => { e.stopPropagation(); deleteRecentPlay(it.uri) })
    d.addEventListener('click', () => { initialTitle = it.title; clearPlayerMedia(); showView('player'); loadVideo(it.uri) })
    hEl.appendChild(d)
  })
}

function deleteRecentPlay(uri: string) {
  history = history.filter((h: any) => h.uri !== uri)
  chrome.storage.local.set({ revivel_history: history })
  renderLibrary()
}

async function loadLibrary() {
  await loadVault()
  await loadHistory()
  renderLibrary()
}

async function resetViewData() {
  // Clear in-memory caches for this player instance (eliminates any prior merge/stale lists)
  feedItems = []
  latestItems = []
  searchItems = []
  feedFetchId++
  latestFetchId++
  searchFetchId++
  feedPage = 1
  latestPage = 1
  searchPage = 1
  feedHasMore = true
  latestHasMore = true
  searchHasMore = true
  feedPrefetchedItems = []
  feedPrefetchPage = 0
  vault = []
  history = []

  // Clear persistent storage for vault and history (shared with popup)
  await chrome.storage.local.remove(['revivel_vault', 'revivel_history'])

  // Always force fresh fetches for dynamic lists so Latest/Feed grids are updated
  await loadFeed()
  await loadLatest(true)

  if (currentView === 'library') {
    await loadLibrary()
  } else if (currentView === 'wallet') {
    renderWallet()
  }

  // Notify popup side indirectly via storage clear (next open will be fresh)
  alert('View data and caches have been reset (fresh Latest/Feed fetched).\n\nIf you still see old items, fully reload the extension at chrome://extensions then reload this page.')
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

  // Send with confirmation
  feeEl.textContent = '0.0001 (est)'
  if (sendBtn) sendBtn.addEventListener('click', async () => {
    if (!sendAddr.value || !sendAmt.value) return
    const amount = sendAmt.value
    const address = sendAddr.value
    const fee = '0.0001'
    const total = (parseFloat(amount) + parseFloat(fee)).toFixed(4)
    const confirmMsg = `Are you sure you want to send ${amount} LBC to ${address} with transaction fee of ${fee} LBC totalling a spend of ${total} LBC?`
    if (!confirm(confirmMsg)) return
    try {
      const result = await sendLBC(address, amount)
      alert('Transaction submitted!')
      // Add to last sent with status
      addToLastSent(address, amount, result?.txid || 'pending')
      loadWalletData()
    } catch (e: any) { alert('Send failed: ' + (e.message || e)) }
  })

function addToLastSent(address: string, amount: string, txid: string) {
  const lastSent = document.getElementById('wallet-last-sent')!
  const div = document.createElement('div')
  div.className = 'mb-1 text-xs'
  const short = txid.slice(0,10) + '...'
  const link = `https://explorer.lbry.com/tx/${txid}`
  div.innerHTML = `Sent ${amount} LBC to ${address.slice(0,12)}... <a href="${link}" target="_blank" class="text-[#14b8a6]" style="color:#14b8a6">${short}</a> <span class="text-[#64748b]">0 conf (just sent)</span>`
  // prepend
  lastSent.prepend(div)
  // keep only last 3
  while (lastSent.children.length > 3) lastSent.removeChild(lastSent.lastChild!)
}

  // History & last tx
  loadWalletData()
}

async function loadWalletData() {
  const lastRecv = document.getElementById('wallet-last-received')!
  const lastSent = document.getElementById('wallet-last-sent')!
  const histEl = document.getElementById('wallet-history')!

  try {
    // fetch last ~15 for history, last 3 for received/sent
    const txs = await getTransactions(1, 15)
    const items: any[] = txs.items || txs || []

    const received = items.filter((t: any) => t.type === 'received' || parseFloat(t.amount) > 0).slice(0, 3)
    lastRecv.innerHTML = received.length ? received.map((t:any) => {
      const amt = t.amount || '0'
      const to = (t.to_address || '').slice(0,12)
      const short = (t.txid || '').slice(0,8)
      const addrPart = to && to !== 'unknown' ? ` to ${to}...` : ''
      return `${amt} LBC received${addrPart} <a href="https://explorer.lbry.com/tx/${t.txid}" target="_blank" class="text-[#14b8a6]" style="color:#14b8a6">${short}</a>`
    }).join('<br>') : 'None'

    const sent = items.filter((t: any) => t.to_address && t.to_address !== 'unknown').slice(0, 3)
    lastSent.innerHTML = sent.length ? sent.map((t:any) => {
      const amt = Math.abs(parseFloat(t.amount || 0))
      const to = (t.to_address || 'unknown').slice(0,10)
      const short = (t.txid || '').slice(0,8)
      const conf = t.confirmations ? ` ${t.confirmations} conf` : ''
      return `${amt} LBC to ${to}... <a href="https://explorer.lbry.com/tx/${t.txid}" target="_blank" class="text-[#14b8a6]" style="color:#14b8a6">${short}</a>${conf}`
    }).join('<br>') : 'None'

    // History: last 15 with full details
    renderHistory(histEl, items.slice(0,15), false)
  } catch (e) {
    lastRecv.textContent = lastSent.textContent = '—'
    histEl.textContent = 'Failed to load history (SPV wallet required)'
  }
}

function renderHistory(el: HTMLElement, items: any[], isFull: boolean) {
  if (!items.length) {
    el.innerHTML = 'No transactions yet'
    return
  }
  const html = items.map((t:any) => {
    const amt = t.amount
    const to = (t.to_address || 'unknown').slice(0,12)
    const txh = t.txid || ''
    const shortTx = txh.slice(0,10) + '...'
    const link = `https://explorer.lbry.com/tx/${txh}`
    const conf = t.confirmations ? `${t.confirmations} conf` : ''
    const toPart = to && to !== 'unknown' ? `to ${to}... ` : ''
    return `<div class="mb-1">${amt} LBC ${toPart}<a href="${link}" target="_blank" class="text-[#14b8a6]" style="color:#14b8a6">${shortTx}</a> ${conf}</div>`
  }).join('')
  el.innerHTML = html
  if (!isFull) {
    // add load more if not already
    if (!el.querySelector('#load-more-tx')) {
      const btn = document.createElement('button')
      btn.id = 'load-more-tx'
      btn.className = 'action-btn text-xs mt-2'
      btn.textContent = 'Load more (last 100)'
      btn.onclick = async () => {
        try {
          const txs = await getTransactions(1, 100)
          historyLoaded = txs.items || txs || []
          renderHistory(el, historyLoaded, true)
        } catch(e) { alert('Failed to load more') }
      }
      el.appendChild(btn)
    }
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

  // NSFW / adult content toggle
  const nsfwToggle = document.getElementById('settings-show-nsfw') as HTMLInputElement | null
  if (nsfwToggle) {
    nsfwToggle.checked = !!showNSFW
    nsfwToggle.onchange = async () => {
      const val = nsfwToggle.checked
      showNSFW = val
      try {
        await new Promise<void>(resolve => chrome.storage.local.set({ revivel_showNSFW: val }, () => resolve()))
      } catch (_) {}
      // Note: switching away from Settings (e.g. to Feed/Latest) will re-fetch using the new preference.
    }
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

  // Wire filters early (for both feed and search tabs)
  wireFeedFilters()

  // Explicit clear on every full page load
  feedItems = []
  latestItems = []
  searchItems = []
  feedFetchId++
  latestFetchId++
  searchFetchId++
  feedPage = 1
  latestPage = 1
  searchPage = 1
  feedHasMore = true
  latestHasMore = true
  feedPrefetchedItems = []
  feedPrefetchPage = 0

  // Load preferences early (before any list fetches that depend on them)
  // Load saved word library preference
  try {
    const saved: any = await new Promise(r => chrome.storage.local.get('revivel_word_library', r))
    if (saved?.revivel_word_library && WORD_LIBRARY_LABELS[saved.revivel_word_library]) {
      currentWordLibrary = saved.revivel_word_library
    }
  } catch (_) {}

  // Load NSFW preference (controls not_tags + client tag filters for all lists)
  try {
    const saved: any = await new Promise(r => chrome.storage.local.get('revivel_showNSFW', r))
    showNSFW = !!saved.revivel_showNSFW
  } catch (_) {}

  // Start the critical feed load *immediately* for default Feed view.
  // This gets the data flowing as early as possible for LCP.
  if (!openedWithSpecificVideo) {
    loadFeed()
  }

  // Only eagerly load video if a specific one was requested via ?uri=.
  if (openedWithSpecificVideo) {
    loadVideo(currentUri, true)
  }

  // Non-critical stuff after kickstarting the main content fetch
  updateStatus().catch(() => {})
  loadVault().catch(() => {})
  loadHistory().catch(() => {})

  // Wire Word Library buttons (Feed and Search)
  const wireWordLibBtn = (id: string) => {
    const btn = document.getElementById(id)
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopImmediatePropagation()
        showWordLibrarySelector()
      })
    }
  }
  wireWordLibBtn('word-library-btn')
  wireWordLibBtn('search-word-library-btn')
  updateWordLibraryButton()

  if (openedWithSpecificVideo) {
    loadLatest(true)
  } else {
    // Preload latest in background
    loadLatest(true).catch(() => {})
  }

  // Default view: Feed when opening without a specific video, Player otherwise
  showView(openedWithSpecificVideo ? 'player' : 'feed')

  // Wire view mode selects for lists (Feed/Latest/Search)
  document.querySelectorAll('.view-mode-select').forEach((sel: any) => {
    sel.addEventListener('change', () => {
      listViewMode = sel.value as any
      // sync other selects
      document.querySelectorAll('.view-mode-select').forEach((s: any) => s.value = listViewMode)
      // Re-render the target grid if possible
      const gridId = sel.getAttribute('data-grid')
      if (gridId === 'feed-grid' && currentView === 'feed') {
        const g = document.getElementById('feed-grid')!
        renderClaimGrid(feedItems, g)
      } else if (gridId === 'latest-grid' && currentView === 'latest') {
        const g = document.getElementById('latest-grid')!
        renderClaimGrid(latestItems, g)
      } else if (gridId === 'search-grid' && currentView === 'search') {
        const g = document.getElementById('search-grid')!
        renderClaimGrid(searchItems, g)
      }
    })
  })

  // Infinite scroll for load-more on Feed / Latest / Search (player)
  let scrollTimer: any = null
  window.addEventListener('scroll', () => {
    if (scrollTimer) clearTimeout(scrollTimer)
    scrollTimer = setTimeout(() => {
      const nearBottom = window.innerHeight + window.scrollY > (document.body.scrollHeight - 280)
      if (!nearBottom) return
      if (currentView === 'feed') loadMoreFeed()
      else if (currentView === 'latest') loadMoreLatest()
      else if (currentView === 'search') loadMoreSearch()
    }, 120)
  }, { passive: true })

  // Poll status so activating Companion later refreshes feed/latest with the right data (support ordering etc.)
  setInterval(() => {
    updateStatus().catch(() => {})
  }, 8000)
}

init()
