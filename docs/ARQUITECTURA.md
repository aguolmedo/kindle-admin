# Arquitectura

```
navegador (public/)  ──HTTP──▶  server.js  ──▶  lib/library.js  ──▶  transporte
  app.js, index.html            127.0.0.1:4242    listar/agregar/       ├─ lib/ssh.js  (wifi, ssh + shell del Kindle)
  styles.css                    rutas /api/*      editar/borrar         └─ lib/mtp.js  (cable, gvfs + gio)
                                                    │
                                                    ├─ lib/epub.js  (OPF y portada, jszip + xmldom)
                                                    └─ lib/pdf.js   (Info, pdfjs + actualización incremental)
```

Sin framework ni build: Node con ESM en el servidor y JS plano en el navegador.
Dependencias: `jszip`, `@xmldom/xmldom`, `pdfjs-dist`.

## Módulos

| Archivo | Qué hace |
|---|---|
| `server.js` | Servidor HTTP: filtro de Host/Origin, estado de conexión (polling cada 5 s), cola de operaciones, caché del listado en memoria, estáticos y portadas. |
| `lib/common.js` | `HttpError`, `exists`, carpetas XDG, la regla del `.sdr` y `serial()` (una cola de promesas). |
| `lib/ssh.js` | `run()` de comandos remotos con una conexión compartida (ControlMaster), subida atómica (temporal oculto + `mv`), clave del Kindle fijada, búsqueda en la `/24`, y el `transport` SSH. |
| `lib/mtp.js` | Encuentra el Kindle montado por gvfs, lee por la carpeta FUSE y escribe con `gio` (gvfs-mtp no acepta escrituras normales). Expone el `transport` USB. |
| `lib/setup.js` | Por cable: revisa jailbreak/KOReader/clave/script y los instala ("habilitar acceso por wifi"). |
| `lib/library.js` | La lógica de la biblioteca sobre un transporte cualquiera, más la caché de metadata y portadas. |
| `lib/epub.js` | Lee y edita la metadata y la portada de un EPUB reescribiendo el OPF. |
| `lib/pdf.js` | Lee el diccionario Info con pdf.js y escribe uno nuevo agregado al final del archivo. |
| `public/app.js` | Grilla, búsqueda, diálogo de edición en el lugar, recorte de portada, subida por arrastre. |
| `kindle/emergency.sh` | Corre en el Kindle en cada arranque: SSH en el 22 y KOReader. |
| `kindle/reading_defaults.lua` | Script opcional para KOReader (ajustes de lectura). |

## El transporte

`library.js` no sabe si está hablando por wifi o por cable. Recibe un objeto
con esta forma (rutas siempre del Kindle, `/mnt/us/...`):

| Método | |
|---|---|
| `list(dir)` | archivos bajo `dir` como `{ rel, size, mtime }`, sin `.sdr` ni ocultos |
| `download(remote, local)` / `upload(local, remote)` | copiar en cada sentido |
| `names(dir)` | nombres de una carpeta (`[]` si no existe) |
| `removeFile(remote)` | borra un archivo |
| `remove(remote)` | borra un libro y su `.sdr` |
| `forget(remote)` | borra la fila del libro en la caché de KOReader (`bookinfo_cache.sqlite3`); por cable no hace nada |

`server.js` elige el transporte en cada pedido: SSH si el Kindle responde por
wifi (un comando de verdad, no solo el puerto abierto), si no USB, si no error
409.

Cada libro del listado trae `fields`, los campos que se pueden editar según el
formato. El front muestra solo esos, y el back rechaza cualquier otro.

## Flujos

- **Listar:** `list(LIBRARY)` → para cada libro que no está en la caché, se
  baja a un temporal, se lee la metadata y la portada y se guarda en
  `~/.cache/kindle-admin/meta.json` (escritura atómica) y `covers/`. La clave
  de la caché es `ruta|tamaño` (sin fecha: por cable y por wifi difiere). Si
  una bajada falla, el libro sale como `pending` y no se guarda nada, así que
  se reintenta. Al final se podan las entradas y portadas de libros que ya no
  están. El id de un libro es su ruta en base64url.
