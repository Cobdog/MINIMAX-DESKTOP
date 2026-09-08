import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import MobileApp from './MobileApp'
import { installBrowserMock } from './browserMock'
import './styles.css'

installBrowserMock()

const mobile = new URLSearchParams(location.search).get('mobile') === '1'
document.documentElement.classList.toggle('mobile-route', mobile)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {mobile ? <MobileApp /> : <App />}
  </StrictMode>,
)
