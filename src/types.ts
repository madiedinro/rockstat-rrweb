import type { eventWithTime } from '@rrweb/types';

export type { eventWithTime };

/**
 * Строка таблицы `stats.rrweb` (ClickHouse, `FORMAT JSONEachRow`).
 * Числа UInt64 приходят строками, остальные — числами; парсер принимает оба варианта.
 * Лишние колонки не мешают — они попадут в `Recording.meta`.
 */
export interface RrwebRow {
  uid: string | number;
  /** `rec_start` — начало записи страницы, `rec_batch` — пачка событий. */
  name?: string;
  /** Серверное время приёма строки, мс. */
  timestamp?: string | number;
  /** Порядковый номер батча внутри записи (сбрасывается при новой записи). */
  data_seq?: string | number;
  /** Номер части батча (батч режется на куски ~40 000 символов). */
  data_part?: string | number;
  /** Сколько всего частей в батче. */
  data_of?: string | number;
  data_packed?: string | number;
  /** Кусок JSON-массива упакованных (zlib + latin1) событий rrweb. */
  data_d?: string;
  sess_start?: string | number;
  sess_num?: string | number;
  sess_pageNum?: string | number;
  page_url?: string;
  page_title?: string;
  browser_w?: string | number;
  browser_h?: string | number;
  [column: string]: unknown;
}

/** Сводка по одной странице (одному вызову `rrweb.record`). */
export interface Recording {
  /** Стабильный идентификатор: `uid:sess_start:sess_pageNum:epoch`. */
  id: string;
  uid: string;
  /** Порядковый номер в списке записей пользователя (по времени). */
  index: number;
  pageUrl: string;
  pageTitle: string;
  /** Время первого события (клиентские часы), мс. */
  startTime: number;
  /** Время последнего события, мс. */
  endTime: number;
  /** Длительность, мс. */
  duration: number;
  /** Размер viewport из Meta-события или из `browser_w/h`. */
  width: number;
  height: number;
  /** События в порядке времени, готовые для `rrweb.Replayer`. */
  events: eventWithTime[];
  /** false, если нет ни одного FullSnapshot — воспроизвести нечего. */
  playable: boolean;
  warnings: string[];
  stats: RecordingStats;
  /** Полезные колонки из `rec_start` (браузер, ОС, гео, ip...). */
  meta: RecordingMeta;
}

export interface RecordingStats {
  /** Сколько батчей (уникальных `data_seq`) пришло. */
  batches: number;
  /** Сколько частей батчей потеряно при доставке. */
  lostParts: number;
  /** Сколько событий не удалось распаковать. */
  decodeErrors: number;
  events: number;
  clicks: number;
  /** Число FullSnapshot (checkout'ов) — точки, к которым можно безопасно перематывать. */
  snapshots: number;
}

export interface RecordingMeta {
  /** Серверное время `rec_start`, мс. */
  serverTime?: number;
  sessStart?: number;
  sessNum?: number;
  pageNum?: number;
  browser?: string;
  os?: string;
  device?: string;
  country?: string;
  city?: string;
  ip?: string;
  userId?: string;
  locale?: string;
  userAgent?: string;
  /** Все остальные колонки строки `rec_start` как есть. */
  raw: Record<string, unknown>;
}

/** Строка из `ClickHouseSource.listUids()`. */
export interface UidSummary {
  uid: string;
  rows: number;
  recordings: number;
  firstSeen: number;
  lastSeen: number;
  bytes: number;
  domain: string;
  browser: string;
  country: string;
}
