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
<style>body { margin: 0; padding: 8px; font: 14px sans-serif; }</style>
<button id="foreign-btn" onclick="this.textContent = 'clicked'; document.title = 'foreign clicked'">Foreign button</button>
<input id="foreign-name" aria-label="Foreign name" oninput="document.getElementById('foreign-echo').textContent = 'typed: ' + this.value">
<span id="foreign-echo"></span>
<input id="foreign-file" type="file" style="display:none" aria-label="Foreign file input"
       onchange="document.getElementById('foreign-label').textContent = 'file: ' + (this.files[0] ? this.files[0].name : 'none')">
<span id="foreign-label"></span>`;

// A cross-origin frame that itself contains a frame: proves whether frame geometry is
// reported in the parent frame's space or already flattened into the top viewport.
const FOREIGN_NESTED_HTML = `<!doctype html>
<meta charset="utf-8">
<title>nested host</title>
<style>body { margin: 0; padding: 4px; }</style>
<iframe id="deep" src="/foreign.html" style="display:block;width:150px;height:70px;border:3px solid #000"></iframe>`;

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
  const foreign = await listen((url) => (String(url).includes('nested') ? FOREIGN_NESTED_HTML : FOREIGN_HTML));
  const crossOriginSrc = `http://127.0.0.1:${foreign.port}/foreign.html`;
  // Same server, different *host*: `localhost` and `127.0.0.1` are different sites, so
  // Chrome puts this frame in its own renderer process (OOPIF). That is the regime real
  // embeds live in — a different port alone is only a different origin, same process.
  const crossSiteSrc = `http://localhost:${foreign.port}/foreign.html`;
  const nestedSrc = `http://127.0.0.1:${foreign.port}/foreign-nested.html`;

  const outerHtml = `<!doctype html>
<meta charset="utf-8">
<title>iframe outer</title>
<button id="outer-btn" onclick="window.__outerClicked = true">Outer button</button>
<iframe id="same" src="/inner.html" style="width:420px;height:180px;border:0"></iframe>
<iframe id="cross" src="${crossOriginSrc}" style="width:200px;height:110px;border:0"></iframe>
<iframe id="site" src="${crossSiteSrc}" style="width:200px;height:110px;border:0"></iframe>
<iframe id="nest" src="${nestedSrc}" style="width:200px;height:110px;border:3px solid #000"></iframe>`;

  const main = await listen((url) => (String(url).startsWith('/inner') ? INNER_HTML : outerHtml));

  return {
    outerUrl: `http://127.0.0.1:${main.port}/outer.html`,
    crossOriginSrc,
    crossSiteSrc,
    close() {
      main.server.close();
      foreign.server.close();
    },
  };
}
