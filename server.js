// kindle-admin: servidor local. `npm start` y abrir http://localhost:4242 (ver README.md).

import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { HttpError, serial } from './lib/common.js';
import { addBook, COVER_DIR, deleteBook, editBook, listBooks } from './lib/library.js';
import * as mtp from './lib/mtp.js';
import { enableSsh, usbStatus } from './lib/setup.js';
import * as ssh from './lib/ssh.js';

const PORT = Number(process.env.PORT) || 4242;
// Para usarla desde otra máquina (p. ej. en un servidor de casa): BIND=0.0.0.0 y
// EXTRA_HOSTS con los nombres o IPs por los que se va a entrar, separados por comas.
const BIND = process.env.BIND || '127.0.0.1';
const EXTRA_HOSTS = (process.env.EXTRA_HOSTS || '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_JSON_BYTES = 30 * 1024 * 1024;

// Solo se atiende a la página propia: evita que otro sitio abierto en el navegador
// use la API (CSRF, o DNS rebinding apuntando su dominio a 127.0.0.1).
const HOSTS = new Set(['localhost', '127.0.0.1', ...EXTRA_HOSTS].map((h) => `${h}:${PORT}`));
const ORIGINS = new Set([...HOSTS].map((h) => `http://${h}`));
// Un header propio obliga al navegador a preguntar antes (preflight) en pedidos de otros sitios.
const CSRF_HEADER = 'x-kindle-admin';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
};

// --- conexión con el Kindle ---------------------------------------------------

// state: 'searching' | 'connected' | 'unreachable'. via: 'ssh' | 'usb' (con wifi se prefiere SSH).
// usb: qué tiene instalado el Kindle conectado por cable (lib/setup.js), o null.
let kindle = { state: 'searching', via: null, host: null, usb: null };
let booksCache = null;
// Listados y cambios de a uno: comparten la caché de metadata y los archivos del Kindle.
const exclusive = serial();

async function poll() {
  const [wifi, cable] = await Promise.all([ssh.findKindle(), mtp.findKindle()]);
  // Lo instalado por cable se revisa al enchufarlo (leer por MTP es lento).
  const usb = cable ? (kindle.usb ?? (await usbStatus().catch(() => null))) : null;
  const via = wifi.state === 'connected' ? 'ssh' : cable ? 'usb' : null;
  const next = { state: via ? 'connected' : 'unreachable', via, host: wifi.host, usb };
  if (next.via !== kindle.via || next.host !== kindle.host) {
    booksCache = null;
    console.log(
      via === 'ssh'
        ? `Kindle conectado por wifi: ${wifi.host}`
        : via === 'usb'
          ? 'Kindle conectado por cable'
          : 'Kindle no disponible',
    );
  }
  kindle = next;
}

function transport() {
  if (kindle.via === 'ssh') return ssh.transport;
  if (kindle.via === 'usb') return mtp.transport;
  throw new HttpError(409, 'el Kindle no responde: despertalo y fijate que tenga wifi, o conectalo por cable');
}

async function books() {
  const t = transport();
  booksCache ??= exclusive(() => listBooks(t)).then(
    (list) => {
      // Si algún libro no se pudo bajar, el próximo pedido lo reintenta.
      if (list.some((b) => b.pending)) booksCache = null;
      return list;
    },
    (e) => {
      booksCache = null;
      throw e;
    },
  );
  return booksCache;
}

async function changing(fn) {
  const t = transport();
  return exclusive(async () => {
    try {
      return await fn(t);
    } finally {
      booksCache = null;
    }
  });
}

// --- helpers HTTP -----------------------------------------------------------

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const notFound = (res) => send(res, 404, { error: 'no encontrado' });

function decode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, 'ruta o nombre mal codificado');
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new HttpError(413, 'pedido demasiado grande');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
}

async function sendFile(res, file) {
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      // Que el navegador siempre pida la versión actual de la página después de un cambio.
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    notFound(res);
  }
}

