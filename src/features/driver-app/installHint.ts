export type InstallPlatform = 'ios-safari' | 'ios-chrome' | 'android' | 'desktop'

export interface InstallHint {
  platform: InstallPlatform
  title: string
  steps: string[]
  canInstall: boolean
}

export function detectInstallPlatform(userAgent: string): InstallPlatform {
  const ua = userAgent.toLowerCase()
  const onIOS = /iphone|ipad|ipod/.test(ua)
  if (onIOS && /crios/.test(ua)) return 'ios-chrome'
  if (onIOS) return 'ios-safari'
  if (/android/.test(ua)) return 'android'
  return 'desktop'
}

export function getInstallHint(userAgent: string): InstallHint {
  const platform = detectInstallPlatform(userAgent)

  switch (platform) {
    case 'ios-safari':
      return {
        platform,
        title: 'Add to Home Screen',
        canInstall: true,
        steps: [
          'Tap the Share button at the bottom of Safari (the square with an arrow).',
          'Scroll down and tap "Add to Home Screen".',
          'Tap "Add" in the top right.',
        ],
      }
    case 'ios-chrome':
      return {
        platform,
        title: 'Open in Safari',
        canInstall: false,
        steps: [
          'Chrome on iPhone can\'t install this app to your home screen.',
          'Open this page in Safari, then tap Share → "Add to Home Screen".',
        ],
      }
    case 'android':
      return {
        platform,
        title: 'Install app',
        canInstall: true,
        steps: [
          'Tap the three-dot menu in the top right of Chrome.',
          'Tap "Install app" or "Add to Home screen".',
          'Tap "Install" or "Add".',
        ],
      }
    case 'desktop':
      return {
        platform,
        title: 'Install this app',
        canInstall: true,
        steps: [
          'Click the install icon in the address bar (Chrome or Edge), or',
          'Click the three-dot menu → "Install" or "Add to home screen".',
        ],
      }
  }
}

export function isStandalone(
  nav: { standalone?: boolean } | undefined = typeof navigator !== 'undefined' ? (navigator as { standalone?: boolean }) : undefined,
  matchMedia: ((query: string) => { matches: boolean }) | undefined = typeof window !== 'undefined' ? (window.matchMedia as (query: string) => { matches: boolean }) : undefined,
): boolean {
  if (nav?.standalone === true) return true
  return matchMedia?.('(display-mode: standalone)')?.matches ?? false
}
