// ReviveL Popup — Premium UX
// Large comfortable window, elegant spacing, in-popup settings, floating video player

import { resolveLbryUri, extractClaim, getPlayableUrl, searchLbryClaims, getWalletBalance, getReceiveAddress, sendLBC, getTransactions, createWallet, closeWallet, deleteWallet, getWalletSeed, getClaimTimestamp, dedupClaims, isFutureDatedClaim, publishStream, stageFile, getChannels, getThumbnail, isClaimId, createThumbHtml } from '../utils/lbryApi.js';

interface LbryItem { id: string; title: string; channel: string; thumbnail: string; duration: string; lbryUri: string; type: 'video'|'image'; timestamp: number; uploaded: string; isLocked: boolean; fee: string; staked: number; description?: string; }
interface LibraryItem { id: string; title: string; description: string; imageData: string; lbryUri: string; channel: string; date: string }

let feedItems: LbryItem[] = []
let latestItems: LbryItem[] = []

// Pagination state (Feed = staked order; Latest = date order only)
let feedPage = 1
let latestPage = 1
let feedHasMore = true
let latestHasMore = true
let isLoadingMoreFeed = false
let isLoadingMoreLatest = false
let channelsPage = 1
let channelsHasMore = true
let isLoadingMoreChannels = false

// View mode for the content lists (affects Feed and Latest)
let listViewMode: 'list' | 'details' | 'small' | 'medium' | 'big' | 'huge' = 'medium'

// Whether to show NSFW/adult content in lists
let showNSFW = false

// Fetch IDs prevent stale results from older fetches (e.g. public trending results arriving
// after a Companion activation fetch, or interleaved calls) from polluting the lists.
let feedFetchId = 0
let latestFetchId = 0

let currentTab: 'feed'|'new'|'library'|'channels'|'upload'|'wallet' = 'feed'
let currentLibSub: 'recent' | 'uploads' | 'saved' = 'recent'
let quickUploadEnabled = true
let pendingUploadImage: { dataUrl: string; name: string } | null = null
let searchTerm = ''
let library: LibraryItem[] = []
let vault: any[] = []
let history: any[] = []
let noDaemonConnection = true
let currentStatus: any = null;

let feedLoading = true;
let latestLoading = true;
let feedHasError = false;
let latestHasError = false;
let feedErrorIsCompanion = false;
let latestErrorIsCompanion = false;

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

  // Over 4 weeks: show date like "10 Jan 2026"
  const date = new Date(timestamp * 1000);
  const dayNum = date.getDate();
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = monthNames[date.getMonth()];
  const year = date.getFullYear();
  return `${dayNum} ${month} ${year}`;
}

function mapClaimToItem(claim: any): LbryItem {
  const value = claim.value || {}
  const thumbnail = getThumbnail(claim)
  const channel = claim.signing_channel?.name || '@unknown'
  const lbryUri = claim.canonical_url || `lbry://${claim.name}`
  const timestamp = getClaimTimestamp(claim);
  const uploaded = formatUploadTime(timestamp);

  // Paywall detection (LBRY fee on stream)
  const fee = value.fee || value.stream?.fee || null;
  const isLocked = !!(fee && fee.amount && parseFloat(fee.amount) > 0);
  const feeStr = isLocked ? `${parseFloat(fee.amount).toFixed(3)} LBC` : '';

  // Total staked (claim + supports)
  const cAmt = parseFloat(claim.amount || 0);
  const sAmt = parseFloat(claim.meta?.support_amount || 0);
  let staked = cAmt + sAmt;
  if (!staked && claim.meta?.effective_amount) {
    staked = parseFloat(claim.meta.effective_amount);
  }

  return {
    id: claim.claim_id || Math.random().toString(),
    title: value.title || claim.name || 'Untitled',
    channel,
    thumbnail,
    duration: '—',
    lbryUri,
    type: 'video',
    timestamp,
    uploaded,
    isLocked,
    fee: feeStr,
    staked,
    description: value.description || ''
  }
}

async function fetchRealFeed(tab: 'feed' | 'latest', page = 1, append = false) {
  const isFeed = tab === 'feed';
  const myId = isFeed ? ++feedFetchId : ++latestFetchId;

  if (!append) {
    if (isFeed) {
      feedItems = [];
      feedPage = 1;
      feedHasMore = true;
      feedHasError = false;
      feedErrorIsCompanion = false;
      feedLoading = true;
      renderContent();
    } else {
      latestItems = [];
      latestPage = 1;
      latestHasMore = true;
      latestHasError = false;
      latestErrorIsCompanion = false;
      latestLoading = true;
      renderContent();
    }
  }

  // Mode detection (prefer daemonUrl)
  let useCompanionLists = false;
  try {
    const cfg: any = await chrome.storage.sync.get(['daemonUrl']);
    const du = String(cfg?.daemonUrl || '');
    if (du.includes('127.0.0.1') || du.includes('localhost')) useCompanionLists = true;
  } catch (_) {}
  if (!useCompanionLists) {
    try {
      const daemonStatus = await new Promise<any>(r => chrome.runtime.sendMessage({ type: 'getDaemonStatus' }, r));
      noDaemonConnection = !daemonStatus?.connected;
      const usingDaemon = (daemonStatus as any)?.using === 'daemon' || (daemonStatus as any)?.isCompanion;
      const ep = String((daemonStatus as any)?.endpoint || '');
      if (usingDaemon || /127\.0\.0\.1|localhost/.test(ep) || daemonStatus?.connected) {
        useCompanionLists = true;
      }
    } catch (_) {
      noDaemonConnection = true;
    }
  }

  const fetchMode = useCompanionLists ? 'companion' : 'public';

  try {
    const params: any = {
      claim_type: 'stream',
      stream_types: ['video'],
      has_source: true,
      page_size: 25,
      page,
    };

    if (tab === 'feed') {
      // FEED: ALWAYS highest LBC staked (effective_amount). Never mix latest ordering.
      params.order_by = ['effective_amount'];
      if (!useCompanionLists) {
        params.fee_amount = '<=0';
        if (!showNSFW) {
          params.not_tags = ['mature', 'nsfw'];
        }
      }
    } else {
      // LATEST: ONLY date. NEVER stake sort. Real-time via newBlock.
      params.order_by = ['release_time'];
      const nowSecForLatest = Math.floor(Date.now() / 1000)
      params.release_time = `<=${nowSecForLatest + 86400 * 2}`
      if (!useCompanionLists) {
        params.fee_amount = '<=0';
        if (!showNSFW) {
          params.not_tags = ['mature', 'nsfw'];
        }
      }
    }

    const result = await searchLbryClaims(params)
    let rawItems = (result.items || []);
    // Filter out claims with future release_time (e.g. bogus year 8878 claims that pollute Latest on scroll)
    rawItems = rawItems.filter((c: any) => !isFutureDatedClaim(c))

    // Apply NSFW filter client-side (for companion mode, and as safety for public)
    if (!showNSFW) {
      rawItems = rawItems.filter((c: any) => {
        const tags = ((c.value || {}).tags || []).map((t: string) => (t || '').toLowerCase())
        return !tags.some((t: string) => t === 'mature' || t === 'nsfw');
      });
    }

    let items = rawItems.map(mapClaimToItem)

    if (tab === 'feed') {
      // Enforce stake sort for Feed (top first)
      items = items.sort((a, b) => (b.staked || 0) - (a.staked || 0))
    } else {
      // Enforce date sort only for Latest. Drop future timestamps.
      const nowSec = Math.floor(Date.now() / 1000)
      const maxLatestTs = nowSec + 86400 * 2
      items = items
        .filter((it: any) => it.timestamp > nowSec - 86400 * 90 && it.timestamp <= maxLatestTs)
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    }

    // Stale fetch guard
    const stillCurrentId = (isFeed ? myId === feedFetchId : myId === latestFetchId);
    if (!stillCurrentId) return;

    // Mode guard at end
    try {
      let freshUse = false;
      try {
        const cfg: any = await chrome.storage.sync.get(['daemonUrl']).catch(() => ({}));
        const du = String(cfg?.daemonUrl || '');
        if (du.includes('127.0.0.1') || du.includes('localhost')) freshUse = true;
      } catch (_) {}
      if (!freshUse) {
        const fresh = await new Promise<any>(r => chrome.runtime.sendMessage({ type: 'getDaemonStatus' }, r));
        const usingD = (fresh as any)?.using === 'daemon' || (fresh as any)?.isCompanion;
        const ep = String((fresh as any)?.endpoint || '');
        if (usingD || /127\.0\.0\.1|localhost/.test(ep) || fresh?.connected) freshUse = true;
      }
      if ((freshUse ? 'companion' : 'public') !== fetchMode) return;
    } catch (_) {}

    if (tab === 'feed') {
      if (append) {
        feedItems = dedupClaims(feedItems as any, items as any) as LbryItem[]
      } else {
        feedItems = items as LbryItem[]
      }
      // Always re-sort by staked desc to guarantee Feed is 100% sorted by LBC staked
      feedItems = feedItems.sort((a, b) => (b.staked || 0) - (a.staked || 0));
      feedHasMore = rawItems.length >= 20
      feedPage = page
    } else {
      if (append) {
        latestItems = dedupClaims(latestItems as any, items as any) as LbryItem[]
      } else {
        latestItems = items as LbryItem[]
      }
      latestHasMore = rawItems.length >= 20
      latestPage = page
    }
  } catch (e) {
    console.warn('Real feed fetch failed', e)
    const stillCurrent = (isFeed ? myId === feedFetchId : myId === latestFetchId);
    if (stillCurrent) {
      if (tab === 'feed') {
        if (!append) feedItems = [];
        feedHasError = true;
        feedErrorIsCompanion = useCompanionLists;
      } else {
        if (!append) latestItems = [];
        latestHasError = true;
        latestErrorIsCompanion = useCompanionLists;
      }
    }
  } finally {
    const stillCurrent = (isFeed ? myId === feedFetchId : myId === latestFetchId);
    if (tab === 'feed') {
      feedLoading = false;
    } else {
      latestLoading = false;
    }
    const shouldRenderCurrent = stillCurrent && !searchTerm &&
      ((tab === 'feed' && currentTab === 'feed') || (tab === 'latest' && currentTab === 'new'));
    if (shouldRenderCurrent) {
      renderContent();
    }
  }
}

async function loadMoreFeedPopup() {
  if (isLoadingMoreFeed || !feedHasMore || currentTab !== 'feed' || searchTerm) return
  isLoadingMoreFeed = true
  feedPage += 1
  try {
    await fetchRealFeed('feed', feedPage, true)
  } finally {
    isLoadingMoreFeed = false
  }
}

async function loadMoreLatestPopup() {
  if (isLoadingMoreLatest || !latestHasMore || currentTab !== 'new' || searchTerm) return
  isLoadingMoreLatest = true
  latestPage += 1
  try {
    await fetchRealFeed('latest', latestPage, true)
  } finally {
    isLoadingMoreLatest = false
  }
}

async function loadMoreChannelsPopup() {
  if (isLoadingMoreChannels || !channelsHasMore || currentTab !== 'channels') return
  isLoadingMoreChannels = true
  channelsPage += 1
  try {
    await loadChannelsForPopup(true)
  } finally {
    isLoadingMoreChannels = false
  }
}

async function performRealSearch(query: string) {
  // Determine mode (search supported in both public and companion, with appropriate filters)
  let useCompanionLists = false;
  try {
    const cfg: any = await chrome.storage.sync.get(['daemonUrl']);
    const du = String(cfg?.daemonUrl || '');
    if (du.includes('127.0.0.1') || du.includes('localhost')) useCompanionLists = true;
  } catch (_) {}
  if (!useCompanionLists) {
    try {
      const daemonStatus = await new Promise<any>(r => chrome.runtime.sendMessage({ type: 'getDaemonStatus' }, r));
      const usingD = (daemonStatus as any)?.using === 'daemon' || (daemonStatus as any)?.isCompanion;
      const ep = String((daemonStatus as any)?.endpoint || '');
      if (usingD || /127\.0\.0\.1|localhost/.test(ep) || daemonStatus?.connected) useCompanionLists = true;
      noDaemonConnection = !daemonStatus?.connected;
    } catch (_) {
      noDaemonConnection = true;
    }
  }

  if (!query || query.length < 2) {
    await fetchRealFeed( (currentTab as any) === 'feed' ? 'feed' : 'latest')
    renderContent()
    return
  }

  // When searching, stop any loading animation for the feed view
  if (currentTab === 'feed') {
    feedLoading = false;
  } else {
    latestLoading = false;
  }
  stopLoadingAnimation();

  try {
    // Search (in popup context) for the current view: always prefer stake sort for Feed/Search-like,
    // but for Latest tab view keep date order.
    const params: any = {
      claim_type: 'stream',
      stream_types: ['video'],
      has_source: true,
      page_size: 10,
      page: 1,
    };
    const q = query.trim();
    if (isClaimId(q)) {
      params.claim_id = q;
    } else if (q.includes('#')) {
      const hashPart = q.split('#')[1] || '';
      if (isClaimId(hashPart)) {
        params.claim_id = hashPart;
      } else {
        params.text = q;
      }
    } else {
      params.text = q;
    }
    // Always stake order unless the active view is the Latest tab
    const wantStake = (currentTab !== 'new')
    if (wantStake) {
      params.order_by = ['effective_amount']
    } else {
      params.order_by = ['release_time']
    }
    if (!useCompanionLists) {
      params.fee_amount = '<=0';
      if (!showNSFW) {
        params.not_tags = ['mature', 'nsfw'];
      }
    }
    const result = await searchLbryClaims(params)
    let raw = (result.items || []);
    if (!showNSFW) {
      raw = raw.filter((c: any) => {
        const tags = ((c.value || {}).tags || []).map((t: string) => (t || '').toLowerCase())
        return !tags.some((t: string) => t === 'mature' || t === 'nsfw');
      });
    }
    let items = raw.map(mapClaimToItem)
    if (currentTab === 'new') {
      items = items.sort((a, b) => b.timestamp - a.timestamp)
    } else {
      // stake order for feed/search context
      items = items.sort((a, b) => (b.staked || 0) - (a.staked || 0))
    }
    if (currentTab === 'feed') {
      feedItems = items
    } else {
      latestItems = items
    }
    renderContent()
  } catch (e) {
    console.warn('Real search failed', e)
    if (currentTab === 'feed') {
      feedItems = [];
      feedHasError = true;
      feedErrorIsCompanion = false; // search failure not companion specific
      feedLoading = false;
    } else {
      latestItems = [];
      latestHasError = true;
      latestErrorIsCompanion = false;
      latestLoading = false;
    }
    renderContent()
  }
}

