// Lee y edita la metadata de un PDF (el diccionario Info), que es lo que
// muestra KOReader: Title, Author y Subject (como descripción). Los PDF no
// tienen editorial ni portada aparte (la portada es la primera página), y el
// idioma está en el catálogo, así que esos campos no se tocan.
//
// Para leer se usa pdf.js, que sigue bien las tablas de referencias (muchos PDF
// tienen varias versiones de la metadata, por ejemplo si se editaron con
// Calibre). Para escribir no se reescribe
// el PDF: se le agrega al final una "actualización incremental" con un Info
// nuevo, como hacen Acrobat o Calibre. El contenido original queda intacto.

import fs from 'node:fs/promises';

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// En el PDF los autores van en un solo texto: se separan con "; " (o " & ").
const AUTHOR_SEP = '; ';
// Sin caracteres de control (hay PDF con "\0" al final del título).
// eslint-disable-next-line no-control-regex
const clean = (s) => (typeof s === 'string' ? s : '').replace(/[\u0000-\u001f]/g, ' ').trim();
const splitAuthors = (s) =>
  clean(s)
    .split(/\s*;\s*|\s+&\s+/)
    .map((a) => a.trim())
    .filter(Boolean);

// Muchos PDF traen como título lo que puso el programa que los generó
// ("Microsoft Word - libro.doc", "final.dvi"): ahí es mejor el nombre del archivo.
const JUNK_TITLE = /^(microsoft \w+ - |untitled\b)|\.(docx?|dvi|tex|pdf|indd|qxd|rtf|odt|ps)\s*$/i;

const fail = (message) => Object.assign(new Error(message), { status: 400 });

// El diccionario Info tal como lo resuelve pdf.js (la última versión).
async function readInfo(data) {
  let doc;
  try {
    doc = await getDocument({ data: new Uint8Array(data), verbosity: 0, isEvalSupported: false }).promise;
  } catch (e) {
    if (e.name === 'PasswordException') throw fail('el PDF está protegido con contraseña');
    throw fail(`no se pudo leer el PDF: ${e.message}`);
  }
  try {
    return (await doc.getMetadata()).info;
  } finally {
    await doc.destroy();
  }
}

// { title, authors, description }
export async function readPdf(file) {
  const info = await readInfo(await fs.readFile(file));
  const title = clean(info.Title);
  return {
    title: JUNK_TITLE.test(title) ? '' : title,
    authors: splitAuthors(info.Author),
    description: clean(info.Subject),
  };
}

