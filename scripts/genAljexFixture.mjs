#!/usr/bin/env node
// Generate a SYNTHETIC Aljex full-export CSV (+ oracle) into an output directory.
//   node scripts/genAljexFixture.mjs --rows 1000 --seed 1 --out /tmp/aljex-synth [--anomalies none|standard|all] [--bom] [--crlf]
// Never reads the real export. Refuses an --out inside the repo unless it is scripts/fixtures.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAljex, renderAljexCsv } from './lib/aljexFixture.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const rows = Number(opt('rows', '1000'));
const seed = Number(opt('seed', '1'));
const anomalies = opt('anomalies', 'standard');
const out = opt('out');
if (!out) {
  console.error('usage: node scripts/genAljexFixture.mjs --rows N --seed N --out <dir> [--anomalies none|standard|all] [--bom] [--crlf]');
  process.exit(2);
}
if (!Number.isInteger(rows) || rows < 1 || rows > 200000) {
  console.error('--rows must be an integer between 1 and 200000');
  process.exit(2);
}
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dir = resolve(out);
if ((dir === repoRoot || dir.startsWith(repoRoot + '/')) && !dir.startsWith(join(repoRoot, 'scripts', 'fixtures'))) {
  console.error('refusing to write generated fixtures inside the repo (use a temp dir, or scripts/fixtures for the committed golden file)');
  process.exit(2);
}
mkdirSync(dir, { recursive: true });
const result = generateAljex({ rows, seed, anomalies });
const base = join(dir, `aljex-synth-${rows}`);
writeFileSync(`${base}.csv`, renderAljexCsv(result, { bom: flag('bom'), crlf: flag('crlf') }));
writeFileSync(`${base}.expected.json`, JSON.stringify(result.oracle, null, 2) + '\n');
console.log(`wrote ${base}.csv (${result.rows.length} rows, ${result.headers.length} columns) and ${base}.expected.json`);
