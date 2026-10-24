import type { MagApi } from '../../preload/api'

declare global {
  interface Window {
    mag: MagApi
  }
}