function initTailwind() {
  const s = document.createElement('style')
  s.textContent = `.revivel-card{transition:all .2s cubic-bezier(.4,0,.2,1)}.revivel-card:hover{transform:translateY(-1px)} .tab-active{background:#14b8a6;color:white}`
  document.head.appendChild(s)
}

async function loadLibrary() {
  const d = await chrome.storage.local.get('revivel_library')
  let localLib: LibraryItem[] = (d.revivel_library as LibraryItem[]) || []

  // For fresh installs or to show on-chain uploads, fetch claims owned by wallet
  try {
    const statusResp = await new Promise<any>(r => chrome.runtime.sendMessage({ type: 'getDaemonStatus' }, r))
    if (statusResp && (statusResp.connected || statusResp.isCompanion)) {
      const claimsResp = await new Promise<any>(r => chrome.runtime.sendMessage({ type: 'getMyClaims' }, r))
      if (claimsResp && claimsResp.ok) {
        const onChainItems = (claimsResp.result.items || claimsResp.result || [])
        const onChainLib: LibraryItem[] = onChainItems.map((claim: any) => {
          const v = claim.value || {}
          const thumb = getThumbnail(claim)
          const uri = claim.canonical_url || `lbry://${claim.name}`
          return {
            id: claim.claim_id || claim.id || Date.now().toString(),
            title: v.title || claim.name || 'Untitled',
            description: v.description || '',
            imageData: thumb,
            lbryUri: uri,
            channel: claim.signing_channel?.name || 'Anonymous',
            date: 'on-chain'
          }
        })
        // Merge: on-chain first, dedup by lbryUri; update thumbs for existing
        const seen = new Set(localLib.map(x => x.lbryUri))
        onChainLib.forEach(item => {
          if (seen.has(item.lbryUri)) {
            const existing = localLib.find((x: any) => x.lbryUri === item.lbryUri)
            if (existing && item.imageData && !String(item.imageData).includes('picsum.photos')) {
              existing.imageData = item.imageData
            }
          } else {
            localLib.unshift(item)
            seen.add(item.lbryUri)
          }
        })
      }
    }
  } catch (e) {
    console.warn('Could not fetch on-chain claims for library', e)
  }

  library = localLib
}
async function saveLibrary() { await chrome.storage.local.set({revivel_library: library}) }

async function loadVault() {
  const d = await chrome.storage.local.get('revivel_vault')
  vault = (d.revivel_vault as any[]) || []
}
async function saveVault() { await chrome.storage.local.set({ revivel_vault: vault }) }

async function loadHistory() {
  const d = await chrome.storage.local.get('revivel_history')
  history = (d.revivel_history as any[]) || []
}

async function addToHistory(uri: string, title: string, ch?: string) {
  await loadHistory()
  history = history.filter((h: any) => (h.uri || h.lbryUri) !== uri)
  history.unshift({ uri, title, time: Date.now(), channel: ch || '' })
  history = history.slice(0, 30)
  await chrome.storage.local.set({ revivel_history: history })
}

function renderContent() {
  const c = document.getElementById('content-area')!
  c.innerHTML = ''
  stopLoadingAnimation();

  const showViewOpts = (currentTab === 'feed' || currentTab === 'new' || currentTab === 'library');
  const po = document.getElementById('popup-view-options');
  const pm = document.getElementById('popup-view-mode') as HTMLSelectElement | null;
  if (po) po.style.display = showViewOpts ? '' : 'none';
  if (pm && showViewOpts) pm.value = listViewMode;

  if (currentTab === 'library') { 
    Promise.all([loadLibrary(), loadVault(), loadHistory()]).then(() => {
      renderLibrary(c);
    }); 
    return 
  }
  if (currentTab === 'channels') { renderChannels(c); return }
  if (currentTab === 'upload') { renderUpload(c); return }
  if (currentTab === 'wallet') { renderWallet(c); return }

  const isFeedTab = currentTab === 'feed' || currentTab === 'new';

  if (isFeedTab) {
    // Always render the list (search will succeed via public proxy even without local daemon)
    doRenderFeedItems();
    // Optionally refresh status in background
    chrome.runtime.sendMessage({ type: 'getDaemonStatus' }, (s: any) => {
      noDaemonConnection = !s?.connected;
      // if still on feed tab and no search term, re-render in case flag changed
      if ((currentTab === 'feed' || currentTab === 'new') && !searchTerm) {
        doRenderFeedItems();
      }
    });
    return;
  }

  // for other cases
  doRenderFeedItems();
}

let loadingInterval: any = null;

function startLoadingAnimation() {
  stopLoadingAnimation();
  const el = document.getElementById('feed-loading');
  if (!el) return;
  let dots = 3;
  el.textContent = 'Loading' + '.'.repeat(dots);
  loadingInterval = setInterval(() => {
    dots = (dots + 1) % 4;
    if (el) el.textContent = 'Loading' + '.'.repeat(dots);
  }, 350);
}

function stopLoadingAnimation() {
  if (loadingInterval) {
    clearInterval(loadingInterval);
    loadingInterval = null;
  }
}

