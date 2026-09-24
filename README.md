# rrweb-viewer

Библиотека для воспроизведения записей поведения пользователей ([rrweb](https://github.com/rrweb-io/rrweb)),
которые трекер складывает в ClickHouse (таблица `stats.rrweb`). Умеет:

- забирать строки по `uid` из ClickHouse (HTTP-интерфейс, из браузера или Node);
- собирать из них записи страниц: склеивать части батчей, распаковывать события
  (формат `@rrweb/packer`: zlib + latin1), восстанавливать события из батчей с потерянными частями;
- показывать плеер: список записей пользователя, таймлайн с кликами и паузами, скорость,
  пропуск бездействия, полноэкранный режим, клавиатура (пробел, ←/→, n/p).

## Быстрый старт

```bash
pnpm install
cp .env.example .env      # заполнить CLICKHOUSE_URL=https://user:pass@host:8443/stats
pnpm dev                  # демо на http://localhost:5173
```

Демо ходит в ClickHouse через прокси dev-сервера (`/ch`), поэтому пароль остаётся на сервере.
Открыть пользователя сразу: `http://localhost:5173/?uid=7505189759623507968`.

## Использование библиотеки

```ts
import { ClickHouseSource, RrwebViewer } from 'rrweb-viewer';
import 'rrweb-viewer/style.css';

const source = new ClickHouseSource({
  url: 'https://clickhouse.example.com:8443', // или '/ch' — путь до прокси
  database: 'stats',
  user: 'default',
  password: '…', // в браузере лучше ходить через прокси, см. ниже
});

const viewer = new RrwebViewer('#player', { autoPlay: true, skipInactive: true });
await viewer.load('7505189759623507968', source);
```

Если данные уже выгружены (например, `SELECT * FROM stats.rrweb WHERE uid = … FORMAT JSONEachRow`),
плееру можно отдать сырые строки:

```ts
const recordings = viewer.loadRows(rows); // rows: RrwebRow[]
```

Или разобрать их отдельно, без UI:

```ts
import { parseRows } from 'rrweb-viewer';

const recordings = parseRows(rows, { onWarning: console.warn });
// recordings[i].events — готовый массив для rrweb.Replayer
// recordings[i].pageUrl, startTime, duration, width, height, stats, meta, warnings
```

Без сборщика — UMD-бандл выставляет глобальную переменную `RrwebViewer`:

```html
<link rel="stylesheet" href="dist/rrweb-viewer.css" />
<script src="dist/rrweb-viewer.umd.cjs"></script>
<script>
  const viewer = new RrwebViewer.RrwebViewer('#player');
  viewer.loadRows(rows);
</script>
```

### API

`ClickHouseSource(options)`

| опция | описание |
| --- | --- |
| `url` | адрес HTTP-интерфейса, можно с логином/паролем и базой: `https://u:p@host:8443/stats` |
| `database`, `table` | по умолчанию `stats` / `rrweb` |
| `user`, `password`, `auth` | способ передачи: `url` (параметры запроса, без preflight), `header`, `basic` |
| `headers`, `settings`, `fetch`, `columns` | доп. заголовки, настройки ClickHouse, своя реализация fetch, список колонок |

- `fetchRows(uid, { from, to, projectId, limit })` — сырые строки;
- `fetchRecordings(uid, …)` — сразу записи;
- `listUids({ limit, from, to, search })` — пользователи с записями, последние первыми;
- `query(sql, params)` — произвольный запрос (`{name:Type}` → `params.name`).

`RrwebViewer(container, options)`

| опция | по умолчанию | описание |
| --- | --- | --- |
| `speed`, `speeds` | `1`, `[0.5…16]` | скорость и варианты в селекте |
| `skipInactive`, `inactiveThreshold` | `true`, `10000` | пропуск пауз длиннее порога (мс) |
| `autoPlay`, `autoNext` | `false`, `false` | запуск при выборе, переход к следующей записи |
| `showList`, `showInfo` | `true` | боковой список и панель с информацией |
| `mouseTail`, `locale` | `true`, `'ru'` | след курсора, язык (`ru`/`en`) |
| `rewriteAssets` | — | подмена URL стилей/картинок/шрифтов записанной страницы, см. ниже |
| `onSelect`, `onStateChange` | — | колбэки |

Методы: `load(uid, source)`, `loadRows(rows)`, `setRecordings(recs)`, `select(i)`, `play()`, `pause()`,
`toggle()`, `seek(ms)`, `setSpeed(n)`, `setSkipInactive(b)`, `setAutoNext(b)`, `next()`, `prev()`,
`toggleFullscreen()`, `destroy()`; свойства `current`, `list`, `playing`.

### Ресурсы записанной страницы (стили, картинки, шрифты)

rrweb не сохраняет внешние стили и картинки — только ссылки на них. При воспроизведении браузер
запрашивает их с оригинального CDN, и тот часто отвечает отказом (hotlink-защита, WAF, авторизация,
удалённая старая сборка). Страница тогда выглядит «голой»: без стилей и картинок.

Решение — гонять ресурсы через свой прокси. Библиотека умеет подменять URL во всех событиях:

```ts
import { RrwebViewer, proxyRewriter } from 'rrweb-viewer';

const viewer = new RrwebViewer('#player', {
  // https://cdn.site/app.css → /asset?url=https%3A%2F%2Fcdn.site%2Fapp.css
  rewriteAssets: proxyRewriter('/asset?url='),
});
```

Прокси на сервере должен запросить ресурс от своего имени и отдать его с исходным `Content-Type`,
а в CSS переписать `url()`/`@import` тем же способом — для этого есть `rewriteCssUrls(css, rewriter, baseUrl)`.
Рабочий пример — middleware `assetProxy()` в `vite.demo.config.ts` (работает и в `pnpm dev`, и в `pnpm preview`).
Отключить прокси в демо: `?direct=1`.

Своя логика вместо прокси (например, ресурсы уже сложены в S3):

```ts
rewriteAssets: (url, kind) => (kind === 'stylesheet' ? url.replace('https://cdn.site/', 'https://archive.my/') : null);
```

Без UI: `rewriteAssetUrls(events, rewriter)` меняет события на месте.

## Как устроены данные

| колонка | смысл |
| --- | --- |
| `name` | `rec_start` — начало записи страницы (содержит метаданные), `rec_batch` — пачка событий |
| `sess_start`, `sess_pageNum` | ключ страницы: одна запись = один вызов `rrweb.record` |
| `data_seq` | номер батча внутри записи, батчи уходят раз в ~5 с |
| `data_part`, `data_of` | батч > 40 000 символов режется на части, части отправляются отдельно |
| `data_d` | кусок JSON-массива строк; каждая строка — событие, упакованное `@rrweb/packer` (`v1`) |

Раз в ~2 минуты трекер делает checkout (Meta + FullSnapshot) — на таймлайне это серые метки,
после них воспроизведение восстанавливается, даже если что-то потерялось. Части батчей теряются
в доставке примерно в 5 % случаев; из оставшихся частей парсер вытаскивает все целые события и
пишет это в `recording.warnings` и `recording.stats.lostParts`. Если потерян самый первый батч
(нет FullSnapshot), запись помечается `playable: false`.

## Скрипты

```bash
pnpm dev            # демо
pnpm build          # библиотека → dist/ (ES + UMD + d.ts + css)
pnpm build:demo     # статическое демо → dist-demo/ (нужен прокси до ClickHouse на /ch)
pnpm test           # юнит-тесты парсера (node --test)
pnpm typecheck
pnpm export --list  # пользователи с записями
pnpm export <uid>   # выгрузить строки в exports/<uid>.jsonl (можно открыть в демо «из файла…»)
```

## Известные особенности

- Блокировщики рекламы (EasyPrivacy) режут URL вида `*/rrweb.js`. В production-сборке это не мешает
  (rrweb внутри общего бандла), а в dev-режиме демо отдаёт rrweb под другим именем файла.
- Внешние стили и картинки записанной страницы плеер грузит с оригинального сайта. CDN текущего
  проекта отдаёт их только при прямом заходе, а подгрузкам со сторонней страницы отвечает 503 —
  поэтому демо проксирует ресурсы через `/asset?url=…` (см. выше).
- CORS у ClickHouse включается параметром `add_http_cors_header=1` (библиотека его добавляет);
  preflight-запросов при `auth: 'url'` не бывает.
