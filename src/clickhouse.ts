import { parseRows, type ParseOptions } from './parse.ts';
import type { Recording, RrwebRow, UidSummary } from './types.ts';

export interface ClickHouseSourceOptions {
  /**
   * Адрес HTTP-интерфейса ClickHouse: `https://host:8443` или путь прокси вроде `/ch`.
   * Логин и пароль можно передать прямо в URL: `https://user:pass@host:8443`.
   */
  url: string;
  /** База данных (по умолчанию `stats`; берётся из пути URL, если он есть). */
  database?: string;
  /** Таблица (по умолчанию `rrweb`). */
  table?: string;
  user?: string;
  password?: string;
  /**
   * Как передавать логин/пароль: `url` — параметрами запроса (не требует preflight в браузере),
   * `header` — заголовками `X-ClickHouse-User/Key`, `basic` — `Authorization: Basic`.
   * По умолчанию `url`.
   */
  auth?: 'url' | 'header' | 'basic';
  /** Дополнительные заголовки (например, для прокси). */
  headers?: Record<string, string>;
  /** Дополнительные настройки ClickHouse, уходят параметрами запроса. */
  settings?: Record<string, string | number>;
  /** Своя реализация fetch (Node < 18, тесты). */
  fetch?: typeof fetch;
  /** Какие колонки выбирать вместе с данными. */
  columns?: string[];
}

export interface FetchRowsOptions {
  /** Ограничить период по колонке `date` (снижает объём чтения — таблица партиционирована по дате). */
  from?: Date | number | string;
  to?: Date | number | string;
  projectId?: number;
  /** Максимум строк (по умолчанию без ограничения). */
  limit?: number;
}

export interface ListUidsOptions {
  from?: Date | number | string;
  to?: Date | number | string;
  projectId?: number;
  limit?: number;
  /** Подстрока домена или uid для фильтра. */
  search?: string;
}

/** Колонки, которые нужны парсеру и карточке записи. */
export const DEFAULT_COLUMNS = [
  'uid',
  'id',
  'timestamp',
  'name',
  'data_seq',
  'data_part',
  'data_of',
  'data_packed',
  'data_d',
  'sess_start',
  'sess_num',
  'sess_pageNum',
  'page_url',
  'page_title',
  'page_domain',
  'browser_w',
  'browser_h',
  'uap_browser_name',
  'uap_browser_version',
  'uap_os_name',
  'uap_os_version',
  'uap_device_type',
  'uap_device_vendor',
  'uap_device_model',
  'mmgeo_country_iso',
  'mmgeo_city_en',
  'td_ip',
  'td_ua',
  'user_id',
  'user_locale',
];

function toDateString(v: Date | number | string): string {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`Некорректная дата: ${String(v)}`);
  return d.toISOString().slice(0, 10);
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) throw new Error(`Недопустимый идентификатор: ${name}`);
  return name
    .split('.')
    .map((p) => `\`${p}\``)
    .join('.');
}

/**
 * Источник данных: ходит в HTTP-интерфейс ClickHouse и достаёт строки таблицы `rrweb` по uid.
 * Работает и в браузере, и в Node.
 */
export class ClickHouseSource {
  readonly baseUrl: string;
  readonly database: string;
  readonly table: string;
  private readonly user?: string;
  private readonly password?: string;
  private readonly authMode: 'url' | 'header' | 'basic';
  private readonly headers: Record<string, string>;
  private readonly settings: Record<string, string | number>;
  private readonly fetchImpl: typeof fetch;
  private readonly columns: string[];

  constructor(opts: ClickHouseSourceOptions) {
    let url = opts.url;
    let user = opts.user;
    let password = opts.password;
    let database = opts.database;
    if (/^https?:\/\//.test(url)) {
      const u = new URL(url);
      if (u.username) user ??= decodeURIComponent(u.username);
      if (u.password) password ??= decodeURIComponent(u.password);
      const path = u.pathname.replace(/^\/|\/$/g, '');
      if (path && !database) database = path;
      u.username = '';
      u.password = '';
      u.pathname = '/';
      u.search = '';
      url = u.toString().replace(/\/$/, '');
    }
    this.baseUrl = url.replace(/\/$/, '');
    this.database = database ?? 'stats';
    this.table = opts.table ?? 'rrweb';
    this.user = user;
    this.password = password;
    this.authMode = opts.auth ?? 'url';
    this.headers = opts.headers ?? {};
    this.settings = opts.settings ?? {};
    // bind — иначе в браузере «Illegal invocation» при вызове fetch без контекста window.
    this.fetchImpl = (opts.fetch ?? globalThis.fetch)?.bind(globalThis);
    this.columns = opts.columns ?? DEFAULT_COLUMNS;
    if (!this.fetchImpl) throw new Error('fetch недоступен — передайте его в options.fetch');
  }

  get tableRef(): string {
    return `${quoteIdent(this.database)}.${quoteIdent(this.table)}`;
  }

