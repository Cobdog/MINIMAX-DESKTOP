/**
 * Canvas Phase 1 — the L33 rendering-budget harness (spec §3).
 *
 * Mounted under ?canvas=1&bench=1 (CanvasApp swaps it in before booting the
 * session). Stages 100/500/1000/2000 SYNTHETIC objects into the same
 * substrate the real canvas renders (same store, same camera pipeline, same
 * culling discipline) and measures, per stage:
 *
 *   idleFps        — rAF frames/sec with the camera at rest
 *   panFps         — frames/sec while the camera is driven once per frame
 *                    through the real store→rAF pipeline
 *   panJank        — fraction of pan frames whose rAF delta exceeded 20 ms
 *   zoomFps        — frames/sec through a 0.25→2 zoom sweep (band crossings
 *                    included — the honest number)
 *   rendersIdle / rendersPan / rendersZoom — substrate re-renders
 *                    (data-canvas-renders deltas): the transient-discipline
 *                    budget. Idle and pan should be ~0; zoom pays only the
 *                    band crossings.
 *   mountedTiles   — DOM tiles after culling (the culling budget: well under
 *                    the staged count at far zoom)
 *
 * Results land on window.__canvasBudgetResults + a console line
 * (`CANVAS_BUDGET <json>`); scripts/canvas-budget.cjs collects them and
 * writes docs/research/canvas-rendering-budget.json. NOT part of the CI gate
 * — perf numbers from shared runners are noise, the budget is a data point.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { camera } from './store'
import { useCanvasStore } from './store'
import type { DocumentChain } from './derive'
import { Substrate } from './Substrate'

const BENCH_PROJECT_ID = 'bench-local'
const STAGES = [100, 500, 1000, 2000]

export type StageResult = {
  staged: number
  edges: number
  idleFps: number
  /** Gentle drift (no culled-set change): fps + renders — the transform
   *  discipline in isolation. Renders must be ~0 at every N. */
  driftFps: number
  rendersDrift: number
  panFps: number
  /** Fraction of pan frames whose rAF delta exceeded 20 ms (jank ratio). */
  panJank: number
  zoomFps: number
  rendersIdle: number
  rendersPan: number
  rendersZoom: number
  mountedTiles: number
  stageMs: number
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Synthetic document: `count` chains, ~1/3 with outputs+canonical takes,
 *  ~30% consuming an earlier output (derived edges). No blobs, no previews —
 *  the substrate's DOM/cull cost is what L33 budgets. */
function syntheticChains(count: number): DocumentChain[] {
  const random = mulberry32(count)
  const chains: DocumentChain[] = []
  const outputs: string[] = []
  for (let index = 0; index < count; index += 1) {
    const id = `bench-chain-${index}`
    const withOutput = random() < 0.36
    const refOutput = outputs.length && random() < 0.3 ? outputs[Math.floor(random() * outputs.length)] : null
    const outputId = `${id}-out`
    chains.push({
      id,
      projectId: BENCH_PROJECT_ID,
      kind: withOutput ? 'generation' : refOutput ? 'generation' : 'seed',
      inputSpec: refOutput ? { outputRef: { outputId: refOutput, substrate: 'decoded' } } : { fresh: { prompt: `synthetic shot ${index}` } },
      settings: { prompt: `synthetic shot ${index}` },
      lockState: 'unlocked',
      hopCount: 0,
      driftMetrics: null,
      stale: random() < 0.08,
      createdAt: index,
      outputs: withOutput
        ? [{
            id: outputId,
            chainId: id,
            substratesAvailable: ['decoded'],
            createdAt: index,
            canonicalTakeId: `${id}-take-0`,
            takes: [{ id: `${id}-take-0`, outputId, jobId: null, artifacts: [], latentPath: null, metrics: { duration: 6 }, createdAt: index, supersededBy: null, evicted: false, contentHash: null }],
          }]
        : [],
      ops: [],
    })
    if (withOutput) outputs.push(outputId)
  }
  return chains
}

const raf = (): Promise<number> => new Promise((resolve) => requestAnimationFrame((time) => resolve(time)))
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

async function frameRate(collectMs: number): Promise<number> {
  const started = performance.now()
  let frames = 0
  while (performance.now() - started < collectMs) {
    await raf()
    frames += 1
  }
  return (frames * 1000) / collectMs
}

function renderCount(): number {
  return Number(document.querySelector<HTMLElement>('[data-canvas-renders]')?.dataset.canvasRenders ?? '0')
}

