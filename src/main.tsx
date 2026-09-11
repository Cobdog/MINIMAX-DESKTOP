import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { LoaderCircle } from 'lucide-react'
import App from './App'
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

// The renderer always runs in a browser against the app's own web server
// (server/index.ts); the HTTP client is the only bridge.
installWebApiClient()

const mobile = new URLSearchParams(location.search).get('mobile') === '1'
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
      {mobile
        ? <Suspense fallback={viewFallback}><MobileApp /></Suspense>
        : <App />}
    </ErrorBoundary>
  </StrictMode>,
)
