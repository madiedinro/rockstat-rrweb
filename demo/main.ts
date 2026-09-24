import { ClickHouseSource, RrwebViewer, formatDuration, type Recording, type RrwebRow } from 'rrweb-viewer';

declare const __CH_DATABASE__: string;
declare const __CH_TABLE__: string;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const uidInput = $<HTMLInputElement>('#uid');
const form = $<HTMLFormElement>('#form');
const recent = $<HTMLSelectElement>('#recent');
const datalist = $<HTMLDataListElement>('#uids');
const fileInput = $<HTMLInputElement>('#file');
const autonext = $<HTMLInputElement>('#autonext');
const status = $('#status');

// Прямой доступ (VITE_CH_URL) или прокси dev-сервера (/ch) — см. vite.demo.config.ts.
const directUrl = import.meta.env.VITE_CH_URL as string | undefined;
const source = new ClickHouseSource(
  directUrl ? { url: directUrl, table: __CH_TABLE__ } : { url: '/ch', database: __CH_DATABASE__, table: __CH_TABLE__ },
);

const viewer = new RrwebViewer('#viewer', {
  autoPlay: true,
  autoNext: autonext.checked,
  onSelect: (rec) => {
    if (rec) document.title = `${rec.pageUrl} — rrweb viewer`;
  },
});

autonext.addEventListener('change', () => viewer.setAutoNext(autonext.checked));

function setStatus(text: string, kind: 'info' | 'error' = 'info'): void {
  status.textContent = text;
  status.className = `status ${kind}`;
}

function summarize(recs: Recording[]): string {
  const playable = recs.filter((r) => r.playable).length;
  const total = recs.reduce((s, r) => s + r.duration, 0);
  const lost = recs.reduce((s, r) => s + r.stats.lostParts, 0);
  return `записей: ${recs.length} (воспроизводимых: ${playable}), суммарно ${formatDuration(total)}` + (lost ? `, потеряно частей: ${lost}` : '');
}

async function loadUid(uid: string): Promise<void> {
  uid = uid.trim();
  if (!uid) return;
  uidInput.value = uid;
  const url = new URL(location.href);
  url.searchParams.set('uid', uid);
  history.replaceState(null, '', url);
  setStatus('Загрузка…');
  const t0 = performance.now();
  try {
    const recs = await viewer.load(uid, {
      fetchRecordings: (id) => source.fetchRecordings(id, {}, { onWarning: (m) => console.warn(m) }),
    });
    setStatus(`${summarize(recs)} · ${Math.round(performance.now() - t0)} мс`);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'error');
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  void loadUid(uidInput.value);
});

recent.addEventListener('change', () => {
  if (recent.value) void loadUid(recent.value);
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  setStatus(`Читаю ${file.name}…`);
  try {
    const text = await file.text();
    const rows = parseExport(text);
    const recs = viewer.loadRows(rows);
    setStatus(`${file.name}: строк ${rows.length}, ${summarize(recs)}`);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'error');
  }
  fileInput.value = '';
});

/** Принимает JSON-массив строк, JSONEachRow/NDJSON или ответ ClickHouse `FORMAT JSON` ({data: [...]}). */
function parseExport(text: string): RrwebRow[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) return JSON.parse(trimmed) as RrwebRow[];
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as { data?: RrwebRow[] } & RrwebRow;
      if (Array.isArray(obj.data)) return obj.data;
      return [obj];
    } catch {
      /* значит, это NDJSON */
    }
  }
  return trimmed
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RrwebRow);
}

async function fillRecent(): Promise<void> {
  try {
    const uids = await source.listUids({ limit: 100 });
    for (const u of uids) {
      const label = `${u.uid} · ${u.domain || '?'} · ${u.recordings} зап. · ${(u.bytes / 1024 / 1024).toFixed(1)} МБ · ${new Date(u.lastSeen).toLocaleString()}`;
      const opt = document.createElement('option');
      opt.value = u.uid;
      opt.textContent = label;
      recent.append(opt);
      const dl = document.createElement('option');
      dl.value = u.uid;
      dl.label = label;
      datalist.append(dl);
    }
    if (!uids.length) setStatus('В таблице нет записей');
  } catch (err) {
    setStatus(`Не удалось получить список пользователей: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

void fillRecent();
const initial = new URL(location.href).searchParams.get('uid');
if (initial) void loadUid(initial);