function doRenderFeedItems() {
  const c = document.getElementById('content-area')!;
  c.innerHTML = '';
  if (currentTab === 'library') { renderLibrary(c); return; }

  const isFeedTab = currentTab === 'feed';
  let items = isFeedTab ? [...feedItems] : [...latestItems];
  const loading = isFeedTab ? feedLoading : latestLoading;
  const hasError = isFeedTab ? feedHasError : latestHasError;

  if (searchTerm) {
    const q = searchTerm.toLowerCase()
    items = items.filter(i => i.title.toLowerCase().includes(q) || i.channel.toLowerCase().includes(q))
    if (!items.length) {
      stopLoadingAnimation();
      c.innerHTML = `<div class="py-6 text-center text-xs text-[#64748b]">No matches found.</div>`
      return
    }
  } else if (loading) {
    c.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:center; height:100%; min-height:200px;">
        <div id="feed-loading" style="font-size:18px; color:#64748b; text-align:center;">Loading...</div>
      </div>
    `;
    startLoadingAnimation();
    return;
  } else if (hasError) {
    stopLoadingAnimation();
    const isCompanionErr = isFeedTab ? feedErrorIsCompanion : latestErrorIsCompanion;
    if (isCompanionErr) {
      c.innerHTML = `
        <div class="py-6 text-center text-xs text-[#64748b]">
          Companion not running.<br>
          Restart your companion.<br>
          <div class="mt-2 flex justify-center items-center gap-2">
            <button id="refresh-companion-btn" class="action-btn text-xs px-2 py-0.5" title="Check for Companion">↻</button>
            <button id="switch-to-public-btn" class="action-btn teal text-xs px-3 py-1">Switch to Public Mode</button>
          </div>
        </div>
      `;
      const switchBtn = c.querySelector('#switch-to-public-btn') as HTMLButtonElement | null;
      if (switchBtn) {
        switchBtn.onclick = () => {
          chrome.storage.sync.set({ daemonUrl: null }, () => {
            chrome.runtime.sendMessage({ type: 'setDaemonUrl', url: null }, () => {
              feedHasError = false;
              latestHasError = false;
              feedErrorIsCompanion = false;
              latestErrorIsCompanion = false;
              noDaemonConnection = true;
              const tabToFetch = (currentTab === 'feed' ? 'feed' : 'latest') as 'feed' | 'latest';
              fetchRealFeed(tabToFetch);
            });
          });
        };
      }

      const refreshBtn = c.querySelector('#refresh-companion-btn') as HTMLButtonElement | null;
      if (refreshBtn) {
        refreshBtn.onclick = async () => {
          refreshBtn.disabled = true;
          refreshBtn.textContent = '⟳';
          try {
            const status = await new Promise<any>(r => chrome.runtime.sendMessage({ type: 'getDaemonStatus' }, r));
            const usingD = (status as any)?.using === 'daemon' || (status as any)?.isCompanion;
            const ep = String((status as any)?.endpoint || '');
            const isOnline = !!(status?.connected && (usingD || /127\.0\.0\.1|localhost/.test(ep)));

            if (isOnline) {
              feedHasError = false;
              latestHasError = false;
              feedErrorIsCompanion = false;
              latestErrorIsCompanion = false;
              noDaemonConnection = false;
              const tabToFetch = (currentTab === 'feed' ? 'feed' : 'latest') as 'feed' | 'latest';
              fetchRealFeed(tabToFetch);
            } else {
              const msg = document.createElement('div');
              msg.style.color = '#f87171';
              msg.style.marginTop = '6px';
              msg.style.fontSize = '10px';
              msg.textContent = "Can't find Companion";
              refreshBtn.parentElement?.appendChild(msg);
              setTimeout(() => {
                if (msg.parentNode) msg.parentNode.removeChild(msg);
              }, 2500);
            }
          } catch (e) {
            const msg = document.createElement('div');
            msg.style.color = '#f87171';
            msg.style.marginTop = '6px';
            msg.style.fontSize = '10px';
            msg.textContent = "Can't find Companion";
            refreshBtn.parentElement?.appendChild(msg);
            setTimeout(() => {
              if (msg.parentNode) msg.parentNode.removeChild(msg);
            }, 2500);
          }
          refreshBtn.disabled = false;
          refreshBtn.textContent = '↻';
        };
      }
      return;
    } else {
      const msg = noDaemonConnection
        ? 'Unable to load feed.<br>Connection issue — using public data if available.'
        : 'Failed to load content.<br>Please try again.';
      c.innerHTML = `<div class="py-6 text-center text-xs text-[#64748b]">${msg}</div>`;
      return;
    }
  } else if (!items.length) {
    stopLoadingAnimation();
    c.innerHTML = `<div class="py-6 text-center text-xs text-[#64748b]">No content available.</div>`;
    return;
  }

  stopLoadingAnimation();

  const list = document.createElement('div')
  list.className = `content-grid view-mode-${listViewMode}`

  items.forEach(it => {
    const row = document.createElement('div')
    row.className = 'claim-card'
    const stakedHtml = it.staked > 0.01 
      ? `<div class="text-[9px] text-emerald-400 mt-0.5">${it.staked.toLocaleString(undefined, {maximumFractionDigits: 0})} LBC staked</div>` 
      : '';

    let inner = ''
    if (listViewMode === 'list') {
      const thumbHtml = createThumbHtml(it, '16/9', 'width:64px;height:36px;aspect-ratio:16/9;flex-shrink:0;border-radius:3px;object-fit:cover;')
      inner = `
        <div class="flex gap-2 p-1.5 items-center">
          ${thumbHtml}
          <div class="min-w-0 flex-1">
            <div class="text-sm font-semibold leading-tight line-clamp-1">${it.title}</div>
            <div class="text-[9px] text-[#64748b] mt-px truncate">${it.channel} • ${it.isLocked ? `🔒 ${it.fee}` : it.uploaded} ${stakedHtml ? ' • ' + it.staked.toLocaleString() + ' LBC' : ''}</div>
          </div>
          <button class="play-btn">Play</button>
        </div>
      `
    } else if (listViewMode === 'details') {
      // Details: smaller thumbnails + more detailed claim info
      const desc = (it.description || '').slice(0, 180) + ((it.description || '').length > 180 ? '…' : '')
      const thumbHtml = createThumbHtml(it, '16/9', 'width:100px;height:56.25px;aspect-ratio:16/9;flex-shrink:0;border-radius:4px;object-fit:cover;')
      inner = `
        <div class="flex gap-3 p-2">
          ${thumbHtml}
          <div class="min-w-0 flex-1">
            <div class="text-sm font-semibold leading-tight line-clamp-2">${it.title}</div>
            <div class="text-[10px] text-[#64748b] mt-1">${it.channel} • ${it.isLocked ? `🔒 ${it.fee}` : it.uploaded}</div>
            ${stakedHtml}
            ${desc ? `<div class="text-[9px] text-[#64748b] mt-1.5 line-clamp-3">${desc}</div>` : ''}
          </div>
          <button class="play-btn mt-0.5 self-start">Play</button>
        </div>
      `
    } else {
      // Icon modes (small/medium/big/huge) - width 100% of card, CSS grid sizes the card, force 16:9
      const thumbHtml = createThumbHtml(it, '16/9')
      inner = `
        ${thumbHtml}
        <div class="p-2">
          <div class="text-sm font-semibold leading-tight line-clamp-2">${it.title}</div>
          <div class="flex items-start justify-between mt-1">
            <div class="text-[10px] text-[#64748b] flex-1 min-w-0">
              <div class="truncate">${it.channel}</div>
              <div class="text-[9px] ${it.isLocked ? 'text-amber-500' : 'opacity-70'}">${it.isLocked ? `🔒 ${it.fee}` : it.uploaded}</div>
              ${stakedHtml}
            </div>
            <button class="play-btn mt-0.5">Play</button>
          </div>
        </div>
      `
    }

    row.innerHTML = inner

    row.querySelector('.play-btn')!.addEventListener('click', e => { e.stopPropagation(); playInOverlay(it.lbryUri, it.title, it.channel) })
    row.addEventListener('click', () => playInOverlay(it.lbryUri, it.title, it.channel))
    list.appendChild(row)
  })
  c.appendChild(list)
}

function renderLibraryItemsForPopup(items: any[], c: HTMLElement, sub?: 'recent'|'uploads'|'saved') {
  c.innerHTML = ''
  if (!items || !items.length) {
    const msg = sub === 'recent' ? 'No recent plays yet.' : (sub === 'uploads' ? 'No uploads yet. Use Upload tab.' : (sub === 'saved' ? 'No saved items yet.' : 'No items.'))
    c.innerHTML = `<div class="text-center py-6 text-[#64748b] text-xs">${msg}</div>`
    return
  }

  const list = document.createElement('div')
  list.className = `content-grid view-mode-${listViewMode}`

  items.forEach((v: any) => {
    const row = document.createElement('div')
    row.className = 'claim-card'
    const title = v.title || 'Untitled'
    const channel = v.channel || 'Anonymous'
    const uploaded = v.date || (v.time ? new Date(v.time).toLocaleDateString() : '')
    const uri = v.lbryUri || v.uri

    const thumbList = createThumbHtml(v, '16/9', 'width:64px;height:36px;flex-shrink:0;border-radius:3px;object-fit:cover;')
    const thumbDetails = createThumbHtml(v, '16/9', 'width:100px;height:56.25px;flex-shrink:0;border-radius:4px;object-fit:cover;')
    const thumbIcon = createThumbHtml(v, '16/9')

    let inner = ''
    if (listViewMode === 'list') {
      inner = `
        <div class="flex gap-2 p-1.5 items-center">
          ${thumbList}
          <div class="min-w-0 flex-1">
            <div class="text-sm font-semibold leading-tight line-clamp-1">${title}</div>
            <div class="text-[9px] text-[#64748b] mt-px truncate">${channel} • ${uploaded}</div>
          </div>
          <button class="play-btn">Play</button>
        </div>
      `
    } else if (listViewMode === 'details') {
      const desc = (v.description || '').slice(0, 180) + ((v.description || '').length > 180 ? '…' : '')
      inner = `
        <div class="flex gap-3 p-2">
          ${thumbDetails}
          <div class="min-w-0 flex-1">
            <div class="text-sm font-semibold leading-tight line-clamp-2">${title}</div>
            <div class="text-[10px] text-[#64748b] mt-1">${channel} • ${uploaded}</div>
            ${desc ? `<div class="text-[9px] text-[#64748b] mt-1.5 line-clamp-3">${desc}</div>` : ''}
          </div>
          <button class="play-btn mt-0.5 self-start">Play</button>
        </div>
      `
    } else {
      inner = `
        ${thumbIcon}
        <div class="p-2">
          <div class="text-sm font-semibold leading-tight line-clamp-2">${title}</div>
          <div class="flex items-start justify-between mt-1">
            <div class="text-[10px] text-[#64748b] flex-1 min-w-0">
              <div class="truncate">${channel}</div>
              <div class="text-[9px] opacity-70">${uploaded}</div>
            </div>
            <button class="play-btn mt-0.5">Play</button>
          </div>
        </div>
      `
    }

    row.innerHTML = inner

    const playBtn = row.querySelector('.play-btn')
    if (playBtn) playBtn.addEventListener('click', e => { e.stopPropagation(); playInOverlay(uri, title, channel) })
    row.addEventListener('click', () => { playInOverlay(uri, title, channel) })
    list.appendChild(row)
  })
  c.appendChild(list)
}

function renderLibrary(c: HTMLElement) {
  c.innerHTML = `
    <div class="text-sm font-semibold mb-1">Library</div>
    <!-- Secondary tabs -->
    <div class="flex gap-1 mb-2 text-xs">
      <button id="lib-sub-recent" class="sub-tab active">Recently Watched</button>
      <button id="lib-sub-uploads" class="sub-tab">My Uploads</button>
      <button id="lib-sub-saved" class="sub-tab">Saved</button>
    </div>
    <div id="library-content"></div>
  `
  setupLibrarySubTabs(c)
}

function setupLibrarySubTabs(c: HTMLElement) {
  const recentBtn = document.getElementById('lib-sub-recent') as HTMLButtonElement | null
  const uploadsBtn = document.getElementById('lib-sub-uploads') as HTMLButtonElement | null
  const savedBtn = document.getElementById('lib-sub-saved') as HTMLButtonElement | null
  const content = document.getElementById('library-content')! as HTMLElement

  if (!recentBtn || !uploadsBtn || !savedBtn) {
    renderLibraryItemsForPopup(library, content, 'uploads')
    return
  }

  function switchSub(mode: 'recent' | 'uploads' | 'saved') {
    currentLibSub = mode
    recentBtn.classList.toggle('active', mode === 'recent')
    uploadsBtn.classList.toggle('active', mode === 'uploads')
    savedBtn.classList.toggle('active', mode === 'saved')

    if (mode === 'recent') {
      renderLibraryItemsForPopup(history.slice(0, 20), content, 'recent')
    } else if (mode === 'uploads') {
      renderLibraryItemsForPopup(library, content, 'uploads')
    } else {
      renderLibraryItemsForPopup(vault, content, 'saved')
    }
  }

  recentBtn.onclick = () => switchSub('recent')
  uploadsBtn.onclick = () => switchSub('uploads')
  savedBtn.onclick = () => switchSub('saved')

  switchSub(currentLibSub)
}

function renderChannels(c: HTMLElement) {
  c.innerHTML = `
    <div class="text-sm font-semibold mb-1">Channels</div>
    <!-- Secondary tabs -->
    <div class="flex gap-1 mb-2 text-xs">
      <button id="ch-sub-top" class="sub-tab active">Top</button>
      <button id="ch-sub-mine" class="sub-tab">My Channels</button>
    </div>
    <div id="channels-list" class="space-y-1"></div>
  `
  setupChannelsSubTabs(c)
}

async function loadChannelsForPopup(append = false) {
  const list = document.getElementById('channels-list')!
  isLoadingMoreChannels = true
  try {
    if (!append) {
      channelsPage = 1
      channelsHasMore = true
      list.innerHTML = ''
    }
    const resp = await searchLbryClaims({
      claim_type: 'channel',
      order_by: ['effective_amount'],
      page_size: 20,
      page: channelsPage
    })
    const items = resp.items || []
    items.forEach((item: any) => {
      const div = document.createElement('div')
      div.className = 'compact-list-item p-1 cursor-pointer'
      const name = item.name
      const title = item.value?.title || name
      const staked = item.meta?.support_amount || item.amount || 0
      const thumbHtml = createThumbHtml(item, '16/9', 'width:40px; height:22.5px; flex-shrink:0; border-radius:3px;', false)
      // Override .compact-list-item's column layout: row with left-aligned content + right-aligned badge
      div.style.display = 'flex';
      div.style.flexDirection = 'row';
      div.style.alignItems = 'center';
      div.style.gap = '6px';
      div.innerHTML = `
        ${thumbHtml}
        <div style="flex:1; min-width:0; text-align:left;">
          <div class="text-xs font-medium">${title}</div>
          <div class="text-[9px] text-[#64748b]">${name} • ${parseFloat(staked).toFixed(2)} LBC staked</div>
        </div>
        <div style="background:#530087; font-size:10px; padding:4px 12px; border-radius:10px; text-shadow:1px 1px black; color:#fff; white-space:nowrap; flex-shrink:0; line-height:1; margin-left:auto;">Channel</div>
      `
      div.onclick = () => openFullPlayer(undefined, name)
      list.appendChild(div)
    })
    channelsHasMore = items.length >= 20
  } catch (e) {
    if (!append) {
      list.innerHTML = '<div class="text-xs text-[#64748b]">Failed to load channels</div>'
    }
  } finally {
    isLoadingMoreChannels = false
  }
}

function setupChannelsSubTabs(c: HTMLElement) {
  const topBtn = document.getElementById('ch-sub-top') as HTMLButtonElement | null
  const mineBtn = document.getElementById('ch-sub-mine') as HTMLButtonElement | null
  const list = document.getElementById('channels-list')!
  if (!topBtn || !mineBtn) {
    loadChannelsForPopup()
    return
  }
  let sub: 'top' | 'mine' = 'top'
  function switchSub(mode: 'top' | 'mine') {
    sub = mode
    topBtn.classList.toggle('active', mode === 'top')
    mineBtn.classList.toggle('active', mode === 'mine')
    if (mode === 'top') {
      loadChannelsForPopup()
    } else {
      channelsHasMore = false
      loadMyChannelsForPopup(list)
    }
  }
  topBtn.onclick = () => switchSub('top')
  mineBtn.onclick = () => switchSub('mine')
  switchSub('top')
}

async function loadMyChannelsForPopup(list: HTMLElement) {
  list.innerHTML = ''
  try {
    const resp = await getChannels()
    const items: any[] = (resp && resp.items) || (Array.isArray(resp) ? resp : [])
    if (items.length === 0) {
      list.innerHTML = '<div class="text-xs text-[#64748b] p-1">No channels owned by this wallet.</div>'
      return
    }
    items.forEach((item: any) => {
      const div = document.createElement('div')
      div.className = 'compact-list-item p-1 cursor-pointer'
      let name = item.name || (item.value && item.value.name) || ''
      if (name && !name.startsWith('@')) name = '@' + name
      const title = item.value?.title || name
      const staked = parseFloat(item.amount || (item.meta && item.meta.support_amount) || 0).toFixed(2)
      const thumbHtml = createThumbHtml(item, '16/9', 'width:40px; height:22.5px; flex-shrink:0; border-radius:3px;', false)
      // Override .compact-list-item's column layout: row with left-aligned content + right-aligned badge
      div.style.display = 'flex';
      div.style.flexDirection = 'row';
      div.style.alignItems = 'center';
      div.style.gap = '6px';
      div.innerHTML = `
        ${thumbHtml}
        <div style="flex:1; min-width:0; text-align:left;">
          <div class="text-xs font-medium">${title}</div>
          <div class="text-[9px] text-[#64748b]">${name} • ${staked} LBC staked</div>
        </div>
        <div style="background:#530087; font-size:10px; padding:4px 12px; border-radius:10px; text-shadow:1px 1px black; color:#fff; white-space:nowrap; flex-shrink:0; line-height:1; margin-left:auto;">Channel</div>
      `
      div.onclick = () => {
        openFullPlayer(undefined, name)
      }
      list.appendChild(div)
    })
  } catch (e) {
    list.innerHTML = '<div class="text-xs text-[#64748b]">Failed to load My Channels</div>'
  }
}

async function renderWallet(c: HTMLElement) {
  c.innerHTML = `
    <div class="space-y-8 text-sm px-6 py-4">
      <!-- Balance -->
      <div class="bg-[#111114] border-2 border-[#27272a] rounded-3xl p-8">
        <div class="flex items-center gap-2 mb-1">
          <span class="text-lg">💰</span>
          <div class="text-lg font-semibold tracking-tight">LBC Balance</div>
        </div>
        <div id="wallet-balance" class="font-mono text-3xl font-bold text-emerald-400 tracking-tighter">—</div>
        <div class="text-xs text-[#64748b] mt-1">Your available balance on the LBRY network</div>
      </div>

      <!-- Receive -->
      <div class="bg-[#111114] border-2 border-[#27272a] rounded-3xl p-8">
        <div class="flex items-center gap-2 mb-2">
          <span class="text-lg">📥</span>
          <div class="text-lg font-semibold tracking-tight">Receive LBC</div>
        </div>
        <div class="flex gap-2 mb-3">
          <input id="receive-address" class="flex-1 bg-[#1e2937] border-2 border-[#334155] focus:border-[#14b8a6] rounded-2xl px-4 py-3 text-sm font-mono text-[#e2e8f0]" readonly placeholder="Your address" />
          <button id="copy-address" class="action-btn text-sm px-4 py-2 font-medium">Copy</button>
        </div>
        <button id="gen-address" class="action-btn text-sm px-4 py-2">Generate New Address</button>
        <div class="mt-8 pt-6 border-t border-[#27272a]">
          <div class="text-xs font-semibold text-[#94a3b8] mb-3">Recent Incoming</div>
          <div id="last-received" class="text-xs bg-[#0a0a0f] p-5 rounded-2xl min-h-[40px]"></div>
        </div>
      </div>

      <!-- Send -->
      <div class="bg-[#111114] border-2 border-[#27272a] rounded-3xl p-8">
        <div class="flex items-center gap-2 mb-2">
          <span class="text-lg">📤</span>
          <div class="text-lg font-semibold tracking-tight">Send LBC</div>
        </div>
        <input id="send-address" placeholder="Paste recipient address" class="w-full bg-[#1e2937] border-2 border-[#334155] focus:border-[#14b8a6] rounded-2xl px-4 py-3 text-sm mb-3 text-[#e2e8f0]" />
        <div class="flex gap-3 mb-2">
          <input id="send-amount" placeholder="0.00" class="flex-1 bg-[#1e2937] border-2 border-[#334155] focus:border-[#14b8a6] rounded-2xl px-4 py-3 text-sm text-[#e2e8f0]" />
          <button id="send-btn" class="action-btn teal text-sm px-5 py-3 font-semibold">Send Now</button>
        </div>
        <div class="text-xs text-[#64748b]">Network fee ≈ <span id="tx-fee" class="font-medium">0.0001</span> LBC</div>
        <div class="mt-8 pt-6 border-t border-[#27272a]">
          <div class="text-xs font-semibold text-[#94a3b8] mb-3">Recent Outgoing</div>
          <div id="last-sent" class="text-xs bg-[#0a0a0f] p-5 rounded-2xl min-h-[40px]"></div>
        </div>
      </div>

      <!-- History -->
      <div class="bg-[#111114] border-2 border-[#27272a] rounded-3xl p-8">
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2">
            <span class="text-lg">📜</span>
            <div class="text-lg font-semibold tracking-tight">History</div>
          </div>
        </div>
        <div id="tx-history" class="text-xs bg-[#0a0a0f] p-6 rounded-2xl max-h-48 overflow-auto leading-[1.5]">Loading recent activity...</div>
      </div>
    </div>
  `

  // Load data
  loadWalletData(c)
}

async function loadWalletData(c: HTMLElement) {
  try {
    // Balance
    const bal = await getWalletBalance()
    const balEl = c.querySelector('#wallet-balance') as HTMLElement
    if (balEl) balEl.textContent = `${bal.available || bal.total || '0'} LBC`

    // Receive address - per INTEGRATION.md returns string directly
    const addr = await getReceiveAddress()
    const addrStr = typeof addr === 'string' ? addr : (addr?.address || '')
    const addrInput = c.querySelector('#receive-address') as HTMLInputElement
    if (addrInput) addrInput.value = addrStr

    const copyBtn = c.querySelector('#copy-address')
    if (copyBtn) copyBtn.addEventListener('click', () => {
      const current = addrInput ? addrInput.value : ''
      if (current) { navigator.clipboard.writeText(current); /* toast */ }
    })

    const genBtn = c.querySelector('#gen-address')
    if (genBtn) genBtn.addEventListener('click', async () => {
      try {
        const newAddr = await getReceiveAddress()
        const addrStr = typeof newAddr === 'string' ? newAddr : (newAddr?.address || '')
        const currentInput = c.querySelector('#receive-address') as HTMLInputElement
        if (currentInput) currentInput.value = addrStr
      } catch(e) { console.error(e) }
    })

    // Last received/sent and history with real data
    const txs = await getTransactions(1, 15)
    const items: any[] = txs.items || txs || []

    const received = items.filter((t: any) => t.type === 'received' || parseFloat(t.amount) > 0).slice(0,3)
    const recvEl = c.querySelector('#last-received') as HTMLElement
    if (recvEl) recvEl.innerHTML = received.length ? received.map((t:any) => {
      const amt = t.amount || '0'
      const to = (t.to_address || '').slice(0,10)
      const short = (t.txid || '').slice(0,6)
      const addrPart = to && to !== 'unknown' ? ` to ${to}...` : ''
      return `${amt} LBC received${addrPart} <a href="https://explorer.lbry.com/tx/${t.txid}" target="_blank" class="text-[#14b8a6]" style="color:#14b8a6">${short}</a>`
    }).join('<br>') : 'None'

    const sent = items.filter((t: any) => t.to_address && t.to_address !== 'unknown').slice(0,3)
    const sentEl = c.querySelector('#last-sent') as HTMLElement
    if (sentEl) sentEl.innerHTML = sent.length ? sent.map((t:any) => {
      const amt = Math.abs(parseFloat(t.amount || 0))
      const to = (t.to_address || 'unknown').slice(0,8)
      const short = (t.txid || '').slice(0,6)
      return `${amt} LBC to ${to}... <a href="https://explorer.lbry.com/tx/${t.txid}" target="_blank" class="text-[#14b8a6]" style="color:#14b8a6">${short}</a>`
    }).join('<br>') : 'None'

    // History
    const histEl = c.querySelector('#tx-history') as HTMLElement
    if (histEl) {
      const list = items.slice(0,10).map((t:any) => {
        const amt = t.amount || '0'
        const to = (t.to_address || 'unknown').slice(0,10)
        const short = (t.txid || '').slice(0,8)
        const toPart = to && to !== 'unknown' ? `to ${to}... ` : ''
        return `${amt} LBC ${toPart}<a href="https://explorer.lbry.com/tx/${t.txid}" target="_blank" class="text-[#14b8a6]" style="color:#14b8a6">${short}</a>`
      }).join('<br>')
      histEl.innerHTML = list || 'No transactions'
      // add load more for 100
      if (!histEl.querySelector('#load-more-hist')) {
        const btn = document.createElement('button')
        btn.id = 'load-more-hist'
        btn.className = 'action-btn text-[9px] mt-1 px-1 py-0'
        btn.textContent = 'Load more (100)'
        btn.onclick = async () => {
          const big = await getTransactions(1, 100)
          const bigItems = big.items || big || []
          histEl.innerHTML = bigItems.map((t:any) => {
            const amt = t.amount || '0'
            const to = (t.to_address || 'unknown').slice(0,10)
            const short = (t.txid || '').slice(0,8)
            const toPart = to && to !== 'unknown' ? `to ${to}... ` : ''
            return `${amt} LBC ${toPart}<a href="https://explorer.lbry.com/tx/${t.txid}" target="_blank" class="text-[#14b8a6]" style="color:#14b8a6">${short}</a>`
          }).join('<br>')
        }
        histEl.appendChild(btn)
      }
    }

    // Send fee estimate (simple fixed for now) - value already in HTML
    const feeEl = c.querySelector('#tx-fee') as HTMLElement
    if (feeEl && !feeEl.textContent.includes('est')) feeEl.textContent = '0.0001 (est)'

    const sendBtn = c.querySelector('#send-btn')
    const sendAddr = c.querySelector('#send-address') as HTMLInputElement
    const sendAmt = c.querySelector('#send-amount') as HTMLInputElement
    if (sendBtn) sendBtn.addEventListener('click', async () => {
      if (!sendAddr?.value || !sendAmt?.value) return
      const amount = sendAmt.value
      const address = sendAddr.value
      const fee = '0.0001'
      const total = (parseFloat(amount) + parseFloat(fee)).toFixed(4)
      const confirmMsg = `Are you sure you want to send ${amount} LBC to ${address} with transaction fee of ${fee} LBC totalling a spend of ${total} LBC?`
      if (!confirm(confirmMsg)) return
      try {
        const result = await sendLBC(address, amount)
        alert('Transaction submitted!')
        // add to last sent
        addToLastSentPopup(c, address, amount, result?.txid || 'pending')
        loadWalletData(c)
      } catch(e: any) { alert('Send failed: ' + e.message) }
    })
  } catch (e) {
    console.error('Wallet load error', e)
    // show friendly if no wallet
  }
}

function addToLastSentPopup(c: HTMLElement, address: string, amount: string, txid: string) {
  const sentEl = c.querySelector('#last-sent') as HTMLElement
  if (!sentEl) return
  const div = document.createElement('div')
  div.className = 'text-[9px]'
  const short = (txid||'').slice(0,6)
  const link = `https://explorer.lbry.com/tx/${txid}`
  div.innerHTML = `Sent ${amount} to ${address.slice(0,6)} <a href="${link}" target="_blank" class="text-[#14b8a6]" style="color:#14b8a6">${short}</a> (0 conf)`
  sentEl.prepend(div)
  while (sentEl.children.length > 3) sentEl.removeChild(sentEl.lastChild!)
}

function renderUpload(c: HTMLElement) {
  c.innerHTML = `
    <div class="px-8 pt-7 pb-5">
      <div class="mb-8">
        <div class="font-semibold text-lg tracking-tight">Upload to LBRY</div>
        <div class="text-xs text-[#64748b] mt-0.5">Share your content on the decentralized web</div>
      </div>

      <!-- Sub-tabs -->
      <div class="flex gap-1 mb-8 p-1 bg-[#0a0a0f] rounded-3xl border border-[#27272a]">
        <button id="up-sub-content" class="sub-tab flex-1 py-2 text-sm font-medium">📁 Content</button>
        <button id="up-sub-mine" class="sub-tab flex-1 py-2 text-sm font-medium">📚 My Channels</button>
        <button id="up-sub-channel" class="sub-tab flex-1 py-2 text-sm font-medium">✨ New Channel</button>
      </div>

      <div id="up-content-panel">
        <div id="up-prev" class="border-2 border-dashed border-[#334155] hover:border-[#14b8a6] bg-[#111114] rounded-3xl min-h-[220px] mb-8 flex items-center justify-center overflow-hidden cursor-pointer active:opacity-90 transition-all">
          <div class="text-center text-sm text-[#64748b]">
            <div class="text-2xl mb-1">📤</div>
            Click or drop file here<br>
            <span class="text-[11px] opacity-70">(images, videos, audio, docs — any size)</span>
          </div>
        </div>
        <input type="file" id="up-file" class="hidden" accept="*/*" />
        <div id="up-file-info" class="text-xs text-[#64748b] mb-8 px-1"></div>

        <div class="space-y-8">
          <div>
            <div class="text-sm font-medium text-[#e2e8f0] mb-2">Title <span class="text-red-400">*</span></div>
            <input id="up-t" class="w-full bg-[#1e2937] border-2 border-[#334155] focus:border-[#14b8a6] rounded-2xl px-4 py-3 text-base" placeholder="Give your upload a catchy title">
          </div>
          <div>
            <div class="text-sm font-medium text-[#e2e8f0] mb-2">Description</div>
            <textarea id="up-d" class="w-full bg-[#1e2937] border-2 border-[#334155] focus:border-[#14b8a6] rounded-2xl px-4 py-3 text-base h-24 resize-y" placeholder="Tell the world what this is about (optional)"></textarea>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <div class="text-sm font-medium text-[#e2e8f0] mb-2">Publish to Channel</div>
              <select id="up-ch" class="w-full bg-[#1e2937] border-2 border-[#334155] focus:border-[#14b8a6] rounded-2xl px-4 py-3 text-base">
                <!-- Populated dynamically -->
              </select>
            </div>
            <div>
              <div class="text-sm font-medium text-[#e2e8f0] mb-2">Stake Amount (LBC)</div>
              <input id="up-b" value="0.01" class="w-full bg-[#1e2937] border-2 border-[#334155] focus:border-[#14b8a6] rounded-2xl px-4 py-3 text-base text-center" title="Bid / stake">
            </div>
          </div>
          <div>
            <div class="text-sm font-medium text-[#e2e8f0] mb-2">Custom Thumbnail URL (optional)</div>
            <input id="up-thumb" placeholder="https://example.com/my-thumb.jpg" class="w-full bg-[#1e2937] border-2 border-[#334155] focus:border-[#14b8a6] rounded-2xl px-4 py-3 text-base">
          </div>
        </div>
      </div>

      <div id="up-channel-panel" style="display:none">
        <div class="space-y-8">
          <div>
            <div class="text-sm font-medium text-[#e2e8f0] mb-2">Channel Handle <span class="text-red-400">*</span></div>
            <input id="up-channel-name" placeholder="@your-awesome-channel" class="w-full bg-[#1e2937] border-2 border-[#334155] focus:border-[#14b8a6] rounded-2xl px-4 py-3 text-base">
          </div>
          <div>
            <div class="text-sm font-medium text-[#e2e8f0] mb-2">Display Title <span class="text-red-400">*</span></div>
            <input id="up-channel-title" class="w-full bg-[#1e2937] border-2 border-[#334155] focus:border-[#14b8a6] rounded-2xl px-4 py-3 text-base" placeholder="Your Channel Title">
          </div>
          <div>
            <div class="text-sm font-medium text-[#e2e8f0] mb-2">Description</div>
            <textarea id="up-channel-desc" class="w-full bg-[#1e2937] border-2 border-[#334155] focus:border-[#14b8a6] rounded-2xl px-4 py-3 text-base h-24 resize-y" placeholder="What is this channel about?"></textarea>
          </div>
          <div>
            <div class="text-sm font-medium text-[#e2e8f0] mb-2">Initial Stake (LBC)</div>
            <input id="up-channel-bid" value="0.1" class="w-40 bg-[#1e2937] border-2 border-[#334155] focus:border-[#14b8a6] rounded-2xl px-4 py-3 text-base" title="Stake amount">
          </div>
        </div>
      </div>

      <div id="up-my-channels-panel" style="display:none">
        <div class="mb-4">
          <div class="text-base font-semibold">Your Owned Channels</div>
          <div class="text-xs text-[#64748b]">Select to manage or view</div>
        </div>
        <div id="up-my-channels-list" class="space-y-3 text-sm"></div>
      </div>

      <div class="flex gap-3 mt-16 pt-7 border-t border-[#27272a]">
        <button id="up-c" class="flex-1 py-3.5 text-sm border-2 border-[#334155] hover:bg-[#1e2937] rounded-2xl transition font-medium">Cancel</button>
        <button id="up-p" class="flex-1 py-3.5 action-btn teal text-sm font-semibold">🚀 Publish</button>
      </div>
      <div class="text-[11px] text-center text-[#64748b] mt-8">Real publishes use Companion + wallet. Otherwise saved locally.</div>
    </div>`

  let selectedFile: File | null = null
  const prev = document.getElementById('up-prev')!
  const fileInp = document.getElementById('up-file') as HTMLInputElement
  const fileInfo = document.getElementById('up-file-info')!
  const titleIn = document.getElementById('up-t') as HTMLInputElement
  const descIn = document.getElementById('up-d') as HTMLTextAreaElement
  const chIn = document.getElementById('up-ch') as HTMLSelectElement
  const bidIn = document.getElementById('up-b') as HTMLInputElement
  const thumbIn = document.getElementById('up-thumb') as HTMLInputElement | null

  const subContentBtn = document.getElementById('up-sub-content')!
  const subMineBtn = document.getElementById('up-sub-mine')!
  const subChannelBtn = document.getElementById('up-sub-channel')!
  const contentPanel = document.getElementById('up-content-panel')!
  const channelPanel = document.getElementById('up-channel-panel')!
  const minePanel = document.getElementById('up-my-channels-panel')!

  const channelNameIn = document.getElementById('up-channel-name') as HTMLInputElement
  const channelTitleIn = document.getElementById('up-channel-title') as HTMLInputElement
  const channelDescIn = document.getElementById('up-channel-desc') as HTMLTextAreaElement
  const channelBidIn = document.getElementById('up-channel-bid') as HTMLInputElement

  let currentUploadSub: 'content' | 'mine' | 'channel' = 'content'

  function switchUploadSub(view: 'content' | 'mine' | 'channel') {
    currentUploadSub = view
    contentPanel.style.display = view === 'content' ? '' : 'none'
    minePanel.style.display = view === 'mine' ? '' : 'none'
    channelPanel.style.display = view === 'channel' ? '' : 'none'
    subContentBtn.classList.toggle('active', view === 'content')
    subMineBtn.classList.toggle('active', view === 'mine')
    subChannelBtn.classList.toggle('active', view === 'channel')
    if (view === 'mine') {
      loadMyChannelsForUploadPopup()
    }
  }

  subContentBtn.onclick = () => switchUploadSub('content')
  subMineBtn.onclick = () => switchUploadSub('mine')
  subChannelBtn.onclick = () => switchUploadSub('channel')
  switchUploadSub('content')

  function updatePreview(file: File) {
    selectedFile = file
    fileInfo.textContent = `${file.name} (${(file.size/1024/1024).toFixed(2)}MB)`
    const url = URL.createObjectURL(file)
    if (file.type.startsWith('image/')) {
      prev.innerHTML = `<img src="${url}" class="max-h-full object-contain">`
    } else if (file.type.startsWith('video/')) {
      prev.innerHTML = `<video src="${url}" class="max-h-full" controls></video>`
    } else {
      prev.innerHTML = `<div class="text-center text-xs">📄 ${file.name}</div>`
    }
  }

  prev.onclick = () => fileInp.click()
  fileInp.onchange = () => {
    if (fileInp.files?.[0]) updatePreview(fileInp.files[0])
  }

  // basic drop support on preview
  prev.ondragover = e => { e.preventDefault() }
  prev.ondrop = e => {
    e.preventDefault()
    if (e.dataTransfer?.files[0]) updatePreview(e.dataTransfer.files[0])
  }

  // Load owned channels into <select> dropdown for Upload content. Default = Anonymous (publish without a channel)
  ;(async () => {
    try {
      const resp = await getChannels()
      const items = (resp && resp.items) || (Array.isArray(resp) ? resp : [])
      const sel = document.getElementById('up-ch') as HTMLSelectElement
      sel.innerHTML = ''

      const anon = document.createElement('option')
      anon.value = ''
      anon.textContent = 'Anonymous'
      sel.appendChild(anon)

      items.forEach((item: any) => {
        let chName = item.name || (item.value && item.value.name) || ''
        if (!chName.startsWith('@')) chName = '@' + chName
        const opt = document.createElement('option')
        opt.value = chName
        if (item.claim_id) opt.dataset.claimId = item.claim_id
        const stake = item.amount ? parseFloat(item.amount).toFixed(2) : ''
        opt.textContent = stake ? `${chName} (staked ${stake})` : chName
        sel.appendChild(opt)
      })
      sel.value = ''
    } catch (e) {
      console.warn('Failed to load owned channels for upload dropdown', e)
      const sel = document.getElementById('up-ch') as HTMLSelectElement
      if (sel && sel.options.length === 0) {
        const o = document.createElement('option'); o.value = ''; o.textContent = 'Anonymous'; sel.appendChild(o); sel.value = ''
      }
    }
  })()

  async function loadMyChannelsForUploadPopup() {
    const list = document.getElementById('up-my-channels-list')!
    list.innerHTML = '<div class="text-[10px] text-[#64748b]">Loading...</div>'
    try {
      const resp = await getChannels()
      const items: any[] = (resp && resp.items) || (Array.isArray(resp) ? resp : [])
      list.innerHTML = ''
      if (items.length === 0) {
        list.innerHTML = '<div class="text-[10px] text-[#64748b]">No owned channels.</div>'
        return
      }
      items.forEach((item: any) => {
        let chName = item.name || (item.value && item.value.name) || ''
        if (!chName.startsWith('@')) chName = '@' + chName
        const title = item.value?.title || chName
        const staked = parseFloat(item.amount || (item.meta && item.meta.support_amount) || 0).toFixed(2)
        const div = document.createElement('div')
        div.className = 'p-1 border border-[#334155] rounded cursor-pointer'
        div.innerHTML = `<span class="font-medium">${title}</span> <span class="text-[9px] text-[#64748b]">${chName} (${staked})</span>`
        div.onclick = () => {
          const uri = item.canonical_url || `lbry://${chName}`
          navigator.clipboard.writeText(uri)
          // switch to channels my for full view if wanted
          currentTab = 'channels'
          updateTabs()
          renderContent()
          // after render, the channels sub can be switched by user; we pre-set no state here
        }
        list.appendChild(div)
      })
    } catch (e) {
      list.innerHTML = '<div class="text-[10px] text-[#64748b]">Failed to load (need Companion).</div>'
    }
  }

  // Prefill from right-click context (when Quick Upload is disabled in settings)
  if (pendingUploadImage) {
    const p = pendingUploadImage
    pendingUploadImage = null
    ;(async () => {
      try {
        let f: File | null = null
        if (p.dataUrl) {
          const blob = await (await fetch(p.dataUrl)).blob()
          f = new File([blob], p.name || 'image.jpg', { type: blob.type || 'image/jpeg' })
        }
        if (f) {
          selectedFile = f
          updatePreview(f)
        }
        if (titleIn) titleIn.value = (p.name || 'image').replace(/\.[^/.]+$/, '')
        if (descIn) descIn.value = 'Uploaded using ReviveL'
        if (chIn) chIn.value = ''  // Anonymous
      } catch (e) { console.warn('prefill from context failed', e) }
    })()
  }

  document.getElementById('up-c')!.onclick = () => renderContent()

  document.getElementById('up-p')!.onclick = async () => {
    if (currentUploadSub === 'mine') {
      alert('Switch to "Create channel" sub-tab to create a new channel, or "Upload content" to publish media.')
      return
    }
    const isChannel = currentUploadSub === 'channel'
    if (!isChannel) {
      if (!titleIn.value.trim()) { alert('Title required'); return }
      if (!selectedFile) { alert('Select a file'); return }
    } else {
      if (!channelNameIn.value.trim()) { alert('Channel name required'); return }
      if (!channelTitleIn.value.trim()) { alert('Title required'); return }
    }

    const t = isChannel ? channelTitleIn.value.trim() : titleIn.value.trim()
    const d = isChannel ? channelDescIn.value.trim() : descIn.value.trim()
    const ch = isChannel ? channelNameIn.value.trim() : (chIn.value || '')   // '' = Anonymous, no channel
    const b = isChannel ? (channelBidIn.value || '0.1') : (bidIn.value || '0.01')
    const thumbUrl = (thumbIn && thumbIn.value.trim()) || ''

    const btn = document.getElementById('up-p') as HTMLButtonElement
    const originalText = btn.textContent || 'Publish'
    btn.disabled = true
    btn.textContent = 'Publishing...'
    btn.classList.add('opacity-50', 'cursor-not-allowed')

    let useRealPublish = false
    try {
      const st = await new Promise<any>(r => chrome.runtime.sendMessage({ type: 'getDaemonStatus' }, r))
      useRealPublish = !!(st?.connected && st?.walletReady)
    } catch {}

    let chForRpc = ch
    if (isChannel && !chForRpc.startsWith('@')) {
      chForRpc = '@' + chForRpc
    }
    const nameBase = chForRpc.replace(/^@/, '').toLowerCase().replace(/\s/g, '-')
    const name = isChannel ? chForRpc : t.toLowerCase().replace(/\s/g, '-')
    const uri = isChannel ? `lbry://@${nameBase}` : (ch ? `lbry://${ch.replace('@','')}/${name}` : `lbry://${name}`)

    let realSucceeded = !useRealPublish
    let pubResult: any = null
    if (useRealPublish) {
      try {
        if (!isChannel) {
          const stagedPath = await stageFile(selectedFile)
          const pubParams: any = {
            name,
            bid: b,
            title: t,
            description: d,
            file_path: stagedPath
            // file_name / file_size / file_type not sent to stream_create (daemon infers from file)
          }
          if (ch) pubParams.channel_name = ch
          if (thumbUrl) pubParams.thumbnail = { url: thumbUrl }
          pubResult = await publishStream(pubParams)
        } else {
          pubResult = await publishStream({
            name,
            bid: b,
            title: t,
            description: d,
            create_channel: true
          })
        }
        realSucceeded = true
      } catch (e) {
        console.warn('Real publish may require Companion file support for large/video', e)
        alert('Staging or publish failed: ' + (e as any)?.message || e)
        realSucceeded = false
      }
    }

    if (!realSucceeded) {
      btn.disabled = false
      btn.textContent = originalText
      btn.classList.remove('opacity-50', 'cursor-not-allowed')
      return
    }

    // Save to Library (or local record after real success)
    await loadLibrary()
    const dataUrl = (!isChannel && selectedFile && (selectedFile.type.startsWith('image/') || selectedFile.size < 2*1024*1024))
      ? await new Promise<string>(r => { const fr=new FileReader(); fr.onload=()=>r(fr.result as string); fr.readAsDataURL(selectedFile!) })
      : null
    library.unshift({
      id: Date.now().toString(),
      title: t,
      description: d,
      imageData: dataUrl || 'https://picsum.photos/id/160/320/180',
      lbryUri: uri,
      channel: ch || 'Anonymous',
      date: 'just now',
      fileName: isChannel ? null : (selectedFile ? selectedFile.name : null),
      fileType: isChannel ? 'channel' : (selectedFile ? selectedFile.type : null)
    } as any)
    await saveLibrary()

    let displayUri = uri
    if (pubResult && pubResult.claim_id) {
      displayUri = uri.includes('#') ? uri : `${uri}#${pubResult.claim_id}`
    }
    let explorerUrl = `https://explorer.lbry.com/${displayUri.replace('lbry://', '')}`
    if (pubResult && pubResult.txid) {
      explorerUrl = `https://explorer.lbry.com/tx/${pubResult.txid}`
    }
    const playerUrl = chrome.runtime.getURL('player.html') + '?uri=' + encodeURIComponent(displayUri)
    c.innerHTML = `
      <div class="text-center py-4 px-2">
        <div class="text-emerald-400 text-4xl mb-2">✓</div>
        <div class="font-semibold text-sm">${useRealPublish ? 'Published to LBRY network' : 'Saved to Library'}</div>
        <a href="${playerUrl}" target="_blank" class="font-mono text-xs text-[#14b8a6] mt-1 mb-1 break-all bg-[#0a0a0f] p-1.5 rounded hover:underline block" style="color:#14b8a6">${displayUri}</a>
        <a href="${explorerUrl}" target="_blank" class="text-xs text-[#14b8a6] underline mb-2 inline-block" style="color:#14b8a6">View on Explorer →</a>
        <div class="flex gap-2">
          <button id="cpy" class="flex-1 action-btn py-1.5 text-xs">Copy URI</button>
          <button id="vlt" class="flex-1 action-btn teal py-1.5 text-xs">View in Library</button>
        </div>
        <div class="mt-2 text-[11px] text-[#64748b] flex items-center justify-center gap-x-1">
          <span class="px-1.5 py-0.5 rounded bg-[#1e2937] text-[#94a3b8] text-[10px]">${ch || 'Anonymous'}</span>
          <span>•</span>
          <span>${useRealPublish ? 'Published via Companion' : 'Saved to Library'}</span>
        </div>
      </div>`

    document.getElementById('cpy')!.onclick = () => { navigator.clipboard.writeText(displayUri); /* toast */ }
    document.getElementById('vlt')!.onclick = () => { currentTab = 'library'; currentLibSub = 'uploads'; updateTabs(); renderContent() }
  }
}

// Play using beautiful floating overlay on current page (no new tab)
function playInOverlay(uri: string, title?: string, ch?: string) {
  if (title) addToHistory(uri, title, ch).catch(() => {})
  chrome.runtime.sendMessage({ 
    type: 'playInOverlay', 
    uri 
  });
}

// Legacy kept for "Full Player" button
function openFullPlayer(uri?: string, searchQuery?: string) {
  const base = chrome.runtime.getURL('player.html')
  const params = new URLSearchParams()
  if (uri) params.set('uri', uri)
  if (searchQuery) params.set('search', searchQuery)
  const qs = params.toString()
  const url = qs ? `${base}?${qs}` : base
  chrome.tabs.create({ url })
}

// Automatic Quick Upload for right-click images (when setting enabled)
async function doQuickUploadAuto(imgData: string | null, suggestedName: string) {
  const c = document.getElementById('content-area')!
  currentTab = 'upload'
  updateTabs()
  c.innerHTML = `<div class="p-4 text-xs text-center text-[#64748b]">Quick uploading <span class="font-mono">${suggestedName}</span> (Anonymous)...</div>`

  let file: File | null = null
  if (imgData) {
    try {
      const blob = await (await fetch(imgData)).blob()
      file = new File([blob], suggestedName, { type: blob.type || 'image/jpeg' })
    } catch (e) { console.warn('quick fetch failed', e) }
  }
  if (!file) {
    c.innerHTML = `<div class="p-3 text-xs text-red-400">Failed to load the image data for quick upload.</div>`
    return
  }

  const title = suggestedName.replace(/\.[^/.]+$/, '') || 'Untitled'
  const desc = 'Uploaded using ReviveL'
  const ch = '' // Anonymous

  try {
    let useRealPublish = false
    try {
      const st = await new Promise<any>(r => chrome.runtime.sendMessage({ type: 'getDaemonStatus' }, r))
      useRealPublish = !!(st?.connected && st?.walletReady)
    } catch {}

    let stagedPath = ''
    if (useRealPublish) {
      try {
        stagedPath = await stageFile(file)
      } catch (e) {
        console.warn('Staging failed for quick upload', e)
      }
    }

    const nameSlug = title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    const uri = `lbry://${nameSlug}`

    let pubResult: any = null
    if (useRealPublish && stagedPath) {
      try {
        const pubParams: any = {
          name: nameSlug,
          bid: '0.0001',
          title,
          description: desc,
          file_path: stagedPath,
          file_name: file.name,
          file_size: file.size
        }
        // no channel_name => Anonymous
        pubResult = await publishStream(pubParams)
      } catch (e) {
        console.warn('Quick publish real failed (will still save to Library)', e)
      }
    }

    let displayUri = uri
    if (pubResult && pubResult.claim_id) {
      displayUri = `lbry://${nameSlug}#${pubResult.claim_id}`
    }

    // Save to Library for local record / history
    await loadLibrary()
    const dataUrl = imgData || 'https://picsum.photos/id/160/320/180'
    library.unshift({
      id: Date.now().toString(),
      title,
      description: desc,
      imageData: dataUrl,
      lbryUri: displayUri,
      channel: 'Anonymous',
      date: 'just now',
      fileName: file.name,
      fileType: file.type
    } as any)
    await saveLibrary()

    let explorerUrl = `https://explorer.lbry.com/${displayUri.replace('lbry://', '')}`
    if (pubResult && pubResult.txid) {
      explorerUrl = `https://explorer.lbry.com/tx/${pubResult.txid}`
    }
    const playerUrl = chrome.runtime.getURL('player.html') + '?uri=' + encodeURIComponent(displayUri)

    c.innerHTML = `
      <div class="text-center py-4 px-2">
        <div class="text-emerald-400 text-4xl mb-2">✓</div>
        <div class="font-semibold text-sm">Uploaded successfully</div>
        <a href="${playerUrl}" target="_blank" class="font-mono text-xs text-[#14b8a6] mt-1 mb-1 break-all bg-[#0a0a0f] p-1 rounded hover:underline block" style="color:#14b8a6">${displayUri}</a>
        <a href="${explorerUrl}" target="_blank" class="text-xs text-[#14b8a6] underline mb-2 inline-block" style="color:#14b8a6">View on Explorer →</a>
        <div class="mt-2 text-[11px] text-[#64748b] flex items-center justify-center gap-x-1">
          <span class="px-1.5 py-0.5 rounded bg-[#1e2937] text-[#94a3b8] text-[10px]">Anonymous</span>
          <span>•</span>
          <span>${useRealPublish ? 'Published via Companion' : 'Saved to Library'}</span>
        </div>
        <div class="flex gap-2 mt-3">
          <button id="q-cpy" class="flex-1 action-btn py-1.5 text-xs">Copy URI</button>
          <button id="q-vlt" class="flex-1 action-btn teal py-1.5 text-xs">View in Library</button>
        </div>
      </div>`

    document.getElementById('q-cpy')!.onclick = () => { navigator.clipboard.writeText(displayUri) }
    document.getElementById('q-vlt')!.onclick = () => { currentTab = 'library'; currentLibSub = 'uploads'; updateTabs(); renderContent() }
  } catch (e: any) {
    c.innerHTML = `<div class="p-3 text-xs text-red-400">Quick upload error: ${e?.message || e}</div>`
  }
}

async function handleUpload(imgData: string | null = null, name = '') {
  const c = document.getElementById('content-area')!
  c.innerHTML = `
    <div class="px-4 pt-3">
      <div class="mb-4">
        <div class="font-semibold text-base">Quick Publish</div>
        <div class="text-xs text-[#64748b]">From context menu / quick action</div>
      </div>
      <div id="up-prev" class="border-2 border-dashed border-[#334155] bg-[#111114] rounded-3xl h-40 mb-4 flex items-center justify-center overflow-hidden cursor-pointer active:opacity-90">
        ${imgData ? `<img src="${imgData}" class="max-h-full object-contain">` : `<div class="text-center text-sm text-[#64748b]"><div class="text-xl mb-1">🖼️</div>Click to choose image<br><span class="text-[10px]">or drag &amp; drop</span></div>`}
      </div>
      
      <div class="space-y-4">
        <div>
          <div class="text-sm font-medium mb-1">Title</div>
          <input id="up-t" value="${name}" class="w-full bg-[#1e2937] border-2 border-[#334155] focus:border-[#14b8a6] rounded-2xl px-4 py-3 text-sm" placeholder="Title">
        </div>
        <div>
          <div class="text-sm font-medium mb-1">Description</div>
          <textarea id="up-d" class="w-full bg-[#1e2937] border-2 border-[#334155] focus:border-[#14b8a6] rounded-2xl px-4 py-3 text-sm h-16 resize-y" placeholder="Description (optional)"></textarea>
        </div>
        
        <div class="grid grid-cols-2 gap-3">
          <div>
            <div class="text-sm font-medium mb-1">Channel</div>
            <select id="up-ch" class="w-full bg-[#1e2937] border-2 border-[#334155] focus:border-[#14b8a6] rounded-2xl px-4 py-3 text-sm">
              <option value="">Anonymous</option>
            </select>
          </div>
          <div>
            <div class="text-sm font-medium mb-1">Bid</div>
            <input id="up-b" value="0.01" class="w-full bg-[#1e2937] border-2 border-[#334155] focus:border-[#14b8a6] rounded-2xl px-4 py-3 text-sm text-center" title="Bid">
          </div>
        </div>
      </div>

      <div class="flex gap-3 mt-6">
        <button id="up-c" class="flex-1 py-3 text-sm border-2 border-[#334155] hover:bg-[#1e2937] rounded-2xl transition">Cancel</button>
        <button id="up-p" class="flex-1 py-3 action-btn teal text-sm">Publish</button>
      </div>
      <div class="text-[10px] text-center text-[#64748b] mt-3">Assisted mode. Use full Upload tab for more options.</div>
    </div>`

  const prev = document.getElementById('up-prev')!
  if (!imgData) prev.onclick = () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'
    inp.onchange = () => { if (inp.files?.[0]) { const fr = new FileReader(); fr.onload = e => handleUpload(e.target?.result as string, inp.files![0].name); fr.readAsDataURL(inp.files[0]) } }; inp.click()
  }

  document.getElementById('up-c')!.onclick = () => renderContent()

  // Populate channel dropdown for legacy quick-upload (best effort)
  ;(async () => {
    try {
      const resp = await getChannels()
      const items = (resp && resp.items) || (Array.isArray(resp) ? resp : [])
      const sel = document.getElementById('up-ch') as HTMLSelectElement
      if (sel) {
        sel.innerHTML = '<option value="">Anonymous</option>'
        items.forEach((item: any) => {
          let nm = item.name || (item.value && item.value.name) || ''
          if (nm && !nm.startsWith('@')) nm = '@' + nm
          const o = document.createElement('option')
          o.value = nm
          o.textContent = nm
          sel.appendChild(o)
        })
        sel.value = ''
      }
    } catch {}
  })()

  document.getElementById('up-p')!.onclick = async () => {
    const t = (document.getElementById('up-t') as HTMLInputElement).value || 'Untitled Revival'
    const chEl = document.getElementById('up-ch') as HTMLSelectElement
    const ch = chEl ? chEl.value : ''
    const desc = (document.getElementById('up-d') as HTMLTextAreaElement).value
    const btn = document.getElementById('up-p') as HTMLButtonElement
    const originalText = btn.innerHTML || 'Publish'
    btn.disabled = true
    btn.innerHTML = 'Publishing...'
    btn.classList.add('opacity-50', 'cursor-not-allowed')

    // Check if we have a real daemon with wallet (Companion)
    let useRealPublish = false
    try {
      const st = await new Promise<any>(r => chrome.runtime.sendMessage({ type: 'getDaemonStatus' }, r))
      useRealPublish = !!(st?.connected && st?.walletReady)
    } catch {}

    if (useRealPublish) {
      btn.innerHTML = 'Publishing to LBRY network...'
    }
    await new Promise(r => setTimeout(r, 800))

    const cid = Math.random().toString(36).slice(2,9)
    const uri = ch ? `lbry://${ch.replace('@','')}/${t.toLowerCase().replace(/\s/g,'-')}#${cid}` : `lbry://${t.toLowerCase().replace(/\s/g,'-')}#${cid}`

    let realResult: any = null
    if (useRealPublish) {
      try {
        // Note: real stream_create usually needs a local file_path visible to the daemon.
        // For images from web we fall back to mock + note.
        // Here we attempt; user running Companion can place files in a watched dir if needed.
        realResult = await new Promise<any>((resolve, reject) => {
          // Simplified: call with basic params. In practice more fields needed (bid, etc).
          chrome.runtime.sendMessage({
            type: 'publish',
            params: {
              name: t.toLowerCase().replace(/\s/g, '-'),
              file_path: null, // would be local path in full impl
              bid: '0.0001',
              title: t,
              description: desc,
              ...(ch ? { channel_name: ch } : {})
            }
          }, (resp: any) => {
            if (resp?.ok) resolve(resp.result)
            else reject(resp?.error || 'publish failed')
          })
        })
      } catch (e) {
        console.warn('Real publish attempt failed (expected for browser-uploaded files):', e)
        btn.disabled = false
        btn.innerHTML = originalText
        btn.classList.remove('opacity-50', 'cursor-not-allowed')
        // continue with local library entry
      }
    }

    library.unshift({id: Date.now().toString(), title: t, description: desc, imageData: imgData || 'https://picsum.photos/id/160/320/180', lbryUri: uri, channel: ch || 'Anonymous', date: 'just now'})
    await saveLibrary()

    const displayUri = realResult && realResult.claim_id ? `${uri}#${realResult.claim_id}` : uri
    let explorerUrl = `https://explorer.lbry.com/${displayUri.replace('lbry://', '')}`
    if (realResult && realResult.txid) {
      explorerUrl = `https://explorer.lbry.com/tx/${realResult.txid}`
    }
    const playerUrl = chrome.runtime.getURL('player.html') + '?uri=' + encodeURIComponent(displayUri)
    const successHtml = realResult 
      ? `<div class="text-emerald-400 text-5xl mb-3">✓</div>
         <div class="font-semibold text-lg">Published via ReviveL Companion!</div>
         <a href="${playerUrl}" target="_blank" class="font-mono text-xs text-[#14b8a6] mt-2 mb-1 break-all bg-[#0a0a0f] p-1.5 rounded hover:underline block" style="color:#14b8a6">${displayUri}</a>
         <a href="${explorerUrl}" target="_blank" class="text-xs text-[#14b8a6] underline mb-2 inline-block" style="color:#14b8a6">View on Explorer →</a>`
      : `<div class="text-emerald-400 text-4xl mb-2">✓</div>
         <div class="font-semibold text-sm">Saved to Library</div>
         <a href="${playerUrl}" target="_blank" class="font-mono text-xs text-[#14b8a6] mt-1 mb-1 break-all bg-[#0a0a0f] p-1.5 rounded hover:underline block" style="color:#14b8a6">${uri}</a>
         <a href="${explorerUrl}" target="_blank" class="text-xs text-[#14b8a6] underline mb-2 inline-block" style="color:#14b8a6">View on Explorer →</a>`

    c.innerHTML = `
      <div class="text-center py-4 px-2">
        ${successHtml}
        <div class="flex gap-2">
          <button id="cpy" class="flex-1 action-btn py-1.5 text-xs">Copy URI</button>
          <button id="vlt" class="flex-1 action-btn teal py-1.5 text-xs">View in Library</button>
        </div>
        <div class="mt-2 text-[11px] text-[#64748b] flex items-center justify-center gap-x-1">
          <span class="px-1.5 py-0.5 rounded bg-[#1e2937] text-[#94a3b8] text-[10px]">${ch || 'Anonymous'}</span>
          <span>•</span>
          <span>${useRealPublish ? 'Published via Companion' : 'Saved to Library'}</span>
        </div>
      </div>`

    document.getElementById('cpy')!.onclick = () => { navigator.clipboard.writeText(realResult ? (realResult.permanent_url || displayUri) : displayUri); showToast('URI copied') }
    document.getElementById('vlt')!.onclick = () => { currentTab = 'library'; currentLibSub = 'uploads'; updateTabs(); renderContent() }
  }
}

