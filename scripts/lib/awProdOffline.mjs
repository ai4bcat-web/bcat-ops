/**
 * Step AW: the production per-file steps run OFFLINE, not through the tmsAljexImport Lambda (whose router refuses production
 * tables in every Lambda mode). Pure argv builders for `scripts/importAljex.mjs file|stage|reconcile-entity --target prod:<tag>`:
 * that CLI carries the production gate (BCAT_ALLOW_PROD, --i-mean-production, fresh prodpre- backups, typed confirmation) and
 * needs AWS credentials only (no staff password).
 */
import { AwProdRefusal, PROD_SUFFIX } from './awProdGuard.mjs'

/** awProd step -> importAljex `file --kind` and the flag the file goes in. */
export const OFFLINE_FILE_KIND = {
  customers: { kind: 'customers', flag: 'file' },
  carriers: { kind: 'carriers', flag: 'file' },
  ar: { kind: 'ar', flag: 'file' },
  'ap-aging': { kind: 'ap', flag: 'aging-file' },
  'ap-expected': { kind: 'ap', flag: 'expected-file' },
}

const gateTail = (apply, account) => ['--i-mean-production', ...(apply ? ['--apply', '--confirm-prod', `${account}:${PROD_SUFFIX}`] : [])]

/** @param {{file?: string, cutoff?: string, 'live-tag'?: string}} values */
export function fileArgs(step, values, { apply, account }) {
  const spec = OFFLINE_FILE_KIND[step]
  if (!spec) throw new AwProdRefusal(`no offline file import for step ${step}`)
  if (!values.file) throw new AwProdRefusal(`${step} needs --file <csv>`)
  if (!values.cutoff) throw new AwProdRefusal(`${step} needs --cutoff YYYY-MM-DD`)
  if (apply && !values['live-tag']) throw new AwProdRefusal(`${step} --apply needs --live-tag <TAG>`)
  return ['scripts/importAljex.mjs', 'file', '--kind', spec.kind, `--${spec.flag}`, values.file, '--cutoff', values.cutoff, '--target', `prod:${values['live-tag'] ?? 'plan'}`, ...gateTail(apply, account)]
}

export function stageArgs(values) {
  if (!values.file) throw new AwProdRefusal('stage-export needs --file <csv>')
  return ['scripts/importAljex.mjs', 'stage', '--source', values.file, '--target', `prod:${values['live-tag'] ?? 'stage'}`, '--i-mean-production']
}

/** The production files bucket (the one the tmsAljexImport Lambda gets as DATA_SAFETY_BUCKET), found without the Lambda: exactly one `<prefix>-datasafetybucket*` S3 bucket. */
export function pickDataSafetyBucket(names, prefix) {
  const hits = names.filter((n) => n.toLowerCase().startsWith(`${prefix.toLowerCase()}-datasafetybucket`))
  if (hits.length !== 1) throw new AwProdRefusal(`expected exactly one production data-safety bucket ${prefix}-datasafetybucket*, found ${hits.length}`)
  return hits[0]
}

export function reconcileArgs(values, { account, bucket }) {
  if (!values.entity || !values['source-job']) throw new AwProdRefusal('reconcile needs --entity and --source-job')
  if (!values.cutoff) throw new AwProdRefusal('reconcile needs --cutoff YYYY-MM-DD')
  if (!bucket) throw new AwProdRefusal('the production files bucket could not be determined')
  return [
    'scripts/importAljex.mjs', 'reconcile-entity', '--entity', values.entity, '--source-job', values['source-job'],
    ...(values['customers-job'] ? ['--customers-job', values['customers-job']] : []),
    '--cutoff', values.cutoff, '--bucket', bucket, '--target', `prod:${values['live-tag'] ?? 'reconcile'}`, ...gateTail(true, account),
  ]
}
