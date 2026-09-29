import { useState } from 'react'
import { Eye, EyeOff, Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { configurePods } from '@/lib/podsClient'
import { graphqlErrorText } from '@/lib/apiClient'
import type { PodConnectionStatus } from '@/types/pods'

export function PodsConnectionForm({ onConfigured }: { onConfigured: (s: PodConnectionStatus) => void }) {
  const [clientId, setClientId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)

  const canSubmit = clientId.trim() && apiKey.trim()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setSaving(true)
    try {
      const status = await configurePods({ clientId: clientId.trim(), apiKey: apiKey.trim() })
      setApiKey('') // never retain the key in memory longer than necessary
      onConfigured(status)
      toast.success('JobsDone connection saved')
    } catch (err) {
      toast.error(graphqlErrorText(err) || 'Could not save JobsDone connection')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="text-xs text-muted-foreground">
        The JobsDone API key is stored server-side and scoped to the tenant client ID.
        Staff do not need to know or keep the key.
      </div>
      <div className="space-y-2">
        <Label htmlFor="pods-client-id">JobsDone Client ID</Label>
        <Input
          id="pods-client-id"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="e.g. bcat-logistics"
          autoComplete="off"
          data-1p-ignore
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="pods-api-key">JobsDone API Key</Label>
        <div className="relative">
          <Input
            id="pods-api-key"
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Paste the API key once"
            autoComplete="off"
            data-1p-ignore
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            tabIndex={-1}
          >
            {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
      </div>
      <button
        type="submit"
        disabled={!canSubmit || saving}
        className="inline-flex items-center justify-center gap-2 h-9 px-4 rounded-md bg-foreground text-background text-sm font-medium disabled:opacity-50"
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
        Save connection
      </button>
    </form>
  )
}