function updateTabs() {
  document.querySelectorAll('.tab-btn').forEach(b => {
    const active = (b as HTMLElement).dataset.tab === currentTab
    b.classList.toggle('tab-active', active)
    b.classList.toggle('text-white', active)
    b.classList.toggle('text-[#64748b]', !active)
  })
}

function showToast(m: string) {
  const t = document.createElement('div')
  t.className = 'fixed bottom-4 left-1/2 bg-[#111114] border border-[#27272a] text-xs px-3 py-1 rounded-2xl -translate-x-1/2 shadow'
  t.textContent = m
  document.body.appendChild(t)
  setTimeout(() => t.remove(), 2100)
}

// In-popup premium Settings (replaces separate options page for primary UX)
function showSettings() {
  const c = document.getElementById('content-area')!
  c.innerHTML = `
    <div class="px-6 py-4">
      <div class="font-semibold text-base mb-6">Settings</div>

      <!-- Connection Status -->
      <div class="bg-[#111114] border border-[#27272a] rounded-3xl p-8 mb-8">
        <div class="flex items-center justify-between mb-2">
          <div class="text-[10px] font-medium text-[#64748b]">Connection Status</div>
          <button id="refresh-status" class="text-[9px] px-1.5 py-0.5 action-btn">Refresh</button>
        </div>

        <div id="detailed-status" class="text-xs space-y-1">
          <div class="flex justify-between"><span class="text-[#64748b]">Status</span><span id="det-status-text" class="font-medium">Checking...</span></div>
          <div class="flex justify-between"><span class="text-[#64748b]">Endpoint</span><span id="det-endpoint" class="font-mono text-[10px] break-all"></span></div>
          <div class="flex justify-between"><span class="text-[#64748b]">Type</span><span id="det-type" class="font-medium"></span></div>
          <div class="flex justify-between"><span class="text-[#64748b]">Wallet</span><span id="det-wallet" class="font-medium"></span></div>
          <div class="flex justify-between"><span class="text-[#64748b]">Blocks</span><span id="det-blocks" class="font-mono text-[10px]"></span></div>
          <div class="flex justify-between"><span class="text-[#64748b]">SPV</span><span id="det-spv" class="font-mono text-[10px]"></span></div>
          <div class="flex justify-between"><span class="text-[#64748b]">Balance</span><span id="det-balance" class="font-mono text-[10px] text-emerald-400">—</span></div>
        </div>

        <div class="mt-6 pt-6 border-t border-[#27272a]">
          <div class="text-xs text-[#64748b] mb-2">Daemon RPC URL</div>
          <input id="set-daemon" class="w-full bg-[#1e2937] border border-[#334155] rounded-xl px-4 py-2.5 text-xs font-mono" placeholder="http://127.0.0.1:5279">
          <div class="text-[9px] text-[#14b8a6] mt-1.5">Auto from Companion. Edit + Save.</div>
          <div class="flex gap-2 mt-3">
            <button id="detect-companion-btn" class="flex-1 py-2 text-xs action-btn">Re-Detect</button>
            <button id="set-save" class="flex-1 py-2 text-xs action-btn teal">Save</button>
          </div>
        </div>
      </div>

      <div class="text-xs text-[#64748b] px-1 leading-relaxed mb-7">
        Full features require the <strong>ReviveL Companion</strong>.
      </div>

      <!-- Content Filter (NSFW) -->
      <div class="bg-[#111114] border border-[#27272a] rounded-3xl p-8 mb-8">
        <div class="text-xs font-medium text-[#64748b] mb-2">Content Filter</div>
        <label class="flex items-center gap-2 cursor-pointer text-sm">
          <input type="checkbox" id="popup-show-nsfw" class="w-4 h-4 accent-[#14b8a6]">
          <span>Show NSFW / adult content</span>
        </label>
        <div class="text-xs text-[#64748b] mt-2 pl-6 leading-snug">Affects all video lists (Feed, Latest, Search). Off = hide mature/nsfw tags.</div>
      </div>

      <!-- Right-Click Quick Upload -->
      <div class="bg-[#111114] border border-[#27272a] rounded-3xl p-8 mb-8">
        <div class="text-xs font-medium text-[#64748b] mb-2">Right-Click Quick Upload</div>
        <label class="flex items-center gap-2 cursor-pointer text-sm">
          <input type="checkbox" id="quick-upload-enabled" class="w-4 h-4 accent-[#14b8a6]">
          <span>Enable automatic Quick Upload (recommended)</span>
        </label>
        <div class="text-xs text-[#64748b] mt-2 pl-6 leading-snug">
          ON (default): Right-click → "Upload image to ReviveL" does automatic upload.<br>
          Title = filename, Description = "Uploaded using ReviveL", Channel = Anonymous.<br>
          OFF: Opens the Upload tab for manual title / description / channel choice.
        </div>
      </div>

      <!-- Wallet Config -->
      <div class="bg-[#111114] border border-[#27272a] rounded-3xl p-8 mb-8">
        <div class="text-xs font-medium text-[#64748b] mb-3">Wallet Config</div>
        <div class="flex gap-2 mb-3">
          <button id="wallet-create-btn" class="flex-1 py-2.5 text-xs action-btn">Create Wallet</button>
          <button id="wallet-close-btn" class="flex-1 py-2.5 text-xs action-btn">Close Wallet</button>
          <button id="wallet-delete-btn" class="flex-1 py-2.5 text-xs action-btn" style="background:#7f1d1d;border-color:#991b1b;color:#fca5a5">Delete Wallet</button>
        </div>
        <div id="wallet-seed" class="text-xs font-mono bg-[#0a0a0f] p-2.5 rounded break-all hidden"></div>
        <div id="wallet-delete-warning" class="text-xs text-red-400 mt-2 hidden"></div>
      </div>

      <!-- Reset View Data -->
      <div class="bg-[#111114] border border-[#27272a] rounded-3xl p-8 mt-6">
        <div class="mb-4">
          <div class="text-sm font-semibold tracking-wide">Reset View Data & Caches</div>
          <div class="text-xs text-[#64748b] mt-2">Clears cached feeds (Latest etc), library (uploads), vault (saved), and history (recently watched).</div>
        </div>
        <button id="reset-data-btn" class="action-btn flex-1 justify-center bg-red-900 border-red-700 text-red-300 hover:bg-red-800">Reset All View Data & Caches</button>
      </div>
    </div>
  `

  const input = document.getElementById('set-daemon') as HTMLInputElement
  const saveBtn = document.getElementById('set-save')! as HTMLButtonElement
  const refreshBtn = document.getElementById('refresh-status')! as HTMLButtonElement
  const detectBtn = document.getElementById('detect-companion-btn')! as HTMLButtonElement

  function renderDetailedStatus(s: any) {
    const set = (id: string, val: string, cls = '') => {
      const el = document.getElementById(id)
      if (el) { el.textContent = val; if (cls) el.className = cls }
    }

    if (!s) {
      set('det-status-text', 'Unknown', 'text-red-400')
      set('det-endpoint', '—')
      set('det-type', '—')
      set('det-wallet', '—')
      set('det-blocks', '—')
      set('det-spv', '—')
      return
    }

    if (s.connected) {
      set('det-status-text', 'Connected', 'text-emerald-400 font-semibold')
      set('det-endpoint', s.endpoint || '127.0.0.1:5279', 'font-mono text-xs')
      set('det-type', s.isCompanion ? 'ReviveL Companion' : 'Local Daemon', s.isCompanion ? 'text-emerald-400' : 'text-yellow-400')
      set('det-wallet', s.walletReady ? 'Ready ✓' : 'Syncing / Limited', s.walletReady ? 'text-emerald-400' : 'text-yellow-400')
      set('det-blocks', `${s.blocks || '?'} (behind ${s.blocksBehind || 0})`)
      set('det-spv', s.spvServer || '—')
    } else if (s.error) {
      set('det-status-text', 'Error', 'text-red-400 font-semibold')
      set('det-endpoint', s.endpoint || '—', 'font-mono text-xs')
      set('det-type', 'Failed to connect')
      set('det-wallet', '—')
      set('det-blocks', '—')
      set('det-spv', '—')
    } else {
      set('det-status-text', 'Public Proxy Only', 'text-amber-400')
      set('det-endpoint', '—')
      set('det-type', 'Public (Odysee)')
      set('det-wallet', 'Not available')
      set('det-blocks', '—')
      set('det-spv', '—')
    }
  }

  chrome.storage.sync.get(['daemonUrl'], (r: any) => {
    if (r.daemonUrl) input.value = r.daemonUrl
  })

  // Use cached status from header if available, so no "Checking..." flash
  if (currentStatus) {
    renderDetailedStatus(currentStatus);
  }

  function loadStatus() {
    chrome.runtime.sendMessage({ type: 'getDaemonStatus' }, (s: any) => {
      renderDetailedStatus(s)
      // Auto-fill the Daemon RPC URL input with the detected Companion endpoint
      if (s && s.connected && s.endpoint && s.isCompanion) {
        input.value = s.endpoint
        // Auto-save so the extension uses it by default
        chrome.storage.sync.set({ daemonUrl: s.endpoint })
      }

      // Fetch balance when Companion + wallet ready
      if (s && s.connected && s.isCompanion && s.walletReady) {
        chrome.runtime.sendMessage({ type: 'getWalletBalance' }, (balResp: any) => {
          const balEl = document.getElementById('det-balance')
          if (balEl) {
            if (balResp && balResp.ok && balResp.result) {
              const available = balResp.result.available || balResp.result.total || 'N/A'
              balEl.textContent = `${available} LBC`
              balEl.className = 'font-mono text-xs text-emerald-400'
            } else {
              balEl.textContent = 'Balance unavailable'
              balEl.className = 'font-mono text-xs text-amber-400'
            }
          }
        })
      }
    })
  }
  loadStatus()

  refreshBtn.onclick = async () => {
    const orig = refreshBtn.textContent || 'Refresh'
    refreshBtn.textContent = 'Refreshing...'
    refreshBtn.disabled = true
    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'getDaemonStatus' }, (s: any) => {
          renderDetailedStatus(s)
          if (s && s.connected && s.endpoint && s.isCompanion) {
            input.value = s.endpoint
            chrome.storage.sync.set({ daemonUrl: s.endpoint })
          }
          resolve(true)
        })
      })
      refreshBtn.textContent = 'Refreshed ✓'
    } catch (e) {
      refreshBtn.textContent = 'Failed'
    }
    setTimeout(() => {
      refreshBtn.textContent = orig
      refreshBtn.disabled = false
    }, 1200)
  }

  detectBtn.onclick = () => {
    const LOCAL = 'http://127.0.0.1:5279'
    const orig = detectBtn.textContent || 'Detect Companion'
    input.value = LOCAL
    detectBtn.textContent = 'Detecting...'
    detectBtn.disabled = true
    chrome.storage.sync.set({ daemonUrl: LOCAL }, () => {
      chrome.runtime.sendMessage({ type: 'setDaemonUrl', url: LOCAL }, () => {
        loadStatus()
        detectBtn.textContent = 'Detected ✓'
        setTimeout(() => {
          detectBtn.textContent = orig
          detectBtn.disabled = false
        }, 1200)
      })
    })
  }

  saveBtn.onclick = () => {
    const url = input.value.trim() || null
    const orig = saveBtn.textContent || 'Save'
    saveBtn.textContent = 'Saving...'
    saveBtn.disabled = true
    chrome.storage.sync.set({ daemonUrl: url }, () => {
      chrome.runtime.sendMessage({ type: 'setDaemonUrl', url }, () => {
        loadStatus()
        saveBtn.textContent = 'Saved ✓'
        setTimeout(() => {
          saveBtn.textContent = orig
          saveBtn.disabled = false
        }, 1200)
      })
    })
  }

  // NSFW toggle in popup settings
  const popupNsfw = document.getElementById('popup-show-nsfw') as HTMLInputElement | null
  if (popupNsfw) {
    popupNsfw.checked = !!showNSFW
    popupNsfw.onchange = async () => {
      const val = popupNsfw.checked
      showNSFW = val
      try {
        await new Promise<void>(r => chrome.storage.local.set({ revivel_showNSFW: val }, () => r()))
      } catch (_) {}
      // Refresh the active list data with new filter
      try {
        feedItems = []
        latestItems = []
        feedPage = 1
        latestPage = 1
        feedHasMore = true
        latestHasMore = true
        const which = (currentTab === 'feed' ? 'feed' : 'latest') as 'feed' | 'latest'
        await fetchRealFeed(which)
      } catch (_) {}
    }
  }

  // Quick Upload toggle in settings
  const quickCb = document.getElementById('quick-upload-enabled') as HTMLInputElement | null
  if (quickCb) {
    quickCb.checked = !!quickUploadEnabled
    quickCb.onchange = async () => {
      const val = quickCb.checked
      quickUploadEnabled = val
      try {
        await new Promise<void>(r => chrome.storage.local.set({ revivel_quickUpload: val }, () => r()))
      } catch (_) {}
    }
  }

  // Wallet config in settings
  const wCreate = document.getElementById('wallet-create-btn')
  const wClose = document.getElementById('wallet-close-btn')
  const wDelete = document.getElementById('wallet-delete-btn')
  const wSeed = document.getElementById('wallet-seed')
  const wWarn = document.getElementById('wallet-delete-warning')

  if (wCreate) wCreate.onclick = async () => {
    try {
      const res = await createWallet()
      // Per INTEGRATION.md: wallet_create does NOT return seed. Call wallet_seed after.
      try {
        const seedRes = await getWalletSeed()
        if (wSeed && seedRes?.seed) {
          wSeed.textContent = seedRes.seed
          wSeed.classList.remove('hidden')
        } else {
          if (wSeed) wSeed.textContent = 'Wallet created. Seed available via Companion or wallet_seed.'
          if (wSeed) wSeed.classList.remove('hidden')
        }
      } catch (seedErr) {
        if (wSeed) {
          wSeed.textContent = 'Wallet created (could not auto-fetch seed; use wallet_seed or Companion)'
          wSeed.classList.remove('hidden')
        }
      }
    } catch(e: any) { alert('Create failed: ' + e.message) }
  }
  if (wClose) wClose.onclick = async () => {
    try { await closeWallet(); alert('Wallet closed') } catch(e: any){ alert('Close failed: '+e.message) }
  }
  let delConfirm = false
  if (wDelete) wDelete.onclick = async () => {
    if (!delConfirm) {
      if (wWarn) {
        wWarn.textContent = 'ARE YOU SURE? Cannot be undone.'
        wWarn.classList.remove('hidden')
      }
      delConfirm = true
      return
    }
    try { await deleteWallet(); alert('Wallet deleted'); if(wWarn) wWarn.classList.add('hidden'); delConfirm=false } catch(e: any){ alert('Delete: '+e.message) }
  }

  // Reset view data button in popup settings
  const resetBtn = document.getElementById('reset-data-btn')
  if (resetBtn) {
    resetBtn.onclick = async () => {
      if (!confirm('Reset view data and caches?')) return;
      feedItems = [];
      latestItems = [];
      feedFetchId++;
      latestFetchId++;
      feedPage = 1;
      latestPage = 1;
      feedHasMore = true;
      latestHasMore = true;
      channelsPage = 1;
      channelsHasMore = true;
      isLoadingMoreChannels = false;
      library = [];
      vault = [];
      history = [];
      await chrome.storage.local.remove(['revivel_library', 'revivel_vault', 'revivel_history']);
      // Force fresh fetch so Latest (and Feed) actually get new content
      feedLoading = true;
      latestLoading = true;
      renderContent();
      // Re-fetch the current tab's data (or both)
      try {
        await fetchRealFeed(currentTab === 'feed' ? 'feed' : 'latest');
      } catch (_) {}
      alert('Caches cleared. Fresh data loaded.');
    }
  }
}

