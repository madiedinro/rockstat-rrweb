import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';

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
    plugins: [unblockRrweb(mode)],
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
