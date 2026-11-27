// Lee y edita la metadata y la portada de un EPUB (un ZIP con un OPF adentro).

import fs from 'node:fs/promises';
import path from 'node:path';

import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import JSZip from 'jszip';

const DC = 'http://purl.org/dc/elements/1.1/';
const OPF = 'http://www.idpf.org/2007/opf';
const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif' };
const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif' };

function parseXml(text) {
  let failed = false;
  // Algunos EPUB traen un BOM antes de <?xml, que el parser no acepta.
  const doc = new DOMParser({ onError: (level) => level !== 'warning' && (failed = true) }).parseFromString(
    text.replace(/^\uFEFF\s*/, ''),
    'application/xml',
  );
  if (failed || !doc.documentElement) throw new Error('OPF inválido');
  return doc;
}

function normalizePath(p) {
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '..') out.pop();
    else if (seg && seg !== '.') out.push(seg);
  }
  return out.join('/');
}

const basename = (p) => p.split('/').pop();
// Un href con un % suelto no tira abajo todo el EPUB.
const decodeHref = (href) => {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
};
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const removeNode = (el) => el.parentNode?.removeChild(el);
const insertAfter = (el, ref) => ref.parentNode.insertBefore(el, ref.nextSibling);
const byTag = (node, ns, name) => Array.from(node.getElementsByTagNameNS(ns, name));

