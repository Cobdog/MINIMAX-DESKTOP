import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { LoaderCircle } from 'lucide-react'
import App from './App'
import { installWebApiClient } from './lib/apiClient'
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {mobile
      ? <Suspense fallback={viewFallback}><MobileApp /></Suspense>
      : <App />}
  </StrictMode>,
)
