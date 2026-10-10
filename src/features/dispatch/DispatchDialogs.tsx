import { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useDrivers } from '@/hooks/useDrivers'
import {
  prettyPhone, toE164Strict, normalizeSettings, conversationTitle, slackChannelNameFor,
  DEFAULT_GREETING, DEFAULT_RING_SECONDS, MIN_RING_SECONDS, MAX_RING_SECONDS,
  type DispatchConversation, type DispatchSettings, type DispatchForward,
} from '@/lib/dispatch'

// ── New message ──────────────────────────────────────────────────────────────

interface NewProps {
  onClose: () => void
  onStart: (input: { driverId?: string; phone?: string; displayName?: string }) => Promise<DispatchConversation>
}

/** Mounted only while open, so every opening starts from a clean form. */
export function NewMessageDialog({ onClose, onStart }: NewProps) {
  const { drivers } = useDrivers()
  const [query, setQuery] = useState('')
  const [phone, setPhone] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return drivers
      .filter((d) => d.type !== 'broker')
      .filter((d) => !q || d.name.toLowerCase().includes(q) || d.phone.replace(/\D/g, '').includes(q.replace(/\D/g, '') || '∅'))
      .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name))
      .slice(0, 12)
  }, [drivers, query])

  const go = async (input: { driverId?: string; phone?: string; displayName?: string }) => {
    setBusy(true)
    try { await onStart(input); onClose() } catch (err) { toast.error(err instanceof Error ? err.message : 'Could not start the conversation') } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New message</DialogTitle>
          <DialogDescription>Pick a driver, or text any number from the dispatch line.</DialogDescription>
        </DialogHeader>
        <div style={{ display: 'grid', gap: 12 }}>
          <div>
            <Label htmlFor="dispatch-new-driver">Driver</Label>
            <Input id="dispatch-new-driver" placeholder="Search by name or number" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
            <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, maxHeight: 220, overflowY: 'auto', border: '1px solid var(--ds-border)', borderRadius: 8 }}>
              {matches.length === 0 ? <li style={{ padding: 10, fontSize: 13, color: 'var(--ds-t3)' }}>No drivers match.</li> : matches.map((d) => (
                <li key={d.id}>
                  <button type="button" disabled={busy} onClick={() => void go({ driverId: d.id })}
                    style={{ width: '100%', textAlign: 'left', display: 'flex', justifyContent: 'space-between', gap: 8, padding: '8px 10px', background: 'none', border: 'none', borderBottom: '1px solid var(--ds-border-soft)', cursor: 'pointer', fontSize: 13 }}>
                    <span style={{ color: d.active ? 'var(--ds-t1)' : 'var(--ds-t3)' }}>{d.name}{d.active ? '' : ' (inactive)'}</span>
                    <span style={{ color: 'var(--ds-t3)', fontVariantNumeric: 'tabular-nums' }}>{prettyPhone(d.phone)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            <Label htmlFor="dispatch-new-phone">Or any phone number</Label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Input id="dispatch-new-phone" placeholder="(847) 555-0100" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
              <Input id="dispatch-new-label" placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button disabled={busy || !toE164Strict(phone)} onClick={() => void go({ phone, displayName: label.trim() || undefined })}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null} Start with number
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Link a number ────────────────────────────────────────────────────────────

interface LinkProps {
  conversation: DispatchConversation
  onClose: () => void
  onLink: (input: { driverId?: string; displayName?: string }) => Promise<void>
}

/** Mounted per conversation (keyed by id), so the label field starts from that row. */
export function LinkNumberDialog({ conversation, onClose, onLink }: LinkProps) {
  const { drivers } = useDrivers()
  const [query, setQuery] = useState('')
  const [label, setLabel] = useState(conversation.displayName ?? '')
  const [busy, setBusy] = useState(false)
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return drivers.filter((d) => d.type !== 'broker').filter((d) => !q || d.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 12)
  }, [drivers, query])
  const go = async (input: { driverId?: string; displayName?: string }) => {
    setBusy(true)
    try { await onLink(input); onClose() } catch (err) { toast.error(err instanceof Error ? err.message : 'Could not update the conversation') } finally { setBusy(false) }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Who is {prettyPhone(conversation.phone)}?</DialogTitle>
          <DialogDescription>Tie this number to a driver, or give it a label. Future texts from it file under that name.</DialogDescription>
        </DialogHeader>
        <div style={{ display: 'grid', gap: 12 }}>
          <div>
            <Label htmlFor="dispatch-link-driver">Driver</Label>
            <Input id="dispatch-link-driver" placeholder="Search drivers" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
            <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, maxHeight: 200, overflowY: 'auto', border: '1px solid var(--ds-border)', borderRadius: 8 }}>
              {matches.map((d) => (
                <li key={d.id}>
                  <button type="button" disabled={busy} onClick={() => void go({ driverId: d.id })}
                    style={{ width: '100%', textAlign: 'left', display: 'flex', justifyContent: 'space-between', padding: '8px 10px', background: 'none', border: 'none', borderBottom: '1px solid var(--ds-border-soft)', cursor: 'pointer', fontSize: 13 }}>
                    <span>{d.name}</span><span style={{ color: 'var(--ds-t3)' }}>{prettyPhone(d.phone)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            <Label htmlFor="dispatch-link-label">Or a label</Label>
            <Input id="dispatch-link-label" placeholder="e.g. Lyons Truck Parts" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button disabled={busy} onClick={() => void go({ displayName: label.trim() })}>{conversation.driverId ? 'Unlink driver and save label' : 'Save label'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Settings ─────────────────────────────────────────────────────────────────

interface SettingsProps {
  onClose: () => void
  dispatchNumber: string | null
  load: () => Promise<DispatchSettings | null>
  save: (s: Partial<DispatchSettings>) => Promise<DispatchSettings>
}

/** Mounted only while open; loads the saved settings once on mount. */
export function DispatchSettingsDialog({ onClose, dispatchNumber, load, save }: SettingsProps) {
  const [forwards, setForwards] = useState<DispatchForward[]>([])
  const [ring, setRing] = useState(DEFAULT_RING_SECONDS)
  const [greeting, setGreeting] = useState('')
  const [voicemail, setVoicemail] = useState(true)
  const [slack, setSlack] = useState('')
  const [autoReply, setAutoReply] = useState('')
  const [slackMirror, setSlackMirror] = useState(true)
  const [slackInvites, setSlackInvites] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    load().then((s) => {
      if (!alive) return
      setForwards(s?.forwardTo ?? [])
      setRing(s?.ringSeconds ?? DEFAULT_RING_SECONDS)
      setGreeting(s?.greeting ?? '')
      setVoicemail(s?.voicemailEnabled !== false)
      setSlack(s?.slackChannelId ?? '')
      setAutoReply(s?.autoReply ?? '')
      setSlackMirror(s?.slackMirror !== false)
      setSlackInvites((s?.slackInviteEmails ?? []).join(', '))
    }).catch((err) => toast.error(err instanceof Error ? err.message : 'Could not load settings')).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [load])

  const submit = async () => {
    const r = normalizeSettings({ forwardTo: forwards, ringSeconds: ring, greeting, voicemailEnabled: voicemail, slackChannelId: slack, autoReply, slackMirror, slackInviteEmails: slackInvites.split(/[\s,;]+/).filter(Boolean) })
    if (!r.ok) { toast.error(r.problem.message); return }
    setSaving(true)
    try { await save(r.value); toast.success('Dispatch settings saved'); onClose() } catch (err) { toast.error(err instanceof Error ? err.message : 'Could not save settings') } finally { setSaving(false) }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Dispatch settings</DialogTitle>
          <DialogDescription>
            {dispatchNumber ? `Drivers text and call ${prettyPhone(dispatchNumber)}.` : 'Twilio is not connected yet; these take effect once it is.'}
          </DialogDescription>
        </DialogHeader>
        {loading ? <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><Loader2 className="size-5 animate-spin" /></div> : (
          <div style={{ display: 'grid', gap: 16, maxHeight: '65vh', overflowY: 'auto', paddingRight: 4 }}>
            <section style={{ display: 'grid', gap: 8 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>When a driver calls, ring these phones</div>
                <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>All at once. Whoever presses a key first takes the call; the rest stop ringing. The call shows as coming from the dispatch number.</div>
              </div>
              {forwards.map((f, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 6 }}>
                  <Input id={`dispatch-fwd-name-${i}`} placeholder="Name" value={f.name} onChange={(e) => setForwards((x) => x.map((y, j) => j === i ? { ...y, name: e.target.value } : y))} />
                  <Input id={`dispatch-fwd-phone-${i}`} placeholder="(847) 555-0100" inputMode="tel" value={f.phone} onChange={(e) => setForwards((x) => x.map((y, j) => j === i ? { ...y, phone: e.target.value } : y))} />
                  <Button variant="outline" size="icon" aria-label="Remove phone" onClick={() => setForwards((x) => x.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
                </div>
              ))}
              <Button variant="outline" size="sm" className="w-fit gap-1" onClick={() => setForwards((x) => [...x, { name: '', phone: '' }])}><Plus className="size-4" /> Add a phone</Button>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Label htmlFor="dispatch-ring">Ring for</Label>
                <Input id="dispatch-ring" type="number" min={MIN_RING_SECONDS} max={MAX_RING_SECONDS} value={ring} onChange={(e) => setRing(Number(e.target.value))} style={{ width: 80 }} />
                <span style={{ fontSize: 12, color: 'var(--ds-t3)' }}>seconds before voicemail</span>
              </div>
            </section>
            <section style={{ display: 'grid', gap: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 }}>
                <input type="checkbox" id="dispatch-vm" checked={voicemail} onChange={(e) => setVoicemail(e.target.checked)} /> Take a voicemail when nobody picks up
              </label>
              <Textarea id="dispatch-greeting" rows={3} placeholder={DEFAULT_GREETING} value={greeting} onChange={(e) => setGreeting(e.target.value)} disabled={!voicemail} />
              <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Voicemails land in the thread with a transcript. Leave blank for the standard greeting.</div>
            </section>
            <section style={{ display: 'grid', gap: 6 }}>
              <Label htmlFor="dispatch-autoreply">First-text auto-reply (optional)</Label>
              <Input id="dispatch-autoreply" placeholder="Got it. BCAT dispatch will reply shortly." value={autoReply} onChange={(e) => setAutoReply(e.target.value)} />
              <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Sent once, the first time a new number texts in.</div>
            </section>
            <section style={{ display: 'grid', gap: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 }}>
                <input type="checkbox" id="dispatch-slack-mirror" checked={slackMirror} onChange={(e) => setSlackMirror(e.target.checked)} /> One Slack channel per driver, mirrored both ways
              </label>
              <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Channels are created from the conversation (Create Slack channel) so you pick the name and who is in it. Texts typed in the channel go to the driver.</div>
              <Label htmlFor="dispatch-slack-invites">Invite these people to every driver channel by default</Label>
              <Input id="dispatch-slack-invites" placeholder="ryne@bcatcorp.com, dennis@bcatcorp.com" value={slackInvites} onChange={(e) => setSlackInvites(e.target.value)} disabled={!slackMirror} />
            </section>
            <section style={{ display: 'grid', gap: 6 }}>
              <Label htmlFor="dispatch-slack">Slack channel ID for a ping on every inbound text (optional)</Label>
              <Input id="dispatch-slack" placeholder="C0123ABCDEF" value={slack} onChange={(e) => setSlack(e.target.value)} />
              <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Channel details → copy channel ID. The BCAT bot must be in the channel.</div>
            </section>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={saving || loading}>{saving ? <Loader2 className="size-4 animate-spin" /> : null} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Slack channel wizard ─────────────────────────────────────────────────────

interface WizardProps {
  conversation: DispatchConversation
  /** Default invitees from Dispatch settings. */
  defaultInvites: string[]
  onClose: () => void
  onCreate: (input: { name: string; inviteEmails: string[] }) => Promise<{ url: string | null; notInvited?: string[] }>
}

/** Mounted per conversation: name the channel, confirm who is in it, create. */
export function SlackChannelWizard({ conversation, defaultInvites, onClose, onCreate }: WizardProps) {
  const [name, setName] = useState(slackChannelNameFor(conversation))
  const [invites, setInvites] = useState<string[]>(defaultInvites)
  const [extra, setExtra] = useState('')
  const [busy, setBusy] = useState(false)
  const cleaned = cleanSlackName(name)

  const addExtra = () => {
    const e = extra.trim().toLowerCase()
    if (!e) return
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { toast.error('Enter an email address'); return }
    if (!invites.includes(e)) setInvites((x) => [...x, e])
    setExtra('')
  }

  const submit = async () => {
    if (!cleaned) { toast.error('Channel names use lowercase letters, numbers and dashes'); return }
    setBusy(true)
    try {
      const r = await onCreate({ name: cleaned, inviteEmails: invites })
      toast.success(`#${cleaned} is ready`, r.url ? { action: { label: 'Open in Slack', onClick: () => window.open(r.url!, '_blank', 'noreferrer') } } : undefined)
      if (r.notInvited?.length) toast.warning(`Not invited (no Slack account with that email): ${r.notInvited.join(', ')}`, { duration: 12_000 })
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the channel')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Slack channel for {conversationTitle(conversation)}</DialogTitle>
          <DialogDescription>
            Everything {conversationTitle(conversation)} texts shows up in this channel, and anything your team types there goes back as a text. Start a Slack message with // to keep it as an internal note.
          </DialogDescription>
        </DialogHeader>
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ display: 'grid', gap: 6 }}>
            <Label htmlFor="dispatch-slack-name">Channel name</Label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: 'var(--ds-t3)' }}>#</span>
              <Input id="dispatch-slack-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </div>
            {cleaned !== name.trim().toLowerCase().replace(/^#/, '') ? <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Will be created as #{cleaned || '…'}</div> : null}
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            <Label>Invite</Label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {invites.length === 0 ? <span style={{ fontSize: 12, color: 'var(--ds-t3)' }}>Nobody yet. Add emails below, or set defaults in Dispatch settings.</span> : null}
              {invites.map((e) => (
                <span key={e} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, background: 'var(--ds-bg-2)', borderRadius: 999, padding: '3px 8px 3px 10px' }}>
                  {e}
                  <button type="button" aria-label={`Remove ${e}`} onClick={() => setInvites((x) => x.filter((y) => y !== e))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ds-t3)', padding: 0, lineHeight: 1 }}>×</button>
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <Input id="dispatch-slack-extra" placeholder="someone@bcatcorp.com" value={extra} onChange={(e) => setExtra(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addExtra() } }} />
              <Button type="button" variant="outline" onClick={addExtra}><Plus className="size-4" /> Add</Button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>People are matched to Slack by their email. The BCAT bot joins automatically.</div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Not now</Button>
          <Button onClick={() => void submit()} disabled={busy || !cleaned}>{busy ? <Loader2 className="size-4 animate-spin" /> : null} Create channel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Mirror of the Lambda's rule, so the wizard previews the real name. */
function cleanSlackName(raw: string): string {
  return raw.trim().toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/^#/, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '')
}


// ── Dispatcher assignment ────────────────────────────────────────────────────

interface AssignProps {
  conversation: DispatchConversation
  /** Suggested pair from the driver file, shown as the default when the row has none. */
  fromDriver: string[]
  loadStaff: () => Promise<string[]>
  onClose: () => void
  onSave: (primary: string | null, backup: string | null) => Promise<void>
}

/** Mounted per conversation: pick the primary and backup dispatcher from everyone in BCAT Ops. */
export function AssignDialog({ conversation, fromDriver, loadStaff, onClose, onSave }: AssignProps) {
  const [staff, setStaff] = useState<string[] | null>(null)
  const [primary, setPrimary] = useState(conversation.assignedTo ?? fromDriver[0] ?? '')
  const [backup, setBackup] = useState(conversation.assignedBackup ?? fromDriver[1] ?? '')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    loadStaff().then((rows) => { if (alive) setStaff(rows) }).catch(() => { if (alive) setStaff([]) })
    return () => { alive = false }
  }, [loadStaff])
  const options = Array.from(new Set([...(staff ?? []), primary, backup, ...fromDriver].filter(Boolean))).sort()
  const submit = async () => {
    setBusy(true)
    try { await onSave(primary || null, backup || null); onClose() } catch (err) { toast.error(err instanceof Error ? err.message : 'Could not save') } finally { setBusy(false) }
  }
  const select = (id: string, value: string, onChange: (v: string) => void, label: string) => (
    <div style={{ display: 'grid', gap: 6 }}>
      <Label htmlFor={id}>{label}</Label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-9 w-full rounded-md border border-input bg-white px-3 text-sm">
        <option value="">Nobody</option>
        {options.map((e) => <option key={e} value={e}>{e}</option>)}
      </select>
    </div>
  )
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Dispatchers for {conversationTitle(conversation)}</DialogTitle>
          <DialogDescription>
            The primary gets a Slack DM when a text from {conversationTitle(conversation)} sits unanswered for 10 minutes; the backup after 20. {staff === null ? 'Loading people…' : ''}
          </DialogDescription>
        </DialogHeader>
        <div style={{ display: 'grid', gap: 12 }}>
          {select('dispatch-assign-primary', primary, setPrimary, 'Primary dispatcher')}
          {select('dispatch-assign-backup', backup, setBackup, 'Backup dispatcher')}
          {fromDriver.length ? <div style={{ fontSize: 12, color: 'var(--ds-t3)' }}>On the driver file: {fromDriver.join(', ')}</div> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy || (!!backup && backup === primary)}>{busy ? <Loader2 className="size-4 animate-spin" /> : null} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
