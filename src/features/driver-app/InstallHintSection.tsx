import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { detectInstallPlatform, getInstallHint, isStandalone } from './installHint'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice?: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export function InstallHintSection() {
  const [hint] = useState(() => getInstallHint(typeof navigator !== 'undefined' ? navigator.userAgent : ''))
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const hidden = isStandalone()

  useEffect(() => {
    if (hidden) return

    const handler = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }

    window.addEventListener('beforeinstallprompt', handler)
    return () => {
      window.removeEventListener('beforeinstallprompt', handler)
    }
  }, [hidden])

  if (hidden) return null

  const isUnsupportedIOSBrowser = detectInstallPlatform(typeof navigator !== 'undefined' ? navigator.userAgent : '') === 'ios-chrome'

  return (
    <section className="mt-6 rounded-2xl border border-slate-700 bg-slate-900/60 p-4 text-slate-200" aria-label="Install this app">
      <h3 className="mb-2 text-sm font-semibold text-white">{hint.title}</h3>

      {isUnsupportedIOSBrowser ? (
        <div className="space-y-2 text-sm leading-relaxed text-slate-300">
          {hint.steps.map((step, i) => (
            <p key={i}>{step}</p>
          ))}
        </div>
      ) : (
        <ol className="list-decimal space-y-1.5 pl-4 text-sm leading-relaxed text-slate-300">
          {hint.steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      )}

      {deferredPrompt && (
        <Button
          type="button"
          onClick={async () => {
            try {
              await deferredPrompt.prompt()
            } catch {
              // Ignore a failed prompt; the written steps remain visible.
            }
          }}
          className="mt-4 h-11 w-full rounded-xl bg-gradient-to-b from-[#3bb5f5] to-[#1ea8f3] text-base font-semibold text-white shadow-sm hover:from-[#1ea8f3] hover:to-[#0d8fd9]"
        >
          <Download className="mr-2 h-5 w-5" />
          Install app
        </Button>
      )}
    </section>
  )
}