  /** Выполняет произвольный запрос, результат — массив объектов (`FORMAT JSONEachRow`). */
  async query<T = Record<string, unknown>>(sql: string, params: Record<string, string | number> = {}): Promise<T[]> {
    const search = new URLSearchParams();
    search.set('database', this.database);
    search.set('default_format', 'JSONEachRow');
    search.set('add_http_cors_header', '1');
    search.set('output_format_json_quote_64bit_integers', '1');
    for (const [k, v] of Object.entries(this.settings)) search.set(k, String(v));
    for (const [k, v] of Object.entries(params)) search.set(`param_${k}`, String(v));

    const headers: Record<string, string> = { ...this.headers };
    if (this.user !== undefined) {
      if (this.authMode === 'url') {
        search.set('user', this.user);
        if (this.password !== undefined) search.set('password', this.password);
      } else if (this.authMode === 'header') {
        headers['X-ClickHouse-User'] = this.user;
        if (this.password !== undefined) headers['X-ClickHouse-Key'] = this.password;
      } else {
        headers.Authorization = `Basic ${btoa(`${this.user}:${this.password ?? ''}`)}`;
      }
    }

    const res = await this.fetchImpl(`${this.baseUrl}/?${search.toString()}`, { method: 'POST', body: sql, headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`ClickHouse HTTP ${res.status}: ${text.slice(0, 500)}`);
    const out: T[] = [];
    for (const line of text.split('\n')) {
      if (line.trim()) out.push(JSON.parse(line) as T);
    }
    return out;
  }

  /** Сырые строки таблицы по одному пользователю, в порядке приёма. */
  async fetchRows(uid: string | number, opts: FetchRowsOptions = {}): Promise<RrwebRow[]> {
    const where = ['uid = {uid:UInt64}'];
    const params: Record<string, string | number> = { uid: String(uid) };
    if (opts.from !== undefined) {
      where.push('date >= {from:Date}');
      params.from = toDateString(opts.from);
    }
    if (opts.to !== undefined) {
      where.push('date <= {to:Date}');
      params.to = toDateString(opts.to);
    }
    if (opts.projectId !== undefined) {
      where.push('projectId = {projectId:UInt32}');
      params.projectId = opts.projectId;
    }
    const sql =
      `SELECT ${this.columns.map(quoteIdent).join(', ')} FROM ${this.tableRef}` +
      ` WHERE ${where.join(' AND ')} ORDER BY timestamp, data_seq, data_part` +
      (opts.limit ? ` LIMIT ${Math.floor(opts.limit)}` : '');
    return this.query<RrwebRow>(sql, params);
  }

  /** Строки → записи. */
  async fetchRecordings(uid: string | number, opts: FetchRowsOptions = {}, parse: ParseOptions = {}): Promise<Recording[]> {
    return parseRows(await this.fetchRows(uid, opts), parse);
  }

  /** Список пользователей с записями, последние — первыми. Удобно для выбора uid в интерфейсе. */
  async listUids(opts: ListUidsOptions = {}): Promise<UidSummary[]> {
    const where: string[] = ['1'];
    const params: Record<string, string | number> = {};
    if (opts.from !== undefined) {
      where.push('date >= {from:Date}');
      params.from = toDateString(opts.from);
    }
    if (opts.to !== undefined) {
      where.push('date <= {to:Date}');
      params.to = toDateString(opts.to);
    }
    if (opts.projectId !== undefined) {
      where.push('projectId = {projectId:UInt32}');
      params.projectId = opts.projectId;
    }
    if (opts.search) {
      where.push("(positionCaseInsensitive(page_domain, {search:String}) > 0 OR startsWith(toString(uid), {search:String}))");
      params.search = opts.search;
    }
    const sql =
      `SELECT toString(uid) AS uid, count() AS rows, countIf(name = 'rec_start') AS recordings,` +
      ` min(timestamp) AS firstSeen, max(timestamp) AS lastSeen, sum(length(data_d)) AS bytes,` +
      ` anyLast(page_domain) AS domain, anyLast(uap_browser_name) AS browser, anyLast(mmgeo_country_iso) AS country` +
      ` FROM ${this.tableRef} WHERE ${where.join(' AND ')} GROUP BY uid HAVING bytes > 0` +
      ` ORDER BY lastSeen DESC LIMIT ${Math.floor(opts.limit ?? 100)}`;
    const rows = await this.query<Record<string, string | number>>(sql, params);
    return rows.map((r) => ({
      uid: String(r.uid),
      rows: Number(r.rows),
      recordings: Number(r.recordings),
      firstSeen: Number(r.firstSeen),
      lastSeen: Number(r.lastSeen),
      bytes: Number(r.bytes),
      domain: String(r.domain ?? ''),
      browser: String(r.browser ?? ''),
      country: String(r.country ?? ''),
    }));
  }
}
