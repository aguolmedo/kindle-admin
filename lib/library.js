// La biblioteca del Kindle: listar, agregar, editar y borrar EPUB y PDF en
// /mnt/us/libros. Cada función recibe el `transport` de lib/ssh.js o lib/mtp.js.
// Los libros se copian tal cual, sin convertir. Ver docs/ARQUITECTURA.md.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CACHE_DIR, HttpError, sdrOf } from './common.js';
import { editEpub, readEpub } from './epub.js';
import { editPdf, readPdf } from './pdf.js';

const LIBRARY = process.env.KINDLE_LIBRARY || '/mnt/us/libros';

export const COVER_DIR = path.join(CACHE_DIR, 'covers');
const META_CACHE = path.join(CACHE_DIR, 'meta.json');

const EPUB = '.epub';
const PDF = '.pdf';
const EXTS = [EPUB, PDF];
const FIELDS = {
  [EPUB]: ['title', 'authors', 'publisher', 'language', 'description', 'cover'],
  // El PDF no tiene editorial, y el idioma está en el catálogo, no en el Info.
  [PDF]: ['title', 'authors', 'description', 'cover'],
};
const COVER_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif' };
// Por encima de esto no se baja el archivo para leer la metadata (tarda mucho por
// wifi: unos 6 s cada 40 MB). Se baja una sola vez: después queda en la caché.
const MAX_META_BYTES = 100 * 1024 * 1024;
const TOO_BIG = 'muy grande para leer la metadata';

const extOf = (name) => path.extname(name).toLowerCase();
const idOf = (rel) => Buffer.from(rel).toString('base64url');
const hashOf = (s) => crypto.createHash('sha1').update(s).digest('hex');
const remoteOf = (rel) => path.posix.join(LIBRARY, rel);
const isCustomCover = (name) => /^cover\.(jpe?g|png|gif)$/i.test(name);
const titleFromName = (name) => path.basename(name, path.extname(name)).replace(/_/g, ' ');
const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'kindle-admin-'));

