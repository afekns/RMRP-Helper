/**
 * Локальная раздача страниц для разработки (без VPS).
 *   node scripts/dev-pages-server.mjs
 * Клиент: $env:RMRP_LOCAL_BINDER_URL='http://127.0.0.1:3098'; npm start
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGES = path.join(__dirname, '..', '..', 'rmrp-helper', 'server', 'src', 'pages');
const ASSETS = path.join(__dirname, '..', '..', 'rmrp-helper', 'server', 'src', 'assets');
const PORT = Number(process.env.RMRP_DEV_PAGES_PORT || 3098);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  try {
    let url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url === '/') url = '/binder.html';

    if (url.startsWith('/img/')) {
      const file = path.join(ASSETS, 'img', path.basename(url));
      if (!file.startsWith(path.join(ASSETS, 'img'))) return send(res, 403, 'Forbidden');
      if (!fs.existsSync(file)) return send(res, 404, 'Not found');
      return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
    }

    const file = path.join(PAGES, url.replace(/^\//, ''));
    if (!file.startsWith(PAGES)) return send(res, 403, 'Forbidden');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found');
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (err) {
    send(res, 500, String(err.message || err));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`RMRP dev pages: http://127.0.0.1:${PORT}/binder.html`);
});