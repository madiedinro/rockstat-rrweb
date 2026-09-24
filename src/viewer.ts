import { Replayer } from 'rrweb';
import { parseRows, type ParseOptions } from './parse.ts';
import type { Recording, RrwebRow } from './types.ts';

export type ViewerState = 'empty' | 'loading' | 'paused' | 'playing' | 'finished';

export interface RecordingSource {
  fetchRecordings(uid: string | number): Promise<Recording[]>;
}

export interface ViewerOptions {
  /** Скорость по умолчанию. */
  speed?: number;
  /** Варианты скорости в селекте. */
  speeds?: number[];
  /** Пропускать паузы без активности пользователя. */
  skipInactive?: boolean;
  /** Запускать воспроизведение сразу после выбора записи. */
  autoPlay?: boolean;
  /** По окончании записи переходить к следующей. */
  autoNext?: boolean;
  /** Показывать список записей слева. */
  showList?: boolean;
  /** Показывать панель с информацией о записи. */
  showInfo?: boolean;
  /** «Хвост» за курсором. */
  mouseTail?: boolean;
  /** Пауза (мс) между действиями пользователя, которая считается бездействием. */
  inactiveThreshold?: number;
  locale?: 'ru' | 'en';
  /** Настройки парсера для `loadRows()`. */
  parse?: ParseOptions;
  onSelect?: (recording: Recording | null, index: number) => void;
  onStateChange?: (state: ViewerState) => void;
}

const I18N = {
  ru: {
    recordings: 'Записи',
    noRecordings: 'Нет записей',
    loading: 'Загрузка…',
    play: 'Играть',
    pause: 'Пауза',
    speed: 'Скорость',
    skipInactive: 'Пропускать паузы',
    fullscreen: 'На весь экран',
    events: 'событий',
    clicks: 'кликов',
    unplayable: 'нет снимка страницы',
    skipping: 'пропуск бездействия',
    lost: 'потери',
    selectHint: 'Выберите запись слева',
    warnings: 'Предупреждения',
    page: 'Страница',
    started: 'Начало',
    browser: 'Браузер',
    device: 'Устройство',
    geo: 'Гео',
    viewport: 'Экран',
    user: 'Пользователь',
  },
  en: {
    recordings: 'Recordings',
    noRecordings: 'No recordings',
    loading: 'Loading…',
    play: 'Play',
    pause: 'Pause',
    speed: 'Speed',
    skipInactive: 'Skip inactive',
    fullscreen: 'Fullscreen',
    events: 'events',
    clicks: 'clicks',
    unplayable: 'no page snapshot',
    skipping: 'skipping inactivity',
    lost: 'lost',
    selectHint: 'Select a recording on the left',
    warnings: 'Warnings',
    page: 'Page',
    started: 'Started',
    browser: 'Browser',
    device: 'Device',
    geo: 'Geo',
    viewport: 'Viewport',
    user: 'User',
  },
};

const ICON_PLAY = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
const ICON_FULL =
  '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, html?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname + (u.search.length > 1 ? u.search : '');
    return path.length > 60 ? path.slice(0, 57) + '…' : path || '/';
  } catch {
    return url || '—';
  }
}

interface Marker {
  at: number;
  kind: 'click' | 'snapshot';
}

interface Span {
  from: number;
  to: number;
}

const INTERACTION_SOURCES_MIN = 1; // MouseMove
const INTERACTION_SOURCES_MAX = 5; // Input

/**
 * Плеер записей: список записей пользователя + rrweb Replayer с управлением.
 *
 * ```ts
 * const viewer = new RrwebViewer('#app');
 * viewer.loadRows(rowsFromClickHouse);
 * ```
 */
export class RrwebViewer {
  readonly root: HTMLElement;
  private readonly t: (typeof I18N)['ru'];
  private readonly opts: Required<Pick<ViewerOptions, 'speed' | 'speeds' | 'skipInactive' | 'autoPlay' | 'autoNext' | 'showList' | 'showInfo' | 'mouseTail' | 'inactiveThreshold'>> &
    ViewerOptions;

