import type { eventWithTime, Recording, RecordingMeta, RrwebRow } from './types.ts';
import { extractStrings, unpackEvent } from './unpack.ts';

export interface ParseOptions {
  /** Куда писать предупреждения (по умолчанию — никуда). */
  onWarning?: (message: string, context?: unknown) => void;
  /** Отбрасывать события до первого FullSnapshot (по умолчанию true — rrweb без снимка их не применит). */
  dropBeforeSnapshot?: boolean;
}

const EVENT_META = 4;
const EVENT_FULL_SNAPSHOT = 2;
const EVENT_INCREMENTAL = 3;
const SOURCE_MOUSE_INTERACTION = 2;
const MOUSE_CLICK = 2;

interface NormRow {
  uid: string;
  name: 'rec_start' | 'rec_batch';
  timestamp: number;
  seq: number;
  part: number;
  of: number;
  data: string;
  sessStart: string;
  pageNum: string;
  raw: RrwebRow;
}

function num(v: unknown, fallback = 0): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

function normalize(row: RrwebRow): NormRow | null {
  const data = typeof row.data_d === 'string' ? row.data_d : '';
  let name = str(row.name);
  if (name !== 'rec_start' && name !== 'rec_batch') name = data ? 'rec_batch' : 'rec_start';
  if (name === 'rec_batch' && !data) return null;
  return {
    uid: str(row.uid),
    name: name as NormRow['name'],
    timestamp: num(row.timestamp),
    seq: num(row.data_seq),
    part: num(row.data_part),
    of: Math.max(1, num(row.data_of, 1)),
    data,
    sessStart: str(row.sess_start),
    pageNum: str(row.sess_pageNum),
    raw: row,
  };
}

/**
 * Разбивает батчи одной страницы на «эпохи»: если `(seq, part)` встречается повторно,
 * значит на этой же странице rrweb запустили заново (новая запись).
 * Опоздавшие части предыдущей эпохи возвращаются в неё.
 */
function splitEpochs(batches: NormRow[]): NormRow[][] {
  const epochs: NormRow[][] = [];
  let seen = new Set<string>();
  let cur: NormRow[] = [];
  let maxSeq = -1;
  for (const b of batches) {
    const key = `${b.seq}:${b.part}`;
    const prev = epochs[epochs.length - 1];
    if (prev && b.seq > maxSeq + 2 && !seen.has(key)) {
      // Явно опоздавшая часть старой записи.
      prev.push(b);
      continue;
    }
    if (seen.has(key)) {
      epochs.push(cur);
      cur = [];
      seen = new Set();
      maxSeq = -1;
    }
    seen.add(key);
    cur.push(b);
    if (b.seq > maxSeq) maxSeq = b.seq;
  }
  if (cur.length) epochs.push(cur);
  return epochs;
}

interface Assembled {
  strings: string[];
  lostParts: number;
}

/** Склеивает части батча. Если части потеряны — достаёт всё, что можно, из оставшихся. */
function assembleBatch(parts: NormRow[]): Assembled {
  const byPart = new Map<number, string>();
  let of = 1;
  for (const p of parts) {
    if (!byPart.has(p.part)) byPart.set(p.part, p.data);
    if (p.of > of) of = p.of;
  }
  const present = [...byPart.keys()].sort((a, b) => a - b);
  const lostParts = Math.max(0, of - present.length);

  if (lostParts === 0) {
    const text = present.map((i) => byPart.get(i)!).join('');
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) return { strings: arr.filter((s) => typeof s === 'string'), lostParts };
    } catch {
      /* падаем в режим восстановления */
    }
    return { strings: extractStrings(text, true), lostParts };
  }

  // Части потеряны: обрабатываем непрерывные отрезки по отдельности.
  const strings: string[] = [];
  let run: number[] = [];
  const flush = () => {
    if (!run.length) return;
    const text = run.map((i) => byPart.get(i)!).join('');
    strings.push(...extractStrings(text, run[0] === 0));
    run = [];
  };
  for (const i of present) {
    if (run.length && i !== run[run.length - 1] + 1) flush();
    run.push(i);
  }
  flush();
  return { strings, lostParts };
}

