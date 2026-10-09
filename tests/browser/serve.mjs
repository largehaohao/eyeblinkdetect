// Serve the production bundle without loading the extension into a personal profile.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
const root = resolve('dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
createServer(async (req, res) => {
  try {
    const path = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!path.startsWith(root + sep)) throw new Error('Invalid path');
    res.setHeader('Content-Type', types[extname(path)] ?? 'application/octet-stream');
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
}).listen(4173, '127.0.0.1');
