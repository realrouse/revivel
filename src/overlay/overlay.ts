// ReviveL floating overlay player (loaded inside extension iframe)
// The iframe has chrome-extension:// origin, so <video src=localhost> does not blame the host page.

const params = new URLSearchParams(location.search);
const uri = params.get('uri') || '';
let streamUrl = params.get('streamUrl') || '';
const title = params.get('title') || '';
const startTime = parseFloat(params.get('startTime') || '0');
const isStandalone = params.get('standalone') === '1';

let acquireAttempts = 0;
const MAX_ACQUIRE_ATTEMPTS = 3;

const video = document.getElementById('v') as HTMLVideoElement | null;
const foot = document.getElementById('foot')!;
const standaloneHeader = document.getElementById('standalone-header') as HTMLDivElement | null;

foot.textContent = uri || 'LBRY stream';

if (isStandalone && standaloneHeader) {
  standaloneHeader.classList.add('show');
  const titleEl = document.getElementById('standalone-title')!;
  titleEl.textContent = title || 'LBRY Player';

  // Wire standalone buttons
  document.getElementById('sa-close')?.addEventListener('click', () => window.close());
  document.getElementById('sa-fullplayer')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'openFullPlayer', uri, title });
    window.close();
  });
  document.getElementById('sa-full')?.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      video?.requestFullscreen?.().catch(() => {});
    }
  });
  document.getElementById('sa-reattach')?.addEventListener('click', () => {
    const currentTime = video?.currentTime || startTime;
    chrome.runtime.sendMessage({
      type: 'reattachFloating',
      uri,
      title,
      streamUrl,
      startTime: currentTime
    });
    window.close();
  });
}

function setVideoSrc(src: string) {
  if (!video) return;

  // For public mode, the direct URLs (v6 or free) often 401 or fail; go straight to embed
  if (src && (src.includes('odycdn.com') || src.includes('odysee.com'))) {
    loadPublicEmbed();
    return;
  }

  // Clean any previous error state
  const parent = video.parentElement;
  if (parent) {
    parent.querySelectorAll('.no-stream').forEach(n => n.remove());
  }
  video.style.display = 'block';
  video.style.width = '100%';
  video.style.height = '100%';
  video.style.objectFit = 'contain';
  video.style.maxWidth = '100%';
  video.style.maxHeight = '100%';
  video.style.boxSizing = 'border-box';

  const isLikelyHls = src.includes('.m3u8') || src.includes('/streams/') || src.includes('odycdn.com');

  const startPlayback = () => {
    const doPlay = (tryMuted = false) => {
      video.muted = tryMuted;
      video.play().catch((err) => {
        if (!tryMuted) {
          console.debug('Unmuted autoplay blocked, trying muted:', err?.name || err);
          doPlay(true);
        } else {
          console.debug('Autoplay blocked even muted:', err?.name || err);
          showPlayOverlay();
        }
      });
    };

    if (startTime > 0) {
      const seekAndPlay = () => {
        try { video.currentTime = startTime; } catch (_) {}
        const onSeeked = () => doPlay();
        video.addEventListener('seeked', onSeeked, { once: true });
        setTimeout(() => {
          if (Math.abs(video.currentTime - startTime) < 1) doPlay();
        }, 150);
      };
      video.addEventListener('loadedmetadata', seekAndPlay, { once: true });
      if (video.readyState >= 1) seekAndPlay();
    } else {
      const playOnLoad = () => doPlay();
      video.addEventListener('loadedmetadata', playOnLoad, { once: true });
      if (video.readyState >= 1) doPlay();
    }
  };

  // Error recovery with limit
  video.onerror = () => {
    console.warn('Video failed to load/play src:', src);
    if (uri && acquireAttempts < MAX_ACQUIRE_ATTEMPTS) {
      streamUrl = '';
      setTimeout(() => tryAcquireStream(), 300);
    } else {
      showNoStream();
    }
  };

  if (isLikelyHls && typeof (window as any).Hls === 'undefined') {
    // Load hls.js dynamically for public mode HLS streams
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js';
    script.onload = () => initHlsOrDirect(src, startPlayback);
    script.onerror = () => {
      // Fallback direct (may not play HLS)
      video.src = src;
      video.load();
      startPlayback();
    };
    document.head.appendChild(script);
  } else {
    initHlsOrDirect(src, startPlayback);
  }
}

function initHlsOrDirect(src: string, startPlayback: () => void) {
  if (!video) return;
  const isHls = src.includes('.m3u8') || src.includes('/streams/') || src.includes('odycdn.com');
  if (isHls && (window as any).Hls && (window as any).Hls.isSupported()) {
    const hls = new (window as any).Hls({ enableWorker: false, lowLatencyMode: true });
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on((window as any).Hls.Events.MANIFEST_PARSED, startPlayback);
    (video as any)._hls = hls;
  } else {
    video.src = src;
    video.load();
    startPlayback();
  }
}

function showNoStream() {
  if (!video) return;
  video.style.display = 'none';
  const parent = video.parentElement;
  if (!parent) return;
  parent.querySelectorAll('.no-stream').forEach(n => n.remove());
  const msg = document.createElement('div');
  msg.className = 'no-stream';
  msg.innerHTML = 'No playable stream found in public mode.<br>Some videos require the ReviveL Companion.';
  parent.appendChild(msg);
}

