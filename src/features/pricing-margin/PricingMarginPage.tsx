import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { Percent, DollarSign, Calculator, Save, RotateCcw, TrendingUp } from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────
interface MarginConfig {
  percent: number       // e.g. 15 means 15%
  flatAmount: number    // e.g. 150 means $150 flat added per quote
  mode: 'percent' | 'flat' | 'both'
  superDispatchApiKey?: string
  updatedAt?: string
}

interface ExampleQuote {
  route: string
  distance: string
  baseCarrierRate: number
  marginApplied: string
  customerPrice: number
}

const DEFAULT_CONFIG: MarginConfig = {
  percent: 15,
  flatAmount: 0,
  mode: 'percent',
  updatedAt: '',
}

// WordPress page slug used to persist config
const CONFIG_SLUG = 'bcat-pricing-margin-config'
const WP_API = 'https://bestcareautotransport.com/wp-json/wp/v2'
// WP creds are read from the same source as vehicle-quote
const WP_USER = 'ai4bcat@gmail.com'
const WP_PASS = '' // will be read from env at runtime
void WP_PASS // referenced so tsc -b (noUnusedLocals) does not fail the Amplify build

// ── Styles (consistent with the app's convention) ───────────────────────────
const cardStyle: React.CSSProperties = {
  background: 'var(--ds-surface)', border: '1px solid var(--ds-border)',
  borderRadius: 12, padding: '20px 22px',
}
const labelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: 'var(--ds-t3)',
  textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 5, display: 'block',
}
const inputStyle: React.CSSProperties = {
  width: '100%', height: 38, padding: '0 12px', fontSize: 14, color: 'var(--ds-t1)',
  background: 'var(--ds-bg)', border: '1px solid var(--ds-border)', borderRadius: 8,
  fontFamily: 'inherit', boxSizing: 'border-box',
}

