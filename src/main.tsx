import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import MobileApp from './MobileApp'
import { installWebApiClient } from './lib/apiClient'
import './styles.css'
import './guided-studio.css'

// The renderer always runs in a browser against the app's own web server
// (server/index.ts); the HTTP client is the only bridge.
installWebApiClient()

const mobile = new URLSearchParams(location.search).get('mobile') === '1'
document.documentElement.classList.toggle('mobile-route', mobile)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {mobile ? <MobileApp /> : <App />}
  </StrictMode>,
)
