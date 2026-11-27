// Conexión con el Kindle por cable (MTP, montado por gvfs).
//
// Se lee por la carpeta FUSE de gvfs y se escribe con `gio`: gvfs-mtp no acepta
// escrituras con las llamadas normales de fs (da ENOTSUP). Las rutas que reciben
// estas funciones son las del Kindle (/mnt/us/...), igual que en lib/ssh.js.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { exists, HttpError, sdrOf } from './common.js';

const exec = promisify(execFile);
const GVFS = `/run/user/${process.getuid()}/gvfs`;
const US = '/mnt/us';

// La carpeta local que corresponde a /mnt/us; la actualiza findKindle().
let root = null;

const isDir = (p) =>
  fs
    .stat(p)
    .then((s) => s.isDirectory())
    .catch(() => false);
const gio = (...args) => exec('gio', args);

export async function findKindle() {
  const hosts = (await fs.readdir(GVFS).catch(() => [])).filter((n) => n.startsWith('mtp:host=') && /kindle/i.test(n));
  for (const host of hosts) {
    for (const storage of await fs.readdir(path.join(GVFS, host)).catch(() => [])) {
      const candidate = path.join(GVFS, host, storage);
      if (await isDir(path.join(candidate, 'documents'))) return (root = candidate);
    }
  }
  return (root = null);
}

function local(remote) {
  if (!root) throw new HttpError(409, 'no hay ningún Kindle conectado por cable');
  if (remote !== US && !remote.startsWith(US + '/')) throw new Error(`ruta fuera de ${US}: ${remote}`);
  return path.join(root, remote.slice(US.length));
}

async function mkdirp(remote) {
  let current = US;
  for (const part of remote.slice(US.length).split('/').filter(Boolean)) {
    current += '/' + part;
    if (!(await exists(local(current)))) await gio('mkdir', local(current));
  }
}

async function removeTree(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await removeTree(p);
    else await gio('remove', p);
  }
  await gio('remove', dir);
}

async function upload(localFile, remote) {
  await mkdirp(path.posix.dirname(remote));
  await gio('copy', localFile, local(remote));
}

export async function writeFile(remote, content) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kindle-admin-'));
  try {
    const file = path.join(tmp, path.posix.basename(remote));
    await fs.writeFile(file, content);
    await upload(file, remote);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

export const readFile = (remote, encoding) => fs.readFile(local(remote), encoding);
export const fileExists = (remote) => exists(local(remote));

// La misma forma que `transport` de lib/ssh.js (ver docs/ARQUITECTURA.md).
export const transport = {
  async list(dir) {
    await mkdirp(dir);
    const out = [];
    async function walk(rel) {
      for (const entry of await fs.readdir(path.join(local(dir), rel), { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name.endsWith('.sdr')) continue;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(childRel);
        else if (entry.isFile()) {
          const st = await fs.stat(path.join(local(dir), childRel));
          out.push({ rel: childRel, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) });
        }
      }
    }
    await walk('');
    return out;
  },

  async download(remote, localFile) {
    await fs.copyFile(local(remote), localFile);
  },

  upload,

  async names(dir) {
    return fs.readdir(local(dir)).catch(() => []);
  },

  async removeFile(remote) {
    if (await exists(local(remote))) await gio('remove', local(remote));
  },

  async remove(remote) {
    await gio('remove', local(remote));
    const sdr = local(sdrOf(remote));
    if (await exists(sdr)) await removeTree(sdr);
  },

  // Por cable no se puede tocar la base de KOReader. KOReader relee un libro cuando
  // cambia su fecha, así que una portada nueva de un PDF puede no verse hasta borrar
  // la caché de portadas en KOReader.
  async forget() {},
};
