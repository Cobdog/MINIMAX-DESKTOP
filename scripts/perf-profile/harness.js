// In-page measurement harness for the density matrix (profiler task eebh7ah).
// Installed per navigation via navigate_page initScript (boot stamps) and
// post-load evaluate_script (drives + state reads). Purely observational:
// drives the camera through the REAL store→rAF pipeline (__canvasDriveCamera,
// the ?probe=canvas seam) or real wheel events (the d3-zoom gesture path).
(() => {
  if (window.__perfInstalled) return
  window.__perfInstalled = true
  window.__perfLongTasks = []
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__perfLongTasks.push({ start: Math.round(entry.startTime), ms: Math.round(entry.duration), name: entry.name })
      }
    }).observe({ entryTypes: ['longtask'] })
  } catch { /* longtask unsupported */ }
  window.__perfBoot = { readyAt: null }
  const bootPoll = () => {
    const root = document.querySelector('[data-canvas-root]')
    if (root && root.getAttribute('data-phase') === 'ready') {
      window.__perfBoot.readyAt = Math.round(performance.now())
      return
    }
    requestAnimationFrame(bootPoll)
  }
  bootPoll()
  const raf = () => new Promise((resolve) => requestAnimationFrame((t) => resolve(t)))
  window.__perfState = () => {
    const tiles = [...document.querySelectorAll('[data-canvas-tile]')]
    const videos = [...document.querySelectorAll('video.canvas-tile-poster')]
    const images = [...document.querySelectorAll('img.canvas-tile-poster')]
    const ready = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 }
    let paused = 0
    let dropped = 0
    let decoded = 0
    for (const video of videos) {
      ready[Math.min(4, video.readyState)] += 1
      if (video.paused) paused += 1
      const q = video.getVideoPlaybackQuality?.()
      if (q) { dropped += q.droppedVideoFrames; decoded += q.totalVideoFrames }
    }
    const mem = performance.memory
    return {
      tilesMounted: tiles.length,
      tilesTotal: window.__canvasTilesTotal ?? null,
      domNodes: document.getElementsByTagName('*').length,
      videoElements: videos.length,
      videoReadyState: ready,
      videoPaused: paused,
      videoDroppedFrames: dropped,
      videoDecodedFrames: decoded,
      imageElements: images.length,
      imagesLoaded: images.filter((img) => img.complete && img.naturalWidth > 0).length,
      substrateRenders: Number(document.querySelector('[data-canvas-renders]')?.dataset.canvasRenders ?? '0'),
      heapUsedMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
      heapTotalMB: mem ? Math.round(mem.totalJSHeapSize / 1048576) : null,
      zoomReadout: document.querySelector('[data-canvas-zoom]')?.textContent ?? null,
      worldTransform: document.querySelector('[data-canvas-world]')?.style.transform ?? null,
    }
  }
  window.__perfDrivePan = async (ms = 2000) => {
    const started = performance.now()
    const before = window.__perfLongTasks.length
    const rendersBefore = Number(document.querySelector('[data-canvas-renders]')?.dataset.canvasRenders ?? '0')
    let frames = 0
    let longFrames = 0
    let previous = performance.now()
    while (performance.now() - started < ms) {
      window.__canvasDriveCamera(6)
      await raf()
      frames += 1
      const now = performance.now()
      if (now - previous > 25) longFrames += 1
      previous = now
    }
    return {
      fps: +((frames * 1000) / ms).toFixed(1),
      frames,
      longFramesGt25ms: longFrames,
      longTasksDuring: window.__perfLongTasks.slice(before),
      rendersDuring: Number(document.querySelector('[data-canvas-renders]')?.dataset.canvasRenders ?? '0') - rendersBefore,
      transformAfter: document.querySelector('[data-canvas-world]')?.style.transform,
    }
  }
  window.__perfDriveZoom = async (ms = 2000, notchesPerFrame = 2) => {
    const viewport = document.querySelector('[data-canvas-viewport]')
    if (!viewport) return { error: 'no viewport' }
    const rect = viewport.getBoundingClientRect()
    const before = window.__perfLongTasks.length
    const rendersBefore = Number(document.querySelector('[data-canvas-renders]')?.dataset.canvasRenders ?? '0')
    const started = performance.now()
    let frames = 0
    let events = 0
    const zoomRead = () => document.querySelector('[data-canvas-zoom]')?.textContent
    const zoomStart = zoomRead()
    let dir = -1
    while (performance.now() - started < ms) {
      for (let i = 0; i < notchesPerFrame; i += 1) {
        viewport.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true,
          deltaY: 120 * dir * -1,
          deltaMode: 0,
          clientX: rect.x + rect.width / 2,
          clientY: rect.y + rect.height / 2,
        }))
        events += 1
      }
      dir = frames % 45 === 44 ? -dir : dir
      await raf()
      frames += 1
    }
    await new Promise((r) => setTimeout(r, 250))
    return {
      fps: +((frames * 1000) / ms).toFixed(1),
      frames,
      wheelEvents: events,
      zoomStart,
      zoomEnd: zoomRead(),
      longTasksDuring: window.__perfLongTasks.slice(before),
      rendersDuring: Number(document.querySelector('[data-canvas-renders]')?.dataset.canvasRenders ?? '0') - rendersBefore,
    }
  }
  window.__perfInteract = () => new Promise((resolve) => {
    const tile = [...document.querySelectorAll('[data-canvas-tile]')].find((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 40 && r.x > 0 && r.x < innerWidth && r.y > 0 && r.y < innerHeight
    })
    if (!tile) { resolve({ error: 'no visible tile' }); return }
    const results = {}
    const t0 = performance.now()
    const observer = new MutationObserver(() => {
      if (tile.classList.contains('selected')) {
        observer.disconnect()
        results.clickToSelectedMs = +(performance.now() - t0).toFixed(1)
        resolve(results)
      }
    })
    observer.observe(tile, { attributes: true, attributeFilter: ['class'] })
    tile.click()
    setTimeout(() => { observer.disconnect(); resolve({ ...results, clickToSelectedMs: null, note: 'selection never landed' }) }, 3000)
  })
  window.__perfForkMenu = () => new Promise((resolve) => {
    const selected = document.querySelector('[data-canvas-tile].selected')
    if (!selected) { resolve({ error: 'no selection' }); return }
    const t0 = performance.now()
    const observer = new MutationObserver(() => {
      if (document.querySelector('[data-canvas-fork-menu]')) {
        observer.disconnect()
        resolve({ keyToForkMenuMs: +(performance.now() - t0).toFixed(1) })
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }))
    setTimeout(() => { observer.disconnect(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); resolve({ keyToForkMenuMs: null, note: 'menu never opened (no canonical take?)' }) }, 3000)
  })
})()
