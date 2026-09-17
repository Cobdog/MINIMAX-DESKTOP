import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { LoaderCircle } from 'lucide-react'
import { ErrorBoundary } from './components/ErrorBoundary'
import { installWebApiClient } from './lib/apiClient'
import { sanitizeError } from './lib/logSanitize'
import { observeLongAnimationFrames } from './lib/loafObserver'
import './styles.css'
import './guided-studio.css'

// Dev-only long-animation-frames instrumentation (b7 seam): tree-shaken from
// production builds by the static DEV replacement.
if (import.meta.env.DEV) observeLongAnimationFrames()

// MobileApp is ~36KB of the bundle and only used on the ?mobile=1 route —
// desktop users never pay for it (perf audit: lazy-load the route split).
const MobileApp = lazy(() => import('./MobileApp'))

// Wave 3 — the UI-direction decision prototypes live behind ?proto= and are
// their own lazy chunk (app + css); every normal app route is untouched.
const PrototypeShell = lazy(() => import('./prototypes/PrototypeShell'))

// The IK pose rig dev surface (task 41ebvfo) — ?proto= precedent: own lazy
// chunk (three.js + React shell + css), never imported by normal routes.
// Wired into the canvas at §5.2 integration time.
const PoseRigApp = lazy(() => import('./poserig/PoseRigApp'))

// Dataset manager workbench (sv14rt0, spec §11): own lazy chunk on
// ?datasets=1 — the poserig precedent. The crop editor needs viewport-scale
// wheel semantics scoped inside it, so it is a dedicated surface, not a dock
// (build decision 2026-09-17); the canvas keeps its wheel-zoom untouched.
const DatasetsApp = lazy(() => import('./datasets/DatasetsApp').then((m) => ({ default: m.DatasetsApp })))

// Canvas Phase 5 (task 7mcp11b, docs/specs/canvas-ui-v1.md §8) — the canvas
// IS the app: the default route. The old shell (App.tsx + the View union +
// its nav model) is deleted; ?canvas=1 remains as a HARMLESS ALIAS (existing
// bookmarks, e2e, and the bench harness keep working — it selects the same
// default surface and is never required again).
const CanvasApp = lazy(() => import('./canvas/CanvasApp').then((m) => ({ default: m.CanvasApp })))

// The renderer always runs in a browser against the app's own web server
// (server/index.ts); the HTTP client is the only bridge.
installWebApiClient()

const params = new URLSearchParams(location.search)
const mobile = params.get('mobile') === '1'
const proto = params.get('proto')
const protoRoute = proto === 'bench' || proto === 'stage' || proto === 'score'
const poserigRoute = params.get('poserig') === '1'
const datasetsRoute = params.get('datasets') === '1'
// NOTE: ?canvas=1 is intentionally NOT read — the canvas being the default
// route makes the param a no-op alias (bookmarks/e2e/bench keep working).
document.documentElement.classList.toggle('mobile-route', mobile)

const viewFallback = <div className="boot"><LoaderCircle className="spin" /><span>Loading…</span></div>

// React 19 root-level reporting for boundary-CAUGHT errors routes through the
// same sanitizer as everything else: without this, React's default reporting
// would print the raw error message (which can embed arbitrary prompt text)
// to the console. The boundary's own line stays the detailed one; this is
// the sanitized backstop.
const onCaughtError = (error: unknown) => {
  const detail = sanitizeError(error)
  console.error(`[boundary:react] name=${detail.name} reason=${detail.reason} path=${detail.path}`)
}

createRoot(document.getElementById('root')!, { onCaughtError }).render(
  <StrictMode>
    <ErrorBoundary label="root">
      {datasetsRoute
        ? <Suspense fallback={viewFallback}><DatasetsApp /></Suspense>
        : poserigRoute
          ? <Suspense fallback={viewFallback}><PoseRigApp /></Suspense>
          : protoRoute
          ? <Suspense fallback={viewFallback}><PrototypeShell /></Suspense>
          : mobile
            ? <Suspense fallback={viewFallback}><MobileApp /></Suspense>
            : <Suspense fallback={viewFallback}><CanvasApp /></Suspense>}
    </ErrorBoundary>
  </StrictMode>,
)