- **Agregar:** el navegador manda el archivo crudo en el cuerpo y el nombre en
  `x-filename`. Se valida (EPUB legible o cabecera `%PDF-`), se arma el nombre
  `Título - Autores.ext` (libre sin distinguir mayúsculas, porque la tarjeta es
  FAT32), se sube tal cual sin convertir y la metadata queda en la caché.
- **Editar EPUB:** bajar → editar el OPF (y la portada dentro del ZIP) → subir
  → `forget` → actualizar la caché con lo recién escrito.
- **Editar PDF:** la metadata va en el PDF (actualización incremental, se
  relee antes de escribir para comprobarla); la portada va aparte, como
  `cover.<ext>` dentro del `.sdr` (portada personalizada de KOReader). Si solo
  cambia la portada, el PDF no se baja.
- **Borrar:** `remove` (libro y `.sdr`) y `forget`.

El front manda solo los campos que cambiaron. Así no se reescribe lo que no se
tocó, como la descripción HTML de un EPUB.

Listados, cambios y el setup pasan de a uno por una cola (`exclusive` en
`server.js`): comparten la caché y los archivos del Kindle. Cada cambio
invalida el listado en memoria.

## Seguridad

- El servidor escucha en `127.0.0.1` (o en `BIND`) y además solo atiende `Host:
  localhost:PORT`, `127.0.0.1:PORT` o los de `EXTRA_HOSTS` (DNS rebinding). Los pedidos que no son
  GET necesitan el header `x-kindle-admin` y, si traen `Origin`, que sea el
  propio (CSRF). El front lo manda en `api()`.
- SSH: la clave del Kindle se fija con `HostKeyAlias=kindle-admin` en
  `~/.config/kindle-admin/known_hosts`. Al principio se toma de
  `~/.ssh/known_hosts` o se acepta la primera vez, pero solo después de
  comprobar que es un Kindle. La búsqueda en la red no comparte la conexión
  (`ControlMaster=no`) y, con la clave ya fijada, descarta a cualquier otro
  equipo antes de autenticarse.
- Los comandos remotos citan todo con `shellQuote`. Las rutas locales se
  validan con `inside()`.

## Dónde queda cada cosa

En la compu:

- `~/.cache/kindle-admin/host`: última IP del Kindle.
- `~/.cache/kindle-admin/meta.json` y `covers/`: caché de metadata y portadas.
- `~/.ssh/kindle_ed25519`: clave SSH.
- `~/.config/kindle-admin/known_hosts`: la clave del Kindle.
- `$XDG_RUNTIME_DIR/kindle-admin-ssh-*`: socket de la conexión compartida.

En el Kindle:

- `/mnt/us/libros/`: la biblioteca (cada libro con su `.sdr` de KOReader).
- `/mnt/us/emergency.sh`: script de arranque.
- `/mnt/us/koreader/settings/SSH/authorized_keys`: clave pública.
- `/mnt/us/koreader/settings/bookinfo_cache.sqlite3`: caché de KOReader que se limpia al editar o borrar.

## Decisiones

- **Sin Calibre ni conversión:** KOReader lee EPUB y PDF directo.
- **Carpeta propia (`/mnt/us/libros`)** separada de `documents/`, que es del
  lector de Amazon.
- **PDF con actualización incremental** en vez de reescribirlo: no toca el
  contenido, y pdf-lib leía versiones viejas de la metadata en PDF editados
  por Calibre.
- **SSH por línea de comandos** (no una librería): reusa la config y el
  ControlMaster de OpenSSH; las rutas se citan con `q()` para el shell del
  Kindle.
- **Tests mínimos, sin dobles:** solo la escritura de PDF y EPUB, sobre
  archivos de verdad. Lo demás se prueba contra el Kindle, con una carpeta de
  prueba (`KINDLE_LIBRARY`).
- **MTP como respaldo** por si se pierde el jailbreak o no hay wifi.
- Fuera de alcance: colecciones (`cc.db`) y los KFX de Amazon.
