// lbryApi.ts - Dual support: public Odysee proxy + local lbrynet daemon
// All calls go through background for consistency (CORS safety)

export interface LbryClaim {
  name?: string
  claim_id?: string
  value?: any
  canonical_url?: string
  short_url?: string
  streaming_url?: string
  title?: string
  thumbnail?: { url?: string }
  [key: string]: any
}

export interface LbryResolveResult {
  [uri: string]: LbryClaim | { error: string }
}

export interface DaemonStatus {
  connected: boolean
  endpoint?: string
  using?: string
  error?: string
}

export async function resolveLbryUri(uri: string): Promise<LbryResolveResult> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'resolve', uri },
      (response) => {
        if (chrome.runtime.lastError) {
          return reject(chrome.runtime.lastError)
        }
        if (response?.ok) {
          resolve(response.result)
        } else {
          reject(new Error(response?.error || 'Resolve failed'))
        }
      }
    )
  })
}

export async function getDaemonStatus(): Promise<DaemonStatus> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'getDaemonStatus' }, (resp) => {
      resolve(resp || { connected: false })
    })
  })
}

export async function setDaemonUrl(url: string | null) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'setDaemonUrl', url }, resolve)
  })
}

export async function getWalletBalance(): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'getWalletBalance' }, (response) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError)
      if (response?.ok) resolve(response.result)
      else reject(new Error(response?.error || 'Balance fetch failed'))
    })
  })
}

export async function getReceiveAddress(): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'getReceiveAddress' }, (response) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError)
      if (response?.ok) resolve(response.result)
      else reject(new Error(response?.error || 'Failed to get receive address'))
    })
  })
}

export async function sendLBC(address: string, amount: string, fee?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'sendLBC', address, amount, fee }, (response) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError)
      if (response?.ok) resolve(response.result)
      else reject(new Error(response?.error || 'Send failed'))
    })
  })
}

export async function getTransactions(typeFilter?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'getTransactions', type_filter: typeFilter }, (response) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError)
      if (response?.ok) resolve(response.result)
      else reject(new Error(response?.error || 'Failed to get transactions'))
    })
  })
}

export async function createWallet(): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'createWallet' }, (response) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError)
      if (response?.ok) resolve(response.result)
      else reject(new Error(response?.error || 'Wallet create failed'))
    })
  })
}

export async function closeWallet(): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'closeWallet' }, (response) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError)
      if (response?.ok) resolve(response.result)
      else reject(new Error(response?.error || 'Close wallet failed'))
    })
  })
}

export async function deleteWallet(): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'deleteWallet' }, (response) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError)
      if (response?.ok) resolve(response.result)
      else reject(new Error(response?.error || 'Delete wallet failed'))
    })
  })
}

export async function getWalletSeed(): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'getWalletSeed' }, (response) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError)
      if (response?.ok) resolve(response.result)
      else reject(new Error(response?.error || 'Failed to get seed'))
    })
  })
}

export async function publishStream(params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'publish', params }, (response) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError)
      if (response?.ok) resolve(response.result)
      else reject(new Error(response?.error || 'Publish failed'))
    })
  })
}

export async function searchLbryClaims(params: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'claimSearch', params },
      (response) => {
        if (chrome.runtime.lastError) {
          return reject(chrome.runtime.lastError)
        }
        if (response?.ok) resolve(response.result)
        else reject(new Error(response?.error || 'Search failed'))
      }
    )
  })
}

// Helper: pick a playable URL from resolve result (prefers daemon/public streaming_url)
export function getPlayableUrl(claim: LbryClaim | any): string | null {
  if (!claim) return null

  // Prefer direct streaming URLs from daemon or proxy
  if (claim.streaming_url && isDirectMediaUrl(claim.streaming_url)) return claim.streaming_url

  const v = claim.value || {}
  if (v.streaming_url && isDirectMediaUrl(v.streaming_url)) return v.streaming_url

  // If we have a direct file URL in other places
  if (v.source?.url && isDirectMediaUrl(v.source.url)) return v.source.url

  // No good direct playable URL found
  return null
}

function isDirectMediaUrl(url: string): boolean {
  if (!url) return false
  const lower = url.toLowerCase()
  // Common direct media extensions used by LBRY
  return lower.includes('.mp4') || lower.includes('.webm') || lower.includes('.m3u8') || lower.includes('.mpd') || lower.includes('/stream')
}

// Extract a nice claim object from the resolve envelope
export function extractClaim(resolveResult: LbryResolveResult, uri: string): LbryClaim | null {
  const entry = resolveResult?.[uri]
  if (!entry || (entry as any).error) return null
  return entry as LbryClaim
}
