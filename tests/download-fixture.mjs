/**
 * A site that serves real downloads, so the download path can be tested honestly.
 *
 * Two things only exist over HTTP: a `Content-Disposition: attachment` response (which
 * decides the file name when the link does not) and a body that arrives in chunks over
 * time (which is what makes a download observably "in progress"). A data: URL or a
 * file:// document can fake neither.
 */

import { createServer } from 'node:http';

export const ATTR_BODY = 'id,name\n1,alpha\n2,beta\n';
export const HEADER_BODY = 'quarter,revenue\nQ3,4200\n';
export const SLOW_BYTES = 8000;
const SLOW_CHUNKS = 8;
const SLOW_EVERY_MS = 150;

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>download fixture</title>
<style>body { font: 14px sans-serif; } a { display: block; margin: 6px 0; }</style>
<a id="attr" href="/files/attr.csv" download="report.csv">Export report (download attribute)</a>
<a id="header" href="/files/header.csv">Download Q3 (content-disposition)</a>
<a id="slow" href="/files/slow.bin" download="slow.bin">Download the big dataset</a>
<p id="done">ready</p>`;

export async function startDownloadSite() {
  const server = createServer((req, res) => {
    const url = String(req.url || '/');

    if (url.startsWith('/files/attr.csv')) {
      // No Content-Disposition on purpose: the anchor's download attribute is the only
      // thing naming this file, so the test proves that attribute is honoured.
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8' });
      res.end(ATTR_BODY);
      return;
    }

    if (url.startsWith('/files/header.csv')) {
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="q3-report.csv"',
      });
      res.end(HEADER_BODY);
      return;
    }

    if (url.startsWith('/files/slow.bin')) {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(SLOW_BYTES),
        'content-disposition': 'attachment; filename="slow.bin"',
      });
      const chunk = Buffer.alloc(SLOW_BYTES / SLOW_CHUNKS, 7);
      let sent = 0;
      const tick = setInterval(() => {
        res.write(chunk);
        sent += 1;
        if (sent >= SLOW_CHUNKS) {
          clearInterval(tick);
          res.end();
        }
      }, SLOW_EVERY_MS);
      req.on('close', () => clearInterval(tick));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  return {
    url: `http://127.0.0.1:${port}/page.html`,
    close() {
      server.close();
    },
  };
}