// La ruta de `rel` dentro de `base`, o null si se sale (por ejemplo con "../").
function inside(base, rel) {
  const file = path.join(base, rel);
  return file.startsWith(base + path.sep) ? file : null;
}

async function withTmpDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindle-admin-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const COVER_DATA_URL = /^data:image\/(jpeg|png|gif);base64,(.+)$/;

// Del cuerpo del PUT, solo los campos que vinieron.
function bookChanges(body, coverFile) {
  const changes = {};
  for (const key of ['title', 'language', 'publisher', 'description']) {
    if (typeof body[key] === 'string') changes[key] = body[key].trim();
  }
  if (Array.isArray(body.authors)) changes.authors = body.authors.map((a) => String(a).trim()).filter(Boolean);
  if (changes.title === '') throw new HttpError(400, 'el título no puede quedar vacío');
  if (coverFile) changes.cover = coverFile;
  return changes;
}

// --- rutas -------------------------------------------------------------------

async function handle(req, res) {
  if (!HOSTS.has(req.headers.host)) return send(res, 403, { error: 'host no permitido' });
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if ((origin && !ORIGINS.has(origin)) || !req.headers[CSRF_HEADER]) {
      return send(res, 403, { error: 'pedido de otro sitio' });
    }
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;
  const bookId = /^\/api\/books\/([\w-]+)$/.exec(url.pathname)?.[1];

  if (route === 'GET /api/status') return send(res, 200, kindle);

  if (route === 'POST /api/setup/ssh') {
    if (!kindle.usb) return send(res, 409, { error: 'conectá el Kindle por cable para habilitar el acceso por wifi' });
    kindle.usb = await exclusive(enableSsh);
    return send(res, 200, kindle.usb);
  }

  if (route === 'GET /api/books') return send(res, 200, { books: await books() });

  if (route === 'POST /api/books') {
    // El cuerpo es el archivo; el nombre original va en x-filename.
    transport();
    const name = decode(req.headers['x-filename'] || '');
    if (!name) throw new HttpError(400, 'falta el nombre del archivo');
    const added = await withTmpDir(async (dir) => {
      const tmp = path.join(dir, 'libro');
      await pipeline(req, createWriteStream(tmp));
      return changing((t) => addBook(t, tmp, name));
    });
    return send(res, 201, added);
  }

  if (bookId && req.method === 'PUT') {
    const body = await readJson(req);
    await withTmpDir(async (dir) => {
      let cover = null;
      if (body.cover) {
        const match = COVER_DATA_URL.exec(body.cover);
        if (!match) throw new HttpError(400, 'la portada tiene que ser JPG, PNG o GIF');
        cover = path.join(dir, `cover.${match[1] === 'jpeg' ? 'jpg' : match[1]}`);
        await fs.writeFile(cover, Buffer.from(match[2], 'base64'));
      }
      const changes = bookChanges(body, cover);
      if (Object.keys(changes).length) await changing((t) => editBook(t, bookId, changes));
    });
    return send(res, 200, { ok: true });
  }

  if (bookId && req.method === 'DELETE') {
    await changing((t) => deleteBook(t, bookId));
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/covers/')) {
    const file = inside(COVER_DIR, path.basename(url.pathname));
    return file ? sendFile(res, file) : notFound(res);
  }

  if (req.method === 'GET') {
    const rel = url.pathname === '/' ? 'index.html' : decode(url.pathname.slice(1));
    const file = inside(PUBLIC_DIR, rel);
    return file ? sendFile(res, file) : notFound(res);
  }

  notFound(res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!e.status) console.error(`${req.method} ${req.url}:`, e.stderr || e.message);
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
  });
});

// Buscar el Kindle en la red puede tardar más que el intervalo: nunca dos a la vez.
let polling = false;
async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    await poll();
  } catch (e) {
    console.error('error buscando el Kindle:', e.message);
  } finally {
    polling = false;
  }
}

server.listen(PORT, BIND, () => {
  console.log(`kindle-admin en ${[...ORIGINS].join(', ')}`);
  pollOnce();
  setInterval(pollOnce, 5000);
});
