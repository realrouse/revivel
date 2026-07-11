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

  const v = claim.value || {}

  // Collect possible streaming URL candidates (public proxy often puts them in different places)
  const candidates = [
    claim.streaming_url,
    v.streaming_url,
    claim.meta?.streaming_url,
    v.source?.url,
    v.stream?.source?.url,
    // Sometimes the proxy includes it under file
    claim.file?.streaming_url,
    v.file?.streaming_url,
  ].filter(Boolean);

  for (const url of candidates) {
    if (typeof url === 'string' && url.length > 10) {
      // In public mode we are more lenient — try any reasonable https URL
      if (isDirectMediaUrl(url) || url.startsWith('https://')) {
        return url;
      }
    }
  }

  // No good playable URL found from resolve
  return null
}

/**
 * Last-resort public stream URL construction for Odysee/LBRY public content.
 * Uses the free streams API when no direct streaming_url was provided by resolve/get.
 */
export function buildPublicStreamUrl(claim: any): string | null {
  if (!claim) return null;
  const v = claim.value || {};
  const name = claim.name;
  const claimId = claim.claim_id || v.claim_id;
  const sdHash = v.source?.sd_hash || v.stream?.source?.sd_hash;

  if (name && claimId && sdHash) {
    // Odysee public free stream endpoint
    return `https://player.odycdn.com/api/v4/streams/free/${name}/${claimId}/${sdHash}`;
  }
  return null;
}

/**
 * For public mode fallback: use Odysee's official embed player.
 * This bypasses direct video CORS/401 issues by using their hosted player.
 */
export function getOdyseeEmbedUrl(claim: any): string | null {
  if (!claim) return null;
  const v = claim.value || {};
  let name = claim.name || claim.normalized_name || v.normalized_name;
  let claimId = claim.claim_id || v.claim_id;
  // fallback to parsing canonical_url like lbry://@ch#id/name#id
  if ((!name || !claimId) && claim.canonical_url) {
    const parts = claim.canonical_url.replace('lbry://', '').split('/');
    if (parts.length > 1) {
      name = parts[1].split('#')[0];
      claimId = parts[1].split('#')[1] || claimId;
    }
  }
  if (name && claimId) {
    return `https://odysee.com/$/embed/${encodeURIComponent(name)}/${claimId}`;
  }
  return null;
}

function isDirectMediaUrl(url: string): boolean {
  if (!url) return false
  const lower = url.toLowerCase()
  // Common direct media + Odysee public stream patterns
  return lower.includes('.mp4') ||
         lower.includes('.webm') ||
         lower.includes('.m3u8') ||
         lower.includes('.mpd') ||
         lower.includes('/stream') ||
         lower.includes('odycdn.com') ||
         lower.includes('player.odycdn.com') ||
         lower.includes('lbry.tv') ||
         lower.includes('/api/v4/streams');
}

// Extract a nice claim object from the resolve envelope
export function extractClaim(resolveResult: LbryResolveResult, uri: string): LbryClaim | null {
  const entry = resolveResult?.[uri]
  if (!entry || (entry as any).error) return null
  return entry as LbryClaim
}

/**
 * Returns the most reliable timestamp for a claim (for recency/"latest" ordering and display).
 * Prefers on-chain meta.creation_timestamp (set by the network at publish/activation time).
 * Falls back to value.release_time but SANITIZES common bad data from publishers:
 *  - Millisecond timestamps (Date.now() mistakes)
 *  - Garbage huge numbers
 *  - Distant future sentinels (e.g. year 9999)
 * This fixes stale 2023-era videos (and similar) polluting "Latest" and "More to Watch"
 * when order_by release_time on daemon or public proxy surfaces them due to bad value.release_time.
 */
export function getClaimTimestamp(claim: any): number {
  const now = Math.floor(Date.now() / 1000)
  const MAX_FUTURE_SKEW = 86400 * 2; // allow up to ~2 days in future for clock skew / minor errors

  // Prefer meta.creation_timestamp (on-chain)
  let ts = Number(claim?.meta?.creation_timestamp || 0)
  if (!ts || ts <= 0 || ts > now + MAX_FUTURE_SKEW) {
    ts = 0
  }

  if (ts === 0) {
    let valTs = Number(claim?.value?.release_time || claim?.release_time || 0)
    // Heuristics for bogus release_time:
    // > 1e11 likely ms since epoch (e.g. 1.7e12)
    // > now + ~10 years also suspicious
    // very small or year-9999 sentinels also bad
    // Also reject clear future dates (e.g. year 3003 bogus claims)
    if (!valTs || valTs > 1e11 || valTs > (now + 86400 * 365 * 10) || valTs > 2e11 || valTs > now + MAX_FUTURE_SKEW) {
      valTs = 0
    }
    ts = valTs
  }

  return ts > 0 ? ts : 0
}

/**
 * Returns true if the claim has a release_time in the future (beyond skew).
 * Such claims should be filtered out of "Latest" results, as they are not yet
 * "released" per the publisher (e.g. bogus future-year claims like 8878, 3003).
 */
export function isFutureDatedClaim(claim: any): boolean {
  const now = Math.floor(Date.now() / 1000)
  const MAX_FUTURE_SKEW = 86400 * 2; // 2 days
  const valTs = Number(claim?.value?.release_time || claim?.release_time || 0)
  if (valTs > now + MAX_FUTURE_SKEW) {
    return true
  }
  return false
}

