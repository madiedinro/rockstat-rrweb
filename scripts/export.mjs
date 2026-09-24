#!/usr/bin/env node
/**
 * Выгружает строки таблицы rrweb по uid в файл (JSONEachRow), который можно
 * открыть в демо кнопкой «из файла…» или скормить `parseRows()`.
 *
 *   node scripts/export.mjs <uid> [--out exports/<uid>.jsonl] [--from 2026-09-01] [--to 2026-09-30]
 *   node scripts/export.mjs --list [--limit 50]
 *
 * Подключение берётся из `.env` (CLICKHOUSE_URL=https://user:pass@host:8443/db).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = resolve(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { ClickHouseSource } = await import('../src/clickhouse.ts');
const { parseRows } = await import('../src/parse.ts');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(`--${name}`);
const VALUE_FLAGS = new Set(['--out', '--from', '--to', '--limit']);
const positional = args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1]));

const url = process.env.CLICKHOUSE_URL;
if (!url) {
  console.error('Задайте CLICKHOUSE_URL в .env (см. .env.example)');
  process.exit(1);
}
const source = new ClickHouseSource({
  url,
  user: process.env.CLICKHOUSE_USER,
  password: process.env.CLICKHOUSE_PASSWORD,
  database: process.env.CLICKHOUSE_DATABASE,
  table: process.env.CLICKHOUSE_TABLE,
  auth: 'basic',
});

if (has('list')) {
  const uids = await source.listUids({ limit: Number(flag('limit') ?? 50), from: flag('from'), to: flag('to') });
  for (const u of uids) {
    console.log(
      `${u.uid}\t${u.recordings} зап.\t${(u.bytes / 1024 / 1024).toFixed(2)} МБ\t${u.domain}\t${u.browser}\t${u.country}\t${new Date(u.lastSeen).toISOString()}`,
    );
  }
  process.exit(0);
}

const uid = positional[0];
if (!uid) {
  console.error('Укажите uid: node scripts/export.mjs <uid> [--out file] [--from date] [--to date] | --list');
  process.exit(1);
}

const rows = await source.fetchRows(uid, { from: flag('from'), to: flag('to') });
const out = resolve(root, flag('out') ?? `exports/${uid}.jsonl`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

const recs = parseRows(rows, { onWarning: (m) => (has('verbose') ? console.warn(m) : undefined) });
console.log(`uid ${uid}: строк ${rows.length}, записей ${recs.length} → ${out}`);
for (const r of recs) {
  const dur = Math.round(r.duration / 1000);
  console.log(
    `  #${r.index + 1}\t${new Date(r.startTime).toISOString()}\t${dur}s\t${r.stats.events} ev\t${r.stats.clicks} clicks\t${r.width}x${r.height}\t${r.playable ? '' : 'UNPLAYABLE '}${r.pageUrl}` +
      (r.warnings.length ? `\n\t! ${r.warnings.join('; ')}` : ''),
  );
}
