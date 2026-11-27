import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const exists = (p) =>
  fs
    .access(p)
    .then(() => true)
    .catch(() => false);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const xdg = (name, fallback) => path.join(process.env[name] || path.join(os.homedir(), fallback), 'kindle-admin');
export const CACHE_DIR = xdg('XDG_CACHE_HOME', '.cache');
export const CONFIG_DIR = xdg('XDG_CONFIG_HOME', '.config');

// La carpeta de KOReader de un libro (progreso, notas y portada personalizada): libro.epub -> libro.sdr
export const sdrOf = (file) => file.replace(/\.[^./]+$/, '') + '.sdr';

// Una cola: cada `fn` corre cuando terminó la anterior.
export function serial() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}