function buildMeta(row: RrwebRow | undefined): RecordingMeta {
  const raw: Record<string, unknown> = {};
  if (!row) return { raw };
  for (const [k, v] of Object.entries(row)) if (k !== 'data_d') raw[k] = v;
  const join = (...xs: unknown[]) => xs.map(str).filter(Boolean).join(' ');
  return {
    serverTime: num(row.timestamp) || undefined,
    sessStart: num(row.sess_start) || undefined,
    sessNum: num(row.sess_num) || undefined,
    pageNum: num(row.sess_pageNum) || undefined,
    browser: join(row.uap_browser_name ?? row.uapc_browser_family, row.uap_browser_version ?? row.uapc_browser_version) || undefined,
    os: join(row.uap_os_name ?? row.uapc_os_family, row.uap_os_version ?? row.uapc_os_version) || undefined,
    device: join(row.uap_device_type, row.uap_device_vendor ?? row.uapc_device_brand, row.uap_device_model ?? row.uapc_device_family) || undefined,
    country: str(row.mmgeo_country_iso ?? row.ip2lgeo_country_iso) || undefined,
    city: str(row.mmgeo_city_en ?? row.ip2lgeo_city_en) || undefined,
    ip: str(row.td_ip) || undefined,
    userId: str(row.user_id) || undefined,
    locale: str(row.user_locale) || undefined,
    userAgent: str(row.td_ua) || undefined,
    raw,
  };
}

function buildRecording(
  id: string,
  uid: string,
  batches: NormRow[],
  metaRow: RrwebRow | undefined,
  opts: ParseOptions,
): Recording | null {
  const warn = opts.onWarning ?? (() => {});
  const bySeq = new Map<number, NormRow[]>();
  for (const b of batches) {
    let arr = bySeq.get(b.seq);
    if (!arr) bySeq.set(b.seq, (arr = []));
    arr.push(b);
  }

  const events: eventWithTime[] = [];
  let lostParts = 0;
  let decodeErrors = 0;
  for (const seq of [...bySeq.keys()].sort((a, b) => a - b)) {
    const { strings, lostParts: lost } = assembleBatch(bySeq.get(seq)!);
    lostParts += lost;
    if (lost) warn(`Запись ${id}: батч ${seq} — потеряно частей: ${lost}, восстановлено событий: ${strings.length}`);
    for (const s of strings) {
      try {
        const e = unpackEvent(s);
        if (e && typeof e.timestamp === 'number' && typeof e.type === 'number') events.push(e);
        else decodeErrors++;
      } catch (err) {
        decodeErrors++;
        warn(`Запись ${id}: батч ${seq} — не удалось распаковать событие`, err);
      }
    }
  }
  if (!events.length) return null;

  // Стабильная сортировка по времени (rrweb всё равно сортирует, но нам нужны start/end).
  events.sort((a, b) => a.timestamp - b.timestamp);

  const warnings: string[] = [];
  const firstSnap = events.findIndex((e) => e.type === EVENT_FULL_SNAPSHOT);
  let playable = firstSnap >= 0;
  let list = events;
  if (!playable) {
    warnings.push('Нет FullSnapshot — воспроизведение невозможно (потерян первый батч)');
  } else if (opts.dropBeforeSnapshot !== false && firstSnap > 0) {
    const dropped = events.slice(0, firstSnap).filter((e) => e.type !== EVENT_META);
    if (dropped.length) warnings.push(`Отброшено событий до первого снимка: ${dropped.length}`);
    list = [...events.slice(0, firstSnap).filter((e) => e.type === EVENT_META), ...events.slice(firstSnap)];
  }

  const metaRaw = metaRow ?? batches[0].raw;
  const meta = buildMeta(metaRaw);
  const firstMeta = list.find((e) => e.type === EVENT_META) as
    | (eventWithTime & { data: { href?: string; width?: number; height?: number } })
    | undefined;
  let width = num(firstMeta?.data.width) || num(metaRaw.browser_w);
  let height = num(firstMeta?.data.height) || num(metaRaw.browser_h);
  const pageUrl = str(metaRaw.page_url) || firstMeta?.data.href || '';

  if (playable && (!firstMeta || list[0].type !== EVENT_META)) {
    // Meta потеряна или пришла позже снимка — синтезируем, иначе iframe плеера будет нулевого размера.
    if (!width || !height) {
      width = width || 1280;
      height = height || 720;
    }
    const synthetic = {
      type: EVENT_META,
      data: { href: pageUrl, width, height },
      timestamp: list[0].timestamp,
    } as eventWithTime;
    list = [synthetic, ...list];
    warnings.push('Meta-событие восстановлено из колонок browser_w/browser_h');
  }

  if (lostParts) warnings.push(`Потеряно частей батчей: ${lostParts}`);
  if (decodeErrors) warnings.push(`Не распаковано событий: ${decodeErrors}`);

  const startTime = list[0].timestamp;
  const endTime = list[list.length - 1].timestamp;
  const clicks = list.filter(
    (e) =>
      e.type === EVENT_INCREMENTAL &&
      (e.data as { source?: number }).source === SOURCE_MOUSE_INTERACTION &&
      (e.data as { type?: number }).type === MOUSE_CLICK,
  ).length;

  return {
    id,
    uid,
    index: 0,
    pageUrl,
    pageTitle: str(metaRaw.page_title),
    startTime,
    endTime,
    duration: endTime - startTime,
    width,
    height,
    events: list,
    playable,
    warnings,
    stats: {
      batches: bySeq.size,
      lostParts,
      decodeErrors,
      events: list.length,
      clicks,
      snapshots: list.filter((e) => e.type === EVENT_FULL_SNAPSHOT).length,
    },
    meta,
  };
}

