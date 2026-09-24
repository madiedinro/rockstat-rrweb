import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proxyRewriter, rewriteAssetUrls, rewriteCssUrls } from '../src/assets.ts';
import type { eventWithTime } from '../src/types.ts';

const rw = proxyRewriter('/asset?url=');
const px = (u: string) => '/asset?url=' + encodeURIComponent(u);

test('rewriteCssUrls переписывает url() и @import, разрешая относительные пути', () => {
  const css = `@import "theme.css";.a{background:url(https://cdn.x/a.png)}.b{src:url('../f/r.woff2')}.c{background:url(data:image/png;base64,AAA)}`;
  const out = rewriteCssUrls(css, rw, 'https://cdn.x/static/css/main.css');
  assert.equal(
    out,
    `@import "${px('https://cdn.x/static/css/theme.css')}";.a{background:url(${px('https://cdn.x/a.png')})}.b{src:url('${px('https://cdn.x/static/f/r.woff2')}')}.c{background:url(data:image/png;base64,AAA)}`,
  );
});

test('rewriteAssetUrls подменяет ссылки в снимке и мутациях', () => {
  const events = [
    {
      type: 2,
      timestamp: 1,
      data: {
        node: {
          type: 0,
          childNodes: [
            {
              type: 2,
              tagName: 'html',
              attributes: {},
              childNodes: [
                { type: 2, tagName: 'link', attributes: { rel: 'stylesheet', href: 'https://cdn.x/a.css' }, childNodes: [] },
                { type: 2, tagName: 'link', attributes: { rel: 'alternate', href: 'https://x.y/' }, childNodes: [] },
                { type: 2, tagName: 'img', attributes: { src: 'https://cdn.x/i.png', srcset: 'https://cdn.x/i2.png 2x, https://cdn.x/i3.png 3x' }, childNodes: [] },
                { type: 2, tagName: 'div', attributes: { style: 'background:url("https://cdn.x/bg.jpg")' }, childNodes: [] },
                { type: 2, tagName: 'style', attributes: { _cssText: '.q{background:url(https://cdn.x/q.png)}' }, childNodes: [] },
              ],
            },
          ],
        },
        initialOffset: { top: 0, left: 0 },
      },
    },
    {
      type: 3,
      timestamp: 2,
      data: {
        source: 0,
        adds: [{ parentId: 1, nextId: null, node: { type: 2, tagName: 'img', attributes: { src: 'https://cdn.x/m.png' }, childNodes: [], id: 9 } }],
        attributes: [{ id: 9, attributes: { src: 'https://cdn.x/m2.png' } }],
        removes: [],
        texts: [],
      },
    },
  ] as unknown as eventWithTime[];

  rewriteAssetUrls(events, rw);
  const html = (events[0].data as { node: { childNodes: Array<{ childNodes: Array<{ attributes: Record<string, string> }> }> } }).node.childNodes[0].childNodes;
  assert.equal(html[0].attributes.href, px('https://cdn.x/a.css'));
  assert.equal(html[1].attributes.href, 'https://x.y/', 'rel=alternate не трогаем');
  assert.equal(html[2].attributes.src, px('https://cdn.x/i.png'));
  assert.equal(html[2].attributes.srcset, `${px('https://cdn.x/i2.png')} 2x, ${px('https://cdn.x/i3.png')} 3x`);
  assert.equal(html[3].attributes.style, `background:url("${px('https://cdn.x/bg.jpg')}")`);
  assert.equal(html[4].attributes._cssText, `.q{background:url(${px('https://cdn.x/q.png')})}`);
  const mut = events[1].data as { adds: Array<{ node: { attributes: Record<string, string> } }>; attributes: Array<{ attributes: Record<string, string> }> };
  assert.equal(mut.adds[0].node.attributes.src, px('https://cdn.x/m.png'));
  assert.equal(mut.attributes[0].attributes.src, px('https://cdn.x/m2.png'));
});

test('proxyRewriter не переписывает уже проксированные URL и уважает фильтр типов', () => {
  const only = proxyRewriter('/asset?url=', ['stylesheet']);
  assert.equal(only('https://cdn.x/a.css', 'stylesheet'), px('https://cdn.x/a.css'));
  assert.equal(only('https://cdn.x/a.png', 'image'), null);
  assert.equal(rw(px('https://cdn.x/a.css'), 'stylesheet'), null);
  assert.equal(rw('//cdn.x/a.css', 'stylesheet'), px('https://cdn.x/a.css'));
});