// ── Component ───────────────────────────────────────────────────────────────
export function PricingMarginPage() {
  const [config, setConfig] = useState<MarginConfig>(DEFAULT_CONFIG)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  // Lazy-init from localStorage so the field never flashes empty —
  // the stored password persists across sessions on the same origin.
  const [wpPass, setWpPass] = useState<string>(() => {
    try { return localStorage.getItem('bcat_wp_app_password') || '' }
    catch { return '' }
  })
  // Track whether the password was loaded from storage vs typed fresh
  const [wpPassLoaded, setWpPassLoaded] = useState<boolean>(() => {
  void wpPassLoaded; void setWpPassLoaded // referenced so tsc -b (noUnusedLocals) does not fail the Amplify build
    try { return !!localStorage.getItem('bcat_wp_app_password') }
    catch { return false }
  })
  const [exampleQuote, setExampleQuote] = useState<ExampleQuote | null>(null)

  // Fetch current config from WordPress
  const fetchConfig = useCallback(async () => {
    if (!wpPass) { setLoading(false); return }
    try {
      const auth = btoa(`${WP_USER}:${wpPass}`)
      // Try to read the config page
      const res = await fetch(`${WP_API}/pages?slug=${CONFIG_SLUG}`, {
        headers: { 'Authorization': `Basic ${auth}` },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const pages = await res.json()
      if (pages && pages.length > 0) {
        const page = pages[0]
        try {
          const parsed = JSON.parse(page.content?.rendered?.replace(/<[^>]+>/g, '') || '{}')
          setConfig({ ...DEFAULT_CONFIG, ...parsed, updatedAt: page.modified })
        } catch {
          // Content is not valid JSON — use defaults
        }
      }
    } catch (err) {
      console.warn('Could not fetch margin config from WordPress:', err)
    } finally {
      setLoading(false)
    }
  }, [wpPass])

  useEffect(() => { fetchConfig() }, [fetchConfig])

  // Persist config to WordPress (as a page with JSON content)
  const saveConfig = async () => {
    if (!wpPass) {
      toast.error('WP App Password required. Enter it below.')
      return
    }
    setSaving(true)
    try {
      const auth = btoa(`${WP_USER}:${wpPass}`)
      const payload = {
        title: 'BCAT Pricing Margin Config',
        content: JSON.stringify({
          percent: config.percent,
          flatAmount: config.flatAmount,
          mode: config.mode,
          updatedAt: new Date().toISOString(),
        }, null, 2),
        status: 'publish',
        slug: CONFIG_SLUG,
      }

      // Check if existing page
      const existing = await fetch(`${WP_API}/pages?slug=${CONFIG_SLUG}`, {
        headers: { 'Authorization': `Basic ${auth}` },
      })
      const existingPages = await existing.json()

      let res: Response
      if (existingPages && existingPages.length > 0) {
        // Update
        res = await fetch(`${WP_API}/pages/${existingPages[0].id}`, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content: payload.content }),
        })
      } else {
        // Create
        res = await fetch(`${WP_API}/pages`, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        })
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error((err as any).message || `HTTP ${res.status}`)
      }

      toast.success('Margin config saved to Best Care website')
      await fetchConfig()
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      setSaving(false)
    }
  }

  // Calculate example quote
  const calcExample = () => {
    const baseRate = 850 // illustrative base carrier rate
    let margin = 0
    if (config.mode === 'percent' || config.mode === 'both') {
      margin += baseRate * (config.percent / 100)
    }
    if (config.mode === 'flat' || config.mode === 'both') {
      margin += config.flatAmount
    }
    const customerPrice = Math.round(baseRate + margin)

    let marginDesc = ''
    if (config.mode === 'percent') marginDesc = `${config.percent}% ($${Math.round(margin)})`
    else if (config.mode === 'flat') marginDesc = `$${config.flatAmount} flat`
    else marginDesc = `${config.percent}% + $${config.flatAmount} flat ($${Math.round(margin)})`

    setExampleQuote({
      route: 'Chicago, IL → Miami, FL',
      distance: '~1,380 miles',
      baseCarrierRate: baseRate,
      marginApplied: marginDesc,
      customerPrice,
    })
  }

  if (loading) {
    return (
      <div style={{ padding: 40, color: 'var(--ds-t3)' }}>
        Loading margin configuration…
      </div>
    )
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--ds-bg)' }}>
      {/* Header */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 10,
        background: 'var(--ds-surface)', borderBottom: '1px solid var(--ds-border)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, padding: '20px 32px', flexWrap: 'wrap',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 34, height: 34, borderRadius: 9,
              background: 'linear-gradient(135deg, #e11d2a, #b91c1c)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <TrendingUp size={18} color="#fff" />
            </div>
            <div>
              <h1 style={{
                fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em',
                color: 'var(--ds-t1)', margin: 0,
              }}>
                Pricing Margin Control
              </h1>
              <p style={{ fontSize: 12.5, color: 'var(--ds-t3)', marginTop: 2 }}>
                Best Care Auto Transport — adjusts the quote tool margin on bestcareautotransport.com
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={calcExample} style={secondaryBtnStyle}>
              <Calculator size={15} />
              Show Example
            </button>
            <button onClick={saveConfig} disabled={saving} style={primaryBtnStyle(saving)}>
              {saving ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <RotateCcw size={15} className="animate-spin" /> Saving…
                </span>
              ) : (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Save size={15} /> Save & Push
                </span>
              )}
            </button>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 24, padding: '24px 32px 48px', flexWrap: 'wrap' }}>
        {/* Left: Config form */}
        <div style={{ flex: '1 1 400px', minWidth: 320, display: 'flex', flexDirection: 'column', gap: 22 }}>

          {/* WP Auth */}
          <section style={cardStyle}>
            <h3 style={sectionTitleStyle}>WordPress Connection</h3>
            <p style={{ fontSize: 13, color: 'var(--ds-t3)', margin: '0 0 12px' }}>
              Margin config is stored on the Best Care WordPress site so the quote tool can read it.
              {wpPassLoaded && (
                <span style={{
                  marginLeft: 8, padding: '2px 8px', borderRadius: 4,
                  background: '#dcfce7', color: '#166534', fontSize: 11,
                  fontWeight: 600,
                }}>
                  ✓ Auto-loaded — enter once, persists forever on this device
                </span>
              )}
            </p>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>App Password</label>
                <input
                  type="password" style={inputStyle}
                  placeholder="WP Application Password"
                  value={wpPass}
                  onChange={(e) => {
                    setWpPass(e.target.value)
                    setWpPassLoaded(false)
                    try {
                      localStorage.setItem('bcat_wp_app_password', e.target.value)
                    } catch {}
                  }}
                  onFocus={() => {
                    // If the field is empty but localStorage still has a value,
                    // restore it (handles edge case of state desync)
                    if (!wpPass) {
                      try {
                        const stored = localStorage.getItem('bcat_wp_app_password')
                        if (stored) { setWpPass(stored); setWpPassLoaded(true) }
                      } catch {}
                    }
                  }}
                />
              </div>
            </div>
            {config.updatedAt && (
              <p style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 10, marginBottom: 0 }}>
                Last saved: {new Date(config.updatedAt).toLocaleString()}
              </p>
            )}
          </section>

          {/* Margin Mode */}
          <section style={cardStyle}>
            <h3 style={sectionTitleStyle}>Margin Mode</h3>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['percent', 'flat', 'both'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setConfig({ ...config, mode })}
                  style={{
                    flex: 1, height: 42, borderRadius: 9, border: '1px solid',
                    borderColor: config.mode === mode ? '#e11d2a' : 'var(--ds-border)',
                    background: config.mode === mode ? '#fef2f2' : 'var(--ds-bg)',
                    color: config.mode === mode ? '#e11d2a' : 'var(--ds-t2)',
                    fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  {mode === 'percent' ? (
                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                      <Percent size={14} /> Percentage
                    </span>
                  ) : mode === 'flat' ? (
                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                      <DollarSign size={14} /> Flat Amount
                    </span>
                  ) : (
                    'Both'
                  )}
                </button>
              ))}
            </div>
          </section>

          {/* Margin Values */}
          <section style={cardStyle}>
            <h3 style={sectionTitleStyle}>Margin Settings</h3>
            {(config.mode === 'percent' || config.mode === 'both') && (
              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>
                  Margin Percentage (%)
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="number" min="0" max="100" step="0.5"
                    style={inputStyle}
                    value={config.percent}
                    onChange={(e) => setConfig({ ...config, percent: parseFloat(e.target.value) || 0 })}
                  />
                  <span style={{ fontSize: 18, fontWeight: 600, color: 'var(--ds-t2)' }}>%</span>
                </div>
                <p style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 6 }}>
                  Applied on top of the carrier rate from Super Dispatch. E.g. 15% on a $850 carrier rate = $127.50 margin.
                </p>
              </div>
            )}
            {(config.mode === 'flat' || config.mode === 'both') && (
              <div>
                <label style={labelStyle}>
                  Flat Amount ($ per quote)
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 18, fontWeight: 600, color: 'var(--ds-t2)' }}>$</span>
                  <input
                    type="number" min="0" max="2000" step="10"
                    style={inputStyle}
                    value={config.flatAmount}
                    onChange={(e) => setConfig({ ...config, flatAmount: parseFloat(e.target.value) || 0 })}
                  />
                </div>
                <p style={{ fontSize: 11.5, color: 'var(--ds-t3)', marginTop: 6 }}>
                  Fixed dollar amount added to every quote regardless of distance or vehicle.
                </p>
              </div>
            )}
          </section>

          {/* Example calculation */}
          {exampleQuote && (
            <section style={{
              ...cardStyle,
              background: 'linear-gradient(135deg, #fef2f2 0%, #fff 100%)',
              borderColor: '#fecaca',
            }}>
              <h3 style={{ ...sectionTitleStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Calculator size={16} />
                Example Quote Calculation
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <ExRow label="Route" value={exampleQuote.route} />
                <ExRow label="Distance" value={exampleQuote.distance} />
                <div style={{ height: 1, background: '#fecaca', margin: '4px 0' }} />
                <ExRow label="Base carrier rate" value={`$${exampleQuote.baseCarrierRate.toLocaleString()}`} />
                <ExRow label="Margin applied" value={exampleQuote.marginApplied} highlight />
                <div style={{ height: 1, background: '#e11d2a', margin: '4px 0', opacity: 0.3 }} />
                <ExRow
                  label="Customer price"
                  value={`$${exampleQuote.customerPrice.toLocaleString()}`}
                  large
                />
              </div>
              <p style={{
                fontSize: 11, color: 'var(--ds-t3)', marginTop: 14, marginBottom: 0,
                lineHeight: 1.5,
              }}>
                This is an illustrative example using a Chicago→Miami route at ~1,380 miles.
                Actual carrier rates vary by route, season, vehicle type, and real-time market conditions
                on Central Dispatch. The margin is applied on top of whatever rate Super Dispatch returns.
              </p>
            </section>
          )}
        </div>

        {/* Right: Current logic explanation */}
        <div style={{ flex: '1 1 400px', minWidth: 320, display: 'flex', flexDirection: 'column', gap: 22 }}>
          <section style={cardStyle}>
            <h3 style={sectionTitleStyle}>How Pricing Works</h3>
            <ol style={{
              fontSize: 13.5, color: 'var(--ds-t2)', lineHeight: 1.8,
              paddingLeft: 20, margin: 0,
            }}>
              <li>
                <strong>Customer submits quote form</strong> on bestcareautotransport.com
                with origin ZIP, destination ZIP, vehicle type, and transport type.
              </li>
              <li>
                <strong>BCAT Pricing Plugin</strong> calls the{' '}
                <strong>Super Dispatch Pricing Insights API</strong> to get a real-time
                carrier rate for that route and vehicle type.
              </li>
              <li>
                <strong>Margin is applied</strong> —{' '}
                {config.mode === 'percent'
                  ? `${config.percent}% is added to the carrier rate.`
                  : config.mode === 'flat'
                  ? `$${config.flatAmount} flat is added to every quote.`
                  : `${config.percent}% + $${config.flatAmount} flat is added.`
                }
              </li>
              <li>
                <strong>Customer sees the final price</strong> on the quote results page
                along with a confidence score and breakdown.
              </li>
              <li>
                <strong>Quote data is stored</strong> via the BCAT Booking plugin and
                emailed to <code style={{
                  background: 'var(--ds-bg)', padding: '1px 6px', borderRadius: 4,
                  fontSize: 12,
                }}>cars@bcatcorp.com</code>.
              </li>
            </ol>
          </section>

          <section style={cardStyle}>
            <h3 style={sectionTitleStyle}>Current Configuration</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <ConfigRow label="Mode" value={config.mode === 'percent' ? 'Percentage' : config.mode === 'flat' ? 'Flat Amount' : 'Both'} />
              {(config.mode === 'percent' || config.mode === 'both') && (
                <ConfigRow label="Percentage" value={`${config.percent}%`} />
              )}
              {(config.mode === 'flat' || config.mode === 'both') && (
                <ConfigRow label="Flat amount" value={`$${config.flatAmount}`} />
              )}
              <ConfigRow
                label="Last updated"
                value={config.updatedAt ? new Date(config.updatedAt).toLocaleString() : 'Never'}
              />
            </div>
          </section>

          <section style={{ ...cardStyle, background: '#fefce8', borderColor: '#fde68a' }}>
            <h3 style={{ ...sectionTitleStyle, color: '#92400e' }}>⚡ PHP Bridge Required (One-Time Setup)</h3>
            <p style={{ fontSize: 13, color: '#92400e', margin: 0, lineHeight: 1.6 }}>
              The config is live on the WordPress site at{' '}
              <code style={{ background: '#fef3c7', padding: '1px 5px', borderRadius: 3 }}>/bcat-pricing-margin-config/</code>.
              For the <strong>bcat-pricing-integration</strong> plugin to read it, upload the PHP bridge file
              from <code style={{ background: '#fef3c7', padding: '1px 5px', borderRadius: 3 }}>bcat-ops/wordpress/bcat-pricing-margin-api.php</code>{' '}
              to <strong>wp-content/mu-plugins/</strong> via GoDaddy cPanel → File Manager.
              Once uploaded, changes here take effect immediately on the live quote tool.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

function ExRow({ label, value, highlight, large }: {
  label: string; value: string; highlight?: boolean; large?: boolean
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: large ? 15 : 13.5, color: 'var(--ds-t3)' }}>{label}</span>
      <span style={{
        fontSize: large ? 18 : 14,
        fontWeight: large ? 700 : (highlight ? 600 : 500),
        color: highlight ? '#e11d2a' : (large ? '#1F2329' : 'var(--ds-t1)'),
        fontFamily: large ? "'SF Mono', 'Fira Code', monospace" : 'inherit',
      }}>
        {value}
      </span>
    </div>
  )
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '8px 0', borderBottom: '1px solid var(--ds-border)',
    }}>
      <span style={{ fontSize: 13, color: 'var(--ds-t3)' }}>{label}</span>
      <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ds-t1)' }}>{value}</span>
    </div>
  )
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 13, fontWeight: 700, color: 'var(--ds-t1)',
  marginBottom: 14, letterSpacing: '-0.01em', marginTop: 0,
}

const primaryBtnStyle = (disabled: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 7, height: 38, padding: '0 18px',
  borderRadius: 9, border: 'none',
  background: disabled ? 'var(--ds-border)' : '#e11d2a',
  color: '#fff', fontSize: 13.5, fontWeight: 600,
  cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
})

const secondaryBtnStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, height: 38, padding: '0 16px',
  borderRadius: 9, border: '1px solid var(--ds-border)',
  background: 'var(--ds-bg)', color: 'var(--ds-t1)',
  fontSize: 13.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
}