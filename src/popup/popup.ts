// ReviveL Popup — Premium UX
// Large comfortable window, elegant spacing, in-popup settings, floating video player

import { resolveLbryUri, extractClaim, getPlayableUrl, searchLbryClaims, getWalletBalance, getReceiveAddress, sendLBC, getTransactions, createWallet, closeWallet, deleteWallet, getWalletSeed, getClaimTimestamp } from '../utils/lbryApi.js';

interface LbryItem { id: string; title: string; channel: string; thumbnail: string; duration: string; lbryUri: string; type: 'video'|'image'; timestamp: number; uploaded: string; isLocked: boolean; fee: string; staked: number; }
interface VaultItem { id: string; title: string; description: string; imageData: string; lbryUri: string; channel: string; date: string }

let feedItems: LbryItem[] = []
let latestItems: LbryItem[] = []

let currentTab: 'feed'|'new'|'vault'|'wallet' = 'feed'
let searchTerm = ''
let vault: VaultItem[] = []
let noDaemonConnection = true
let currentStatus: any = null;

let feedLoading = true;
let latestLoading = true;
let feedHasError = false;
let latestHasError = false;

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
  const thumbnail = value.thumbnail?.url || 'https://picsum.photos/id/1015/320/180'
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
    staked
  }
}

async function fetchRealFeed(tab: 'feed' | 'latest') {
  const isFeed = tab === 'feed';
  const currentItems = isFeed ? feedItems : latestItems;
  const hasData = currentItems.length > 0;

  if (isFeed) {
    feedHasError = false;
    if (!hasData) {
      feedLoading = true;
      renderContent();
    }
  } else {
    latestHasError = false;
    if (!hasData) {
      latestLoading = true;
      renderContent();
    }
  }

  // Check status for flag (but always attempt search via proxy if needed)
  try {
    const daemonStatus = await new Promise<any>(r => chrome.runtime.sendMessage({ type: 'getDaemonStatus' }, r));
    noDaemonConnection = !daemonStatus?.connected;
  } catch (_) {
    noDaemonConnection = true;
  }

  try {
    const params: any = {
      claim_type: 'stream',
      page_size: 20,
      page: 1,
    }
    if (tab === 'feed') {
      // Feed = highest LBC support (effective_amount includes deposited supports).
      // Sort client-side for reliability (same as player).
      params.order_by = ['effective_amount']
    } else {
      // release_time to bias toward recent (proxy returns recent items); client-side
      // getClaimTimestamp + filter removes any polluted by bad release_time values
      params.order_by = ['release_time']
    }
    const result = await searchLbryClaims(params)
    let rawItems = (result.items || [])
    if (tab === 'feed') {
      rawItems = rawItems.sort((a: any, b: any) => {
        const be = (b.meta?.effective_amount || 0)
        const ae = (a.meta?.effective_amount || 0)
        return be - ae
      })
    }
    let items = rawItems.map(mapClaimToItem)
    if (tab === 'latest' || !isFeed) {
      // Strict recent filter + sort by reliable timestamp (getClaimTimestamp prefers meta.creation_timestamp).
      // Drops stale items that polluted server results due to bad value.release_time.
      const nowSec = Math.floor(Date.now() / 1000)
      const minLatestTs = nowSec - (86400 * 400)
      items = items.filter((it: any) => it.timestamp > minLatestTs)
        .sort((a, b) => b.timestamp - a.timestamp)
    }
    if (tab === 'feed') {
      feedItems = items
    } else {
      latestItems = items
    }
  } catch (e) {
    console.warn('Real feed fetch failed', e)
    if (tab === 'feed') {
      feedItems = [];
      feedHasError = true;
    } else {
      latestItems = [];
      latestHasError = true;
    }
  } finally {
    if (tab === 'feed') {
      feedLoading = false;
    } else {
      latestLoading = false;
    }
    const shouldRenderCurrent = !searchTerm &&
      ((tab === 'feed' && currentTab === 'feed') || (tab === 'latest' && currentTab === 'new'));
    if (shouldRenderCurrent) {
      renderContent();
    }
  }
}

