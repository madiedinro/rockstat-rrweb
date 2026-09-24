import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strFromU8, strToU8, zlibSync } from 'fflate';
import { parseRows } from '../src/parse.ts';
import { extractStrings, unpackEvent } from '../src/unpack.ts';
import type { RrwebRow } from '../src/types.ts';

/** Упаковка как в `@rrweb/packer`: zlib + latin1-строка + маркер версии внутри JSON. */
function pack(event: object): string {
  return strFromU8(zlibSync(strToU8(JSON.stringify({ ...event, v: 'v1' }))), true);
}

const T0 = 1_790_000_000_000;
const meta = (ts = T0) => ({ type: 4, data: { href: 'https://example.com/', width: 1280, height: 720 }, timestamp: ts });
const snapshot = (ts = T0 + 10) => ({ type: 2, data: { node: { type: 0, childNodes: [], id: 1 }, initialOffset: { top: 0, left: 0 } }, timestamp: ts });
const click = (ts: number) => ({ type: 3, data: { source: 2, type: 2, id: 1, x: 1, y: 1 }, timestamp: ts });
const move = (ts: number) => ({ type: 3, data: { source: 1, positions: [], }, timestamp: ts });

let rowId = 0;
function batch(seq: number, events: object[], opts: { partSize?: number; ts?: number; sessStart?: string; pageNum?: number } = {}): RrwebRow[] {
  const text = JSON.stringify(events.map(pack));
  const size = opts.partSize ?? 40_000;
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts.map((data_d, part) => ({
    uid: '42',
    id: String(++rowId),
    name: 'rec_batch',
    timestamp: (opts.ts ?? T0 + seq * 5000) + part,
    data_seq: seq,
    data_part: part,
    data_of: parts.length,
    data_packed: 0,
    data_d,
    sess_start: opts.sessStart ?? '100',
    sess_pageNum: opts.pageNum ?? 1,
    page_url: 'https://example.com/',
    browser_w: 1280,
    browser_h: 720,
  }));
}

function start(opts: { ts?: number; sessStart?: string; pageNum?: number } = {}): RrwebRow {
  return {
    uid: '42',
    id: String(++rowId),
    name: 'rec_start',
    timestamp: opts.ts ?? T0 - 100,
    data_seq: 0,
    data_part: 0,
    data_of: 0,
    data_packed: 1,
    data_d: '',
    sess_start: opts.sessStart ?? '100',
    sess_pageNum: opts.pageNum ?? 1,
    page_url: 'https://example.com/',
    page_title: 'Example',
    browser_w: 1280,
    browser_h: 720,
    uap_browser_name: 'Chrome',
    uap_browser_version: '153',
    mmgeo_country_iso: 'LV',
  };
}

test('unpackEvent распаковывает формат rrweb packer и обычный JSON', () => {
  const e = unpackEvent(pack(click(T0 + 1)));
  assert.equal(e.type, 3);
  assert.equal(e.timestamp, T0 + 1);
  assert.equal((e as { v?: string }).v, undefined);
  assert.equal(unpackEvent(JSON.stringify(click(T0 + 2))).timestamp, T0 + 2);
});

test('extractStrings достаёт целые строки из обрезанного массива', () => {
  const full = JSON.stringify(['aaa', 'b"b\\', 'ccc', 'ddd']);
  assert.deepEqual(extractStrings(full, true), ['aaa', 'b"b\\', 'ccc', 'ddd']);
  // потерян хвост
  assert.deepEqual(extractStrings(full.slice(0, full.indexOf('"ccc"') + 3), true), ['aaa', 'b"b\\']);
  // потеряно начало
  assert.deepEqual(extractStrings(full.slice(5), false), ['b"b\\', 'ccc', 'ddd']);
});