/**
 * Multiple categorized one-word libraries for the Feed sidebars in player.html.
 * All entries are strictly single words (no phrases).
 * Users can switch libraries via the "Word Library" button (General, NSFW, Politics, etc.).
 * Each library is expanded with hundreds of relevant one-word terms.
 */

export const WORD_LIBRARIES: Record<string, string[]> = {
  general: [
    "what", "why", "how", "who", "when", "where", "best", "top", "news", "world", "science", "tech", "ai", "future", "past",
    "truth", "lie", "freedom", "control", "mind", "health", "money", "power", "love", "war", "peace", "god", "faith",
    "bible", "jesus", "israel", "gaza", "trump", "biden", "russia", "china", "usa", "uk", "europe", "crypto", "bitcoin",
    "ethereum", "lbc", "odysee", "video", "movie", "music", "game", "sport", "soccer", "football", "nba", "ufc", "car",
    "home", "diy", "cook", "food", "travel", "space", "earth", "moon", "sun", "star", "fire", "water", "air", "tree",
    "dog", "cat", "life", "death", "soul", "spirit", "energy", "covid", "climate", "election", "vote", "protest", "police",
    "army", "school", "work", "job", "boss", "family", "friend", "baby", "child", "man", "woman", "king", "queen", "city",
    "farm", "ocean", "mountain", "river", "forest", "desert", "island", "plane", "train", "ship", "bike", "phone",
    "computer", "robot", "drone", "mars", "alien", "ufo", "ghost", "magic", "witch", "vampire", "zombie", "titanic",
    "epstein", "gates", "wef", "nwo", "reset", "agenda", "one", "government", "bank", "fed", "dollar", "gold",
    "silver", "oil", "gas", "solar", "wind", "nuclear", "shortage", "collapse", "survive", "prep", "garden", "grow",
    "seed", "sovereign", "liberty", "tyranny", "patriot", "globalist", "nationalist", "populist", "woke", "meme", "viral",
    "trend", "youtube", "twitter", "telegram", "rumble", "bitchute", "lbry", "revive", "claim", "stake", "support", "blockchain",
    "market", "stock", "debt", "inflation", "recession", "land", "rights", "speech", "press", "tax", "audit", "vaccine",
    "great", "reset", "build", "back", "better", "plandemic", "scamdemic", "hoax", "real", "awake", "sheep", "wolf",
    "lion", "eagle", "dragon", "phoenix", "tiger", "bear", "bull", "venus", "jupiter", "saturn", "pluto",
    "comet", "asteroid", "blackhole", "quantum", "dna", "rna", "virus", "bacteria", "fungi", "plant", "animal", "human",
    "cyborg", "android", "neural", "link", "brain", "chip", "wifi", "internet", "web", "net", "dark", "deep", "state",
    "swamp", "drain", "anon", "maga", "save", "america", "order", "new", "old", "young", "ancient", "modern", "history",
    "mystery", "secret", "hidden", "forbidden", "lost", "found", "treasure", "ark", "holy", "grail", "temple", "pyramid",
    "sphinx", "civil", "atlantis", "valhalla", "armageddon", "apocalypse", "revelation", "prophecy", "end", "times",
    "messiah", "antichrist", "beast", "mark", "matrix", "simulation", "hologram", "illusion", "awakening", "ascension",
    "enlightenment", "meditation", "yoga", "prayer", "fast", "detox", "cleanse", "organic", "natural", "raw", "vegan",
    "carnivore", "keto", "paleo", "gluten", "fluoride", "offgrid", "homestead", "self", "sustainable", "permaculture",
    "solar", "wind", "generator", "battery", "well", "spring", "rain", "catchment", "compost", "tiny", "home", "cabin",
    "bunker", "shelter", "kit", "first", "aid", "trauma", "surgery", "herbal", "remedy", "essential", "oil", "silver",
    "iodine", "charcoal", "zeolite", "vitamin", "zinc", "turmeric", "ginger", "garlic", "honey", "mushroom", "reishi",
    "chaga", "health", "longevity", "biohacking", "nootropic", "stack", "peptide", "pineal", "gland", "heavy", "metal",
    "chelation", "bentonite", "clay", "shilajit", "fulvic", "acid", "ormus", "gold", "powder", "manna", "elixir", "alchemy",
    "symptom", "disease", "cure", "healing", "miracle", "placebo", "mind", "body", "soul", "consciousness", "awareness",
    "source", "creator", "universe", "cosmos", "multiverse", "fractal", "sacred", "geometry", "flower", "life", "torus",
    "vortex", "frequency", "vibration", "resonance", "sound", "healing", "music", "binaural", "beats", "breathwork",
    "kundalini", "chakra", "eye", "dmt", "ayahuasca", "psilocybin", "cannabis", "hemp", "cbd", "thc", "energy", "tesla",
    "coil", "free", "energy", "overunity", "gravity", "ufo", "disclosure", "area", "lazar", "fusion", "plasma", "physics",
    "astronomy", "cosmology", "gravity", "string", "theory", "entanglement", "observer", "anthropic", "principle",
    "simulation", "hypothesis", "reality", "ancestor", "glitch", "matrix", "mandela", "effect", "cern", "higgs", "boson",
    "blackhole", "hawking", "entropy", "inflation", "multiverse", "dark", "matter", "energy", "wimp", "axion", "quantum",
    "time", "life", "love", "hope", "dream", "fear", "anger", "joy", "peace", "chaos", "order", "light", "dark", "shadow",
    "ego", "self", "higher", "lower", "good", "evil", "truth", "lie", "real", "fake", "awake", "asleep", "sheeple", "redpill",
    "bluepill", "based", "cringe", "sigma", "alpha", "beta", "omega", "grind", "hustle", "wealth", "poverty", "success",
    "failure", "win", "lose", "fight", "flight", "survive", "thrive", "build", "destroy", "create", "consume", "learn",
    "teach", "lead", "follow", "question", "answer", "search", "find", "hide", "reveal", "expose", "cover", "up", "wake",
    "sleep", "dream", "nightmare", "vision", "prophet", "sage", "wizard", "witch", "hero", "villain", "king", "queen",
    "rebel", "slave", "master", "servant", "friend", "enemy", "ally", "traitor", "patriot", "globalist", "nationalist"
  ],

  nsfw: [
    "sex", "porn", "fuck", "pussy", "dick", "cock", "ass", "tits", "boobs", "cum", "blowjob", "handjob", "anal", "oral",
    "vagina", "penis", "clit", "nipple", "orgasm", "masturbate", "fisting", "gangbang", "threesome", "milf", "teen",
    "bbw", "creampie", "squirt", "fetish", "bdsm", "bondage", "spank", "whip", "latex", "leather", "nude", "naked",
    "lesbian", "gay", "bisexual", "trans", "shemale", "hentai", "ecchi", "yaoi", "yuri", "thot", "slut", "whore",
    "escort", "hooker", "stripper", "camgirl", "onlyfans", "thirst", "horny", "kink", "taboo", "incest", "stepmom",
    "stepsister", "cheating", "cuckold", "hotwife", "swinger", "orgy", "swing", "voyeur", "exhibition", "public",
    "gloryhole", "pegging", "rimming", "deepthroat", "facial", "swallow", "doggy", "missionary", "cowgirl", "reverse",
    "69", "hardcore", "softcore", "amateur", "professional", "interracial", "asian", "ebony", "latina", "blonde",
    "redhead", "brunette", "big", "small", "tight", "wet", "juicy", "thick", "thin", "shaved", "hairy", "piercing",
    "tattoo", "lingerie", "stockings", "heels", "boots", "collar", "leash", "gag", "blindfold", "rope", "cuffs",
    "paddle", "cane", "flogger", "wax", "ice", "vibrator", "dildo", "buttplug", "cockring", "strapon", "harness",
    "dominatrix", "submissive", "dominant", "switch", "master", "slave", "daddy", "mommy", "brat", "petplay", "puppy",
    "kitty", "pony", "latex", "rubber", "pvc", "vinyl", "nylon", "silk", "lace", "fishnet", "corset", "bodysuit",
    "chastity", "cage", "plug", "pump", "suction", "edging", "denial", "ruined", "sissification", "feminization",
    "sissy", "chastity", "keyholder", "bull", "cuck", "hotwife", "stag", "vixen", "unicorn", "throuple", "poly",
    "open", "swinger", "lifestyle", "kinky", "vanilla", "prude", "slutty", "whorish", "naughty", "dirty", "filthy",
    "nasty", "pervy", "lewd", "lascivious", "carnal", "sensual", "erotic", "explicit", "xxx", "adult", "mature",
    "bareback", "raw", "condomless", "breeding", "impregnate", "pregnant", "lactating", "milking", "squirting",
    "gushing", "creamy", "messy", "sloppy", "sloppy", "throat", "gagging", "choking", "slapping", "spitting",
    "pissing", "golden", "shower", "watersports", "scat", "toilet", "rim", "ass", "eating", "facesitting", "queening",
    "smother", "trampling", "foot", "worship", "shoe", "sock", "armpit", "sweat", "smell", "musk", "body", "fluid",
    "spit", "saliva", "sweat", "piss", "semen", "sperm", "jizz", "load", "nut", "balls", "shaft", "head", "tip",
    "foreskin", "circumcised", "uncut", "girth", "length", "monster", "huge", "tiny", "micro", "average", "normal",
    "erect", "flaccid", "hard", "soft", "wet", "dry", "lubed", "oiled", "slick", "sticky", "tasty", "smelly", "rank"
  ],

  politics: [
    "trump", "biden", "obama", "clinton", "bush", "putin", "xi", "jinping", "zelensky", "netanyahu", "modi", "erdogan",
    "election", "vote", "ballot", "fraud", "steal", "rigged", "swamp", "deepstate", "congress", "senate", "house",
    "democrat", "republican", "liberal", "conservative", "progressive", "libertarian", "socialist", "communist",
    "fascist", "woke", "cancel", "culture", "protest", "riot", "march", "rally", "campaign", "candidate", "president",
    "vice", "governor", "mayor", "senator", "representative", "justice", "supreme", "court", "judge", "law", "bill",
    "act", "amendment", "constitution", "freedom", "liberty", "rights", "speech", "press", "assembly", "petition",
    "second", "amendment", "gun", "control", "border", "wall", "immigration", "deport", "citizen", "patriot",
    "nationalist", "globalist", "elite", "cabal", "illuminati", "nwo", "wef", "davos", "agenda", "reset", "great",
    "qanon", "anon", "wwg1wga", "maga", "maha", "drain", "corrupt", "scandal", "impeach", "censure", "investigate",
    "hearing", "testimony", "whistleblower", "leak", "spy", "surveillance", "fisa", "cia", "fbi", "nsa", "pentagon",
    "whitehouse", "capitol", "hill", "lobby", "pac", "donation", "superpac", "dark", "money", "influence", "bribe",
    "corruption", "treason", "sedition", "insurrection", "coup", "revolution", "resistance", "rebellion", "tyranny",
    "dictator", "authoritarian", "totalitarian", "democracy", "republic", "monarchy", "oligarchy", "plutocracy",
    "technocracy", "bureaucracy", "deep", "state", "administrative", "state", "uniparty", "rhino", "rinos", "neocon",
    "neoliberal", "globalism", "nationalism", "populism", "isolationism", "intervention", "war", "hawk", "dove",
    "peace", "sanction", "tariff", "trade", "deal", "treaty", "alliance", "nato", "un", "who", "wto", "imf", "world",
    "bank", "fed", "reserve", "treasury", "debt", "ceiling", "deficit", "tax", "spend", "stimulus", "bailout",
    "infrastructure", "green", "new", "deal", "medicare", "social", "security", "welfare", "entitlement", "reform",
    "abortion", "roe", "wade", "prolife", "prochoice", "gender", "trans", "lgbt", "pride", "flag", "rainbow",
    "critical", "race", "theory", "crt", "dei", "diversity", "equity", "inclusion", "affirmative", "action", "quota",
    "reparations", "slavery", "colonial", "imperial", "empire", "colony", "independence", "sovereignty", "secede",
    "union", "confederate", "civil", "war", "revolution", "founding", "fathers", "constitution", "bill", "rights",
    "declaration", "independence", "federalist", "antifederalist", "originalist", "textualist", "living", "document"
  ],

  science: [
    "physics", "quantum", "biology", "chemistry", "astronomy", "cosmology", "geology", "ecology", "genetics", "dna",
    "rna", "atom", "particle", "electron", "proton", "neutron", "quark", "boson", "higgs", "gravity", "relativity",
    "blackhole", "wormhole", "singularity", "event", "horizon", "nasa", "spacex", "mars", "moon", "venus", "jupiter",
    "saturn", "pluto", "comet", "asteroid", "meteor", "nebula", "galaxy", "universe", "multiverse", "big", "bang",
    "inflation", "dark", "matter", "energy", "string", "theory", "loop", "quantum", "gravity", "entanglement",
    "superposition", "uncertainty", "heisenberg", "schrodinger", "cat", "double", "slit", "observer", "measurement",
    "wave", "function", "collapse", "decoherence", "entanglement", "nonlocality", "bell", "inequality", "epr",
    "paradox", "time", "travel", "warp", "drive", "fusion", "fission", "nuclear", "plasma", "laser", "particle",
    "accelerator", "cern", "lhc", "collider", "neutrino", "muon", "lepton", "hadron", "fermion", "boson", "gluon",
    "photon", "graviton", "tachyon", "antimatter", "positron", "proton", "neutron", "isotope", "element", "periodic",
    "table", "molecule", "atom", "ion", "electron", "orbital", "valence", "bond", "covalent", "ionic", "hydrogen",
    "carbon", "oxygen", "nitrogen", "silicon", "gold", "iron", "copper", "silver", "uranium", "plutonium", "fusion",
    "reactor", "tokamak", "stellarator", "iter", "nif", "laser", "inertial", "confinement", "sonofusion", "bubble",
    "cavitation", "lenr", "cold", "fusion", "ecat", "rossi", "hydrino", "mills", "polywell", "bussard", "fusor",
    "farnsworth", "focus", "fusion", "dense", "plasma", "focus", "lerner", "sonoluminescence", "pistol", "shrimp",
    "biology", "genetics", "crispr", "cas9", "gene", "editing", "sequencing", "genome", "proteome", "transcriptome",
    "epigenetics", "methylation", "histone", "rna", "mrna", "trna", "rrna", "sirna", "mirna", "lncrna", "virus",
    "bacteria", "fungi", "prion", "viroid", "pathogen", "vaccine", "mrna", "vector", "adenovirus", "spike", "protein",
    "antibody", "antigen", "immune", "system", "tcell", "bcell", "macrophage", "neutrophil", "lymphocyte", "cytokine",
    "interferon", "inflammation", "apoptosis", "mitosis", "meiosis", "replication", "transcription", "translation",
    "mutation", "evolution", "darwin", "natural", "selection", "speciation", "adaptation", "fitness", "ecology",
    "ecosystem", "biodiversity", "extinction", "climate", "change", "global", "warming", "greenhouse", "carbon",
    "dioxide", "methane", "ozone", "pollution", "radiation", "nuclear", "waste", "renewable", "solar", "wind",
    "geothermal", "hydro", "tidal", "biomass", "fossil", "fuel", "oil", "gas", "coal", "fracking", "peak", "oil"
  ],

  sports: [
    "soccer", "football", "basketball", "nba", "nfl", "mlb", "nhl", "ufc", "mma", "boxing", "wrestling", "tennis",
    "golf", "baseball", "hockey", "cricket", "rugby", "olympics", "worldcup", "superbowl", "finals", "championship",
    "playoffs", "quarterfinal", "semifinal", "goal", "score", "touchdown", "home", "run", "strike", "out", "pitcher",
    "quarterback", "point", "guard", "center", "forward", "striker", "goalkeeper", "referee", "umpire", "coach",
    "manager", "player", "team", "league", "tournament", "bracket", "seed", "rank", "ranking", "record", "win", "loss",
    "draw", "tie", "overtime", "extra", "innings", "penalty", "shootout", "free", "throw", "field", "goal", "kick",
    "punt", "tackle", "sack", "interception", "fumble", "turnover", "assist", "rebound", "steal", "block", "dunk",
    "layup", "three", "pointer", "slam", "dunk", "fastbreak", "zone", "defense", "offense", "strategy", "playbook",
    "training", "workout", "gym", "fitness", "athlete", "professional", "amateur", "college", "highschool", "youth",
    "draft", "trade", "contract", "salary", "cap", "free", "agent", "rookie", "veteran", "allstar", "mvp", "award",
    "trophy", "medal", "gold", "silver", "bronze", "champ", "underdog", "favorite", "odds", "betting", "spread",
    "over", "under", "prop", "parlay", "fantasy", "league", "roster", "lineup", "bench", "starter", "substitute",
    "injury", "concussion", "acl", "hamstring", "recovery", "rehab", "doping", "steroid", "ped", "testing", "clean",
    "dirty", "scandal", "cheat", "ref", "bad", "call", "var", "review", "instant", "replay", "challenge", "flag",
    "yellow", "card", "red", "card", "ejection", "suspension", "ban", "fine", "appeal", "fan", "crowd", "stadium",
    "arena", "field", "court", "pitch", "rink", "track", "pool", "gym", "mat", "ring", "cage", "octagon", "canvas",
    "gloves", "helmet", "pads", "jersey", "uniform", "cleats", "sneakers", "ball", "puck", "bat", "club", "racket",
    "stick", "net", "hoop", "goalpost", "endzone", "sideline", "baseline", "halfcourt", "midfield", "penalty", "box"
  ],

  spirituality: [
    "god", "jesus", "allah", "buddha", "krishna", "shiva", "vishnu", "yahweh", "jehovah", "soul", "spirit", "chakra",
    "karma", "dharma", "zen", "tao", "yoga", "meditation", "prayer", "mantra", "chant", "om", "namaste", "enlighten",
    "ascension", "awakening", "consciousness", "awareness", "presence", "mindfulness", "transcend", "nirvana",
    "samsara", "moksha", "heaven", "hell", "purgatory", "limbo", "angel", "archangel", "demon", "devil", "satan",
    "lucifer", "seraphim", "cherubim", "throne", "dominion", "virtue", "power", "principalities", "fallen", "nephilim",
    "watchers", "elohim", "yhwh", "holy", "spirit", "trinity", "father", "son", "ghost", "prophet", "messiah",
    "christ", "buddha", "bodhisattva", "guru", "saint", "mystic", "shaman", "priest", "monk", "nun", "sage", "seer",
    "oracle", "divine", "sacred", "holy", "blessed", "anointed", "chosen", "elect", "saved", "damned", "sin",
    "forgive", "repent", "grace", "faith", "hope", "love", "charity", "virtue", "sin", "temptation", "lust", "pride",
    "greed", "envy", "gluttony", "wrath", "sloth", "humility", "patience", "kindness", "diligence", "chastity",
    "temple", "church", "mosque", "synagogue", "shrine", "altar", "cross", "star", "crescent", "lotus", "mandala",
    "yantra", "talisman", "amulet", "relic", "icon", "statue", "idol", "graven", "image", "scripture", "bible",
    "quran", "torah", "vedas", "upanishads", "bhagavad", "gita", "dhammapada", "tripitaka", "sutra", "koan", "zazen",
    "vipassana", "metta", "tonglen", "kundalini", "shakti", "shiva", "shakti", "tantra", "mantra", "yantra", "mudra",
    "bandha", "pranayama", "asana", "samadhi", "satori", "kensho", "wu", "wei", "yin", "yang", "tao", "te", "ching",
    "i", "ching", "hexagram", "trigram", "feng", "shui", "qi", "chi", "prana", "life", "force", "aura", "chakra",
    "root", "sacral", "solar", "plexus", "heart", "throat", "third", "eye", "crown", "pineal", "gland", "kundalini",
    "serpent", "energy", "meridian", "acupuncture", "reiki", "healing", "crystal", "quartz", "amethyst", "sodalite",
    "lapiz", "lazuli", "turquoise", "jade", "obsidian", "sacred", "geometry", "flower", "life", "metatron", "cube",
    "merkaba", "torus", "vesica", "piscis", "golden", "ratio", "phi", "fibonacci", "spiral", "fractal", "hologram",
    "illusion", "maya", "veil", "matrix", "simulation", "awakening", "gnosis", "esoteric", "occult", "mystery",
    "initiation", "mystery", "school", "hermetic", "kybalion", "emerald", "tablet", "thoth", "hermes", "trismegistus",
    "alchemy", "transmute", "philosopher", "stone", "elixir", "life", "ambrosia", "soma", "manna", "prana", "qi"
  ],

  tech: [
    "ai", "gpt", "llm", "neural", "network", "deep", "learning", "machine", "learning", "robot", "drone", "blockchain",
    "crypto", "bitcoin", "ethereum", "solana", "cardano", "ripple", "nft", "web3", "metaverse", "vr", "ar", "xr",
    "5g", "6g", "wifi", "iot", "sensor", "chip", "cpu", "gpu", "tpu", "quantum", "computing", "qubit", "superposition",
    "entanglement", "algorithm", "code", "program", "software", "hardware", "firmware", "kernel", "driver", "api",
    "sdk", "framework", "library", "database", "server", "cloud", "edge", "fog", "computing", "neuralink", "brain",
    "chip", "interface", "bci", "cyber", "security", "hacking", "malware", "ransomware", "virus", "worm", "trojan",
    "phishing", "spoof", "ddos", "firewall", "vpn", "proxy", "tor", "darkweb", "deepweb", "encryption", "decryption",
    "hash", "block", "chain", "ledger", "token", "coin", "wallet", "exchange", "defi", "yield", "farm", "liquidity",
    "pool", "smart", "contract", "solidity", "rust", "go", "python", "javascript", "typescript", "react", "vue",
    "angular", "node", "express", "django", "flask", "fastapi", "docker", "kubernetes", "aws", "azure", "gcp",
    "lambda", "serverless", "microservice", "monolith", "devops", "ci", "cd", "git", "github", "gitlab", "bitbucket",
    "open", "source", "closed", "source", "proprietary", "patent", "copyright", "license", "gpl", "mit", "apache",
    "agpl", "copyleft", "free", "software", "stallman", "torvalds", "gates", "musk", "bezos", "zuck", "cook", "jobs",
    "wozniak", "tesla", "spacex", "neuralink", "boring", "company", "xai", "openai", "anthropic", "google", "deepmind",
    "meta", "apple", "microsoft", "amazon", "nvidia", "amd", "intel", "arm", "riscv", "fpga", "asic", "quantum",
    "supremacy", "advantage", "error", "correction", "decoherence", "superconducting", "ion", "trap", "photonic",
    "neutral", "atom", "spin", "qubit", "topological", "quantum", "internet", "teleportation", "entanglement",
    "swapping", "repeater", "satellite", "starlink", "constellation", "orbit", "low", "earth", "leo", "meo", "geo",
    "space", "x", "rocket", "falcon", "starship", "dragon", "capsule", "iss", "nasa", "esa", "roscosmos", "cnsa",
    "isro", "jaxa", "mars", "perseverance", "curiosity", "rover", "helicopter", "ingenuity", "starship", "artemis",
    "moon", "base", "colony", "mars", "terraform", "space", "travel", "warp", "drive", "em", "drive", "alcubierre",
    "metric", "lightsail", "solar", "sail", "ion", "thruster", "nuclear", "thermal", "propulsion", "fusion", "rocket"
  ],

  health: [
    "vaccine", "detox", "vitamin", "mineral", "supplement", "herb", "mushroom", "fast", "keto", "paleo", "carnivore",
    "vegan", "vegetarian", "organic", "gmo", "fluoride", "heavy", "metal", "chelation", "ivermectin", "hydroxychloroquine",
    "zinc", "quercetin", "d3", "c", "magnesium", "potassium", "boron", "selenium", "turmeric", "curcumin", "ginger",
    "garlic", "onion", "honey", "manuka", "propolis", "royal", "jelly", "bee", "pollen", "reishi", "chaga", "cordyceps",
    "lion", "mane", "turkey", "tail", "maitake", "shiitake", "agaricus", "health", "longevity", "biohacking", "nootropic",
    "peptide", "bpc157", "tb500", "semax", "selank", "pineal", "gland", "decals", "activated", "charcoal", "zeolite",
    "bentonite", "clay", "shilajit", "fulvic", "humic", "acid", "ormus", "monoatomic", "gold", "silver", "colloidal",
    "iodine", "nascent", "mms", "cds", "chlorine", "dioxide", "edta", "dmps", "dmsa", "chelation", "detox", "liver",
    "kidney", "colon", "lymph", "blood", "brain", "gut", "microbiome", "probiotic", "prebiotic", "synbiotic", "enzyme",
    "digestive", "metabolism", "hormone", "thyroid", "adrenal", "cortisol", "insulin", "leptin", "ghrelin", "testosterone",
    "estrogen", "progesterone", "melatonin", "serotonin", "dopamine", "oxytocin", "endorphin", "inflammation", "cytokine",
    "autoimmune", "allergy", "histamine", "mast", "cell", "cancer", "tumor", "oncology", "remission", "apoptosis",
    "mitochondria", "atp", "oxidative", "stress", "antioxidant", "free", "radical", "glycation", "advanced", "end",
    "product", "telomere", "senescence", "stem", "cell", "regeneration", "healing", "wound", "scar", "tissue",
    "collagen", "elastin", "hyaluronic", "acid", "peptide", "growth", "factor", "igf", "hgh", "sermorelin", "tesamorelin",
    "cjc", "ipamorelin", "ghrp", "mk677", "ibutamoren", "rad", "140", "lgd", "4033", "sarms", "steroid", "anabolic",
    "tren", "deca", "test", "cyp", "enanthate", "propionate", "sustanon", "trt", "hrt", "menopause", "andropause",
    "libido", "erectile", "dysfunction", "fertility", "sperm", "egg", "embryo", "pregnancy", "birth", "postpartum",
    "breastfeed", "colostrum", "lactation", "ketosis", "autophagy", "intermittent", "fasting", "omad", "water", "fast",
    "dry", "fast", "juice", "fast", "bone", "broth", "collagen", "hydrolyzed", "whey", "protein", "casein", "pea",
    "rice", "hemp", "soy", "isolate", "concentrate", "hydrolysate", "creatine", "monohydrate", "beta", "alanine",
    "citrulline", "malate", "arginine", "nitric", "oxide", "preworkout", "postworkout", "electrolyte", "hydration",
    "dehydration", "electrolytes", "sodium", "potassium", "magnesium", "calcium", "phosphorus", "trace", "mineral"
  ],

  finance: [
    "bitcoin", "ethereum", "solana", "cardano", "ripple", "xrp", "dogecoin", "shiba", "litecoin", "monero", "zcash",
    "stock", "bond", "etf", "index", "fund", "mutual", "fund", "hedge", "fund", "private", "equity", "venture",
    "capital", "angel", "investor", "seed", "round", "series", "a", "b", "ipo", "spac", "merger", "acquisition",
    "takeover", "buyout", "leveraged", "debt", "equity", "valuation", "market", "cap", "share", "dividend", "yield",
    "eps", "pe", "ratio", "book", "value", "intrinsic", "value", "technical", "analysis", "fundamental", "chart",
    "candle", "trend", "support", "resistance", "moving", "average", "rsi", "macd", "bollinger", "band", "fibonacci",
    "retracement", "inflation", "deflation", "recession", "depression", "boom", "bust", "cycle", "bull", "bear",
    "market", "correction", "crash", "bubble", "manipulation", "pump", "dump", "short", "squeeze", "gamma", "squeeze",
    "options", "call", "put", "strike", "expiry", "premium", "volatility", "vix", "implied", "vol", "delta", "gamma",
    "theta", "vega", "rho", "leverage", "margin", "futures", "commodity", "gold", "silver", "oil", "natural", "gas",
    "copper", "wheat", "corn", "soy", "coffee", "cocoa", "sugar", "cotton", "currency", "forex", "dollar", "euro",
    "yen", "pound", "franc", "yuan", "rupee", "ruble", "crypto", "stablecoin", "usdt", "usdc", "busd", "dai", "fiat",
    "central", "bank", "fed", "reserve", "treasury", "sec", "cftc", "irs", "tax", "audit", "capital", "gain", "loss",
    "income", "revenue", "profit", "loss", "balance", "sheet", "income", "statement", "cash", "flow", "earnings",
    "guidance", "forward", "looking", "quarterly", "annual", "report", "10k", "10q", "8k", "insider", "trading",
    "whistleblower", "sec", "filing", "proxy", "statement", "shareholder", "meeting", "dividend", "yield", "buyback",
    "split", "reverse", "split", "spinoff", "carveout", "restructuring", "bankruptcy", "chapter", "11", "liquidation",
    "receivership", "bailout", "stimulus", "quantitative", "easing", "qe", "tapering", "rate", "hike", "cut", "pivot",
    "fomc", "powell", "yellen", "bernanke", "greenspan", "volcker", "inflation", "target", "employment", "unemployment",
    "labor", "force", "participation", "cpi", "ppi", "gdp", "gnp", "trade", "balance", "deficit", "surplus", "debt",
    "ceiling", "ceiling", "limit", "default", "treasury", "bill", "note", "bond", "yield", "curve", "inverted", "steep",
    "flat", "spread", "credit", "default", "swap", "cds", "interest", "rate", "fed", "funds", "prime", "libor", "sofr"
  ],

  conspiracy: [
    "wef", "nwo", "greatreset", "agenda", "2030", "2050", "epstein", "gates", "soros", "rockefeller", "rothschild",
    "illuminati", "freemason", "skull", "bones", "bohemian", "grove", "bilderberg", "davos", "trilateral", "commission",
    "council", "foreign", "relations", "cfr", "cia", "fbi", "nsa", "deepstate", "swamp", "cabal", "cult", "satanic",
    "pedophile", "elite", "globalist", "new", "world", "order", "one", "world", "government", "un", "who", "wto",
    "imf", "world", "bank", "bis", "bank", "international", "settlements", "central", "bank", "digital", "currency",
    "cbdc", "social", "credit", "score", "digital", "id", "vaccine", "passport", "climate", "hoax", "plandemic",
    "scamdemic", "covid", "vax", "population", "control", "depopulation", "eugenics", "transhuman", "cyborg",
    "neuralink", "brain", "chip", "5g", "6g", "radiation", "emf", "geoengineering", "chemtrail", "contrail", "haarp",
    "weather", "modification", "cloud", "seeding", "hurricane", "manipulation", "earthquake", "weapon", "directed",
    "energy", "weapon", "dew", "scalar", "wave", "mind", "control", "mkultra", "monarch", "programming", "trauma",
    "based", "mind", "control", "subliminal", "message", "frequency", "weapon", "sound", "wave", "ultrasonic",
    "infrasound", "voice", "to", "skull", "v2k", "targeted", "individual", "gang", "stalking", "electronic",
    "harassment", "satellite", "surveillance", "spy", "satellite", "starlink", "spyware", "pegasus", "carnivore",
    "echalon", "prism", "xkeyscore", "snowden", "assange", "wikileaks", "vault", "seven", "pandora", "papers",
    "panama", "paradise", "offshore", "account", "shell", "company", "laundering", "black", "budget", "secret",
    "space", "program", "ssp", "solar", "warden", "breakaway", "civilization", "underground", "base", "dumb",
    "deep", "underground", "military", "base", "area", "51", "s4", "pap", "o", "dulce", "base", "archuleta",
    "mesa", "mount", "weather", "ravens", "rock", "cheyenne", "mountain", "norad", "denver", "airport", "murals",
    "blucifer", "horse", "of", "apocalypse", "lizard", "people", "reptilian", "shapeshifter", "annunaki", "nephilim",
    "fallen", "angel", "watchers", "enoch", "book", "of", "enoch", "dead", "sea", "scrolls", "nag", "hammadi",
    "gnostic", "gospel", "apocrypha", "pseudepigrapha", "forbidden", "history", "ancient", "alien", "ancient",
    "civilization", "atlantis", "lemuria", "mu", "hyperborea", "shambhala", "agartha", "hollow", "earth", "flat",
    "earth", "firmament", "dome", "ice", "wall", "antarctica", "pyramid", "giza", "sphinx", "water", "erosion",
    "bosnian", "pyramid", "gunung", "padang", "derinkuyu", "underground", "city", "derinkuyu", "cappadocia",
    "gobekli", "tepe", "catalhoyuk", "ancient", "technology", "out", "of", "place", "artifact", "oopart", "baghdad",
    "battery", "antikythera", "mechanism", "voynich", "manuscript", "crystal", "skull", "mitchell", "hedges",
    "dinosaur", "footprint", "human", "footprint", "forbidden", "archaeology", "cremo", "thompson", "forbidden",
    "history", "graham", "hancock", "randall", "carlson", "lost", "civilization", "younger", "dryas", "impact",
    "event", "comet", "flood", "noah", "ark", "great", "flood", "atlantis", "plato", "critias", "timaeus", "santorini",
    "thera", "eruption", "minoan", "civilization", "crete", "knossos", "linear", "a", "b", "script", "undeciphered",
    "easter", "island", "moai", "statue", "rongorongo", "script", "nazca", "lines", "peru", "geoglyph", "puma",
    "punku", "tiwanaku", "bolivia", "bolivian", "temple", "kalasasaya", "gateway", "sun", "akapana", "pyramid",
    "stone", "henge", "avebury", "silbury", "hill", "newgrange", "ireland", "passage", "tomb", "knowth", "dowth",
    "carnac", "stones", "france", "megalith", "dolmen", "menhir", "cromlech", "ancient", "high", "technology",
    "vitrified", "fort", "scotland", "melted", "stone", "wall", "baalbek", "lebanon", "trilithon", "quarry", "stone",
    "block", "transport", "levitation", "sound", "wave", "anti", "gravity", "vortex", "math", "sacred", "geometry"
  ]
};

