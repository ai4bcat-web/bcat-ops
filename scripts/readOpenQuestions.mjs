// Reads back Accounting → Open questions: each question, its status and the answers people saved.
//
//   node scripts/readOpenQuestions.mjs                 (everything, open first)
//   node scripts/readOpenQuestions.mjs --answered      (only questions with an answer or marked resolved)
//   node scripts/readOpenQuestions.mjs --json
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
const require = createRequire(import.meta.url)
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb')
const { DynamoDBDocumentClient, ScanCommand } = require('@aws-sdk/lib-dynamodb')

const { values } = parseArgs({ options: { answered: { type: 'boolean' }, json: { type: 'boolean' }, suffix: { type: 'string' } } })
const TABLE = `Feedback${values.suffix ?? '-5ucwdyvwivelbo4k4jomvrwel4-NONE'}`
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }))
const rows = []
let ExclusiveStartKey
do {
  const r = await doc.send(new ScanCommand({
    TableName: TABLE, ExclusiveStartKey,
    FilterExpression: '#p = :p', ExpressionAttributeNames: { '#p': 'page' }, ExpressionAttributeValues: { ':p': 'accounting-open-question' },
  }))
  rows.push(...(r.Items ?? []))
  ExclusiveStartKey = r.LastEvaluatedKey
} while (ExclusiveStartKey)

const out = rows
  .map((r) => {
    let d = {}
    try { d = JSON.parse(r.details ?? '{}') } catch { /* keep empty */ }
    return { id: r.id, status: r.status === 'DONE' ? 'RESOLVED' : 'OPEN', area: d.area, pros: (d.refs ?? []).map((x) => x.pro), question: r.summary, answers: r.adminNotes ?? '', updatedAt: r.updatedAt }
  })
  .filter((q) => !values.answered || q.answers || q.status === 'RESOLVED')
  .sort((a, b) => (a.status === b.status ? a.id.localeCompare(b.id) : a.status === 'OPEN' ? -1 : 1))

if (values.json) console.log(JSON.stringify(out, null, 2))
else for (const q of out) console.log(`[${q.status}] ${q.id} (${q.pros.join(', ')})\n  ${q.question}${q.answers ? `\n  ${q.answers.replace(/\n/g, '\n  ')}` : ''}\n`)
