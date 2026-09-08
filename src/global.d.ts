import type { DesktopApi } from './types'

declare global {
  interface Window {
    minimax: DesktopApi
  }
}

export {}
