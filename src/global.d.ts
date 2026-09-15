import type { DesktopApi } from './types'

declare global {
  interface Window {
    minimax: DesktopApi
  }

  /** App version from package.json, injected by vite define at build time. */
  const __APP_VERSION__: string
}

export {}
