# kindle-admin

Manager local de la biblioteca de un Kindle jailbreakeado que lee con KOReader.
Corre en la compu, sirve una página en `http://localhost:4242` y habla con el
Kindle por wifi (SSH) o por cable (MTP). Permite ver los libros con su portada,
agregar EPUB y PDF (arrastrándolos), editar título, autores, editorial, idioma,
descripción y portada, y borrarlos.

Cómo está armado por dentro: [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md).

## Requisitos

### En la compu

- Linux (usa `/run/user/$UID/gvfs` y `XDG_*`).
- Node 22 o más nuevo.
- Cliente OpenSSH (`ssh` y `ssh-keygen`).
- Para usarlo por cable: `gvfs-mtp` y `gio` (el escritorio tiene que montar
  el Kindle solo al enchufarlo).
- Para usarlo por wifi: la compu y el Kindle en la misma red, con máscara
  `/24` (la búsqueda del Kindle recorre esa red).

### En el Kindle

1. **Jailbreak.** Se hizo con [Véra](https://kindlemodding.org/jailbreaking/Vera/)
   (Kindle 11ª gen 2024, `KT6`, firmware 5.20.1). Para otro modelo o firmware,
   ver [kindlemodding.org/jailbreaking](https://kindlemodding.org/jailbreaking/).
   Véra ya bloquea las actualizaciones automáticas (OTA) y trae el gestor de
   paquetes KPM. Para comprobar que quedó: escribir `;log` en la búsqueda.
2. **KOReader.** En la búsqueda del Kindle: `;kpm update` y después
   `;kpm install koreader`.
3. **Carpeta de inicio de KOReader:** `/mnt/us/libros` (ahí pone los libros
   kindle-admin). `documents/` queda para el lector de Amazon.

### Acceso por wifi (clave SSH y script de arranque)

Lo más simple es hacerlo desde la app:

1. `npm install && npm start` y abrir http://localhost:4242.
2. Conectar el Kindle por cable. Aparece un panel con lo que tiene instalado.
3. Tocar **habilitar acceso por wifi**. Eso:
   - genera la clave `~/.ssh/kindle_ed25519` si no existe (la privada nunca
     sale de la compu);
   - agrega la pública a `/mnt/us/koreader/settings/SSH/authorized_keys`;
   - copia `kindle/emergency.sh` a `/mnt/us/emergency.sh`. El jailbreak lo
     corre en cada arranque: levanta un SSH en el puerto 22 (solo con clave,
     con el dropbear de KOReader) y abre KOReader cuando el Kindle terminó de
     arrancar.
4. Reiniciar el Kindle y desenchufarlo. Cuando termina de arrancar, la app lo
   encuentra sola por wifi.

Si ya hay un `/mnt/us/emergency.sh` que no es de kindle-admin, la app no lo
pisa.

A mano sería: `ssh-keygen -t ed25519 -f ~/.ssh/kindle_ed25519`, copiar el
`.pub` a ese `authorized_keys` y `kindle/emergency.sh` a `/mnt/us/` por MTP.

Recomendado: reservarle una IP fija al Kindle en el router. La app guarda la
última IP en `~/.cache/kindle-admin/host` y solo recorre la red si deja de
responder.

### La clave del Kindle (host key)

La primera vez que la app se conecta, guarda la clave SSH del Kindle en
`~/.config/kindle-admin/known_hosts`, a nombre de `kindle-admin` y no de la IP. Si
ya te habías conectado antes, la toma de `~/.ssh/known_hosts`. A partir de ahí
solo habla con un equipo que tenga esa clave, aunque cambie la IP. Al buscar en
la red, cualquier otro equipo se descarta antes de mandarle tu clave.

Si reinstalás KOReader o le hacés un reset al Kindle, la clave cambia y la app
deja de conectarse por wifi. Para aceptar la nueva, borrá
`~/.config/kindle-admin/known_hosts`.

## Uso

```sh
npm install
npm start          # o npm run dev (se reinicia al cambiar el código)
```

El Kindle se duerme y corta el wifi: mientras tanto la app muestra "no
encuentro el Kindle" hasta que se lo despierta.

La página solo funciona entrando por `http://localhost:4242` o
`http://127.0.0.1:4242`. Cualquier otro nombre, u otro sitio abierto en el
navegador que intente usar la API, recibe un 403.

Para correrla en otra máquina de la red (un servidor de casa) y entrar desde
la compu: `BIND=0.0.0.0 EXTRA_HOSTS=192.168.1.10,servidor npm start`, con la IP
o el nombre por el que se entra. No tiene contraseña: cualquiera en la red
puede manejar el Kindle. Por cable (MTP) solo funciona en la máquina donde se
enchufa el Kindle.

### Desarrollo

```sh
npm test           # tests (node:test) de la escritura de EPUB y PDF
npm run lint       # eslint + prettier --check
npm run format     # prettier --write
```

Los tests cubren solo lo más delicado: que editar un PDF no toque su
contenido, y que editar un EPUB no reescriba lo que no cambió. El resto se
prueba contra el Kindle. Para no tocar la biblioteca real, usá
`KINDLE_LIBRARY=/mnt/us/libros-prueba` y otro `XDG_CACHE_HOME`.

### Variables de entorno

| Variable | Por defecto | Para qué |
|---|---|---|
| `PORT` | `4242` | puerto de la página |
| `BIND` | `127.0.0.1` | dirección donde escucha (`0.0.0.0` para toda la red) |
| `EXTRA_HOSTS` | (ninguno) | otros nombres o IPs aceptados en `Host`, separados por comas |
| `KINDLE_HOST` | (la última conocida, o la busca) | IP fija del Kindle; con esto no recorre la red |
| `KINDLE_PORT` | `22` | puerto SSH del Kindle |
| `KINDLE_KEY` | `~/.ssh/kindle_ed25519` | clave privada |
| `KINDLE_LIBRARY` | `/mnt/us/libros` | carpeta de la biblioteca en el Kindle |

### Ajustes de lectura parecidos a los de Amazon (opcional)

`kindle/reading_defaults.lua` pone Bookerly, tamaño, interlineado y márgenes
como predeterminados de KOReader y saca los ajustes de diseño guardados en
cada libro de `/mnt/us/libros` (no toca progreso ni notas). Con KOReader
cerrado, en el Kindle:

```sh
cd /mnt/us/koreader && ./luajit /ruta/a/reading_defaults.lua
```

## Límites conocidos

- Solo EPUB y PDF. Los libros de Amazon (KFX) siguen en el lector nativo.
- De los PDF se editan título, autores y descripción. La portada de un PDF se
  cambia con la portada personalizada de KOReader (no se toca el PDF). Los PDF
  protegidos no se editan.
- Los archivos de más de 100 MB no se bajan para leer la metadata.
- Por cable no se puede limpiar la caché de KOReader: KOReader relee el libro
  cuando cambia su fecha. Por eso una portada nueva de un PDF, puesta por cable,
  puede no verse hasta que se limpia la caché de portadas de KOReader.
- Por cable la subida no es atómica (por wifi sí): si se desenchufa a mitad de
  una edición, el libro puede quedar roto.
- El título no se puede dejar vacío. Autores, idioma, editorial y descripción sí.
- Borrar un libro borra también su `.sdr` (progreso y notas de KOReader).

## Desactivar o revertir

- Sin SSH por wifi: borrar `/mnt/us/emergency.sh` (por cable) y reiniciar.
- Que no abra KOReader al arrancar: crear `/mnt/us/NO_KOREADER_AUTOSTART`.
- Sacar el jailbreak: ver [kindlemodding.org/jailbreaking](https://kindlemodding.org/jailbreaking/)
  (scriptlet `ota.sh`, factory reset y firmware igual o más nuevo). Se pierde
  el jailbreak para siempre si ese firmware no tiene exploit.
