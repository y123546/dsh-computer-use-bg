/**
 * A page with one same-origin and one cross-origin frame, served over real HTTP.
 *
 * file:// cannot stand in for this: every file:// document is its own opaque origin,
 * so even the "same-origin" frame would be blocked and the test would pass without
 * proving anything. Two ports on 127.0.0.1 are two genuinely different origins.
 */

import { createServer } from 'node:http';

const INNER_HTML = `<!doctype html>
<meta charset="utf-8">
<title>inner frame</title>
<style>body { margin: 0; padding: 8px; font: 14px sans-serif; }</style>
<h2>Inner heading</h2>
<input id="inner-name" aria-label="Inner name" placeholder="Inner name">
<button id="inner-btn" aria-label="Inner button" onclick="window.__innerClicked = true">Inner button</button>
<input id="inner-file" type="file" style="display:none" aria-label="Inner file input">`;

const FOREIGN_HTML = `<!doctype html>
<meta charset="utf-8">
<title>foreign frame</title>
<button id="foreign-btn">Foreign button</button>`;

const listen = (htmlFor) =>
  new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(htmlFor(req.url));
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });

export async function startIframeSites() {
  const foreign = await listen(() => FOREIGN_HTML);
  const crossOriginSrc = `http://127.0.0.1:${foreign.port}/foreign.html`;

  const outerHtml = `<!doctype html>
<meta charset="utf-8">
<title>iframe outer</title>
<button id="outer-btn" onclick="window.__outerClicked = true">Outer button</button>
<iframe id="same" src="/inner.html" style="width:420px;height:180px;border:0"></iframe>
<iframe id="cross" src="${crossOriginSrc}" style="width:200px;height:110px;border:0"></iframe>`;

  const main = await listen((url) => (String(url).startsWith('/inner') ? INNER_HTML : outerHtml));

  return {
    outerUrl: `http://127.0.0.1:${main.port}/outer.html`,
    crossOriginSrc,
    close() {
      main.server.close();
      foreign.server.close();
    },
  };
}