/**
 * Превращает строки таблицы `rrweb` (любых пользователей) в список записей,
 * готовых к воспроизведению. Записи отсортированы по времени начала.
 */
export function parseRows(rows: RrwebRow[], opts: ParseOptions = {}): Recording[] {
  const groups = new Map<string, { uid: string; key: string; starts: NormRow[]; batches: NormRow[] }>();
  for (const raw of rows) {
    const row = normalize(raw);
    if (!row) continue;
    const key = `${row.uid}:${row.sessStart}:${row.pageNum}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { uid: row.uid, key, starts: [], batches: [] }));
    (row.name === 'rec_start' ? g.starts : g.batches).push(row);
  }

  const recordings: Recording[] = [];
  for (const g of groups.values()) {
    const byTime = (a: NormRow, b: NormRow) => a.timestamp - b.timestamp || a.seq - b.seq || a.part - b.part;
    g.starts.sort(byTime);
    g.batches.sort(byTime);
    const epochs = splitEpochs(g.batches);
    epochs.forEach((batches, epoch) => {
      // Ближайший rec_start, отправленный не позже первого батча эпохи.
      const firstTs = batches[0].timestamp;
      const start = [...g.starts].reverse().find((s) => s.timestamp <= firstTs + 1000) ?? g.starts[0];
      const rec = buildRecording(`${g.key}:${epoch}`, g.uid, batches, start?.raw, opts);
      if (rec) recordings.push(rec);
    });
  }

  recordings.sort((a, b) => a.startTime - b.startTime);
  recordings.forEach((r, i) => (r.index = i));
  return recordings;
}

/** Группирует записи по uid — удобно, если в выборке несколько пользователей. */
export function groupByUid(recordings: Recording[]): Map<string, Recording[]> {
  const out = new Map<string, Recording[]>();
  for (const r of recordings) {
    let arr = out.get(r.uid);
    if (!arr) out.set(r.uid, (arr = []));
    arr.push(r);
  }
  return out;
}
