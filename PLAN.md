# kindle-admin — plan

## 1.0 (2026-11-12): terminada

Listar, agregar, editar y borrar EPUB y PDF en `/mnt/us/libros` de un Kindle
jailbreakeado con KOReader, por wifi (SSH) o por cable (MTP), con instalación
del acceso por wifi desde la app. Requisitos y uso en `README.md`, diseño en
`docs/ARQUITECTURA.md`.

## Auditoría (2026-11-12): hecha

Seguridad (Host/Origin, clave del Kindle fijada), streams de `ssh.run`, cola de
operaciones, campos editados solos, caché atómica y podada, limpieza de código
muerto, duplicados y comentarios, tests (`npm test`) y lint (`npm run lint`).

## Próximo

- Probado por wifi contra el Kindle (2026-11-12): conexión, clave fijada,
  listar, agregar, editar EPUB y PDF (con portada) y borrar. Falta probar por
  cable y la UI en el navegador.
- Subida atómica por cable (`gio copy` a un temporal + `gio move`): falta ver
  cómo se comporta gvfs-mtp al pisar un archivo.
- Fijar la clave del Kindle durante el setup por cable, en vez de aceptarla la
  primera vez: falta saber dónde guarda el dropbear de KOReader sus claves.
- `emergency.sh`: `iptables -I` en vez de `-A`. El marcador `kindle-admin` es
  laxo.
- `reading_defaults.lua` tiene `/mnt/us/libros` fijo.
- Nombres de archivo con salto de línea rompen el `list` por SSH.

## Fuera de alcance

- Colecciones del Kindle (`cc.db`) y libros de Amazon (KFX).
- Hosting en internet: solo local o en la red de casa (`BIND`/`EXTRA_HOSTS`).
