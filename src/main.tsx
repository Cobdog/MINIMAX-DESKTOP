import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { LoaderCircle } from 'lucide-react'
import { ErrorBoundary } from './components/ErrorBoundary'
import { installWebApiClient } from './lib/apiClient'
import { sanitizeError } from './lib/logSanitize'
import { observeLongAnimationFrames } from './lib/loafObserver'
import { resolveSurface } from './surfaces/registry'
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

// Top-level SURFACES (canvas default, datasets, …) live in the surface
// registry (QOL wave rrxlw2r, 2026-09-18): each surface self-registers ONE
// entry there and both the route resolution below and the shared titlebar
// switcher pick it up — surfaces land independently without nav conflicts.
// Canvas Phase 5 (task 7mcp11b) made the canvas the default route; ?canvas=1
// remains a HARMLESS ALIAS (bookmarks/e2e/bench keep working).
//
// Non-surface routes stay here: ?mobile=1, ?proto=, ?poserig=1 are companion
// and dev surfaces, never titlebar-switchable.

// The renderer always runs in a browser against the app's own web server
// (server/index.ts); the HTTP client is the only bridge.
installWebApiClient()

const params = new URLSearchParams(location.search)
const mobile = params.get('mobile') === '1'
const proto = params.get('proto')
const protoRoute = proto === 'bench' || proto === 'stage' || proto === 'score'
const poserigRoute = params.get('poserig') === '1'
// Surface resolution (registry-driven): an explicit surface match (?datasets=1,
// …) wins; otherwise the companion/dev routes; otherwise the registry default
// (canvas). NOTE: ?canvas=1 is intentionally NOT read — the canvas being the
// default route makes the param a no-op alias (bookmarks/e2e/bench keep
// working).
const surface = resolveSurface(params)
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
      {!surface.default
        ? <Suspense fallback={viewFallback}><surface.component /></Suspense>
        : poserigRoute
          ? <Suspense fallback={viewFallback}><PoseRigApp /></Suspense>
          : protoRoute
          ? <Suspense fallback={viewFallback}><PrototypeShell /></Suspense>
          : mobile
            ? <Suspense fallback={viewFallback}><MobileApp /></Suspense>
            : <Suspense fallback={viewFallback}><surface.component /></Suspense>}
    </ErrorBoundary>
  </StrictMode>,
)
