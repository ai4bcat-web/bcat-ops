#!/usr/bin/env node
/**
 * Step AB §10.4 — live eval of the spot-request classifier. MANUAL; never run by tests.
 *
 * Runs the synthetic corpus (src/lib/spot/fixtures.ts) through the REAL pre-filters and the
 * REAL model call the spot Lambda uses (`realModel.classify`), then prints:
 *   - a confusion matrix (fixture label × what the pipeline did),
 *   - hard-negative stores (acceptance: 0),
 *   - request recall (acceptance: >= 90 %),
 *   - exact-match rate on the required fields for clean requests (acceptance: >= 90 %),
 *   - follow-up intent accuracy, and token totals (so the per-mail cost is visible).
 * and writes Docs/tms-build/ab-proof/eval.json.
 *
 * Usage (TypeScript sources are imported, so run through tsx):
 *   ANTHROPIC_API_KEY=... npx tsx scripts/evalSpotClassifier.mjs [--limit=N]
 *
 * No key: prints "SKIPPED — no key" and exits 0. Nothing is sent anywhere but the model
 * call; no Gmail, no AWS, no database.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

if (!process.env.ANTHROPIC_API_KEY) {
  console.log('SKIPPED — no key (set ANTHROPIC_API_KEY to run the live eval)')
  process.exit(0)
}

const { SPOT_FIXTURES, FIXTURE_OWN_DOMAINS, FIXTURE_REP_EMAIL } = await import('../src/lib/spot/fixtures.ts')
const { prefilterStage1, prefilterStage2, stripQuotedHistory } = await import('../src/lib/spot/prefilter.ts')
const { normalizeExtraction, REQUIRED_SPOT_FIELDS } = await import('../src/lib/spot/normalize.ts')
const { realModel } = await import('../amplify/functions/tms-spot-quoter/model.ts')

const limitArg = process.argv.find((a) => a.startsWith('--limit='))
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : Infinity
const fixtures = SPOT_FIXTURES.slice(0, Number.isFinite(limit) ? limit : undefined)

const EXPECTED_INTENT = { 'fu-accept': 'ACCEPT', 'fu-counter': 'COUNTER', 'fu-question': 'QUESTION' }
const NEGATIVE_INJECTION = 'req-injection'

const matrix = {}
const bump = (label, outcome) => {
  matrix[label] ??= {}
  matrix[label][outcome] = (matrix[label][outcome] ?? 0) + 1
}

let inputTokens = 0
let outputTokens = 0
let modelCalls = 0
const rows = []

for (const f of fixtures) {
  const row = { id: f.id, label: f.label, expectStage: f.expectStage, outcome: null, detail: null }
  rows.push(row)

  if (f.trackedThread) {
    // Follow-ups on a tracked thread skip the prefilters and the classifier; only the intent call runs.
    try {
      const intent = await realModel.replyIntent({ subject: f.meta.subject, fromEmail: f.meta.from, body: f.body })
      modelCalls += 1
      row.outcome = 'ATTACHED'
      row.detail = { intent, expected: EXPECTED_INTENT[f.id] ?? null, ok: intent === EXPECTED_INTENT[f.id] }
    } catch (error) {
      row.outcome = 'ERROR'
      row.detail = { error: String(error?.message ?? error).slice(0, 200) }
    }
    bump(f.label, row.outcome)
    continue
  }

  const s1 = prefilterStage1(f.meta, {
    repEmail: FIXTURE_REP_EMAIL,
    ownDomains: FIXTURE_OWN_DOMAINS,
    blacklist: { addresses: [], keywords: [] },
    watchLabel: null,
    knownSender: Boolean(f.knownContact),
  })
  if (!s1.pass) {
    row.outcome = 'STAGE1_REJECT'
    row.detail = { reason: s1.reason }
    bump(f.label, row.outcome)
    continue
  }
  const stripped = stripQuotedHistory(f.body)
  const s2 = prefilterStage2(stripped)
  if (!s2.pass) {
    row.outcome = 'STAGE2_REJECT'
    row.detail = { reason: s2.reason, score: s2.score }
    bump(f.label, row.outcome)
    continue
  }

  try {
    const answer = await realModel.classify({
      subject: f.meta.subject,
      fromEmail: f.meta.from,
      mailDate: String(f.meta.headers.date ?? ''),
      body: stripped,
      aiAgents: null,
    })
    modelCalls += 1
    inputTokens += answer.inputTokens
    outputTokens += answer.outputTokens
    const n = normalizeExtraction(answer.output, { mailDate: '2026-11-04' })
    row.outcome = n.classification.kind === 'QUOTE_REQUEST' ? 'STORED' : n.classification.kind === 'FOLLOW_UP' ? 'DROPPED_FOLLOW_UP' : 'MODEL_NOT_REQUEST'
    row.detail = { kind: n.classification.kind, confidence: n.classification.confidence, status: n.status }

    if (f.expect && row.outcome === 'STORED') {
      const e = n.extraction
      const want = f.expect
      const got = {
        origin: e.stops[0] && `${e.stops[0].city}|${e.stops[0].state}`,
        destination: e.stops.length > 1 && `${e.stops[e.stops.length - 1].city}|${e.stops[e.stops.length - 1].state}`,
        equipment: e.equipmentType,
        pickupDate: e.pickupDate,
      }
      const exp = {
        origin: want.stops?.[0] && `${want.stops[0].city}|${want.stops[0].state}`,
        destination: want.stops && want.stops.length > 1 && `${want.stops[want.stops.length - 1].city}|${want.stops[want.stops.length - 1].state}`,
        equipment: want.equipment,
        pickupDate: want.pickupDate,
      }
      const fields = {}
      for (const key of REQUIRED_SPOT_FIELDS) {
        if (exp[key] == null || exp[key] === false) continue
        fields[key] = String(got[key]) === String(exp[key])
      }
      if (want.weightLbs != null) fields.weightLbs = e.weightLbs === want.weightLbs
      if (want.mode != null) fields.mode = e.mode === want.mode
      if (want.accessorials != null) fields.accessorials = JSON.stringify([...e.accessorials].sort()) === JSON.stringify([...want.accessorials].sort())
      row.detail.fields = fields
      row.detail.requiredExact = Object.entries(fields).filter(([k]) => REQUIRED_SPOT_FIELDS.includes(k)).every(([, ok]) => ok)
    }
  } catch (error) {
    row.outcome = 'ERROR'
    row.detail = { error: String(error?.message ?? error).slice(0, 200) }
  }
  bump(f.label, row.outcome)
}

// ── Summary ─────────────────────────────────────────────────────────────────
const requests = rows.filter((r) => r.label === 'REQUEST')
const storedRequests = requests.filter((r) => r.outcome === 'STORED')
const recall = requests.length ? storedRequests.length / requests.length : null
const hardNegativesStored = rows.filter((r) => r.label === 'NOT_REQUEST' && r.outcome === 'STORED').map((r) => r.id)
const clean = storedRequests.filter((r) => r.detail?.requiredExact !== undefined)
const exactRate = clean.length ? clean.filter((r) => r.detail.requiredExact).length / clean.length : null
const followUps = rows.filter((r) => r.label === 'FOLLOW_UP')
const intentRate = followUps.length ? followUps.filter((r) => r.detail?.ok).length / followUps.length : null
const injection = rows.find((r) => r.id === NEGATIVE_INJECTION)

const summary = {
  generatedAt: new Date().toISOString(),
  fixtures: rows.length,
  modelCalls,
  tokens: { input: inputTokens, output: outputTokens, perClassifiedMail: modelCalls ? { input: Math.round(inputTokens / modelCalls), output: Math.round(outputTokens / modelCalls) } : null },
  matrix,
  hardNegativesStored,
  requestRecall: recall,
  requiredFieldsExactRate: exactRate,
  followUpIntentAccuracy: intentRate,
  injectionFixture: injection ? { outcome: injection.outcome, requiredExact: injection.detail?.requiredExact ?? null } : null,
  acceptance: {
    zeroHardNegativesStored: hardNegativesStored.length === 0,
    recallAtLeast90: recall != null && recall >= 0.9,
    requiredExactAtLeast90: exactRate != null && exactRate >= 0.9,
    injectionStillNormal: Boolean(injection && injection.outcome === 'STORED' && injection.detail?.requiredExact),
  },
}

console.log('\nConfusion matrix (fixture label → pipeline outcome)')
for (const [label, outcomes] of Object.entries(matrix)) {
  console.log(`  ${label.padEnd(12)} ${Object.entries(outcomes).map(([k, v]) => `${k}=${v}`).join('  ')}`)
}
const pct = (n) => (n == null ? 'n/a' : `${(n * 100).toFixed(0)}%`)
console.log(`\nHard negatives stored : ${hardNegativesStored.length}${hardNegativesStored.length ? ` (${hardNegativesStored.join(', ')})` : ''}`)
console.log(`Request recall        : ${pct(recall)}`)
console.log(`Required fields exact : ${pct(exactRate)}`)
console.log(`Follow-up intent      : ${pct(intentRate)}`)
console.log(`Injection fixture     : ${summary.injectionFixture ? summary.injectionFixture.outcome : 'not run'}`)
console.log(`Tokens                : ${inputTokens} in / ${outputTokens} out over ${modelCalls} model calls`)
console.log(`Acceptance            : ${JSON.stringify(summary.acceptance)}`)

const out = resolve(root, 'Docs/tms-build/ab-proof/eval.json')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify({ summary, rows }, null, 2)}\n`)
console.log(`\nWrote ${out}`)
