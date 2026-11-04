/// <reference types="vite/client" />

import type { DesktopManager } from './types'

declare global {
  interface Window { desktopManager?: DesktopManager }
}

export {}
