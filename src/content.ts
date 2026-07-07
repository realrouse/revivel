// ReviveL Content Script — Premium in-page enhancements + floating video player
(function () {
  function enhanceLinks() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while (node = walker.nextNode()) {
      if (node.textContent && node.textContent.includes('lbry://')) {
        const span = document.createElement('span')
        span.innerHTML = node.textContent.replace(
          /(lbry:\/\/[^\s]+)/g, 
          `<span class="revivel-link" style="color:#14b8a6; cursor:pointer; text-decoration:none; padding:1px 4px; border-radius:4px; background:rgba(20,184,166,0.08); font-weight:500;">$1</span>`
        )
        if (node.parentNode) node.parentNode.replaceChild(span, node)
      }
    }

    document.querySelectorAll('.revivel-link').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault()
        const uri = (el as HTMLElement).textContent || ''
        chrome.runtime.sendMessage({ type: 'openPlayer', uri })
      })
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enhanceLinks)
  } else {
    enhanceLinks()
  }

  // Premium "Revive" hover affordance on images
  document.querySelectorAll('img').forEach(img => {
    if (img.width > 80 && img.height > 40 && !img.closest('.revivel-skip')) {
      img.addEventListener('mouseenter', () => {
        if (img.dataset.reviveAdded) return
        img.dataset.reviveAdded = '1'

        const badge = document.createElement('div')
        badge.style.cssText = `
          position:absolute; background:#0f172a; color:#14b8a6; font-size:10px; 
          font-weight:600; padding:2px 9px; border-radius:9999px; cursor:pointer; 
          z-index:999999; border:1px solid #14b8a6; box-shadow:0 2px 8px rgb(0 0 0 / .3);
          display:flex; align-items:center; gap:4px; letter-spacing:-.2px;
        `
        badge.innerHTML = `<span style="font-size:9px">↑</span> <span>Revive</span>`
        
        const rect = img.getBoundingClientRect()
        badge.style.top = (window.scrollY + rect.top + 6) + 'px'
        badge.style.left = (window.scrollX + rect.left + 6) + 'px'

        document.body.appendChild(badge)
        
        badge.onclick = (ev) => {
          ev.stopImmediatePropagation()
          chrome.runtime.sendMessage({ type: 'uploadImage', src: img.src })
          badge.remove()
        }
        setTimeout(() => { if (badge.parentNode) badge.remove() }, 3200)
      }, { once: true })
    }
  })

  // === Floating Video Overlay ===
  // Uses an extension-owned iframe for the actual <video> element so the host page is never
  // considered the party requesting access to local apps/services (avoids the "google.com is asking..." prompt).
  function showFloatingPlayer(data: { uri: string; title?: string; streamUrl?: string; startTime?: number; fromTabSwitch?: boolean }) {
    const existing = document.getElementById('revivel-floating')
    if (existing) existing.remove()

    const container = document.createElement('div')
    container.id = 'revivel-floating'
    container.style.cssText = `
      position:fixed; right:20px; bottom:20px; 
      width:min(420px, 42vw); min-width:300px; 
      height:auto; min-height:260px; max-height:65vh;
      background:#0f172a; color:#e2e8f0; 
      border:1px solid #334155; border-radius:16px; 
      box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.5), 0 10px 10px -6px rgb(0 0 0 / 0.4);
      z-index:2147483647; overflow:hidden; font-family:system-ui, -apple-system, sans-serif;
      font-size:13px; display:flex; flex-direction:column; resize: both;
    `

    const header = document.createElement('div')
    header.style.cssText = `
      background:#1e2937; padding:6px 10px; display:flex; align-items:center; 
      justify-content:space-between; cursor:grab; user-select:none; font-size:12px; flex-shrink:0;
    `
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
    `

    const iframe = document.createElement('iframe')
    const q = new URLSearchParams()
    q.set('uri', data.uri)
    if (data.streamUrl) q.set('streamUrl', data.streamUrl)
    if (data.title) q.set('title', data.title)
    if (data.startTime && data.startTime > 0) q.set('startTime', String(data.startTime))
    // chrome.runtime is available in content scripts
    const overlaySrc = chrome.runtime.getURL('overlay.html') + '?' + q.toString()
    iframe.src = overlaySrc
    iframe.style.cssText = 'flex:1; width:100%; border:0; background:#000; display:block;'
    iframe.setAttribute('allowfullscreen', 'true')
    iframe.setAttribute('allow', 'fullscreen')

    container.append(header, iframe)
    document.body.appendChild(container)

    // Keep bg session in sync
    chrome.runtime.sendMessage({
      type: 'setFloatingSession',
      uri: data.uri,
      title: data.title,
      streamUrl: data.streamUrl,
      lastTime: data.startTime || 0
    }).catch(() => {});

    if (data.fromTabSwitch) {
      // Simple toast to offer detach for persistent across tabs
      const toast = document.createElement('div')
      toast.style.cssText = `
        position:absolute; bottom:8px; left:50%; transform:translateX(-50%);
        background:#1e2937; color:#94a3b8; font-size:10px; padding:4px 8px;
        border-radius:6px; border:1px solid #334155; z-index:10; white-space:nowrap;
        box-shadow:0 2px 8px rgba(0,0,0,0.3);
      `
      toast.innerHTML = `Tab switched — <span style="color:#14b8a6; cursor:pointer; text-decoration:underline;">Detach</span> to keep playing`
      container.appendChild(toast)
      const detachSpan = toast.querySelector('span')!
      detachSpan.onclick = () => {
        chrome.runtime.sendMessage({ type: 'detachFloating', uri: data.uri, title: data.title, streamUrl: data.streamUrl })
        container.remove()
      }
      setTimeout(() => toast.remove(), 6000)
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

    // Controls on the wrapper (outside iframe)
    header.querySelector('#rf-close')!.addEventListener('click', () => {
      try { chrome.runtime.sendMessage({ type: 'floatingClosed', uri: data.uri }); } catch (_) {}
      container.remove()
    })

    const fullBtn = header.querySelector('#rf-full') as HTMLElement
    fullBtn.addEventListener('click', () => {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {})
      } else {
        (container.requestFullscreen || (container as any).webkitRequestFullscreen)?.call(container)
      }
    })

    // "Full player" button — opens the same video in the premium full tab player
    const fullPlayerBtn = header.querySelector('#rf-fullplayer') as HTMLElement
    fullPlayerBtn?.addEventListener('click', (e) => {
      e.stopImmediatePropagation()
      chrome.runtime.sendMessage({ 
        type: 'openFullPlayer', 
        uri: data.uri, 
        title: data.title 
      })
      container.remove() // close the floating overlay
    })

    // Detach button for hybrid: close in-page and open persistent popup window
    const detachBtn = header.querySelector('#rf-detach') as HTMLElement | null
    detachBtn?.addEventListener('click', (e) => {
      e.stopImmediatePropagation()
      chrome.runtime.sendMessage({
        type: 'detachFloating',
        uri: data.uri,
        title: data.title,
        streamUrl: data.streamUrl
      })
      container.remove()
    })

    // Draggable
    let dragging = false, sx = 0, sy = 0, sr = 0, sb = 0
    header.addEventListener('mousedown', (e) => {
      dragging = true
      sx = e.clientX; sy = e.clientY
      const r = container.getBoundingClientRect()
      sr = window.innerWidth - r.right
      sb = window.innerHeight - r.bottom
      header.style.cursor = 'grabbing'
    })
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return
      container.style.right = (sr - (e.clientX - sx)) + 'px'
      container.style.bottom = (sb - (e.clientY - sy)) + 'px'
    })
    window.addEventListener('mouseup', () => {
      dragging = false
      header.style.cursor = 'grab'
    })

    header.addEventListener('dblclick', () => fullBtn.click())
    iframe.addEventListener('dblclick', () => fullBtn.click())
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'showFloatingPlayer') {
      showFloatingPlayer(msg)
      sendResponse({ ok: true })
      return true
    }
    if (msg.type === 'uploadImage' && msg.src) {
      // forward to popup via storage (existing behavior)
      chrome.runtime.sendMessage({ type: 'uploadImage', src: msg.src })
    }
  })
})()
