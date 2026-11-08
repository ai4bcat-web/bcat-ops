/**
 * argv handling for scripts/importAljex.mjs in production mode. Pure: no AWS, no engine bundle.
 *
 * The engine CLI (amplify/.../engine/cli.ts) knows nothing about the gate. The wrapper takes the gate flags out of
 * argv, rewrites `--target prod:<liveTag>` to the engine's `--target live:<liveTag>`, and only after
 * `requireProd` (scripts/lib/prodGate.mjs) passed does it hand the engine a production policy.
 */

/** Engine commands that may run in production mode. Everything else is dev tooling. */
export const PROD_COMMANDS = ['run', 'resume', 'seed-counter', 'rollback', 'pitr-restore', 'file', 'stage', 'reconcile-entity'];
/** Commands whose engine implementation has no dry run of its own: without --apply the wrapper stops after the plan. */
const NEEDS_APPLY_TO_ACT = ['resume', 'pitr-restore'];
/** Commands that create a new table / read only: they overwrite nothing, so no backup is demanded. */
const READ_ONLY = ['pitr-restore', 'stage'];
const DRY_IS_READ_ONLY = ['file', 'reconcile-entity'];

const GATE_FLAGS = ['i-mean-production', 'confirm-prod', 'prod-mode-rehearsal-suffix'];

/**
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{prod: false, cliArgv: string[]} | {prod: true, command: string, liveTag: string | null, values: Record<string, unknown>, cliArgv: string[], readOnly: boolean, stopAfterPlan: boolean, synthetic: boolean}}
 */
export function splitProdArgs(argv) {
  const [command = '', ...rest] = argv;
  const kept = [];
  const values = {};
  let target = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const name = a.startsWith('--') ? (eq > 0 ? a.slice(2, eq) : a.slice(2)) : null;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    const takeValue = () => {
      if (inline !== undefined) return inline;
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`--${name} needs a value`);
      i += 1;
      return next;
    };
    if (name === 'i-mean-production') {
      values['i-mean-production'] = true;
    } else if (name === 'confirm-prod' || name === 'prod-mode-rehearsal-suffix') {
      values[name] = takeValue();
    } else if (name === 'target') {
      target = takeValue();
      kept.push('--target', target);
    } else {
      kept.push(a);
    }
  }
  const gateFlagGiven = GATE_FLAGS.some((f) => values[f] !== undefined);
  const isProd = target !== null && /^prod(:|$)/.test(target);
  if (!isProd) {
    if (gateFlagGiven) throw new Error('--i-mean-production, --confirm-prod and --prod-mode-rehearsal-suffix only apply together with --target prod:<liveTag>');
    return { prod: false, cliArgv: [command, ...kept] };
  }
  if (!PROD_COMMANDS.includes(command)) {
    throw new Error(`--target prod runs ${PROD_COMMANDS.join(' | ')} only; "${command}" is dev tooling (production backups: scripts/prodBackup.mjs)`);
  }
  if (kept.includes('--memory')) throw new Error('--memory is not available in production mode');
  const apply = kept.includes('--apply');
  const liveTag = target.includes(':') ? target.slice(target.indexOf(':') + 1) : '';
  if (command !== 'pitr-restore' && !liveTag.trim()) throw new Error('--target prod:<liveTag> needs the live tag typed by the owner');
  const cliArgv = [command];
  for (let i = 0; i < kept.length; i++) {
    if (kept[i] === '--target') {
      if (command !== 'pitr-restore') cliArgv.push('--target', `live:${liveTag}`);
      i += 1;
    } else cliArgv.push(kept[i]);
  }
  // The engine's `run` applies unless told not to; production plans by default and applies only on --apply.
  if (command === 'run' && !apply) cliArgv.push('--no-apply');
  return {
    prod: true,
    command,
    liveTag: liveTag || null,
    values: { ...values, target: 'prod', apply },
    cliArgv,
    // A dry run of the per-file commands reads only (no backup demanded); their --apply writes and needs the fresh backups.
    readOnly: READ_ONLY.includes(command) || (DRY_IS_READ_ONLY.includes(command) && !apply),
    stopAfterPlan: NEEDS_APPLY_TO_ACT.includes(command) && !apply,
    synthetic: kept.includes('--synthetic'),
  };
}