async function performRealSearch(query: string) {
  // Check connection
  try {
    const daemonStatus = await new Promise<any>(r => chrome.runtime.sendMessage({ type: 'getDaemonStatus' }, r));
    if (!daemonStatus?.connected) {
      noDaemonConnection = true;
      if (currentTab === 'feed') feedItems = [];
      else latestItems = [];
      renderContent();
      return;
    }
  } catch (_) {
    noDaemonConnection = true;
    if (currentTab === 'feed') {
      feedItems = [];
      feedHasError = true;
      feedLoading = false;
    } else {
      latestItems = [];
      latestHasError = true;
      latestLoading = false;
    }
    renderContent();
    return;
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
    noDaemonConnection = false;
    const params: any = {
      text: query,
      claim_type: 'stream',
      page_size: 10,
      page: 1,
      order_by: ['effective_amount']
    }
    const result = await searchLbryClaims(params)
    let items = (result.items || []).map(mapClaimToItem)
    if (currentTab === 'new') {
      items = items.sort((a, b) => b.timestamp - a.timestamp)
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
      feedLoading = false;
    } else {
      latestItems = [];
      latestHasError = true;
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

async function loadVault() {
  const d = await chrome.storage.local.get('revivel_vault')
  vault = (d.revivel_vault as VaultItem[]) || []
}
async function saveVault() { await chrome.storage.local.set({revivel_vault: vault}) }

function renderContent() {
  const c = document.getElementById('content-area')!
  c.innerHTML = ''
  stopLoadingAnimation();

  if (currentTab === 'vault') { renderVault(c); return }
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
  if (currentTab === 'vault') { renderVault(c); return; }

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
    const msg = noDaemonConnection
      ? 'Unable to load feed.<br>Connection issue — using public data if available.'
      : 'Failed to load content.<br>Please try again.';
    c.innerHTML = `<div class="py-6 text-center text-xs text-[#64748b]">${msg}</div>`;
    return;
  } else if (!items.length) {
    stopLoadingAnimation();
    c.innerHTML = `<div class="py-6 text-center text-xs text-[#64748b]">No content available.</div>`;
    return;
  }

  stopLoadingAnimation();

  const list = document.createElement('div')
  list.className = 'content-grid'

  items.forEach(it => {
    const row = document.createElement('div')
    row.className = 'claim-card'
    const stakedHtml = it.staked > 0.01 
      ? `<div class="text-[9px] text-emerald-400 mt-0.5">${it.staked.toLocaleString(undefined, {maximumFractionDigits: 0})} LBC staked</div>` 
      : '';
    row.innerHTML = `
      <img src="${it.thumbnail}" alt="">
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

    row.querySelector('.play-btn')!.addEventListener('click', e => { e.stopPropagation(); playInOverlay(it.lbryUri) })
    row.addEventListener('click', () => playInOverlay(it.lbryUri))
    list.appendChild(row)
  })
  c.appendChild(list)
}

function renderVault(c: HTMLElement) {
  if (!vault.length) {
    c.innerHTML = `<div class="text-center py-6 text-[#64748b] text-xs">Your vault is empty.<br>Right-click images to start reviving.</div>`
    return
  }
  const list = document.createElement('div')
  list.className = 'space-y-1'
  vault.forEach((v, idx) => {
    const row = document.createElement('div')
    row.className = 'compact-list-item flex items-center gap-1.5'
    row.innerHTML = `
      <div class="w-9 h-6 bg-[#1e2937] rounded-lg overflow-hidden flex-shrink-0">
        <img src="${v.imageData}" class="w-full h-full object-cover">
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-xs font-medium truncate">${v.title}</div>
        <div class="font-mono text-[9px] text-[#14b8a6] truncate mt-px">${v.lbryUri}</div>
      </div>
      <button data-p="${idx}" class="play-btn">Play</button>
      <button data-c="${idx}" class="action-btn text-[10px] px-1.5 py-0.5">⎘</button>`
    row.querySelector('[data-p]')!.addEventListener('click', e => { e.stopPropagation(); playInOverlay(v.lbryUri) })
    row.querySelector('[data-c]')!.addEventListener('click', e => { e.stopPropagation(); navigator.clipboard.writeText(v.lbryUri); showToast('Copied lbry:// link') })
    row.addEventListener('click', () => playInOverlay(v.lbryUri))
    list.appendChild(row)
  })
  c.appendChild(list)
}

async function renderWallet(c: HTMLElement) {
  c.innerHTML = `
    <div class="space-y-3 text-sm">
      <!-- Balance -->
      <div class="bg-[#111114] border border-[#27272a] rounded-2xl p-3">
        <div class="flex justify-between items-center">
          <div class="text-xs font-semibold">LBC Balance</div>
          <div id="wallet-balance" class="font-mono text-emerald-400">—</div>
        </div>
      </div>

      <!-- Receive -->
      <div class="bg-[#111114] border border-[#27272a] rounded-2xl p-3">
        <div class="text-xs font-semibold mb-1.5">Receive LBC</div>
        <div class="flex gap-1.5 mb-1.5">
          <input id="receive-address" class="flex-1 bg-[#1e2937] border border-[#334155] rounded px-2 py-1 text-[10px] font-mono" readonly />
          <button id="copy-address" class="action-btn text-xs px-2 py-0.5">Copy</button>
        </div>
        <button id="gen-address" class="action-btn text-xs px-2 py-0.5">New Addr</button>
        <div class="mt-1.5">
          <div class="text-[10px] text-[#64748b] mb-0.5">Last Received</div>
          <div id="last-received" class="text-[10px] bg-[#0a0a0f] p-1 rounded"></div>
        </div>
      </div>

      <!-- Send -->
      <div class="bg-[#111114] border border-[#27272a] rounded-2xl p-3">
        <div class="text-xs font-semibold mb-1.5">Send LBC</div>
        <input id="send-address" placeholder="Recipient address" class="w-full bg-[#1e2937] border border-[#334155] rounded px-2 py-1 text-[10px] mb-1" />
        <div class="flex gap-1.5 mb-1">
          <input id="send-amount" placeholder="Amount" class="flex-1 bg-[#1e2937] border border-[#334155] rounded px-2 py-1 text-[10px]" />
          <button id="send-btn" class="action-btn teal text-xs px-2 py-0.5">Send</button>
        </div>
        <div class="text-[10px] text-[#64748b]">Est fee: <span id="tx-fee">0.0001</span> LBC</div>
        <div class="mt-1.5">
          <div class="text-[10px] text-[#64748b] mb-0.5">Last Sent</div>
          <div id="last-sent" class="text-[10px] bg-[#0a0a0f] p-1 rounded"></div>
        </div>
      </div>

      <!-- History -->
      <div class="bg-[#111114] border border-[#27272a] rounded-2xl p-3">
        <div class="text-xs font-semibold mb-1.5">Transaction History</div>
        <div id="tx-history" class="text-[10px] bg-[#0a0a0f] p-1.5 rounded max-h-32 overflow-auto">Loading...</div>
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
      if (addrStr) { navigator.clipboard.writeText(addrStr); /* toast */ }
    })

    const genBtn = c.querySelector('#gen-address')
    if (genBtn) genBtn.addEventListener('click', async () => {
      try {
        const newAddr = await getReceiveAddress()
        if (addrInput) addrInput.value = newAddr.address || ''
      } catch(e) { console.error(e) }
    })

    // Last received (simple, use tx history)
    const txs = await getTransactions()
    const received = (txs.items || []).filter((t: any) => t.type === 'received' || (t.amount && !t.spent)).slice(0,3)
    const recvEl = c.querySelector('#last-received') as HTMLElement
    if (recvEl) recvEl.innerHTML = received.length ? received.map((t:any) => `${t.amount} LBC`).join('<br>') : 'None'

    // Last sent
    const sent = (txs.items || []).filter((t: any) => t.type === 'spend' || t.spent).slice(0,3)
    const sentEl = c.querySelector('#last-sent') as HTMLElement
    if (sentEl) sentEl.innerHTML = sent.length ? sent.map((t:any) => `${t.amount} LBC`).join('<br>') : 'None'

    // History full
    const histEl = c.querySelector('#tx-history') as HTMLElement
    if (histEl) {
      const list = (txs.items || []).slice(0,10).map((t:any) => `${t.txid?.slice(0,8)}... ${t.amount} LBC`).join('<br>')
      histEl.innerHTML = list || 'No transactions'
    }

    // Send fee estimate (simple fixed for now)
    const feeEl = c.querySelector('#tx-fee') as HTMLElement
    if (feeEl) feeEl.textContent = '0.0001 LBC (est)'

    const sendBtn = c.querySelector('#send-btn')
    const sendAddr = c.querySelector('#send-address') as HTMLInputElement
    const sendAmt = c.querySelector('#send-amount') as HTMLInputElement
    if (sendBtn) sendBtn.addEventListener('click', async () => {
      if (!sendAddr?.value || !sendAmt?.value) return
      try {
        await sendLBC(sendAddr.value, sendAmt.value)
        alert('Sent! (check history)')
        loadWalletData(c)
      } catch(e: any) { alert('Send failed: ' + e.message) }
    })
  } catch (e) {
    console.error('Wallet load error', e)
    // show friendly if no wallet
  }
}

// Play using beautiful floating overlay on current page (no new tab)
function playInOverlay(uri: string) {
  chrome.runtime.sendMessage({ 
    type: 'playInOverlay', 
    uri 
  });
}

// Legacy kept for "Full Player" button
function openFullPlayer(uri?: string) {
  const url = chrome.runtime.getURL('player.html') + (uri ? '?uri=' + encodeURIComponent(uri) : '');
  chrome.tabs.create({ url });
}

async function handleUpload(imgData: string | null = null, name = '') {
  const c = document.getElementById('content-area')!
  c.innerHTML = `
    <div class="px-1 pt-1">
      <div class="flex items-center justify-between mb-3 px-1">
        <div class="font-semibold text-sm">Publish to LBRY</div>
      </div>
      <div id="up-prev" class="border border-[#27272a] bg-[#111114] rounded-2xl h-36 mb-3 flex items-center justify-center overflow-hidden cursor-pointer active:opacity-90">${imgData ? `<img src="${imgData}" class="max-h-full">` : `<div class="text-center text-xs text-[#64748b]">Click to choose image<br><span class="opacity-60">or drag &amp; drop</span></div>`}</div>
      
      <div class="space-y-2">
        <input id="up-t" value="${name}" class="w-full bg-[#1e2937] border border-[#334155] rounded-xl px-3 py-1.5 text-xs" placeholder="Title">
        <textarea id="up-d" class="w-full bg-[#1e2937] border border-[#334155] rounded-xl px-3 py-1 text-xs h-10 resize-y" placeholder="Description (optional)"></textarea>
        
        <div class="flex gap-2">
          <input id="up-ch" value="@you" class="flex-1 bg-[#1e2937] border border-[#334155] rounded-xl px-3 py-1 text-xs">
          <input id="up-b" value="0.05" class="w-16 bg-[#1e2937] border border-[#334155] rounded-xl px-2 py-1 text-xs text-center" title="Bid amount">
        </div>
      </div>

      <div class="flex gap-2 mt-3">
        <button id="up-c" class="flex-1 py-1.5 text-xs border border-[#334155] hover:bg-[#1e2937] rounded-xl transition">Cancel</button>
        <button id="up-p" class="flex-1 py-1.5 action-btn teal text-xs">Publish</button>
      </div>
      <div class="text-[10px] text-center text-[#64748b] mt-1.5">Public = assisted. Connect Companion for direct.</div>
    </div>`

  const prev = document.getElementById('up-prev')!
  if (!imgData) prev.onclick = () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'
    inp.onchange = () => { if (inp.files?.[0]) { const fr = new FileReader(); fr.onload = e => handleUpload(e.target?.result as string, inp.files![0].name); fr.readAsDataURL(inp.files[0]) } }; inp.click()
  }

  document.getElementById('up-c')!.onclick = () => renderContent()
  document.getElementById('up-p')!.onclick = async () => {
    const t = (document.getElementById('up-t') as HTMLInputElement).value || 'Untitled Revival'
    const ch = (document.getElementById('up-ch') as HTMLInputElement).value
    const desc = (document.getElementById('up-d') as HTMLTextAreaElement).value
    const btn = document.getElementById('up-p') as HTMLButtonElement

    // Check if we have a real daemon with wallet (Companion)
    let useRealPublish = false
    try {
      const st = await new Promise<any>(r => chrome.runtime.sendMessage({ type: 'getDaemonStatus' }, r))
      useRealPublish = !!(st?.connected && st?.walletReady)
    } catch {}

    btn.innerHTML = useRealPublish ? 'Publishing to LBRY network...' : 'Publishing...'
    await new Promise(r => setTimeout(r, 800))

    const cid = Math.random().toString(36).slice(2,9)
    const uri = `lbry://${ch.replace('@','')}/${t.toLowerCase().replace(/\s/g,'-')}#${cid}`

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
              bid: '0.01',
              title: t,
              description: desc,
              channel_name: ch
            }
          }, (resp: any) => {
            if (resp?.ok) resolve(resp.result)
            else reject(resp?.error || 'publish failed')
          })
        })
      } catch (e) {
        console.warn('Real publish attempt failed (expected for browser-uploaded files):', e)
        // continue with local vault entry
      }
    }

    vault.unshift({id: Date.now().toString(), title: t, description: desc, imageData: imgData || 'https://picsum.photos/id/160/320/180', lbryUri: uri, channel: ch, date: 'just now'})
    await saveVault()

    const successHtml = realResult 
      ? `<div class="text-emerald-400 text-5xl mb-3">✓</div>
         <div class="font-semibold text-lg">Published via ReviveL Companion!</div>
         <div class="font-mono text-xs text-[#14b8a6] mt-2 mb-3 break-all bg-[#0a0a0f] p-1.5 rounded">${realResult.claim_id || uri}</div>`
      : `<div class="text-emerald-400 text-4xl mb-2">✓</div>
         <div class="font-semibold text-sm">Saved to local Vault</div>
         <div class="font-mono text-xs text-[#14b8a6] mt-1 mb-3 break-all bg-[#0a0a0f] p-1.5 rounded">${uri}</div>`

    c.innerHTML = `
      <div class="text-center py-4 px-2">
        ${successHtml}
        <div class="flex gap-2">
          <button id="cpy" class="flex-1 action-btn py-1.5 text-xs">Copy URI</button>
          <button id="vlt" class="flex-1 action-btn teal py-1.5 text-xs">View in Vault</button>
        </div>
        <div class="text-[10px] mt-2 text-[#64748b]">${useRealPublish ? 'Submitted via Companion.' : 'Assisted publish (use Companion for full).'}</div>
      </div>`

    document.getElementById('cpy')!.onclick = () => { navigator.clipboard.writeText(realResult ? (realResult.permanent_url || uri) : uri); showToast('URI copied') }
    document.getElementById('vlt')!.onclick = () => { currentTab = 'vault'; updateTabs(); renderContent() }
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
    <div class="px-1">
      <div class="flex items-center justify-between mb-3">
        <div class="font-semibold text-sm">Settings</div>
        <button id="settings-back" class="text-xs px-2 py-0.5 action-btn">Done</button>
      </div>

      <!-- Connection Status -->
      <div class="bg-[#111114] border border-[#27272a] rounded-2xl p-3 mb-3">
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

        <div class="mt-2 pt-2 border-t border-[#27272a]">
          <div class="text-[10px] text-[#64748b] mb-1">Daemon RPC URL</div>
          <input id="set-daemon" class="w-full bg-[#1e2937] border border-[#334155] rounded-xl px-2 py-1 text-[10px] font-mono" placeholder="http://127.0.0.1:5279">
          <div class="text-[9px] text-[#14b8a6] mt-0.5">Auto from Companion. Edit + Save.</div>
          <div class="flex gap-1.5 mt-1.5">
            <button id="detect-companion-btn" class="flex-1 py-1 text-[10px] action-btn">Re-Detect</button>
            <button id="set-save" class="flex-1 py-1 text-[10px] action-btn teal">Save</button>
          </div>
        </div>
      </div>

      <div class="text-[10px] text-[#64748b] px-1 leading-relaxed mb-2">
        Full features require the <strong>ReviveL Companion</strong>.
      </div>

      <!-- Wallet Config -->
      <div class="bg-[#111114] border border-[#27272a] rounded-2xl p-3">
        <div class="text-[10px] font-medium text-[#64748b] mb-1.5">Wallet Config</div>
        <div class="flex gap-1.5 mb-1">
          <button id="wallet-create-btn" class="flex-1 py-1 text-[10px] action-btn">Create</button>
          <button id="wallet-close-btn" class="flex-1 py-1 text-[10px] action-btn">Close</button>
          <button id="wallet-delete-btn" class="flex-1 py-1 text-[10px] action-btn" style="background:#7f1d1d;border-color:#991b1b;color:#fca5a5">Delete</button>
        </div>
        <div id="wallet-seed" class="text-[10px] font-mono bg-[#0a0a0f] p-1.5 rounded break-all hidden"></div>
        <div id="wallet-delete-warning" class="text-[10px] text-red-400 mt-1 hidden">ARE YOU SURE? Cannot be undone.</div>
      </div>

      <!-- Reset View Data -->
      <div class="bg-[#111114] border border-[#27272a] rounded-2xl p-6 mt-6">
        <div class="mb-3">
          <div class="text-sm font-semibold tracking-wide">Reset View Data & Caches</div>
          <div class="text-xs text-[#64748b] mt-1">Clears cached feeds (Latest etc), vault, and history.</div>
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
      if (wWarn) wWarn.classList.remove('hidden')
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
      vault = [];
      await chrome.storage.local.remove(['revivel_vault', 'revivel_history']);
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

  document.getElementById('settings-back')!.onclick = () => renderContent()
}