function safeName(s) {
  return (
    s
      .replace(/[/\\:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'libro'
  );
}

// --- caché de metadata: { "ruta|tamaño": { title, authors, ..., cover (ruta local) } | { error } }

let metaCache = null;

// Sin la fecha: por cable y por wifi el mismo archivo puede mostrar fechas distintas.
const keyOf = (f) => `${f.rel}|${f.size}`;

async function loadCache() {
  metaCache ??= await fs.readFile(META_CACHE, 'utf8').then(JSON.parse, () => ({}));
  return metaCache;
}

async function saveCache() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const tmp = `${META_CACHE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(metaCache));
  await fs.rename(tmp, META_CACHE);
}

// Saca de la caché los libros que ya no están y las portadas que nadie usa.
async function pruneCache(files) {
  const live = new Set(files.map(keyOf));
  for (const key of Object.keys(metaCache)) if (!live.has(key)) delete metaCache[key];
  const used = new Set(Object.values(metaCache).map((m) => m.cover && path.basename(m.cover)));
  for (const name of await fs.readdir(COVER_DIR).catch(() => [])) {
    if (!used.has(name)) await fs.rm(path.join(COVER_DIR, name), { force: true });
  }
}

async function saveCover(rel, ext, data) {
  await fs.mkdir(COVER_DIR, { recursive: true });
  const file = path.join(COVER_DIR, hashOf(rel) + ext);
  await fs.writeFile(file, data);
  return file;
}

async function epubMeta({ cover, ...meta }, rel) {
  if (cover && COVER_EXT[cover.type]) meta.cover = await saveCover(rel, COVER_EXT[cover.type], cover.data);
  return meta;
}

async function readMeta(file, rel) {
  return extOf(rel) === PDF ? readPdf(file) : epubMeta(await readEpub(file), rel);
}

// La portada de un PDF es la "portada personalizada" de KOReader: `cover.<ext>` en el .sdr.
async function fetchCustomCover(t, rel) {
  const sdr = sdrOf(remoteOf(rel));
  const name = (await t.names(sdr)).find(isCustomCover);
  if (!name) return null;
  const file = path.join(await tmpDir(), 'cover');
  try {
    await t.download(path.posix.join(sdr, name), file);
    return await saveCover(rel, extOf(name).replace('.jpeg', '.jpg'), await fs.readFile(file));
  } finally {
    await fs.rm(path.dirname(file), { recursive: true, force: true });
  }
}

async function setCustomCover(t, rel, image) {
  const sdr = sdrOf(remoteOf(rel));
  for (const name of (await t.names(sdr)).filter(isCustomCover)) await t.removeFile(path.posix.join(sdr, name));
  await t.upload(image, path.posix.join(sdr, 'cover' + extOf(image)));
}

// Baja los libros que no están en la caché y les lee la metadata y la portada.
// Devuelve las rutas que no se pudieron bajar (no se guardan: se reintentan la próxima vez).
async function fillCache(t, files) {
  const cache = await loadCache();
  // Los que se saltearon por grandes se reintentan si ahora entran en el límite.
  const missing = files.filter(
    (f) => !cache[keyOf(f)] || (cache[keyOf(f)].error === TOO_BIG && f.size <= MAX_META_BYTES),
  );
  const failed = [];
  const tmp = await tmpDir();
  try {
    for (const f of missing) {
      if (f.size > MAX_META_BYTES) {
        cache[keyOf(f)] = { error: TOO_BIG };
        continue;
      }
      const file = path.join(tmp, 'book' + extOf(f.rel));
      try {
        await t.download(remoteOf(f.rel), file);
      } catch (e) {
        console.error(`no se pudo bajar ${f.rel}:`, e.message);
        failed.push(f.rel);
        continue;
      }
      try {
        cache[keyOf(f)] = await readMeta(file, f.rel);
        if (extOf(f.rel) === PDF) cache[keyOf(f)].cover = await fetchCustomCover(t, f.rel);
      } catch (e) {
        cache[keyOf(f)] = { error: e.message };
      }
    }
    await pruneCache(files);
    await saveCache();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  return failed;
}

async function remoteFiles(t) {
  return (await t.list(LIBRARY)).filter((f) => EXTS.includes(extOf(f.rel)));
}

// Cada libro: { id, file, format, fields (los que se pueden editar), size, title, ..., cover (URL),
// pending (no se pudo leer todavía) }.
export async function listBooks(t) {
  const files = await remoteFiles(t);
  const failed = new Set(await fillCache(t, files));
  const cache = await loadCache();

  return files
    .map((f) => {
      const meta = cache[keyOf(f)] || {};
      return {
        id: idOf(f.rel),
        file: f.rel,
        format: extOf(f.rel).slice(1),
        fields: FIELDS[extOf(f.rel)],
        size: f.size,
        title: (!meta.error && meta.title) || titleFromName(f.rel),
        authors: meta.authors || [],
        publisher: meta.publisher || '',
        language: meta.language || '',
        description: meta.description || '',
        cover: meta.cover ? `/api/covers/${path.basename(meta.cover)}?v=${f.mtime}` : null,
        pending: failed.has(f.rel),
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title, 'es'));
}

async function findBook(t, id) {
  const rel = Buffer.from(id, 'base64url').toString();
  const book = (await listBooks(t)).find((b) => b.file === rel);
  if (!book) throw new HttpError(404, 'ese libro ya no está en el Kindle');
  return book;
}

async function readHead(file, n) {
  const fh = await fs.open(file);
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(n), 0, n, 0);
    return buffer.subarray(0, bytesRead).toString('latin1');
  } finally {
    await fh.close();
  }
}

// `src` puede ser un temporal: el nombre y el formato salen de `name`, el nombre original.
export async function addBook(t, src, name) {
  const ext = extOf(name);
  if (!EXTS.includes(ext)) throw new HttpError(400, 'solo se aceptan EPUB y PDF');

  let parsed = {};
  if (ext === EPUB) {
    try {
      parsed = await readEpub(src);
    } catch (e) {
      throw new HttpError(400, `no parece un EPUB válido: ${e.message}`);
    }
  } else if ((await readHead(src, 5)) !== '%PDF-') {
    throw new HttpError(400, 'no parece un PDF válido');
  }

  const title = parsed.title || titleFromName(name);
  const authors = parsed.authors?.length ? ` - ${parsed.authors.join(', ')}` : '';
  const base = safeName(`${title}${authors}`);
  // La tarjeta del Kindle es FAT32: "Libro.epub" y "libro.epub" son el mismo archivo.
  const taken = new Set((await remoteFiles(t)).map((f) => f.rel.toLowerCase()));
  let rel = base + ext;
  for (let n = 2; taken.has(rel.toLowerCase()); n++) rel = `${base} (${n})${ext}`;

  await t.upload(src, remoteOf(rel));

  const cache = await loadCache();
  const { size } = await fs.stat(src);
  cache[keyOf({ rel, size })] =
    ext === EPUB ? await epubMeta(parsed, rel) : await readPdf(src).catch((e) => ({ error: e.message }));
  await saveCache();
  return { file: rel, title };
}

// `changes` trae solo los campos que cambian: { title, authors[], publisher, language, description,
// cover (ruta local) }.
export async function editBook(t, id, changes) {
  const book = await findBook(t, id);
  const unknown = Object.keys(changes).filter((k) => !book.fields.includes(k));
  if (unknown.length)
    throw new HttpError(400, `no se puede editar ${unknown.join(', ')} de un ${book.format.toUpperCase()}`);
  if (extOf(book.file) === PDF) return editPdfBook(t, book, changes);

  const tmp = await tmpDir();
  try {
    const remote = remoteOf(book.file);
    const local = path.join(tmp, 'book' + EPUB);
    await t.download(remote, local);
    await editEpub(local, changes);
    await t.upload(local, remote);
    await t.forget(remote);
    // Lo recién escrito va a la caché: así no se vuelve a bajar.
    const cache = await loadCache();
    const { size } = await fs.stat(local);
    cache[keyOf({ rel: book.file, size })] = await readMeta(local, book.file);
    await saveCache();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// En un PDF la metadata va en el archivo y la portada en el .sdr: si solo
// cambia la portada no hace falta bajar y subir el PDF entero.
async function editPdfBook(t, book, { cover, ...metaChanges }) {
  const remote = remoteOf(book.file);
  const cache = await loadCache();
  const meta = { ...cache[keyOf({ rel: book.file, size: book.size })] };
  delete meta.error;
  let size = book.size;
  const tmp = await tmpDir();
  try {
    if (Object.keys(metaChanges).length) {
      const local = path.join(tmp, 'book' + PDF);
      await t.download(remote, local);
      await editPdf(local, metaChanges);
      await t.upload(local, remote);
      size = (await fs.stat(local)).size;
      Object.assign(meta, await readPdf(local));
    }
    if (cover) {
      await setCustomCover(t, book.file, cover);
      meta.cover = await saveCover(book.file, extOf(cover), await fs.readFile(cover));
    }
    await t.forget(remote);
    // Va a la caché aunque el PDF sea muy grande para leerlo al listar.
    cache[keyOf({ rel: book.file, size })] = meta;
    await saveCache();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

export async function deleteBook(t, id) {
  const remote = remoteOf((await findBook(t, id)).file);
  await t.remove(remote);
  await t.forget(remote);
}
