// Conexión con el Kindle jailbreakeado por SSH (wifi).
//
// Variables de entorno:
//   KINDLE_HOST  IP del Kindle (si no está, usa la última conocida o la busca en la red)
//   KINDLE_PORT  puerto SSH (22 por defecto)
//   KINDLE_KEY   clave privada (~/.ssh/kindle_ed25519)
//
// La clave del Kindle se fija en CONFIG_DIR/known_hosts con el alias "kindle-admin",
// no por IP: así sobrevive a que el router le cambie la IP, y cualquier otro equipo
// que diga ser el Kindle es rechazado antes de mandarle nuestra clave.

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import { CACHE_DIR, CONFIG_DIR, exists, HttpError, sdrOf } from './common.js';

const HOST_FILE = path.join(CACHE_DIR, 'host');
const KNOWN_HOSTS = path.join(CONFIG_DIR, 'known_hosts');
const HOST_ALIAS = 'kindle-admin';
const PORT = Number(process.env.KINDLE_PORT) || 22;
export const KEY = process.env.KINDLE_KEY || path.join(os.homedir(), '.ssh', 'kindle_ed25519');

// ssh no acepta rutas de socket de más de 108 caracteres: va en una carpeta de ruta corta.
const CONTROL_PATH = path.join(process.env.XDG_RUNTIME_DIR || '/tmp', 'kindle-admin-ssh-%C');

let host = process.env.KINDLE_HOST || null;
let pinned = null;

async function isPinned() {
  pinned ||= await fs
    .readFile(KNOWN_HOSTS, 'utf8')
    .then((t) => t.trim() !== '')
    .catch(() => false);
  return pinned;
}

// Si ~/.ssh/known_hosts ya conoce la clave de `target` (de versiones anteriores), se fija esa.
async function pinFromUserKnownHosts(target) {
  const name = PORT === 22 ? target : `[${target}]:${PORT}`;
  const file = path.join(os.homedir(), '.ssh', 'known_hosts');
  const { stdout } = await promisify(execFile)('ssh-keygen', ['-F', name, '-f', file]).catch(() => ({ stdout: '' }));
  const lines = stdout
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => [HOST_ALIAS, ...l.split(' ').slice(1)].join(' '));
  if (!lines.length) return;
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(KNOWN_HOSTS, lines.join('\n') + '\n');
  pinned = true;
}

async function sshArgs(target, command, probe) {
  const common = ['-i', KEY, '-p', String(PORT), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5'];
  const keepAlive = ['-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3'];
  let hostKey;
  if (await isPinned()) {
    hostKey = ['StrictHostKeyChecking=yes', `UserKnownHostsFile=${KNOWN_HOSTS}`, `HostKeyAlias=${HOST_ALIAS}`];
  } else if (probe) {
    // Sin clave fijada todavía, al buscar se prueba contra otros equipos (el router): no se guarda nada.
    hostKey = ['StrictHostKeyChecking=no', 'UserKnownHostsFile=/dev/null', 'LogLevel=ERROR'];
  } else {
    hostKey = ['StrictHostKeyChecking=accept-new', `UserKnownHostsFile=${KNOWN_HOSTS}`, `HostKeyAlias=${HOST_ALIAS}`];
  }
  // Fuera de la búsqueda se reusa una sola conexión: abrir una por comando es lento sobre wifi.
  const control = probe
    ? ['-o', 'ControlMaster=no', '-o', 'ControlPath=none']
    : ['-o', 'ControlMaster=auto', '-o', `ControlPath=${CONTROL_PATH}`, '-o', 'ControlPersist=120'];
  return [...common, ...keepAlive, ...hostKey.flatMap((o) => ['-o', o]), ...control, `root@${target}`, command];
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// `input`: stream o Buffer para stdin; `output`: stream para stdout (si no, devuelve stdout como texto).
async function run(command, { input, output, target = host, probe = false, timeout } = {}) {
  if (!target) throw new HttpError(409, 'no hay ningún Kindle conectado');
  const child = spawn('ssh', await sshArgs(target, command, probe), { timeout });

  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));
  const exit = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) return resolve();
      const reason = signal ? `ssh cortado (${signal})` : `ssh terminó con código ${code}`;
      reject(Object.assign(new Error(stderr.trim() || reason), { code }));
    });
  });

  const chunks = [];
  const stdout = output
    ? pipeline(child.stdout, output)
    : (async () => {
        for await (const c of child.stdout) chunks.push(c);
      })();
  const stdin = input?.pipe
    ? pipeline(input, child.stdin)
    : new Promise((resolve, reject) => {
        child.stdin.on('error', reject);
        child.stdin.end(input, resolve);
      });
  // Si falla un lado (disco lleno, archivo ilegible), ssh quedaría esperando: se lo corta.
  stdout.catch(() => child.kill());
  stdin.catch(() => child.kill());

  const [e, o, i] = await Promise.allSettled([exit, stdout, stdin]);
  // El error de ssh explica mejor que el EPIPE que provoca del lado de stdin.
  for (const r of [e, o, i]) if (r.status === 'rejected') throw r.reason;
  return Buffer.concat(chunks).toString();
}