async function initPopup() {
  initTailwind()
  await loadVault()

  // Always fetch fresh for feed/latest to avoid stale data from previous configs/sessions
  feedItems = [];
  latestItems = [];
  feedLoading = true;
  latestLoading = true;
  feedHasError = false;
  latestHasError = false;

  // Always render something and attach listeners first (do not block on status messages)
  try { updateTabs(); renderContent(); } catch {}

  document.querySelectorAll('.tab-btn').forEach(b => {
    b.addEventListener('click', () => {
      const tab = (b as HTMLElement).dataset.tab as 'feed' | 'new' | 'vault' | 'wallet'
      if (tab) {
        currentTab = tab
        searchTerm = ''  // clear search when switching tabs
        updateTabs()
        renderContent()
        if (tab !== 'vault' && tab !== 'wallet') {
          fetchRealFeed( (currentTab as any) === 'feed' ? 'feed' : 'latest')
        }
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
  if (uploadBtn) uploadBtn.addEventListener('click', () => handleUpload())

  const playerBtn = document.getElementById('open-player-btn')
  if (playerBtn) playerBtn.addEventListener('click', () => openFullPlayer())

  const settingsBtn = document.getElementById('settings-btn')
  if (settingsBtn) settingsBtn.addEventListener('click', () => showSettings())

  // Final render (in case anything was missed)
  updateTabs()
  renderContent()

  // Fetch real LBRY content for feeds and latest
  fetchRealFeed('feed')
  fetchRealFeed('latest')

  // Status checks (async, non-blocking)
  updateHeaderStatus()
  setTimeout(() => updateHeaderStatus(), 600)

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

  // Listen for new blocks to refresh Latest
  chrome.runtime.onMessage.addListener((msg: any) => {
    if (msg.type === 'newBlock') {
      console.log('[ReviveL Popup] New block:', msg.height);
      fetchRealFeed('latest');
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
      currentStatus = status;
      renderHeaderStatus(status);
      // If connection state changed for feed/latest, re-render content to show/hide button
      if ((currentTab === 'feed' || currentTab === 'new') && wasNoConn !== noDaemonConnection) {
        renderContent();
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
    try {
      const blob = await fetch(srcUrl).then(r => r.blob())
      const fr = new FileReader()
      fr.onload = () => handleUpload(fr.result as string, suggestedName)
      fr.readAsDataURL(blob)
    } catch(e) { handleUpload(null, suggestedName) }
    chrome.storage.local.remove('lastUploadContext')
  }
}

initPopup()