export function CanvasBenchmark() {
  const [status, setStatus] = useState('idle — press run')
  const [results, setResults] = useState<StageResult[]>([])
  const running = useRef(false)

  useEffect(() => {
    Object.defineProperty(window, '__canvasBudgetResults', { configurable: true, value: null })
  }, [])

  const stage = useCallback(async (count: number): Promise<StageResult> => {
    const started = performance.now()
    const chains = syntheticChains(count)
    useCanvasStore.setState({
      phase: 'ready',
      activeProjectId: BENCH_PROJECT_ID,
      documents: { [BENCH_PROJECT_ID]: { project: { id: BENCH_PROJECT_ID, name: 'bench', camera: {}, createdAt: 0, lastActiveAt: 0 }, chains } },
      layout: undefined,
      selection: { tileIds: [] },
      chainJobs: {},
    })
    useCanvasStore.getState().recompute()
    camera.set({ x: 60, y: 40, k: 0.9 })
    await raf()
    await sleep(350) // let filmstrip-less tiles + culling settle

    const mountedTiles = document.querySelectorAll('.canvas-tile').length
    const edges = useCanvasStore.getState().edges.length

    // idle
    const rendersIdleStart = renderCount()
    const idleFps = await frameRate(800)
    const rendersIdle = renderCount() - rendersIdleStart

    // gentle drift: small camera motion that keeps the culled SET constant —
    // the pure transform-discipline budget (zero renders expected at any N).
    const rendersDriftStart = renderCount()
    const driftStarted = performance.now()
    const driftDuration = 1500
    let driftFrames = 0
    while (performance.now() - driftStarted < driftDuration) {
      const t = (performance.now() - driftStarted) / driftDuration
      camera.set({ x: 60 + Math.sin(t * Math.PI * 4) * 40, y: 40 + Math.cos(t * Math.PI * 3) * 24, k: camera.get().k })
      await raf()
      driftFrames += 1
    }
    const driftFps = (driftFrames * 1000) / driftDuration
    const rendersDrift = renderCount() - rendersDriftStart

    // pan: drive the camera one set per frame for 2s (a representative
    // pointer-move rate through the REAL store→rAF pipeline) and measure
    // delivered frames plus jank (rAF deltas > 20 ms).
    const rendersPanStart = renderCount()
    const panStarted = performance.now()
    const panDuration = 2000
    let panFrames = 0
    let longFrames = 0
    let previousFrame = performance.now()
    while (performance.now() - panStarted < panDuration) {
      const t = (performance.now() - panStarted) / panDuration
      const zig = Math.sin(t * Math.PI * 8) * 900
      camera.set({ x: 60 + zig, y: 40 + Math.cos(t * Math.PI * 6) * 500, k: camera.get().k })
      await raf()
      panFrames += 1
      const now = performance.now()
      if (now - previousFrame > 20) longFrames += 1
      previousFrame = now
    }
    const panFps = (panFrames * 1000) / panDuration
    const panJank = panFrames ? longFrames / panFrames : 1
    const rendersPan = renderCount() - rendersPanStart

    // zoom sweep 0.25 → 2 → 0.25 (crosses all three bands, twice)
    const rendersZoomStart = renderCount()
    const zoomStarted = performance.now()
    const zoomDuration = 2000
    let zoomFrames = 0
    while (performance.now() - zoomStarted < zoomDuration) {
      const t = (performance.now() - zoomStarted) / zoomDuration
      const k = 0.25 + (2 - 0.25) * (0.5 - 0.5 * Math.cos(t * Math.PI * 2))
      const current = camera.get()
      const cx = 960, cy = 540
      const ratio = k / current.k
      camera.set({ k, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio })
      await raf()
      zoomFrames += 1
    }
    const zoomFps = (zoomFrames * 1000) / zoomDuration
    const rendersZoom = renderCount() - rendersZoomStart

    return { staged: count, edges, idleFps, driftFps, rendersDrift, panFps, panJank, zoomFps, rendersIdle, rendersPan, rendersZoom, mountedTiles, stageMs: performance.now() - started }
  }, [])

  const run = useCallback(async () => {
    if (running.current) return
    running.current = true
    const collected: StageResult[] = []
    try {
      for (const count of STAGES) {
        setStatus(`staging ${count} objects…`)
        const result = await stage(count)
        collected.push(result)
        setResults([...collected])
      }
      const payload = {
        meta: {
          date: new Date().toISOString(),
          viewport: { width: window.innerWidth, height: window.innerHeight },
          userAgent: navigator.userAgent,
          stages: STAGES,
        },
        results: collected,
      }
      Object.defineProperty(window, '__canvasBudgetResults', { configurable: true, value: payload })
      console.log(`CANVAS_BUDGET ${JSON.stringify(payload)}`)
      setStatus('done — results on window.__canvasBudgetResults')
    } finally {
      running.current = false
    }
  }, [stage])

  return <div className="canvas-root canvas-bench-root" data-canvas-bench>
    <div className="canvas-bench-panel" data-canvas-bench-panel>
      <header>
        <strong>L33 rendering-budget harness</strong>
        <button type="button" data-canvas-bench-run onClick={() => void run()}>{running.current ? 'running…' : 'run'}</button>
      </header>
      <p className="canvas-bench-status" data-canvas-bench-status>{status}</p>
      <table className="canvas-bench-table">
        <thead>
          <tr><th>N</th><th>edges</th><th>idle fps</th><th>drift fps</th><th>r drift</th><th>pan fps</th><th>jank</th><th>zoom fps</th><th>r idle</th><th>r pan</th><th>r zoom</th><th>DOM</th><th>ms</th></tr>
        </thead>
        <tbody>
          {results.map((result) => (
            <tr key={result.staged} data-canvas-bench-row={result.staged}>
              <td>{result.staged}</td>
              <td>{result.edges}</td>
              <td>{result.idleFps.toFixed(0)}</td>
              <td>{result.driftFps.toFixed(0)}</td>
              <td>{result.rendersDrift}</td>
              <td>{result.panFps.toFixed(0)}</td>
              <td>{(result.panJank * 100).toFixed(0)}%</td>
              <td>{result.zoomFps.toFixed(0)}</td>
              <td>{result.rendersIdle}</td>
              <td>{result.rendersPan}</td>
              <td>{result.rendersZoom}</td>
              <td>{result.mountedTiles}</td>
              <td>{Math.round(result.stageMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <div className="canvas-stage">
      <Substrate />
    </div>
  </div>
}
