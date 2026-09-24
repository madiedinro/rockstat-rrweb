import type { eventWithTime } from './types.ts';

export type AssetKind = 'stylesheet' | 'image' | 'media' | 'font' | 'other';

/**
 * Возвращает новый URL ресурса или `null`/`undefined`, чтобы оставить как есть.
 * Вызывается для каждого внешнего ресурса записанной страницы.
 */
export type AssetUrlRewriter = (url: string, kind: AssetKind) => string | null | undefined;

const EVENT_FULL_SNAPSHOT = 2;
const EVENT_INCREMENTAL = 3;
const SOURCE_MUTATION = 0;
const NODE_ELEMENT = 2;

interface SerializedElement {
  type: number;
  tagName?: string;
  attributes?: Record<string, string | number | boolean>;
  childNodes?: SerializedElement[];
  isSVG?: boolean;
}

function kindOf(tag: string, attrs: Record<string, unknown>, attr: string): AssetKind | null {
  switch (tag) {
    case 'link': {
      const rel = String(attrs.rel ?? '').toLowerCase();
      const as = String(attrs.as ?? '').toLowerCase();
      if (attr !== 'href') return null;
      if (rel.includes('stylesheet')) return 'stylesheet';
      if (rel.includes('preload') || rel.includes('prefetch')) {
        if (as === 'style') return 'stylesheet';
        if (as === 'font') return 'font';
        if (as === 'image') return 'image';
      }
      if (rel.includes('icon')) return 'image';
      return null;
    }
    case 'img':
    case 'image':
      return attr === 'src' || attr === 'srcset' || attr === 'href' || attr === 'xlink:href' ? 'image' : null;
    case 'source':
      return attr === 'src' || attr === 'srcset' ? 'media' : null;
    case 'video':
    case 'audio':
      return attr === 'src' || attr === 'poster' ? 'media' : null;
    case 'iframe':
    case 'embed':
    case 'object':
      return attr === 'src' || attr === 'data' ? 'other' : null;
    default:
      return null;
  }
}

function isAbsoluteHttp(url: string): boolean {
  return /^https?:\/\//i.test(url) || url.startsWith('//');
}

function rewriteSrcset(value: string, kind: AssetKind, rewrite: AssetUrlRewriter): string {
  return value
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return trimmed;
      const [url, ...rest] = trimmed.split(/\s+/);
      const next = isAbsoluteHttp(url) ? rewrite(url, kind) : null;
      return [next || url, ...rest].join(' ');
    })
    .join(', ');
}

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
const CSS_IMPORT_RE = /@import\s+(['"])([^'"]+)\1/g;

/** Переписывает `url()` и `@import` в тексте CSS. Относительные ссылки разрешаются относительно `base`. */
export function rewriteCssUrls(css: string, rewrite: AssetUrlRewriter, base?: string): string {
  const resolve = (u: string): string | null => {
    if (/^(data|blob):/i.test(u) || u.startsWith('#')) return null;
    let abs = u;
    if (!isAbsoluteHttp(u)) {
      if (!base) return null;
      try {
        abs = new URL(u, base).toString();
      } catch {
        return null;
      }
    }
    const kind: AssetKind = /\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(abs) ? 'font' : /\.css(\?|#|$)/i.test(abs) ? 'stylesheet' : 'image';
    return rewrite(abs, kind) ?? (abs !== u ? abs : null);
  };
  return css
    .replace(CSS_IMPORT_RE, (m, q: string, u: string) => {
      const next = resolve(u);
      return next ? `@import ${q}${next}${q}` : m;
    })
    .replace(CSS_URL_RE, (m, q: string, u: string) => {
      const next = resolve(u);
      return next ? `url(${q}${next}${q})` : m;
    });
}

function rewriteAttributes(tag: string, attrs: Record<string, unknown>, rewrite: AssetUrlRewriter): void {
  for (const [attr, raw] of Object.entries(attrs)) {
    if (typeof raw !== 'string' || !raw) continue;
    if (attr === '_cssText' || (attr === 'style' && raw.includes('url('))) {
      attrs[attr] = rewriteCssUrls(raw, rewrite);
      continue;
    }
    const kind = kindOf(tag, attrs, attr);
    if (!kind) continue;
    if (attr === 'srcset') {
      attrs[attr] = rewriteSrcset(raw, kind, rewrite);
    } else if (isAbsoluteHttp(raw)) {
      const next = rewrite(raw, kind);
      if (next) attrs[attr] = next;
    }
  }
}

function walkNode(node: SerializedElement | undefined, rewrite: AssetUrlRewriter): void {
  if (!node) return;
  if (node.type === NODE_ELEMENT && node.tagName && node.attributes) {
    rewriteAttributes(node.tagName.toLowerCase(), node.attributes, rewrite);
  }
  if (node.childNodes) for (const child of node.childNodes) walkNode(child, rewrite);
}

/**
 * Подменяет URL внешних ресурсов (стили, картинки, шрифты) во всех событиях записи —
 * в полном снимке и в мутациях. Полезно, когда оригинальный сайт не отдаёт ресурсы
 * плееру (hotlink-защита, авторизация, устаревшая версия сборки) и их нужно
 * проксировать. События изменяются на месте; чтобы сохранить оригинал, передайте копию.
 */
export function rewriteAssetUrls(events: eventWithTime[], rewrite: AssetUrlRewriter): eventWithTime[] {
  for (const e of events) {
    if (e.type === EVENT_FULL_SNAPSHOT) {
      walkNode((e.data as { node: SerializedElement }).node, rewrite);
    } else if (e.type === EVENT_INCREMENTAL && (e.data as { source: number }).source === SOURCE_MUTATION) {
      const data = e.data as {
        adds?: Array<{ node: SerializedElement }>;
        attributes?: Array<{ id: number; attributes: Record<string, unknown> }>;
      };
      for (const add of data.adds ?? []) walkNode(add.node, rewrite);
      for (const change of data.attributes ?? []) {
        // Тег неизвестен — перебираем атрибуты, характерные для ресурсов.
        const attrs = change.attributes;
        for (const [attr, raw] of Object.entries(attrs)) {
          if (typeof raw !== 'string' || !raw) continue;
          if (attr === 'style' && raw.includes('url(')) attrs[attr] = rewriteCssUrls(raw, rewrite);
          else if (attr === 'srcset') attrs[attr] = rewriteSrcset(raw, 'image', rewrite);
          else if ((attr === 'src' || attr === 'href' || attr === 'poster') && isAbsoluteHttp(raw)) {
            const kind: AssetKind = /\.css(\?|#|$)/i.test(raw) ? 'stylesheet' : attr === 'href' ? 'other' : 'image';
            const next = rewrite(raw, kind);
            if (next) attrs[attr] = next;
          }
        }
      }
    }
  }
  return events;
}

/**
 * Готовый переписыватель для прокси вида `/asset?url=<encoded>`.
 * `only` ограничивает типы ресурсов (по умолчанию — все).
 */
export function proxyRewriter(prefix = '/asset?url=', only?: AssetKind[]): AssetUrlRewriter {
  return (url, kind) => {
    if (only && !only.includes(kind)) return null;
    if (url.startsWith(prefix)) return null;
    return prefix + encodeURIComponent(url.startsWith('//') ? `https:${url}` : url);
  };
}