test('parseRows собирает запись из батчей и частей', () => {
  const big = Array.from({ length: 300 }, (_, i) => move(T0 + 20 + i));
  const rows = [
    start(),
    ...batch(0, [meta(), snapshot(), ...big], { partSize: 3000 }),
    ...batch(1, [click(T0 + 5000), move(T0 + 5100)]),
    ...batch(2, [click(T0 + 10_000)]),
  ];
  assert.ok(rows.length > 5, 'батч 0 должен быть порезан на части');
  const recs = parseRows(rows);
  assert.equal(recs.length, 1);
  const r = recs[0];
  assert.equal(r.playable, true);
  assert.equal(r.events.length, 2 + 300 + 3);
  assert.equal(r.events[0].type, 4);
  assert.equal(r.events[1].type, 2);
  assert.equal(r.stats.clicks, 2);
  assert.equal(r.stats.batches, 3);
  assert.equal(r.stats.lostParts, 0);
  assert.equal(r.startTime, T0);
  assert.equal(r.endTime, T0 + 10_000);
  assert.equal(r.width, 1280);
  assert.equal(r.meta.browser, 'Chrome 153');
  assert.equal(r.meta.country, 'LV');
  assert.equal(r.pageTitle, 'Example');
});

test('parseRows восстанавливает события при потере части батча', () => {
  const many = Array.from({ length: 200 }, (_, i) => click(T0 + 1000 + i));
  const b1 = batch(1, many, { partSize: 2500 });
  assert.ok(b1.length >= 3);
  const lost = b1.filter((row) => row.data_part !== 1); // теряем среднюю часть
  const rows = [start(), ...batch(0, [meta(), snapshot()]), ...lost];
  const recs = parseRows(rows);
  assert.equal(recs.length, 1);
  const r = recs[0];
  assert.equal(r.stats.lostParts, 1);
  assert.ok(r.stats.clicks > 100 && r.stats.clicks < 200, `восстановлено кликов: ${r.stats.clicks}`);
  assert.ok(r.warnings.some((w) => w.includes('Потеряно')));
});

test('parseRows: без снимка запись невоспроизводима, без Meta — синтезирует её', () => {
  const noSnap = parseRows([start(), ...batch(1, [click(T0 + 5000)])]);
  assert.equal(noSnap.length, 1);
  assert.equal(noSnap[0].playable, false);

  const noMeta = parseRows([start(), ...batch(0, [snapshot(), click(T0 + 50)])]);
  assert.equal(noMeta[0].playable, true);
  assert.equal(noMeta[0].events[0].type, 4);
  assert.equal(noMeta[0].width, 1280);
});

test('parseRows разделяет страницы и повторные запуски записи', () => {
  const rows = [
    start({ sessStart: '100', pageNum: 1 }),
    ...batch(0, [meta(), snapshot(), click(T0 + 100)]),
    start({ sessStart: '100', pageNum: 2, ts: T0 + 60_000 }),
    ...batch(0, [meta(T0 + 60_000), snapshot(T0 + 60_010)], { pageNum: 2, ts: T0 + 60_100 }),
    // тот же pageNum, но seq снова 0 → новая эпоха
    ...batch(0, [meta(T0 + 120_000), snapshot(T0 + 120_010), click(T0 + 120_020)], { pageNum: 2, ts: T0 + 120_100 }),
  ];
  const recs = parseRows(rows);
  assert.equal(recs.length, 3);
  assert.deepEqual(
    recs.map((r) => r.startTime),
    [T0, T0 + 60_000, T0 + 120_000],
  );
  assert.deepEqual(
    recs.map((r) => r.index),
    [0, 1, 2],
  );
});

test('parseRows принимает числовые колонки строками (JSONEachRow)', () => {
  const rows = batch(0, [meta(), snapshot()]).map((r) => ({ ...r, uid: 42, timestamp: String(r.timestamp), data_seq: '0', data_part: String(r.data_part), data_of: String(r.data_of) }));
  const recs = parseRows(rows);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].uid, '42');
  assert.equal(recs[0].playable, true);
});
