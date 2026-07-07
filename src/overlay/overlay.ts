// ReviveL floating overlay player (loaded inside extension iframe)
// The iframe has chrome-extension:// origin, so <video src=localhost> does not blame the host page.

const params = new URLSearchParams(location.search);
const uri = params.get('uri') || '';
let streamUrl = params.get('streamUrl') || '';
const title = params.get('title') || '';
const startTime = parseFloat(params.get('startTime') || '0');
const isStandalone = params.get('standalone') === '1';

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
  // Clean any previous error state
  const parent = video.parentElement;
  if (parent) {
    parent.querySelectorAll('.no-stream').forEach(n => n.remove());
  }
  video.style.display = 'block';
  video.src = src;
  video.load();

  const doPlay = () => {
    video.muted = false;
    video.play().catch((err) => {
      // Autoplay blocked by browser policy (no recent user gesture in this context).
      // Do NOT force mute. Show a play overlay so user can start with one click (unmuted).
      console.debug('Autoplay blocked:', err?.name || err);
      showPlayOverlay();
    });
  };

  if (startTime > 0) {
    const seekAndPlay = () => {
      try {
        video.currentTime = startTime;
      } catch (_) {}
      // Wait for the seek to complete before playing to ensure we start at the exact position
      const onSeeked = () => {
        doPlay();
      };
      video.addEventListener('seeked', onSeeked, { once: true });
      // Fallback in case 'seeked' doesn't fire promptly (e.g. already at position)
      setTimeout(() => {
        if (Math.abs(video.currentTime - startTime) < 1) {
          doPlay();
        }
      }, 150);
    };
    video.addEventListener('loadedmetadata', seekAndPlay, { once: true });
    // Fallback if metadata already loaded
    if (video.readyState >= 1) {
      seekAndPlay();
    }
  } else {
    // No seek needed, play immediately after load
    const playOnLoad = () => doPlay();
    video.addEventListener('loadedmetadata', playOnLoad, { once: true });
    if (video.readyState >= 1) {
      doPlay();
    }
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
  msg.innerHTML = 'No playable stream.<br>Make sure the ReviveL Companion is running.';
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
  if (!uri || !('chrome' in window) || !chrome.runtime) return;

  try {
    const resp: any = await new Promise(r => chrome.runtime.sendMessage({ type: 'streamGet', uri }, r));
    if (resp && resp.ok) {
      const g = resp.result;
      const got = g?.streaming_url || g?.file?.streaming_url || g?.stream?.streaming_url || (g?.value && g.value.streaming_url) || null;
      if (got) {
        streamUrl = got;
        setVideoSrc(streamUrl);
        return;
      }
    }
  } catch (e) {
    // ignore
  }
  // If we get here with no url, show placeholder
  if (!streamUrl) showNoStream();
}

if (streamUrl) {
  setVideoSrc(streamUrl);
} else if (uri) {
  // Try to get a real stream (the "try harder" path)
  tryAcquireStream();
} else {
  showNoStream();
}

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
