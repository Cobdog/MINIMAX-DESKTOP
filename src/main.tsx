import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import MobileApp from './MobileApp'
import { installWebApiClient } from './lib/apiClient'
import { installBrowserMock } from './browserMock'
import './styles.css'
import './guided-studio.css'

// Bridge selection: the Electron preload defines window.minimax; in a plain
// browser the real HTTP client talks to the app's own web server. The mock
// bridge remains only for static previews with no server at all (vite dev
// server on 5173 without the backend).
if (!window.minimax) {
  if (window.location.port !== '5173') installWebApiClient()
  else installBrowserMock()
}

const mobile = new URLSearchParams(location.search).get('mobile') === '1'
document.documentElement.classList.toggle('mobile-route', mobile)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {mobile ? <MobileApp /> : <App />}
  </StrictMode>,
)
