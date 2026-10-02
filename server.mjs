import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 的整数');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    const url = new URL(req.url, 'http://localhost');
    let requested = decodeURIComponent(url.pathname);
    if (requested.includes('\\') || requested.includes('\0')) { res.writeHead(400); res.end(); return; }
    const relative = requested.startsWith('/lib/') || requested.startsWith('/examples/') ? requested.slice(1) : `public/${requested === '/' ? 'index.html' : requested.slice(1)}`;
    const file = path.resolve(root, relative);
    const allowed = ['public', 'lib', 'examples'].some(folder => file.startsWith(path.join(root, folder) + path.sep));
    if (!allowed) { res.writeHead(403); res.end('Forbidden'); return; }
    const contents = await readFile(file);
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      'Content-Length': contents.length
    });
    res.end(req.method === 'HEAD' ? undefined : contents);
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' || error.code === 'EISDIR' ? 404 : 400);
    res.end('请求的文件不存在或无法读取');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`资源构建变化解释器已启动：http://127.0.0.1:${port}`));
server.on('error', error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
