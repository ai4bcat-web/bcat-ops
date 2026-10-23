import { useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { useAppStore } from '@/store/useAppStore'
import { graphqlErrorText } from '@/lib/apiClient'
import type { Load } from '@/types'

/**
 * Why this load's POD is what it is — "the receiver's BOL is one page, there is no page 2".
 *
 * Written on the PODs review page and kept on the load, so whoever bills or answers the
 * broker later reads the explanation beside the POD instead of chasing the driver again.
 */
export function LoadPodNotes({ load }: { load: Load }) {
  const updateLoad = useAppStore((s) => s.updateLoad)
  const [draft, setDraft] = useState(load.podNotes ?? '')
  const [saving, setSaving] = useState(false)
  const dirty = (draft.trim() || null) !== (load.podNotes ?? null)

  const save = async () => {
    setSaving(true)
    try {
      await updateLoad(load.id, { podNotes: draft.trim() || null })
      toast.success('POD notes saved')
    } catch (err) {
      toast.error(graphqlErrorText(err) || 'Could not save the POD notes')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor={`pod-notes-${load.id}`} className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        POD notes
      </label>
      <textarea
        id={`pod-notes-${load.id}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={2}
        placeholder="e.g. Receiver's BOL is one page only — no page 2 exists."
        className="w-full rounded-md border px-3 py-2 text-sm bg-background"
      />
      {dirty && (
        <button onClick={save} disabled={saving} className="inline-flex items-center gap-1 h-7 px-3 rounded-md border text-xs font-semibold disabled:opacity-50">
          {saving && <Loader2 size={12} className="animate-spin" />} Save notes
        </button>
      )}
    </div>
  )
}
