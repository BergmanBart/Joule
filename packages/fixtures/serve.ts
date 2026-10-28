/** Tiny static server for the fixture site used by end-to-end checks. Usage: tsx serve.ts [port] */
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./site/', import.meta.url));
const TYPES: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

export function serveFixtures(port = 4400): Promise<Server> {
  const server = createServer(async (req, res) => {
    const path = normalize(new URL(req.url ?? '/', 'http://x').pathname).replace(/^([/\\])+/, '') || 'index.html';
    try {
      const body = await readFile(join(ROOT, path));
      res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const port = Number(process.argv[2] ?? 4400);
  await serveFixtures(port);
  console.log(`Fixture site on http://127.0.0.1:${port}/`);
}
