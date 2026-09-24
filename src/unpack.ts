import { strFromU8, strToU8, unzlibSync } from 'fflate';
import type { eventWithTime } from './types.ts';

/** Версия упаковщика rrweb (`@rrweb/packer`), которую пишет трекер в поле `v`. */
export const PACK_MARK = 'v1';

/**
 * Распаковывает одно событие в том виде, в котором его сохраняет трекер:
 * `zlib(JSON.stringify({...event, v: 'v1'}))`, закодированный как latin1-строка.
 * Совместимо с `pack()` из `@rrweb/packer`. Обычный JSON тоже принимается.
 */
export function unpackEvent(raw: string | eventWithTime): eventWithTime {
  if (typeof raw !== 'string') return raw;
  if (raw.charCodeAt(0) === 0x7b /* { */) {
    try {
      const e = JSON.parse(raw) as eventWithTime;
      if (e && typeof e.timestamp === 'number') return e;
    } catch {
      /* не JSON — идём распаковывать */
    }
  }
  const json = strFromU8(unzlibSync(strToU8(raw, true)));
  const e = JSON.parse(json) as eventWithTime & { v?: string };
  if (e.v !== undefined && e.v !== PACK_MARK) {
    throw new Error(`Неподдерживаемая версия упаковщика: ${e.v} (ожидалась ${PACK_MARK})`);
  }
  delete e.v;
  return e;
}

/** Считает, экранирована ли кавычка в позиции `i` (нечётное число `\` перед ней). */
function isEscaped(text: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) n++;
  return n % 2 === 1;
}

/**
 * Достаёт целые строки из текста JSON-массива строк `["...","..."]`,
 * даже если начало или конец массива потеряны (пропала часть батча).
 *
 * @param text     текст (склеенные подряд идущие части батча)
 * @param anchored true, если текст начинается с начала массива (часть 0)
 */
export function extractStrings(text: string, anchored: boolean): string[] {
  const out: string[] = [];
  const n = text.length;
  let i = 0;

  if (anchored) {
    while (i < n && text[i] !== '[') i++;
    i++;
  } else {
    // Начало обрезано: ищем первую границу `","` — внутри строк
    // неэкранированная кавычка встретиться не может.
    let found = -1;
    for (let j = 0; j < n - 2; j++) {
      if (text[j] === '"' && text[j + 1] === ',' && text[j + 2] === '"' && !isEscaped(text, j)) {
        found = j + 2;
        break;
      }
    }
    if (found < 0) return out;
    i = found;
  }

  while (i < n) {
    const c = text[i];
    if (c === ',' || c === ' ' || c === '\n' || c === '\r' || c === '\t') {
      i++;
      continue;
    }
    if (c !== '"') break; // `]` или мусор
    let j = i + 1;
    let closed = false;
    while (j < n) {
      const ch = text[j];
      if (ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === '"') {
        closed = true;
        break;
      }
      j++;
    }
    if (!closed) break; // строка обрезана концом текста
    try {
      out.push(JSON.parse(text.slice(i, j + 1)) as string);
    } catch {
      /* битая строка — пропускаем */
    }
    i = j + 1;
  }
  return out;
}
