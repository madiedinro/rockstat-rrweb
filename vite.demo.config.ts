import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { proxyRewriter, rewriteCssUrls } from './src/assets.ts';

/**
 * Блокировщики рекламы (EasyPrivacy и т.п.) режут любой URL вида `/rrweb.js`,
 * поэтому в dev-режиме отдаём бандл rrweb под другим именем файла.
 * В production-сборке rrweb попадает в общий чанк, и проблема не возникает.
 */
function unblockRrweb(mode: string): Plugin {
  const source = fileURLToPath(new URL('./node_modules/rrweb/dist/rrweb.js', import.meta.url));
  const dir = fileURLToPath(new URL('./node_modules/.cache/replayer-lib/', import.meta.url));
  const copy = `${dir}replayer.mjs`;
  let version = '';
  return {
    name: 'unblock-rrweb',
    enforce: 'pre',
    apply: 'serve',
    configResolved() {
      mkdirSync(dir, { recursive: true });
      // `process.env.NODE_ENV` заменяем сами: иначе файл пойдёт через define-трансформ Vite.
      const code = readFileSync(source, 'utf8')
        .replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n')
        .replace(/process\.env\.NODE_ENV/g, JSON.stringify(mode));
      writeFileSync(copy, code);
      version = createHash('sha1').update(code).digest('hex').slice(0, 8);
    },
    // Версия в query, иначе браузер закэширует файл из node_modules навсегда.
    resolveId: (id) => (id === 'rrweb' ? `${copy}?v=${version}` : null),
  };
}

const ASSET_PREFIX = '/asset?url=';
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

/**
 * Прокси для ресурсов записанных страниц: `/asset?url=<encoded>`.
 * CDN часто не отдают стили и картинки сторонним страницам (hotlink-защита, WAF),
 * а серверному запросу отдают. В CSS переписываем `url()`/`@import` тоже на прокси.
 */
function assetProxy(): Plugin {
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/asset?')) return next();
    const target = new URL(req.url, 'http://localhost').searchParams.get('url') ?? '';
    if (!/^https?:\/\//i.test(target)) {
      res.statusCode = 400;
      res.end('bad url');
      return;
    }
    try {
      const upstream = await fetch(target, {
        headers: { 'user-agent': BROWSER_UA, accept: '*/*', 'accept-language': 'en-US,en;q=0.9' },
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
      });
      const type = upstream.headers.get('content-type') ?? 'application/octet-stream';
      res.statusCode = upstream.status;
      res.setHeader('cache-control', 'public, max-age=3600');
      if (/text\/css/i.test(type) || /\.css(\?|#|$)/i.test(target)) {
        res.setHeader('content-type', 'text/css; charset=utf-8');
        res.end(rewriteCssUrls(await upstream.text(), proxyRewriter(ASSET_PREFIX), upstream.url || target));
      } else {
        res.setHeader('content-type', type);
        res.end(Buffer.from(await upstream.arrayBuffer()));
      }
    } catch (err) {
      res.statusCode = 502;
      res.end(err instanceof Error ? err.message : String(err));
    }
  };
  return {
    name: 'asset-proxy',
    configureServer: (server) => {
      server.middlewares.use(handler);
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const raw = env.CLICKHOUSE_URL || 'http://localhost:8123/default';
  const u = new URL(raw);
  const user = env.CLICKHOUSE_USER || decodeURIComponent(u.username || 'default');
  const password = env.CLICKHOUSE_PASSWORD || decodeURIComponent(u.password || '');
  const database = env.CLICKHOUSE_DATABASE || u.pathname.replace(/^\/|\/$/g, '') || 'default';
  const target = `${u.protocol}//${u.host}`;
  const proxy = {
    '/ch': {
      target,
      changeOrigin: true,
      secure: true,
      rewrite: (p: string) => p.replace(/^\/ch/, ''),
      headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` },
    },
  };

  return {
    root: 'demo',
    plugins: [unblockRrweb(mode), assetProxy()],
    optimizeDeps: { exclude: ['rrweb'] },
    envDir: fileURLToPath(new URL('.', import.meta.url)),
    resolve: {
      alias: { 'rrweb-viewer': fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
    },
    define: {
      __CH_DATABASE__: JSON.stringify(database),
      __CH_TABLE__: JSON.stringify(env.CLICKHOUSE_TABLE || 'rrweb'),
    },
    server: { port: 5173, proxy },
    preview: { port: 4173, proxy },
    build: { outDir: '../dist-demo', emptyOutDir: true },
  };
});
