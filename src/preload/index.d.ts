import type { AriaApi } from '../shared/types'

declare global {
  interface Window {
    aria: AriaApi
  }
}

export {}
