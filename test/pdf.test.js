import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { editPdf, readPdf } from '../lib/pdf.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindle-admin-test-'));
after(() => fs.rm(dir, { recursive: true, force: true }));

// PDF mínimo de una página, con tabla de referencias clásica o con stream de referencias.
function makePdf(xrefStream) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    '<< /Title (Ficciones) /Author (Jorge Luis Borges) >>',
  ];
  let out = '%PDF-1.5\n';
  const offsets = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  if (!xrefStream) {
    out += `xref\n0 5\n0000000000 65535 f\r\n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n\r\n`).join('')}`;
    return Buffer.from(`${out}trailer\n<< /Size 5 /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1');
  }
  const row = (type, offset, gen) => {
    const r = Buffer.alloc(7);
    r[0] = type;
    r.writeUInt32BE(offset, 1);
    r.writeUInt16BE(gen, 5);
    return r;
  };
  const rows = Buffer.concat([row(0, 0, 0xffff), ...offsets.map((o) => row(1, o, 0)), row(1, xref, 0)]);
  return Buffer.concat([
    Buffer.from(
      `${out}5 0 obj\n<< /Type /XRef /Size 6 /W [1 4 2] /Root 1 0 R /Info 4 0 R /Length ${rows.length} >>\nstream\n`,
      'latin1',
    ),
    rows,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${xref}\n%%EOF\n`, 'latin1'),
  ]);
}

for (const xrefStream of [false, true]) {
  test(`edita sin tocar el contenido original (${xrefStream ? 'stream de referencias' : 'tabla xref'})`, async () => {
    const file = path.join(await fs.mkdtemp(path.join(dir, 'pdf-')), 'libro.pdf');
    const original = makePdf(xrefStream);
    await fs.writeFile(file, original);

    await editPdf(file, { title: 'Ñandú — edición', authors: ['Ana', 'Beto'] });
    // Una segunda edición encadena otra actualización y conserva lo que no cambia.
    await editPdf(file, { description: 'Cuentos' });

    assert.deepEqual(await readPdf(file), {
      title: 'Ñandú — edición',
      authors: ['Ana', 'Beto'],
      description: 'Cuentos',
    });
    assert.ok((await fs.readFile(file)).subarray(0, original.length).equals(original));
  });
}
