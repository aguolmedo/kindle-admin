import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import JSZip from 'jszip';

import { editEpub, readEpub } from '../lib/epub.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kindle-admin-test-'));
after(() => fs.rm(dir, { recursive: true, force: true }));

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const DESCRIPTION = '&lt;p&gt;Hola &lt;b&gt;mundo&lt;/b&gt;&lt;/p&gt;';

async function makeEpub() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  // Sin entradas de carpeta, como la mayoría de los EPUB.
  const add = (name, data) => zip.file(name, data, { createFolders: false });
  add(
    'META-INF/container.xml',
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  add(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">x</dc:identifier>
    <dc:title>Rayuela</dc:title>
    <dc:creator>Julio Cortázar</dc:creator>
    <dc:description>${DESCRIPTION}</dc:description>
    <meta name="cover" content="cover"/>
  </metadata>
  <manifest>
    <item id="cover" href="images/cover.jpg" media-type="image/jpeg"/>
    <item id="p" href="cover.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="p"/></spine>
</package>`,
  );
  add('OEBPS/images/cover.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  add('OEBPS/cover.xhtml', '<html><body><img src="images/cover.jpg"/></body></html>');
  const file = path.join(await fs.mkdtemp(path.join(dir, 'epub-')), 'libro.epub');
  await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
  return file;
}

test('cambiar el título no reescribe la descripción', async () => {
  const file = await makeEpub();
  const names = async () => Object.keys((await JSZip.loadAsync(await fs.readFile(file))).files).sort();
  const before = await names();
  await editEpub(file, { title: 'Rayuela (2)' });
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const opf = await zip.file('OEBPS/content.opf').async('string');
  assert.ok(opf.includes(`<dc:description>${DESCRIPTION}</dc:description>`));
  assert.equal((await readEpub(file)).title, 'Rayuela (2)');
  assert.equal(Object.keys(zip.files)[0], 'mimetype');
  // Ni archivos ni entradas de carpeta de más o de menos.
  assert.deepEqual(await names(), before);
});

test('cambiar la portada a PNG renombra la imagen y sus referencias', async () => {
  const file = await makeEpub();
  const cover = path.join(path.dirname(file), 'nueva.png');
  await fs.writeFile(cover, PNG);
  await editEpub(file, { cover });
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  assert.equal(zip.file('OEBPS/images/cover.jpg'), null);
  assert.match(await zip.file('OEBPS/cover.xhtml').async('string'), /images\/cover\.png/);
  assert.ok((await readEpub(file)).cover.data.equals(PNG));
});
