/**
 * Table names from one suffix. Lambda refuses a function whose environment variables total over
 * 4 KB, and every `<X>_TABLE_NAME` costs ~300 B in the data-stack template (a Select/Split over the
 * table ARN) on top of its runtime bytes. The stack passes ONE `DATA_TABLE_SUFFIX` (`<apiId>-NONE`)
 * and every Amplify table is named `<Model>-<suffix>`; this fills each `<X>_TABLE_NAME` the handler
 * reads from it. An explicit value still wins (unit tests, rehearsal stacks).
 *
 * The handler's `tableEnv.ts` must be its FIRST import: sibling modules read these variables when
 * they load.
 */
export type DataTableEnv = Readonly<Record<string, string>>

export function applyDataTableSuffix(
  tables: DataTableEnv,
  env: Record<string, string | undefined> = process.env,
): void {
  const suffix = env.DATA_TABLE_SUFFIX
  if (!suffix) return
  for (const [name, model] of Object.entries(tables)) {
    if (env[name] === undefined) env[name] = `${model}-${suffix}`
  }
}