function showPlayOverlay() {
  if (!video) return;
  const parent = video.parentElement;
  if (!parent) return;

  // Remove any existing overlay
  parent.querySelectorAll('.play-overlay').forEach(n => n.remove());

  const overlay = document.createElement('div');
  overlay.className = 'play-overlay';
  overlay.style.cssText = `
    position: absolute; inset: 0; z-index: 10;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.45); cursor: pointer;
  `;
  overlay.innerHTML = `
    <div style="
      width: 72px; height: 72px; background: #14b8a6; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    ">
      <div style="
        width: 0; height: 0; border-left: 26px solid #fff;
        border-top: 16px solid transparent; border-bottom: 16px solid transparent;
        margin-left: 6px;
      "></div>
    </div>
  `;

  // Make the parent positioned if needed
  if (getComputedStyle(parent).position === 'static') {
    parent.style.position = 'relative';
  }

  parent.appendChild(overlay);

  const startPlay = (e: Event) => {
    e.stopPropagation();
    video.muted = false;
    video.play().catch(() => {});
    overlay.remove();
    // Re-attach if it pauses later without gesture
    video.addEventListener('pause', () => {
      // only if user didn't pause manually, but keep simple
    }, { once: true });
  };

  overlay.addEventListener('click', startPlay);
  // Also allow double-click on video area
  video.addEventListener('click', startPlay, { once: true });
}

async function tryAcquireStream() {
  if (!uri || !('chrome' in window) || !chrome.runtime) {
    if (!streamUrl) loadPublicEmbed();
    return;
  }

  try {
    const resp: any = await new Promise(r => chrome.runtime.sendMessage({ type: 'streamGet', uri }, r));
    if (resp && resp.ok) {
      const g = resp.result;
      // Dig for streaming_url in various possible shapes (daemon vs public proxy responses)
      const got = g?.streaming_url || 
                  g?.file?.streaming_url || 
                  g?.stream?.streaming_url || 
                  (g?.value && g.value.streaming_url) ||
                  g?.result?.streaming_url ||
                  null;
      if (got) {
        streamUrl = got;
        setVideoSrc(streamUrl);
        return;
      }
    }
  } catch (e) {
    // ignore
  }

  // If streamGet didn't give a URL, try one more fresh
  if (!streamUrl) {
    try {
      const resp2: any = await new Promise(r => chrome.runtime.sendMessage({ type: 'streamGet', uri }, r));
      if (resp2 && resp2.ok) {
        const g2 = resp2.result;
        const got2 = g2?.streaming_url || 
                     g2?.file?.streaming_url || 
                     g2?.stream?.streaming_url || 
                     (g2?.value && g2.value.streaming_url) ||
                     g2?.result?.streaming_url ||
                     null;
        if (got2) {
          streamUrl = got2;
          setVideoSrc(streamUrl);
          return;
        }
      }
    } catch (e) {}
  }

  // If streamGet didn't give usable URL (common in public mode), fallback to Odysee embed
  if (!streamUrl) {
    loadPublicEmbed();
  }
}

async function loadPublicEmbed() {
  if (!video || !uri) {
    showNoStream();
    return;
  }
  try {
    const resolveResp: any = await new Promise(r => chrome.runtime.sendMessage({ type: 'resolve', uri }, r));
    if (resolveResp && resolveResp.ok) {
      const result = resolveResp.result;
      const claim = result && (result[uri] || Object.values(result)[0]);
      const v = claim?.value || {};
      const name = claim?.name || claim?.normalized_name || v.normalized_name;
      const claimId = claim?.claim_id || v.claim_id;
      if (name && claimId) {
        const embedUrl = `https://odysee.com/$/embed/${encodeURIComponent(name)}/${claimId}`;
        // Replace video with embed iframe sized to container
        const parent = video.parentElement;
        if (parent && video && video.parentNode === parent) {
          parent.querySelectorAll('.no-stream').forEach(n => n.remove());
          const iframe = document.createElement('iframe');
          iframe.src = embedUrl;
          iframe.style.cssText = 'width:100%; height:100%; border:0; background:#000; flex:1; min-height:0;';
          iframe.allow = 'fullscreen; autoplay';
          iframe.setAttribute('allowfullscreen', 'true');
          parent.replaceChild(iframe, video);
        }
        return;
      }
    }
  } catch (_) {}
  showNoStream();
}

if (streamUrl) {
  setVideoSrc(streamUrl);
} else if (uri) {
  // Try to get a real stream (the "try harder" path)
  tryAcquireStream();
} else {
  showNoStream();
}

// Help public/floating autoplay: on any interaction with the player, unmute if muted
const unMuteOnInteract = () => {
  if (video && video.muted) {
    video.muted = false;
  }
};
video?.addEventListener('click', unMuteOnInteract, { once: true });
document.getElementById('wrap')?.addEventListener('click', unMuteOnInteract, { once: true });

// Report playback position periodically so background can follow tabs
if (video) {
  setInterval(() => {
    if (video && chrome.runtime && !video.paused && video.currentTime > 0) {
      try {
        chrome.runtime.sendMessage({
          type: 'floatingTimeUpdate',
          uri,
          time: video.currentTime
        });
      } catch (_) {}
    }
  }, 1500);
}

// Bonus: allow double-click on video area to toggle native fullscreen inside the small player
if (video) {
  video.addEventListener('dblclick', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(()=>{});
    } else {
      video.requestFullscreen?.().catch(() => {});
    }
  });
}

// Extra attempts to autoplay when the context gets a gesture (e.g. tab becomes visible)
if (video) {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && video.paused) {
      video.muted = false;
      video.play().catch(() => {});
    }
  });

  // Also try on first user interaction anywhere in the document
  const onceGesture = () => {
    if (video.paused) {
      video.muted = false;
      video.play().catch(() => {});
    }
    document.removeEventListener('click', onceGesture);
    document.removeEventListener('keydown', onceGesture);
  };
  document.addEventListener('click', onceGesture, { once: true });
  document.addEventListener('keydown', onceGesture, { once: true });
}