// Texto PDF: ASCII como literal, el resto en UTF-16BE (hex con BOM).
function pdfString(s) {
  if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/[\\()]/g, '\\$&')})`;
  const utf16 = Buffer.from('\uFEFF' + s, 'utf16le').swap16();
  return `<${utf16.toString('hex').toUpperCase()}>`;
}

function pdfDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

// El diccionario `<< ... >>` que empieza en `start` (respeta anidados y strings).
function dictAt(text, start) {
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '(') {
      // String literal: se saltea entero (puede tener "<<" o ">>" adentro).
      for (let n = 1, j = i + 1; j < text.length; j++) {
        if (text[j] === '\\') j++;
        else if (text[j] === '(') n++;
        else if (text[j] === ')' && --n === 0) {
          i = j;
          break;
        }
      }
    } else if (text.startsWith('<<', i)) {
      depth++;
      i++;
    } else if (text.startsWith('>>', i)) {
      depth--;
      i++;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Lo que hace falta del último trailer: dónde está, si es tabla o stream, /Size, /Root y /ID.
function lastTrailer(data) {
  const tail = data.subarray(Math.max(0, data.length - 2048)).toString('latin1');
  const startxref = [...tail.matchAll(/startxref\s+(\d+)/g)].pop();
  if (!startxref) throw fail('el PDF está dañado (no tiene startxref)');
  const offset = Number(startxref[1]);
  const section = data.subarray(offset, offset + 1024 * 1024).toString('latin1');

  let dict = null;
  let isStream = false;
  if (/^\s*xref\b/.test(section)) {
    const at = section.indexOf('trailer');
    dict = at >= 0 ? dictAt(section, section.indexOf('<<', at)) : null;
  } else if (/^\s*\d+\s+\d+\s+obj\b/.test(section)) {
    isStream = true;
    dict = dictAt(section, section.indexOf('<<'));
  }
  if (!dict) throw fail('el PDF está dañado (no se encontró el trailer)');
  if (/\/Encrypt\b/.test(dict)) throw fail('el PDF está protegido: no se puede editar la metadata');

  const size = Number(/\/Size\s+(\d+)/.exec(dict)?.[1]);
  const root = /\/Root\s+(\d+\s+\d+\s+R)/.exec(dict)?.[1];
  if (!size || !root) throw fail('el PDF está dañado (trailer incompleto)');
  const id = /\/ID\s*(\[[^\]]*\])/.exec(dict)?.[1];
  return { offset, isStream, size, root, id };
}

// Edita el archivo en el lugar. `changes`: { title, authors[], description }, solo los que cambian.
export async function editPdf(file, changes) {
  const data = await fs.readFile(file);
  const info = await readInfo(data);
  const trailer = lastTrailer(data);

  const fields = {
    Title: clean(info.Title),
    Author: clean(info.Author),
    Subject: clean(info.Subject),
    Keywords: clean(info.Keywords),
    Creator: clean(info.Creator),
    Producer: clean(info.Producer),
    ...Object.fromEntries(Object.entries(info.Custom || {}).map(([k, v]) => [k, clean(v)])),
  };
  if (changes.title !== undefined) fields.Title = clean(changes.title);
  if (changes.authors !== undefined) fields.Author = clean(changes.authors.join(AUTHOR_SEP));
  if (changes.description !== undefined) fields.Subject = changes.description;

  const entries = Object.entries(fields)
    .filter(([k, v]) => v && /^[A-Za-z0-9_.-]+$/.test(k))
    .map(([k, v]) => `/${k} ${pdfString(v)}`);
  if (typeof info.CreationDate === 'string' && /^D:[\d+\-Z']+$/.test(info.CreationDate)) {
    entries.push(`/CreationDate (${info.CreationDate})`);
  }
  entries.push(`/ModDate (${pdfDate(new Date())})`);

  const infoNum = trailer.size;
  const common = `/Root ${trailer.root} /Info ${infoNum} 0 R${trailer.id ? ` /ID ${trailer.id}` : ''} /Prev ${trailer.offset}`;
  const parts = [];
  let pos = data.length;
  const push = (chunk) => {
    const b = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
    parts.push(b);
    pos += b.length;
  };

  push('\n');
  const infoOffset = pos;
  push(`${infoNum} 0 obj\n<< ${entries.join(' ')} >>\nendobj\n`);
  const xrefOffset = pos;

  if (trailer.isStream) {
    // Si el PDF usa streams de referencias, la actualización también (sin comprimir).
    const xrefNum = infoNum + 1;
    const row = (off) => {
      const b = Buffer.alloc(7);
      b[0] = 1;
      b.writeUInt32BE(off, 1);
      return b;
    };
    const rows = Buffer.concat([row(infoOffset), row(xrefOffset)]);
    push(
      `${xrefNum} 0 obj\n<< /Type /XRef /Size ${xrefNum + 1} /Index [${infoNum} 2] /W [1 4 2] ${common} /Length ${rows.length} >>\nstream\n`,
    );
    push(rows);
    push(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`);
  } else {
    push(`xref\n${infoNum} 1\n${String(infoOffset).padStart(10, '0')} 00000 n\r\n`);
    push(`trailer\n<< /Size ${infoNum + 1} ${common} >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  }

  const updated = Buffer.concat([data, ...parts]);
  // Antes de dar por bueno el cambio se relee: si no quedó bien, el archivo no se toca.
  const check = await readInfo(updated).catch(() => null);
  if (!check || clean(check.Title) !== fields.Title || clean(check.Author) !== fields.Author) {
    throw fail('no se pudo editar este PDF sin riesgo de romperlo');
  }
  await fs.writeFile(file, updated);
}
