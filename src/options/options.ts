const input = document.getElementById('daemon') as HTMLInputElement
const save = document.getElementById('save')!
const statusEl = document.getElementById('status')!
const detectBtn = document.getElementById('detect-companion') as HTMLButtonElement | null

function updateStatus() {
  chrome.runtime.sendMessage({ type: 'getDaemonStatus' }, (s: any) => {
    if (!s) return
    if (s.connected) {
      let html = `<span class="text-emerald-400">✓ Connected</span>`
      if (s.isCompanion) html += ` <span class="text-teal-400">(ReviveL Companion)</span>`
      if (s.walletReady) html += ` <span class="text-emerald-300">Wallet Ready</span>`
      if (s.spvServer) html += `<br><span class="text-xs">SPV: ${s.spvServer}</span>`
      if (s.blocks) html += ` <span class="text-xs">Blocks: ${s.blocks}</span>`
      if (s.endpoint) html += `<br><span class="text-xs text-slate-400">${s.endpoint}</span>`
      statusEl.innerHTML = html

      // Auto-fill input with detected Companion URL
      if (s.isCompanion && s.endpoint) {
        input.value = s.endpoint
        chrome.storage.sync.set({ daemonUrl: s.endpoint })
      }
    } else if (s.using === 'public') {
      statusEl.innerHTML = `<span class="text-amber-400">Public proxy mode</span> (no local daemon)`
    } else {
      statusEl.textContent = s.error ? 'Connection issue: ' + s.error : 'Public mode'
    }
  })
}

function detectCompanion() {
  const LOCAL = 'http://127.0.0.1:5279'
  input.value = LOCAL
  chrome.storage.sync.set({ daemonUrl: LOCAL }, () => {
    chrome.runtime.sendMessage({ type: 'setDaemonUrl', url: LOCAL }, () => {
      updateStatus()
      if (detectBtn) detectBtn.textContent = 'Detected ✓'
      setTimeout(() => { if (detectBtn) detectBtn.textContent = 'Detect ReviveL Companion' }, 1500)
    })
  })
}

chrome.storage.sync.get(['daemonUrl'], (r: { [key: string]: any }) => {
  if (r.daemonUrl) input.value = r.daemonUrl
  updateStatus()
})

if (detectBtn) {
  detectBtn.addEventListener('click', detectCompanion)
}

save.addEventListener('click', () => {
  const url = input.value.trim() || null
  chrome.storage.sync.set({ daemonUrl: url }, () => {
    chrome.runtime.sendMessage({ type: 'setDaemonUrl', url }, () => {
      save.textContent = 'Saved ✓'
      updateStatus()
      setTimeout(() => save.textContent = 'Save settings', 1600)
    })
  })
})