async function download(remote, local) {
  const out = createWriteStream(local);
  try {
    await run(`cat ${shellQuote(remote)}`, { output: out });
  } finally {
    out.destroy();
  }
}

// Sube a un temporal oculto y renombra, para no dejar un libro a medio escribir si se corta el wifi.
async function upload(local, remote) {
  const dir = path.posix.dirname(remote);
  const tmp = shellQuote(path.posix.join(dir, `.${path.posix.basename(remote)}.${randomUUID()}.tmp`));
  await run(
    `mkdir -p ${shellQuote(dir)} && { cat > ${tmp} && mv -f ${tmp} ${shellQuote(remote)} || { rm -f ${tmp}; exit 1; }; }`,
    { input: createReadStream(local) },
  );
}

function portOpen(target, timeout = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: target, port: PORT, timeout });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

const responds = (target) =>
  run('true', { target, timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

async function isKindle(target) {
  try {
    const out = await run('test -d /mnt/us/documents && cat /etc/prettyversion.txt', {
      target,
      probe: true,
      timeout: 8000,
    });
    if (!out.startsWith('Kindle')) return false;
    // Primera vez: se fija la clave de este Kindle.
    return (await isPinned()) || (await responds(target));
  } catch {
    return false;
  }
}

// Busca en la red local un equipo con el puerto SSH abierto que acepte la clave y sea un Kindle.
async function discover() {
  const prefixes = Object.values(os.networkInterfaces())
    .flat()
    .filter(
      (i) => i.family === 'IPv4' && !i.internal && i.netmask === '255.255.255.0' && !i.address.startsWith('172.17.'),
    )
    .map((i) => i.address.split('.').slice(0, 3).join('.'));
  for (const prefix of prefixes) {
    const candidates = Array.from({ length: 254 }, (_, n) => `${prefix}.${n + 1}`);
    const open = (await Promise.all(candidates.map(async (ip) => ((await portOpen(ip)) ? ip : null)))).filter(Boolean);
    for (const ip of open) if (await isKindle(ip)) return ip;
  }
  return null;
}

let lastDiscovery = 0;

// { host, state }: 'connected' si un comando corrió en el Kindle; si no 'unreachable' (dormido, sin wifi
// o no encontrado).
export async function findKindle() {
  if (!host) {
    host = (await fs.readFile(HOST_FILE, 'utf8').catch(() => '')).trim() || null;
  }
  if (host && !(await isPinned())) await pinFromUserKnownHosts(host);
  if (host && (await portOpen(host)) && (await responds(host))) return { host, state: 'connected' };

  // Buscar en la red como mucho una vez por minuto, y solo si ya hay clave
  // (sin clave ningún Kindle va a aceptar la conexión).
  if ((await exists(KEY)) && !process.env.KINDLE_HOST && Date.now() - lastDiscovery > 60_000) {
    lastDiscovery = Date.now();
    const found = await discover();
    if (found) {
      host = found;
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.writeFile(HOST_FILE, found);
      return { host, state: 'connected' };
    }
  }
  return { host, state: 'unreachable' };
}

const BOOKINFO_DB = '/mnt/us/koreader/settings/bookinfo_cache.sqlite3';

// Rutas del Kindle (/mnt/us/...). La misma forma que `transport` de lib/mtp.js (ver docs/ARQUITECTURA.md).
export const transport = {
  async list(dir) {
    const out = await run(
      `mkdir -p ${shellQuote(dir)} && cd ${shellQuote(dir)} && find . \\( -name '*.sdr' -o -name '.*' ! -name . \\) -prune -o -type f -exec stat -c '%s %Y %n' {} +`,
    );
    return out
      .split('\n')
      .map((line) => /^(\d+) (\d+) \.\/(.+)$/.exec(line))
      .filter(Boolean)
      .map((m) => ({ size: Number(m[1]), mtime: Number(m[2]), rel: m[3] }));
  },

  download,
  upload,

  async names(dir) {
    const out = await run(`[ -d ${shellQuote(dir)} ] && ls -1A ${shellQuote(dir)} || true`);
    return out.split('\n').filter(Boolean);
  },

  async removeFile(remote) {
    await run(`rm -f ${shellQuote(remote)}`);
  },

  async remove(remote) {
    await run(`rm -f ${shellQuote(remote)} && rm -rf ${shellQuote(sdrOf(remote))}`);
  },

  async forget(remote) {
    const sql = (s) => `'${s.replace(/'/g, "''")}'`;
    const dir = path.posix.dirname(remote) + '/';
    const query = `DELETE FROM bookinfo WHERE directory=${sql(dir)} AND filename=${sql(path.posix.basename(remote))};`;
    await run(`[ -f ${BOOKINFO_DB} ] && sqlite3 ${BOOKINFO_DB} ${shellQuote(query)} || true`);
  },
};