/** Human-friendly labels for the libraries */
export const WORD_LIBRARY_LABELS: Record<string, string> = {
  general: "General",
  nsfw: "NSFW / Adult",
  politics: "Politics & News",
  science: "Science & Tech",
  sports: "Sports",
  spirituality: "Spirituality & Mystery",
  tech: "Tech & Crypto",
  health: "Health & Wellness",
  finance: "Finance & Markets",
  conspiracy: "Conspiracy & Hidden History"
};

/** Return words for a given library key (falls back to general) */
export function getLibraryWords(key: string = "general"): string[] {
  return WORD_LIBRARIES[key] || WORD_LIBRARIES.general;
}

/** Return a random selection of unique one-word terms from the chosen library. */
export function getRandomSearchWords(count: number, libraryKey: string = "general"): string[] {
  const source = getLibraryWords(libraryKey);
  const arr = [...source];
  // Fisher-Yates shuffle
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.min(count, arr.length));
}

/** Back-compat alias (points to general) */
export const POPULAR_SEARCH_WORDS: string[] = getLibraryWords("general");

/** Deduplicate claims by claim_id or canonical_url (for appending pages safely) */
export function dedupClaims(existing: any[], incoming: any[]): any[] {
  const seen = new Set<string>();
  existing.forEach(c => {
    const key = c.claim_id || c.canonical_url || c.name || '';
    if (key) seen.add(String(key));
  });
  const out = [...existing];
  incoming.forEach(c => {
    const key = c.claim_id || c.canonical_url || c.name || '';
    if (!key || seen.has(String(key))) return;
    seen.add(String(key));
    out.push(c);
  });
  return out;
}