function stripHtml(html) {
  // Solo etiquetas HTML de verdad: un "<2>" en el texto queda como está.
  const text = (html || '').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<\/?[a-z][^>]*>/gi, '');
  const decoded = text.replace(
    /&(amp|lt|gt|quot|#39|nbsp);/g,
    (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' })[e],
  );
  return decoded.replace(/\n{3,}/g, '\n\n').trim();
}

async function open(file) {
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('no es un EPUB (falta META-INF/container.xml)');
  const container = parseXml(await containerFile.async('string'));
  const opfPath = byTag(container, '*', 'rootfile')[0]?.getAttribute('full-path');
  if (!opfPath || !zip.file(opfPath)) throw new Error('no es un EPUB (no se encuentra el OPF)');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opfText = (await zip.file(opfPath).async('string')).replace(/^\uFEFF/, '');
  // Las entradas de carpeta del original: al escribir, zip.file() agrega las que faltan.
  const folders = Object.values(zip.files)
    .filter((f) => f.dir)
    .map((f) => f.name);
  return { zip, folders, opfPath, opfDir, opfText, doc: parseXml(opfText) };
}

function findCoverItem(doc, items) {
  const isImage = (i) => (i.getAttribute('media-type') || '').startsWith('image/');
  const byProperty = items.find((i) => (i.getAttribute('properties') || '').split(/\s+/).includes('cover-image'));
  if (byProperty) return byProperty;
  const meta = byTag(doc, OPF, 'meta').find((m) => m.getAttribute('name') === 'cover');
  const byMeta = meta && items.find((i) => i.getAttribute('id') === meta.getAttribute('content'));
  if (byMeta && isImage(byMeta)) return byMeta;
  return items.find((i) => isImage(i) && /cover/i.test((i.getAttribute('id') || '') + (i.getAttribute('href') || '')));
}

// { title, authors, publisher, language, description, cover: { data, type } | null }
export async function readEpub(file) {
  const { zip, opfDir, doc } = await open(file);
  const metadata = byTag(doc, OPF, 'metadata')[0];
  const dc = (name) =>
    metadata
      ? byTag(metadata, DC, name)
          .map((el) => el.textContent.trim())
          .filter(Boolean)
      : [];

  let cover = null;
  const items = byTag(doc, OPF, 'item');
  const item = findCoverItem(doc, items);
  const coverFile = item && zip.file(normalizePath(opfDir + decodeHref(item.getAttribute('href'))));
  if (coverFile) cover = { data: await coverFile.async('nodebuffer'), type: item.getAttribute('media-type') };

  return {
    title: dc('title')[0] || '',
    authors: dc('creator'),
    publisher: dc('publisher')[0] || '',
    language: dc('language')[0] || '',
    description: stripHtml(dc('description')[0]),
    cover,
  };
}

function editOpf(doc) {
  const metadata = byTag(doc, OPF, 'metadata')[0];
  const prefix = metadata.lookupPrefix(DC) || 'dc';
  const metas = () => byTag(metadata, OPF, 'meta');
  const dcAll = (name) => byTag(metadata, DC, name);

  function removeRefines(el, property) {
    const id = el.getAttribute('id');
    if (!id) return;
    metas()
      .filter((m) => m.getAttribute('refines') === `#${id}`)
      .filter((m) => !property || m.getAttribute('property') === property)
      .forEach(removeNode);
  }

  function remove(el) {
    removeRefines(el);
    removeNode(el);
  }

  function create(name, value) {
    const el = doc.createElementNS(DC, `${prefix}:${name}`);
    el.textContent = value;
    return el;
  }

  function setSingle(name, value) {
    const [first, ...rest] = dcAll(name);
    rest.forEach(remove);
    if (!value) return first && remove(first);
    if (first) first.textContent = value;
    else metadata.appendChild(create(name, value));
  }

  // Un autor nuevo lleva el mismo rol que el último existente: en EPUB3 los lectores
  // ignoran a los creadores sin rol "aut" si los demás lo tienen.
  function copyRole(from, to) {
    const role = from.getAttributeNS(OPF, 'role');
    if (role) to.setAttributeNS(OPF, from.lookupPrefix(OPF) ? `${from.lookupPrefix(OPF)}:role` : 'opf:role', role);
    const id = from.getAttribute('id');
    const roleMeta =
      id && metas().find((m) => m.getAttribute('refines') === `#${id}` && m.getAttribute('property') === 'role');
    if (!roleMeta) return;
    const ids = new Set(Array.from(doc.getElementsByTagName('*')).map((el) => el.getAttribute('id')));
    let newId = 'creator';
    for (let n = 2; ids.has(newId); n++) newId = `creator-${n}`;
    to.setAttribute('id', newId);
    const meta = roleMeta.cloneNode(true);
    meta.setAttribute('refines', `#${newId}`);
    insertAfter(meta, roleMeta);
  }

  function setCreators(names) {
    const existing = dcAll('creator');
    let last = existing[existing.length - 1];
    names.forEach((name, i) => {
      const el = existing[i];
      if (!el) {
        const created = create('creator', name);
        if (last) {
          insertAfter(created, last);
          copyRole(last, created);
        } else metadata.appendChild(created);
        last = created;
      } else if (el.textContent.trim() !== name) {
        el.textContent = name;
        // el orden viejo ("Apellido, Nombre") ya no corresponde
        el.removeAttributeNS(OPF, 'file-as');
        removeRefines(el, 'file-as');
      }
    });
    existing.slice(names.length).forEach(remove);
  }

  function dropCalibreMeta(name) {
    metas()
      .filter((m) => m.getAttribute('name') === name)
      .forEach(removeNode);
  }

  return { setSingle, setCreators, dropCalibreMeta };
}

// La página de portada (y a veces el NCX o el CSS) apuntan a la imagen por nombre.
async function rewriteReferences(zip, oldName, newName) {
  const pattern = new RegExp(`(^|[/"'(])${escapeRegExp(oldName)}`, 'g');
  const textFiles = Object.values(zip.files).filter((f) => !f.dir && /\.(x?html?|ncx|css)$/i.test(f.name));
  await Promise.all(
    textFiles.map(async (f) => {
      const text = await f.async('string');
      const updated = text.replace(pattern, `$1${newName}`);
      if (updated !== text) zip.file(f.name, updated);
    }),
  );
}

async function replaceCover(zip, doc, opfDir, coverPath) {
  const type = IMAGE_TYPES[path.extname(coverPath).toLowerCase()];
  if (!type) throw Object.assign(new Error('la portada tiene que ser JPG, PNG o GIF'), { status: 400 });
  const ext = IMAGE_EXT[type];
  const data = await fs.readFile(coverPath);
  const manifest = byTag(doc, OPF, 'manifest')[0];
  const items = byTag(manifest, OPF, 'item');
  const resolve = (href) => normalizePath(opfDir + decodeHref(href));
  let item = findCoverItem(doc, items);

  if (item) {
    const oldHref = item.getAttribute('href');
    const newHref = oldHref.replace(/\.[^./]+$/, '') + '.' + ext;
    zip.remove(resolve(oldHref));
    zip.file(resolve(newHref), data);
    item.setAttribute('href', newHref);
    item.setAttribute('media-type', type);
    if (newHref !== oldHref) await rewriteReferences(zip, basename(oldHref), basename(newHref));
  } else {
    const ids = new Set(items.map((i) => i.getAttribute('id')));
    let id = 'cover-image';
    for (let n = 2; ids.has(id); n++) id = `cover-image-${n}`;
    const href = `${id}.${ext}`;
    zip.file(resolve(href), data);
    item = doc.createElementNS(OPF, 'item');
    item.setAttribute('id', id);
    item.setAttribute('href', href);
    item.setAttribute('media-type', type);
    if ((doc.documentElement.getAttribute('version') || '').startsWith('3')) {
      item.setAttribute('properties', 'cover-image');
    }
    manifest.appendChild(item);
  }

  // Los lectores EPUB2 buscan <meta name="cover">.
  const metadata = byTag(doc, OPF, 'metadata')[0];
  let meta = byTag(metadata, OPF, 'meta').find((m) => m.getAttribute('name') === 'cover');
  if (!meta) {
    meta = doc.createElementNS(OPF, 'meta');
    meta.setAttribute('name', 'cover');
    metadata.appendChild(meta);
  }
  meta.setAttribute('content', item.getAttribute('id'));
}

// mimetype tiene que ser la primera entrada y sin comprimir.
async function repack(zip, folders) {
  const out = new JSZip();
  out.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  const entries = Object.values(zip.files).filter((f) => !f.dir && f.name !== 'mimetype');
  const contents = await Promise.all(entries.map((f) => f.async('nodebuffer')));
  entries.forEach((f, i) => out.file(f.name, contents[i], { createFolders: false }));
  for (const name of folders) out.folder(name);
  return out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

// Edita el archivo en el lugar. `changes`: los campos que cambian (ver editBook en library.js).
export async function editEpub(file, changes) {
  const { zip, folders, opfPath, opfDir, opfText, doc } = await open(file);
  const opf = editOpf(doc);

  if (changes.title !== undefined) {
    opf.setSingle('title', changes.title);
    opf.dropCalibreMeta('calibre:title_sort');
  }
  if (changes.authors !== undefined) opf.setCreators(changes.authors);
  if (changes.language !== undefined) opf.setSingle('language', changes.language);
  if (changes.publisher !== undefined) opf.setSingle('publisher', changes.publisher);
  if (changes.description !== undefined) opf.setSingle('description', changes.description);
  if (changes.cover) await replaceCover(zip, doc, opfDir, changes.cover);

  const declaration = opfText.match(/^\s*<\?xml[^>]*\?>/)?.[0].trim() ?? '<?xml version="1.0" encoding="utf-8"?>';
  const body = new XMLSerializer().serializeToString(doc).replace(/^\s*<\?xml[^>]*\?>\s*/, '');
  zip.file(opfPath, `${declaration}\n${body}`);
  await fs.writeFile(file, await repack(zip, folders));
}