async function initPopup() {
  initTailwind()
  await loadLibrary()

  // Load NSFW preference
  try {
    const saved: any = await new Promise(r => chrome.storage.local.get('revivel_showNSFW', r))
    showNSFW = !!saved.revivel_showNSFW
  } catch (_) {}

  // Load Quick Upload preference (default true = automatic, no manual intervention)
  try {
    const saved: any = await new Promise(r => chrome.storage.local.get('revivel_quickUpload', r))
    quickUploadEnabled = saved.revivel_quickUpload !== false
  } catch (_) {}

  // Always fetch fresh for feed/latest to avoid stale data from previous configs/sessions
  feedItems = [];
  latestItems = [];
  feedFetchId++;
  latestFetchId++;
  feedPage = 1;
  latestPage = 1;
  feedHasMore = true;
  latestHasMore = true;
  feedLoading = true;
  latestLoading = true;
  feedHasError = false;
  latestHasError = false;
  feedErrorIsCompanion = false;
  latestErrorIsCompanion = false;

  // Always render something and attach listeners first (do not block on status messages)
  try { updateTabs(); renderContent(); } catch {}

  document.querySelectorAll('.tab-btn').forEach(b => {
    b.addEventListener('click', () => {
      const tab = (b as HTMLElement).dataset.tab as 'feed' | 'new' | 'library' | 'channels' | 'upload' | 'wallet'
      if (tab) {
        currentTab = tab
        searchTerm = ''  // clear search when switching tabs
        // Reset pagination when explicitly switching to a list tab
        if (tab === 'feed') { feedPage = 1; feedHasMore = true }
        if (tab === 'new') { latestPage = 1; latestHasMore = true }
        if (tab === 'channels') { channelsPage = 1; channelsHasMore = true }
        updateTabs()
        renderContent()
        if (tab !== 'library' && tab !== 'wallet') {
          fetchRealFeed( (currentTab as any) === 'feed' ? 'feed' : 'latest')
        }
        // update view opts visibility
        if (popupOpts) popupOpts.style.display = (currentTab === 'feed' || currentTab === 'new' || currentTab === 'library') ? '' : 'none'
        if (popupModeSel) popupModeSel.value = listViewMode
      }
    })
  })

  const s = document.getElementById('search-input') as HTMLInputElement | null
  if (s) {
    let searchDebounce: any
    s.addEventListener('input', () => {
      searchTerm = s.value
      stopLoadingAnimation();
      clearTimeout(searchDebounce)
      searchDebounce = setTimeout(() => {
        if (searchTerm.length > 1) {
          performRealSearch(searchTerm)
        } else {
          // restore current tab's default feed
          if ((currentTab as any) === 'feed') { feedPage=1; feedHasMore=true }
          else { latestPage=1; latestHasMore=true }
          fetchRealFeed( (currentTab as any) === 'feed' ? 'feed' : 'latest')
        }
      }, 350)
    })

    // Support direct lbry:// URIs in search: Enter → floating player overlay
    s.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = s.value.trim()
        if (val.startsWith('lbry://')) {
          playInOverlay(val)
          s.value = ''
        }
      }
    })
  }

  const uploadBtn = document.getElementById('upload-btn')
  if (uploadBtn) uploadBtn.addEventListener('click', () => {
    currentTab = 'upload'
    updateTabs()
    renderContent()
  })

  const playerBtn = document.getElementById('open-player-btn')
  if (playerBtn) playerBtn.addEventListener('click', () => openFullPlayer())

  const settingsBtn = document.getElementById('settings-btn')
  if (settingsBtn) settingsBtn.addEventListener('click', () => showSettings())

  // Final render (in case anything was missed)
  updateTabs()
  renderContent()

  // Wire view mode for popup lists (feed/new)
  const popupModeSel = document.getElementById('popup-view-mode') as HTMLSelectElement | null
  const popupOpts = document.getElementById('popup-view-options')
  if (popupModeSel) {
    popupModeSel.addEventListener('change', () => {
      listViewMode = popupModeSel.value as any
      if (currentTab === 'feed' || currentTab === 'new') {
        doRenderFeedItems()
      } else if (currentTab === 'library') {
        const c = document.getElementById('content-area')!
        c.innerHTML = '';
        renderLibrary(c)
      }
    })
  }
  // Show options only on list tabs
  const updatePopupViewOpts = () => {
    if (popupOpts) popupOpts.style.display = (currentTab === 'feed' || currentTab === 'new' || currentTab === 'library') ? '' : 'none'
    if (popupModeSel) popupModeSel.value = listViewMode
  }
  updatePopupViewOpts()

  // Fetch real LBRY content for feeds and latest (Feed stake sorted, Latest date only)
  feedPage = 1; latestPage = 1
  fetchRealFeed('feed')
  fetchRealFeed('latest')

  // Scroll load-more for Feed / Latest in popup (same contract as player)
  const contentScroller = document.getElementById('content-area')!
  let popScrollT: any = null
  contentScroller.addEventListener('scroll', () => {
    if (popScrollT) clearTimeout(popScrollT)
    popScrollT = setTimeout(() => {
      const near = contentScroller.scrollTop + contentScroller.clientHeight > contentScroller.scrollHeight - 80
      if (!near || searchTerm) return
      if (currentTab === 'feed' && feedHasMore) loadMoreFeedPopup()
      else if (currentTab === 'new' && latestHasMore) loadMoreLatestPopup()
      else if (currentTab === 'channels' && channelsHasMore) loadMoreChannelsPopup()
    }, 140)
  }, { passive: true })

  // Status checks (async, non-blocking)
  updateHeaderStatus()
  setTimeout(() => updateHeaderStatus(), 600)

  // Poll status so that when Companion is started *after* initial public load,
  // we detect the flip and refresh Feed/Latest with Companion data (highest support etc).
  setInterval(() => {
    updateHeaderStatus().catch(() => {})
  }, 8000)

  // Early status for the no-conn flag (non-blocking)
  new Promise<any>(r => chrome.runtime.sendMessage({ type: 'getDaemonStatus' }, r)).then((status) => {
    noDaemonConnection = !status?.connected;
    currentStatus = status;
    if (currentStatus) {
      renderHeaderStatus(currentStatus);
    }
    // re-render feeds to pick up button if no connection
    if (currentTab === 'feed' || currentTab === 'new') {
      renderContent();
    }
  }).catch(() => {
    noDaemonConnection = true;
    currentStatus = { connected: false, error: 'Detection failed' };
    if (currentTab === 'feed' || currentTab === 'new') {
      renderContent();
    }
  });

  // Listen for new blocks to refresh Latest (real-time, date order, reset to top page)
  chrome.runtime.onMessage.addListener((msg: any) => {
    if (msg.type === 'newBlock') {
      console.log('[ReviveL Popup] New block:', msg.height);
      latestPage = 1
      latestHasMore = true
      fetchRealFeed('latest')
    }
  });

  // Comprehensive connection status indicator (green/yellow/red circle)
  function renderHeaderStatus(status: any) {
    currentStatus = status;
    const dot = document.getElementById('status-dot')
    const label = document.getElementById('status-label')
    const pill = document.getElementById('status-pill')
    if (!dot || !label || !pill) return

    let color = 'bg-red-500'
    let text = 'Error'
    let title = 'Connection error'

    if (status?.connected) {
      if (status.isCompanion && status.walletReady) {
        color = 'bg-emerald-500'
        text = 'Companion'
        title = `ReviveL Companion connected\nWallet: Ready\nSPV: ${status.spvServer || 'unknown'}\nBlocks: ${status.blocks || '?'}\n${status.endpoint}`
      } else if (status.isCompanion) {
        color = 'bg-yellow-500'
        text = 'Companion'
        title = `ReviveL Companion connected (wallet syncing or limited)\nBlocks: ${status.blocks || '?'}\n${status.endpoint}`
      } else {
        color = 'bg-yellow-500'
        text = 'Local'
        title = `Local daemon connected\n${status.endpoint}`
      }
    } else if (status?.error) {
      color = 'bg-red-500'
      text = 'Error'
      title = status.error || 'Connection error'
      // Make the red circle the main visible indicator - always a clear red circle
      setTimeout(() => {
        if (dot) {
          dot.className = `w-4 h-4 rounded-full ${color} ring-2 ring-red-900 flex-shrink-0`
          dot.style.boxShadow = '0 0 8px #ef4444'
          dot.style.border = '1px solid #7f1d1d'
        }
        if (label) label.className = 'font-medium tracking-wide text-red-400 text-[9px]'
      }, 0)
    } else {
      color = 'bg-amber-500'
      text = 'Public'
      title = 'Public proxy mode (limited features)'
    }

    dot.className = `w-2.5 h-2.5 rounded-full ${color} flex-shrink-0`
    label.textContent = text
    label.className = 'font-medium tracking-wide text-[#94a3b8]'
    pill.style.borderColor = status?.connected ? '#166534' : (status?.error ? '#7f1d1d' : '#78350f')

    // Visual emphasis for error state (red circle indicator)
    if (status?.error) {
      pill.style.background = '#3f1a1a'
      dot.style.boxShadow = '0 0 0 3px #450a0a'
      // Ensure the red circle is always visible and prominent
      dot.style.width = '14px'
      dot.style.height = '14px'
    } else {
      pill.style.background = ''
      dot.style.boxShadow = ''
      dot.style.width = ''
      dot.style.height = ''
    }

    // Make error state clickable to open mini error window
    pill.style.cursor = status?.error ? 'pointer' : 'default'
    pill.onclick = null
    if (status?.error) {
      pill.onclick = (e) => {
        e.stopPropagation()
        showErrorMiniWindow(status.error)
      }
    }
  }

  function showErrorMiniWindow(errorMsg: string) {
    // Remove any existing
    const existing = document.getElementById('error-mini-window')
    if (existing) existing.remove()

    const win = document.createElement('div')
    win.id = 'error-mini-window'
    win.style.cssText = `
      position: absolute;
      top: 8px;
      left: 8px;
      right: 8px;
      background: #1e2937;
      border: 1px solid #7f1d1d;
      border-radius: 10px;
      padding: 10px;
      z-index: 9999;
      font-size: 11px;
      box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.4);
    `

    const safeMsg = escapeHtml(errorMsg || 'Unknown error')

    win.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
        <div style="color:#f87171; font-weight:600;">Connection Error</div>
        <button id="close-error-win" style="background:none; border:none; color:#94a3b8; font-size:14px; cursor:pointer; line-height:1;">×</button>
      </div>
      <div style="background:#0f172a; border:1px solid #334155; border-radius:6px; padding:6px; max-height:90px; overflow:auto; white-space:pre-wrap; font-family:monospace; font-size:10px; color:#e2e8f0; margin-bottom:6px;">
${safeMsg}
      </div>
      <div style="display:flex; gap:6px;">
        <button id="copy-error-btn" style="flex:1; background:#334155; color:#e2e8f0; border:none; padding:5px 8px; border-radius:6px; font-size:10px; cursor:pointer;">Copy Error</button>
        <button id="close-error-btn" style="flex:1; background:#475569; color:#e2e8f0; border:none; padding:5px 8px; border-radius:6px; font-size:10px; cursor:pointer;">Close</button>
      </div>
    `

    // Find a good container — append to body for overlay feel inside popup
    document.body.appendChild(win)

    const copyBtn = win.querySelector('#copy-error-btn') as HTMLButtonElement
    const closeBtn = win.querySelector('#close-error-btn') as HTMLButtonElement
    const xBtn = win.querySelector('#close-error-win') as HTMLButtonElement

    const close = () => win.remove()

    copyBtn.onclick = () => {
      navigator.clipboard.writeText(errorMsg).then(() => {
        const orig = copyBtn.textContent
        copyBtn.textContent = 'Copied!'
        setTimeout(() => {
          if (copyBtn.parentNode) copyBtn.textContent = orig
        }, 1400)
      }).catch(() => {
        // fallback
        const ta = document.createElement('textarea')
        ta.value = errorMsg
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        copyBtn.textContent = 'Copied!'
        setTimeout(() => { if (copyBtn.parentNode) copyBtn.textContent = 'Copy Error' }, 1400)
      })
    }

    closeBtn.onclick = close
    xBtn.onclick = close

    // Click outside to close (simple)
    setTimeout(() => {
      document.addEventListener('click', function handler(ev) {
        if (!win.contains(ev.target as Node)) {
          close()
          document.removeEventListener('click', handler)
        }
      }, { once: true })
    }, 10)
  }

  function escapeHtml(str: string): string {
    return str.replace(/[&<>"']/g, (m) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m] || m
    })
  }

  // Initial header status (with retry for detection)
  async function updateHeaderStatus() {
    try {
      const status = await new Promise<any>(r => chrome.runtime.sendMessage({ type: 'getDaemonStatus' }, r))
      const wasNoConn = noDaemonConnection;
      noDaemonConnection = !status?.connected;
      // Use robust check for "now in companion" to trigger list refresh.
      let nowInCompanion = !!status?.connected;
      const usingD = (status as any)?.using === 'daemon' || (status as any)?.isCompanion;
      const ep = String((status as any)?.endpoint || '');
      if (usingD || /127\.0\.0\.1|localhost/.test(ep)) nowInCompanion = true;
      try {
        const cfg: any = await chrome.storage.sync.get(['daemonUrl']);
        const du = String(cfg?.daemonUrl || '');
        if (du.includes('127.0.0.1') || du.includes('localhost')) nowInCompanion = true;
      } catch (_) {}
      currentStatus = status;
      renderHeaderStatus(status);
      // If connection state changed for feed/latest, re-render content to show/hide button
      if ((currentTab === 'feed' || currentTab === 'new') && wasNoConn !== noDaemonConnection) {
        renderContent();
      }
      // When Companion just became available, clear stale public-mode list data and re-fetch
      // using daemon-backed queries (e.g. effective_amount for Feed = highest LBC support).
      if (wasNoConn && nowInCompanion) {
        feedItems = [];
        latestItems = [];
        feedFetchId++;
        latestFetchId++;
        feedPage = 1;
        latestPage = 1;
        feedHasMore = true;
        latestHasMore = true;
        if (currentTab === 'feed' || currentTab === 'new') {
          fetchRealFeed( (currentTab as any) === 'feed' ? 'feed' : 'latest' );
        }
      }
    } catch (e) {
      renderHeaderStatus({ connected: false, error: 'Detection failed' })
    }
  }

  // Right-click image context
  const ctx = await chrome.storage.local.get('lastUploadContext')
  if (ctx.lastUploadContext) {
    const data = ctx.lastUploadContext as any
    const srcUrl = data.srcUrl
    const suggestedName = data.suggestedName
    chrome.storage.local.remove('lastUploadContext')

    // Read fresh to ensure default automatic quick upload works reliably
    let isQuick = true
    try {
      const qsaved: any = await new Promise(r => chrome.storage.local.get('revivel_quickUpload', r))
      isQuick = qsaved.revivel_quickUpload !== false
    } catch (_) {}

    try {
      const blob = await fetch(srcUrl).then(r => r.blob())
      const fr = new FileReader()
      fr.onload = () => {
        const imgData = fr.result as string
        if (isQuick) {
          // Automatic Quick Upload: filename title, fixed desc, Anonymous channel. No manual form.
          doQuickUploadAuto(imgData, suggestedName)
        } else {
          pendingUploadImage = { dataUrl: imgData, name: suggestedName }
          currentTab = 'upload'
          updateTabs()
          renderContent()
        }
      }
      fr.readAsDataURL(blob)
    } catch(e) {
      if (isQuick) {
        doQuickUploadAuto(null, suggestedName)
      } else {
        pendingUploadImage = { dataUrl: '', name: suggestedName }
        currentTab = 'upload'
        updateTabs()
        renderContent()
      }
    }
  }
}

initPopup()
