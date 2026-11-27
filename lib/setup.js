// "Habilitar acceso por wifi": con el Kindle conectado por cable, instala lo
// necesario para que después se pueda usar por SSH sin cable.
//
//   - la clave pública de esta compu en koreader/settings/SSH/authorized_keys
//     (la usa el dropbear de KOReader);
//   - kindle/emergency.sh en /mnt/us/emergency.sh, que el jailbreak corre en cada
//     arranque: levanta el SSH en el puerto 22 y abre KOReader.
//
// La clave privada se genera acá y nunca sale de esta compu.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { exists, HttpError } from './common.js';
import * as mtp from './mtp.js';
import { KEY } from './ssh.js';

const exec = promisify(execFile);
const BOOT_SCRIPT = '/mnt/us/emergency.sh';
const AUTHORIZED_KEYS = '/mnt/us/koreader/settings/SSH/authorized_keys';
const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kindle', 'emergency.sh');
// Así se reconoce un emergency.sh puesto por kindle-admin (para no pisar uno ajeno).
const MARKER = 'kindle-admin';

const readLocal = (file) =>
  fs
    .readFile(file, 'utf8')
    .then((s) => s.trim())
    .catch(() => null);
const readOr = (remote, fallback) => mtp.readFile(remote, 'utf8').catch(() => fallback);

async function ensureKey() {
  const pub = await readLocal(`${KEY}.pub`);
  if (pub) return pub;
  if (await exists(KEY)) {
    // Está la privada pero no la pública: se regenera la pública (ssh-keygen preguntaría si pisar la privada).
    const { stdout } = await exec('ssh-keygen', ['-y', '-f', KEY]);
    await fs.writeFile(`${KEY}.pub`, stdout);
  } else {
    await fs.mkdir(path.dirname(KEY), { recursive: true, mode: 0o700 });
    await exec('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'kindle-admin', '-f', KEY, '-q']);
  }
  return readLocal(`${KEY}.pub`);
}

// Qué tiene el Kindle conectado por cable. `sshEnabled`: ya está todo instalado.
export async function usbStatus() {
  const [jailbreak, koreader, keys, script, pub] = await Promise.all([
    Promise.all([mtp.fileExists('/mnt/us/kmc'), mtp.fileExists('/mnt/us/libkh')]).then((r) => r.some(Boolean)),
    mtp.fileExists('/mnt/us/koreader/koreader.sh'),
    readOr(AUTHORIZED_KEYS, ''),
    readOr(BOOT_SCRIPT, null),
    readLocal(`${KEY}.pub`),
  ]);
  // Se compara solo el cuerpo de la clave (sin el comentario del final).
  const keyInstalled = Boolean(pub) && keys.includes(pub.split(/\s+/)[1]);
  const bootScript = script === null ? 'missing' : script.includes(MARKER) ? 'ours' : 'other';
  return { jailbreak, koreader, keyInstalled, bootScript, sshEnabled: keyInstalled && bootScript === 'ours' };
}

export async function enableSsh() {
  const status = await usbStatus();
  if (!status.jailbreak)
    throw new HttpError(409, 'el Kindle no parece jailbreakeado (no encuentro las carpetas del jailbreak)');
  if (!status.koreader) {
    throw new HttpError(
      409,
      'falta KOReader: instalalo en el Kindle escribiendo ";kpm install koreader" en la búsqueda',
    );
  }
  if (status.bootScript === 'other') {
    throw new HttpError(409, 'el Kindle ya tiene un /mnt/us/emergency.sh que no es de kindle-admin: no lo piso');
  }

  const pub = await ensureKey();
  if (!status.keyInstalled) {
    const keys = (await readOr(AUTHORIZED_KEYS, '')).trimEnd();
    await mtp.writeFile(AUTHORIZED_KEYS, `${keys ? keys + '\n' : ''}${pub}\n`);
  }
  // También se reescribe si es de kindle-admin pero de una versión vieja.
  const template = await fs.readFile(TEMPLATE, 'utf8');
  if ((await readOr(BOOT_SCRIPT, null)) !== template) await mtp.writeFile(BOOT_SCRIPT, template);
  return usbStatus();
}