  private recordings: Recording[] = [];
  private replayer: Replayer | null = null;
  private currentIndex = -1;
  private state: ViewerState = 'empty';
  private totalTime = 0;
  private speed: number;
  private skipInactive: boolean;
  private raf = 0;
  private dragging = false;
  private destroyed = false;
  private readonly resizeObserver?: ResizeObserver;

  private readonly ui: {
    sidebar: HTMLElement;
    list: HTMLElement;
    listTitle: HTMLElement;
    main: HTMLElement;
    stage: HTMLElement;
    frame: HTMLElement;
    hint: HTMLElement;
    badge: HTMLElement;
    controls: HTMLElement;
    playBtn: HTMLButtonElement;
    time: HTMLElement;
    track: HTMLElement;
    spans: HTMLElement;
    markers: HTMLElement;
    fill: HTMLElement;
    handle: HTMLElement;
    speedSel: HTMLSelectElement;
    skipChk: HTMLInputElement;
    fullBtn: HTMLButtonElement;
    info: HTMLElement;
  };

  constructor(container: HTMLElement | string, options: ViewerOptions = {}) {
    const rootEl = typeof container === 'string' ? document.querySelector<HTMLElement>(container) : container;
    if (!rootEl) throw new Error(`RrwebViewer: контейнер не найден: ${String(container)}`);
    this.root = rootEl;
    this.opts = {
      speed: 1,
      speeds: [0.5, 1, 2, 4, 8, 16],
      skipInactive: true,
      autoPlay: false,
      autoNext: false,
      showList: true,
      showInfo: true,
      mouseTail: true,
      inactiveThreshold: 10_000,
      ...options,
    };
    this.t = I18N[this.opts.locale ?? 'ru'];
    this.speed = this.opts.speed;
    this.skipInactive = this.opts.skipInactive;

    this.root.classList.add('rrv');
    this.root.tabIndex = 0;
    this.root.innerHTML = '';

    const sidebar = el('aside', 'rrv-sidebar');
    const listTitle = el('div', 'rrv-sidebar-title', this.t.recordings);
    const list = el('div', 'rrv-list');
    sidebar.append(listTitle, list);
    if (!this.opts.showList) sidebar.hidden = true;

    const main = el('section', 'rrv-main');
    const stage = el('div', 'rrv-stage');
    const frame = el('div', 'rrv-frame');
    const hint = el('div', 'rrv-hint', this.t.selectHint);
    const badge = el('div', 'rrv-badge', this.t.skipping);
    badge.hidden = true;
    stage.append(frame, hint, badge);

    const controls = el('div', 'rrv-controls');
    const playBtn = el('button', 'rrv-btn rrv-play', ICON_PLAY);
    playBtn.type = 'button';
    playBtn.title = this.t.play;
    const time = el('div', 'rrv-time', '00:00 / 00:00');
    const track = el('div', 'rrv-track');
    const spans = el('div', 'rrv-spans');
    const markers = el('div', 'rrv-markers');
    const fill = el('div', 'rrv-fill');
    const handle = el('div', 'rrv-handle');
    track.append(spans, markers, fill, handle);
    const speedSel = el('select', 'rrv-speed');
    speedSel.title = this.t.speed;
    for (const s of this.opts.speeds) {
      const o = el('option', undefined, `${s}×`);
      o.value = String(s);
      if (s === this.speed) o.selected = true;
      speedSel.append(o);
    }
    const skipLabel = el('label', 'rrv-skip');
    const skipChk = el('input');
    skipChk.type = 'checkbox';
    skipChk.checked = this.skipInactive;
    skipLabel.append(skipChk, document.createTextNode(' ' + this.t.skipInactive));
    const fullBtn = el('button', 'rrv-btn rrv-full', ICON_FULL);
    fullBtn.type = 'button';
    fullBtn.title = this.t.fullscreen;
    controls.append(playBtn, time, track, speedSel, skipLabel, fullBtn);

    const info = el('div', 'rrv-info');
    if (!this.opts.showInfo) info.hidden = true;

    main.append(stage, controls, info);
    this.root.append(sidebar, main);

    this.ui = { sidebar, list, listTitle, main, stage, frame, hint, badge, controls, playBtn, time, track, spans, markers, fill, handle, speedSel, skipChk, fullBtn, info };

    playBtn.addEventListener('click', () => this.toggle());
    speedSel.addEventListener('change', () => this.setSpeed(Number(speedSel.value)));
    skipChk.addEventListener('change', () => this.setSkipInactive(skipChk.checked));
    fullBtn.addEventListener('click', () => this.toggleFullscreen());
    this.bindTrack();
    this.root.addEventListener('keydown', this.onKeyDown);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.fit());
      this.resizeObserver.observe(stage);
    }
    this.renderList();
    this.setControlsEnabled(false);
  }

  // ---------- публичное API ----------

  get current(): Recording | null {
    return this.recordings[this.currentIndex] ?? null;
  }

  get currentIndexValue(): number {
    return this.currentIndex;
  }

  get list(): readonly Recording[] {
    return this.recordings;
  }

  get playing(): boolean {
    return this.state === 'playing';
  }

  /** Заменяет список записей и выбирает первую воспроизводимую. */
  setRecordings(recordings: Recording[]): void {
    this.unmount();
    this.recordings = recordings;
    this.currentIndex = -1;
    this.renderList();
    const first = recordings.findIndex((r) => r.playable);
    if (first >= 0) this.select(first);
    else {
      this.setState('empty');
      this.ui.hint.textContent = recordings.length ? this.t.unplayable : this.t.noRecordings;
      this.ui.hint.hidden = false;
      this.renderInfo(null);
      this.setControlsEnabled(false);
      this.opts.onSelect?.(null, -1);
    }
  }

  /** Сырые строки таблицы → записи → в плеер. */
  loadRows(rows: RrwebRow[]): Recording[] {
    const recs = parseRows(rows, this.opts.parse);
    this.setRecordings(recs);
    return recs;
  }

  /** Загружает записи пользователя через источник (например, `ClickHouseSource`). */
  async load(uid: string | number, source: RecordingSource): Promise<Recording[]> {
    this.unmount();
    this.recordings = [];
    this.currentIndex = -1;
    this.setState('loading');
    this.ui.listTitle.textContent = this.t.loading;
    this.ui.list.innerHTML = '';
    this.ui.hint.textContent = this.t.loading;
    this.ui.hint.hidden = false;
    try {
      const recs = await source.fetchRecordings(uid);
      if (this.destroyed) return recs;
      this.setRecordings(recs);
      return recs;
    } catch (err) {
      this.renderList();
      this.setState('empty');
      this.ui.hint.textContent = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /** Выбирает запись по индексу и монтирует плеер. */
  select(index: number, autoPlay = this.opts.autoPlay): void {
    const rec = this.recordings[index];
    if (!rec) return;
    this.unmount();
    this.currentIndex = index;
    this.highlightList();
    this.renderInfo(rec);
    this.opts.onSelect?.(rec, index);
    if (!rec.playable) {
      this.ui.hint.textContent = this.t.unplayable;
      this.ui.hint.hidden = false;
      this.setControlsEnabled(false);
      this.setState('paused');
      return;
    }
    this.mount(rec, autoPlay);
  }

  play(): void {
    if (!this.replayer) return;
    if (this.state === 'finished') this.replayer.play(0);
    else this.replayer.play(this.replayer.getCurrentTime());
  }

  pause(): void {
    this.replayer?.pause();
  }

  toggle(): void {
    if (this.state === 'playing') this.pause();
    else this.play();
  }

  /** Перемотка на смещение (мс) от начала записи. */
  seek(offset: number): void {
    if (!this.replayer) return;
    const t = Math.max(0, Math.min(this.totalTime, offset));
    if (this.state === 'playing') this.replayer.play(t);
    else {
      this.replayer.pause(t);
      this.setState('paused');
    }
    this.updateProgress(t);
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.ui.speedSel.value = String(speed);
    this.replayer?.setConfig({ speed });
  }

  setSkipInactive(value: boolean): void {
    this.skipInactive = value;
    this.ui.skipChk.checked = value;
    this.replayer?.setConfig({ skipInactive: value });
  }

  /** Переходить ли к следующей записи по окончании текущей. */
  setAutoNext(value: boolean): void {
    this.opts.autoNext = value;
  }

  next(): void {
    const i = this.recordings.findIndex((r, idx) => idx > this.currentIndex && r.playable);
    if (i >= 0) this.select(i, true);
  }

  prev(): void {
    for (let i = this.currentIndex - 1; i >= 0; i--) {
      if (this.recordings[i].playable) {
        this.select(i, true);
        return;
      }
    }
  }

  toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void this.ui.main.requestFullscreen?.();
  }

  destroy(): void {
    this.destroyed = true;
    this.unmount();
    this.resizeObserver?.disconnect();
    this.root.removeEventListener('keydown', this.onKeyDown);
    this.root.classList.remove('rrv');
    this.root.innerHTML = '';
  }

  // ---------- внутреннее ----------

  private mount(rec: Recording, autoPlay: boolean): void {
    this.ui.frame.innerHTML = '';
    this.ui.hint.hidden = true;
    const replayer = new Replayer(rec.events, {
      root: this.ui.frame,
      speed: this.speed,
      skipInactive: this.skipInactive,
      inactivePeriodThreshold: this.opts.inactiveThreshold,
      mouseTail: this.opts.mouseTail,
      showWarning: false,
      showDebug: false,
      useVirtualDom: true,
      UNSAFE_replayCanvas: false,
    });
    this.replayer = replayer;
    this.totalTime = replayer.getMetaData().totalTime;

    replayer.on('resize', () => this.fit());
    replayer.on('start', () => this.setState('playing'));
    replayer.on('resume', () => this.setState('playing'));
    replayer.on('pause', () => {
      if (this.state !== 'finished') this.setState('paused');
    });
    replayer.on('finish', () => {
      this.setState('finished');
      this.updateProgress(this.totalTime);
      if (this.opts.autoNext) this.next();
    });
    replayer.on('skip-start', () => (this.ui.badge.hidden = false));
    replayer.on('skip-end', () => (this.ui.badge.hidden = true));

    this.renderTrack(rec);
    this.setControlsEnabled(true);
    replayer.pause(0);
    this.setState('paused');
    this.updateProgress(0);
    this.fit();
    if (autoPlay) replayer.play(0);
  }

  private unmount(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.replayer) {
      try {
        this.replayer.pause();
        this.replayer.destroy();
      } catch {
        /* уже уничтожен */
      }
      this.replayer = null;
    }
    this.ui.frame.innerHTML = '';
    this.ui.badge.hidden = true;
    this.totalTime = 0;
  }

  private setState(state: ViewerState): void {
    const prev = this.state;
    this.state = state;
    const playing = state === 'playing';
    this.ui.playBtn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    this.ui.playBtn.title = playing ? this.t.pause : this.t.play;
    this.root.dataset.state = state;
    if (playing) this.startTicker();
    else cancelAnimationFrame(this.raf);
    if (prev !== state) this.opts.onStateChange?.(state);
  }

  private startTicker(): void {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!this.replayer || this.state !== 'playing') return;
      if (!this.dragging) this.updateProgress(this.replayer.getCurrentTime());
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private updateProgress(t: number): void {
    const pct = this.totalTime ? Math.min(100, Math.max(0, (t / this.totalTime) * 100)) : 0;
    this.ui.fill.style.width = `${pct}%`;
    this.ui.handle.style.left = `${pct}%`;
    this.ui.time.textContent = `${formatDuration(t)} / ${formatDuration(this.totalTime)}`;
  }

  private fit(): void {
    const replayer = this.replayer;
    const rec = this.current;
    if (!replayer || !rec) return;
    const wrapper = replayer.wrapper;
    const iframe = replayer.iframe;
    const w = parseFloat(iframe.width || '') || rec.width || 1280;
    const h = parseFloat(iframe.height || '') || rec.height || 720;
    const sw = this.ui.stage.clientWidth;
    const sh = this.ui.stage.clientHeight;
    if (!sw || !sh) return;
    const scale = Math.min(sw / w, sh / h);
    wrapper.style.position = 'absolute';
    wrapper.style.left = '50%';
    wrapper.style.top = '50%';
    wrapper.style.transformOrigin = '0 0';
    wrapper.style.transform = `scale(${scale}) translate(-50%, -50%)`;
  }

  private setControlsEnabled(enabled: boolean): void {
    this.ui.controls.classList.toggle('rrv-disabled', !enabled);
    this.ui.playBtn.disabled = !enabled;
    if (!enabled) {
      this.ui.fill.style.width = '0';
      this.ui.handle.style.left = '0';
      this.ui.time.textContent = '00:00 / 00:00';
      this.ui.markers.innerHTML = '';
      this.ui.spans.innerHTML = '';
    }
  }

  private bindTrack(): void {
    const { track } = this.ui;
    const offsetFromEvent = (e: PointerEvent) => {
      const r = track.getBoundingClientRect();
      const pct = r.width ? (e.clientX - r.left) / r.width : 0;
      return Math.max(0, Math.min(1, pct)) * this.totalTime;
    };
    let wasPlaying = false;
    track.addEventListener('pointerdown', (e) => {
      if (!this.replayer) return;
      this.dragging = true;
      wasPlaying = this.state === 'playing';
      if (wasPlaying) this.replayer.pause();
      track.setPointerCapture(e.pointerId);
      this.updateProgress(offsetFromEvent(e));
    });
    track.addEventListener('pointermove', (e) => {
      if (this.dragging) this.updateProgress(offsetFromEvent(e));
    });
    const finish = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      const t = offsetFromEvent(e);
      if (!this.replayer) return;
      if (wasPlaying) this.replayer.play(t);
      else {
        this.replayer.pause(t);
        this.setState('paused');
      }
      this.updateProgress(t);
    };
    track.addEventListener('pointerup', finish);
    track.addEventListener('pointercancel', finish);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if ((e.target as HTMLElement | null)?.tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'checkbox') return;
    if (!this.replayer) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        this.toggle();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        this.seek(this.replayer.getCurrentTime() - 5000);
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.seek(this.replayer.getCurrentTime() + 5000);
        break;
      case 'n':
        this.next();
        break;
      case 'p':
        this.prev();
        break;
    }
  };

  private renderTrack(rec: Recording): void {
    const { markers, spans } = this.ui;
    markers.innerHTML = '';
    spans.innerHTML = '';
    const total = this.totalTime || 1;
    const start = rec.startTime;
    const marks: Marker[] = [];
    const inactive: Span[] = [];
    let lastInteraction = start;
    for (const e of rec.events) {
      if (e.type === 2) marks.push({ at: e.timestamp - start, kind: 'snapshot' });
      if (e.type === 3) {
        const src = (e.data as { source: number }).source;
        if ((e.data as { type?: number }).type === 2 && src === 2) marks.push({ at: e.timestamp - start, kind: 'click' });
        if (src >= INTERACTION_SOURCES_MIN && src <= INTERACTION_SOURCES_MAX) {
          if (e.timestamp - lastInteraction > this.opts.inactiveThreshold) {
            inactive.push({ from: lastInteraction - start, to: e.timestamp - start });
          }
          lastInteraction = e.timestamp;
        }
      }
    }
    if (rec.endTime - lastInteraction > this.opts.inactiveThreshold) {
      inactive.push({ from: lastInteraction - start, to: rec.endTime - start });
    }
    for (const s of inactive) {
      const d = el('div', 'rrv-span');
      d.style.left = `${(s.from / total) * 100}%`;
      d.style.width = `${((s.to - s.from) / total) * 100}%`;
      spans.append(d);
    }
    for (const m of marks) {
      const d = el('div', `rrv-marker rrv-marker-${m.kind}`);
      d.style.left = `${(m.at / total) * 100}%`;
      d.title = `${m.kind} · ${formatDuration(m.at)}`;
      markers.append(d);
    }
  }

  private renderList(): void {
    const { list, listTitle } = this.ui;
    listTitle.textContent = `${this.t.recordings} (${this.recordings.length})`;
    list.innerHTML = '';
    if (!this.recordings.length) {
      list.append(el('div', 'rrv-empty', this.t.noRecordings));
      return;
    }
    this.recordings.forEach((rec, i) => {
      const item = el('button', 'rrv-item');
      item.type = 'button';
      item.dataset.index = String(i);
      if (!rec.playable) item.classList.add('rrv-item-unplayable');
      const started = new Date(rec.startTime);
      const lost = rec.stats.lostParts ? ` · <span class="rrv-lost">${this.t.lost}: ${rec.stats.lostParts}</span>` : '';
      item.innerHTML =
        `<div class="rrv-item-head"><span class="rrv-item-num">${i + 1}</span>` +
        `<span class="rrv-item-url" title="${escapeHtml(rec.pageUrl)}">${escapeHtml(shortUrl(rec.pageUrl))}</span>` +
        `<span class="rrv-item-dur">${formatDuration(rec.duration)}</span></div>` +
        `<div class="rrv-item-sub">${started.toLocaleString()} · ${rec.width}×${rec.height}</div>` +
        `<div class="rrv-item-sub">${rec.stats.events} ${this.t.events} · ${rec.stats.clicks} ${this.t.clicks}${lost}` +
        (rec.playable ? '' : ` · <span class="rrv-lost">${this.t.unplayable}</span>`) +
        `</div>`;
      item.addEventListener('click', () => this.select(i, this.opts.autoPlay || this.state === 'playing'));
      list.append(item);
    });
    this.highlightList();
  }

  private highlightList(): void {
    const items = this.ui.list.querySelectorAll<HTMLElement>('.rrv-item');
    items.forEach((it) => it.classList.toggle('rrv-item-active', Number(it.dataset.index) === this.currentIndex));
    const active = this.ui.list.querySelector<HTMLElement>('.rrv-item-active');
    active?.scrollIntoView({ block: 'nearest' });
  }

  private renderInfo(rec: Recording | null): void {
    const { info } = this.ui;
    info.innerHTML = '';
    if (!rec) return;
    const rows: Array<[string, string]> = [];
    rows.push([this.t.page, `<a href="${escapeHtml(rec.pageUrl)}" target="_blank" rel="noopener">${escapeHtml(rec.pageUrl || '—')}</a>${rec.pageTitle ? ` — ${escapeHtml(rec.pageTitle)}` : ''}`]);
    rows.push([this.t.started, `${new Date(rec.startTime).toLocaleString()} (${formatDuration(rec.duration)})`]);
    const m = rec.meta;
    if (m.browser || m.os) rows.push([this.t.browser, escapeHtml([m.browser, m.os].filter(Boolean).join(' · '))]);
    if (m.device) rows.push([this.t.device, escapeHtml(m.device)]);
    if (m.country || m.city || m.ip) rows.push([this.t.geo, escapeHtml([m.country, m.city, m.ip].filter(Boolean).join(' · '))]);
    rows.push([this.t.viewport, `${rec.width}×${rec.height}`]);
    if (m.userId) rows.push([this.t.user, escapeHtml(m.userId)]);
    rows.push([
      'uid',
      `${escapeHtml(rec.uid)} · ${rec.stats.events} ${this.t.events} · ${rec.stats.clicks} ${this.t.clicks} · snapshots: ${rec.stats.snapshots} · batches: ${rec.stats.batches}`,
    ]);
    if (rec.warnings.length) rows.push([this.t.warnings, escapeHtml(rec.warnings.join('; '))]);
    for (const [k, v] of rows) {
      const row = el('div', 'rrv-info-row');
      row.append(el('span', 'rrv-info-key', escapeHtml(k)), el('span', 'rrv-info-val', v));
      info.append(row);
    }
  }
}
