document.addEventListener('DOMContentLoaded', function () {
  const grid = document.getElementById('grid');
  const search = document.getElementById('search');
  const count = document.getElementById('count');
  const empty = document.getElementById('empty');
  const device = document.getElementById('device');
  const addButton = document.getElementById('add');
  const toastEl = document.getElementById('toast');

  const dialog = document.getElementById('book');
  const coverImg = document.getElementById('book-cover');
  const coverEdit = document.getElementById('cover-edit');
  const coverInput = document.getElementById('cover-input');
  const fields = [...dialog.querySelectorAll('.editable')];
  const saveButton = document.getElementById('book-save');
  const discardButton = document.getElementById('book-discard');
  const deleteButton = document.getElementById('book-delete');
  const bookStatus = document.getElementById('book-status');

  const addDialog = document.getElementById('add-dialog');
  const fileInput = document.getElementById('file-input');
  const dropzone = addDialog.querySelector('.dropzone');
  const addStatus = document.getElementById('add-status');
  const dropOverlay = document.getElementById('drop-overlay');

  const setup = document.getElementById('setup');
  const setupButton = document.getElementById('setup-ssh');
  const setupStatus = document.getElementById('setup-status');

  let books = [];
  let items = [];
  let current = null;
  let newCover = null;
  let saving = false;
  let connected = false;
  let connectedVia = null;

  const authorsText = (book) => book.authors.join(', ') || 'autor desconocido';
  const normalize = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  async function api(path, options = {}) {
    // El servidor rechaza los cambios que no traen este header (ver server.js).
    const headers = { ...options.headers, ...(options.method ? { 'x-kindle-admin': '1' } : {}) };
    const res = await fetch(path, { ...options, headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `error ${res.status}`);
    return body;
  }

  let toastTimer = null;
  function toast(text, isError = false) {
    toastEl.textContent = text;
    toastEl.classList.toggle('error', isError);
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), isError ? 8000 : 4000);
  }

  function placeholder(book) {
    const div = document.createElement('div');
    div.className = 'placeholder';
    div.textContent = book.title;
    return div;
  }

  async function checkStatus() {
    let status;
    try {
      status = await api('/api/status');
    } catch {
      device.dataset.state = 'off';
      device.textContent = 'el servidor no responde';
      return;
    }
    const isConnected = status.state === 'connected';
    if (status.via === 'ssh') {
      device.dataset.state = 'on';
      device.textContent = `conectado por wifi · ${status.host}`;
    } else if (status.via === 'usb') {
      device.dataset.state = 'on';
      device.textContent = 'conectado por cable';
    } else if (status.state === 'searching') {
      device.dataset.state = 'off';
      device.textContent = 'buscando el Kindle…';
    } else {
      device.dataset.state = 'locked';
      device.textContent = 'no encuentro el Kindle: despertalo y fijate que tenga wifi, o conectalo por cable';
    }
    addButton.disabled = !isConnected;
    renderSetup(status);
    // Recargar también si cambia el medio (de cable a wifi, por ejemplo).
    if (isConnected !== connected || status.via !== connectedVia) {
      connected = isConnected;
      connectedVia = status.via;
      if (connected) loadBooks();
      else render([]);
    }
  }

  function renderSetup(status) {
    const usb = status.usb;
    setup.hidden = !usb || (usb.sshEnabled && status.via === 'ssh');
    if (setup.hidden) return;

    const checks = document.getElementById('setup-checks');
    checks.replaceChildren();
    if (usb.sshEnabled) {
      document.getElementById('setup-text').textContent =
        'El acceso por wifi está instalado. Reiniciá el Kindle (mantené apretado el botón de encendido → Reiniciar) ' +
        'y desenchufalo: cuando termine de arrancar se conecta solo por wifi.';
      setupButton.hidden = true;
      return;
    }

    document.getElementById('setup-text').textContent =
      'Kindle conectado por cable. Podés habilitar el acceso por wifi para usarlo sin cable.';
    const requirements = [
      [usb.jailbreak, 'jailbreak', 'no encuentro el jailbreak en el Kindle'],
      [usb.koreader, 'KOReader instalado', 'falta KOReader: escribí ";kpm install koreader" en la búsqueda del Kindle'],
      [
        usb.bootScript !== 'other',
        'script de arranque',
        'ya hay un emergency.sh que no es de kindle-admin: no lo voy a pisar',
      ],
    ];
    for (const [ok, good, bad] of requirements) {
      const li = document.createElement('li');
      li.className = ok ? 'ok' : 'missing';
      li.textContent = ok ? good : bad;
      checks.appendChild(li);
    }
    setupButton.hidden = false;
    setupButton.disabled = !requirements.every(([ok]) => ok);
  }

  setupButton.addEventListener('click', async () => {
    setupButton.disabled = true;
    setupStatus.classList.remove('error');
    setupStatus.textContent = 'instalando en el Kindle…';
    try {
      const usb = await api('/api/setup/ssh', { method: 'POST' });
      setupStatus.textContent = '';
      toast('acceso por wifi instalado');
      renderSetup({ usb, via: connectedVia });
    } catch (e) {
      setupStatus.classList.add('error');
      setupStatus.textContent = e.message;
      setupButton.disabled = false;
    }
  });

  async function loadBooks() {
    count.textContent = 'leyendo el Kindle…';
    try {
      const { books } = await api('/api/books');
      render(books);
    } catch (e) {
      toast(e.message, true);
      count.textContent = '';
    }
  }

  function render(list) {
    books = list;
    grid.replaceChildren();
    items = books.map((book) => {
      const li = document.createElement('li');
      const poster = document.createElement('button');
      poster.type = 'button';
      poster.className = 'poster';
      poster.title = `${book.title} — ${authorsText(book)}`;

      if (book.cover) {
        const img = document.createElement('img');
        img.src = book.cover;
        img.alt = book.title;
        img.loading = 'lazy';
        poster.appendChild(img);
      } else {
        poster.appendChild(placeholder(book));
      }

      const caption = document.createElement('span');
      caption.className = 'caption';
      caption.textContent = book.title;

      poster.append(caption);
      poster.addEventListener('click', () => openBook(book));
      li.appendChild(poster);
      grid.appendChild(li);
      return { li, book, haystack: normalize(`${book.title} ${book.authors.join(' ')}`) };
    });
    filter();
  }

  function filter() {
    const q = normalize(search.value.trim());
    let shown = 0;
    for (const item of items) {
      item.li.hidden = Boolean(q) && !item.haystack.includes(q);
      if (!item.li.hidden) shown++;
    }
    count.textContent = q ? `${shown} de ${items.length} libros` : `${items.length} libros`;
    empty.hidden = shown > 0 || !connected;
  }

  search.addEventListener('input', filter);

  // --- diálogo de un libro: los campos se editan ahí mismo ---

  // Los autores se muestran y se escriben separados por " & ".
  const fieldValue = (book, field) => (field === 'authors' ? book.authors.join(' & ') : book[field] || '');
  const fieldText = (el) => el.textContent.trim();

  // Texto plano editable; los navegadores sin "plaintext-only" usan "true" (y el pegado se limpia abajo).
  function setEditable(el) {
    try {
      el.contentEditable = 'plaintext-only';
    } catch {
      el.contentEditable = 'true';
    }
  }

  function showCover(src) {
    coverEdit.querySelector('.placeholder')?.remove();
    coverImg.hidden = !src;
    if (src) coverImg.src = src;
    else coverEdit.prepend(placeholder(current));
  }

  function openBook(book) {
    if (crop) endCrop();
    current = book;
    newCover = null;
    showCover(book.cover);
    coverImg.alt = book.title;
    coverInput.disabled = !book.fields.includes('cover');
    for (const el of fields) {
      el.textContent = fieldValue(book, el.dataset.field);
      el.hidden = !book.fields.includes(el.dataset.field);
      setEditable(el);
    }
    const size = `${(book.size / 1024 / 1024).toFixed(1)} MB`;
    document.getElementById('book-size').textContent =
      book.format === 'epub' ? size : `${book.format.toUpperCase()} · ${size}`;
    bookStatus.textContent = '';
    updateDirty();
    if (!dialog.open) dialog.showModal();
  }

  // Los campos editados (solo esos se mandan, para no reescribir lo que no se tocó).
  function changedFields() {
    const changes = {};
    for (const el of fields) {
      const field = el.dataset.field;
      if (el.hidden || fieldText(el) === fieldValue(current, field)) continue;
      changes[field] =
        field === 'authors'
          ? fieldText(el)
              .split('&')
              .map((a) => a.trim())
              .filter(Boolean)
          : fieldText(el);
    }
    if (newCover) changes.cover = newCover;
    return changes;
  }

  const isDirty = () => Boolean(current) && (crop !== null || Object.keys(changedFields()).length > 0);

  function updateDirty() {
    const dirty = isDirty();
    saveButton.hidden = !dirty;
    discardButton.hidden = !dirty;
  }

  for (const el of fields) {
    el.addEventListener('input', updateDirty);
    // Enter guarda en los campos de una línea en vez de agregar un salto.
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && el.dataset.field !== 'description') {
        event.preventDefault();
        if (isDirty()) save();
      }
    });
    el.addEventListener('paste', (event) => {
      if (el.contentEditable !== 'true') return;
      event.preventDefault();
      document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
    });
  }

  // --- acomodar la portada nueva (arrastrar y zoom, como una foto de perfil) ---

  const cropper = document.getElementById('cropper');
  const cropFrame = document.getElementById('crop-frame');
  const cropImg = document.getElementById('crop-img');
  const cropZoom = document.getElementById('crop-zoom');
  // La portada que se guarda: 2:3, como el marco.
  const COVER_W = 1000;
  const COVER_H = 1500;
  // crop: { w, h (tamaño del marco), min, max (escalas), scale, x, y (posición), fill (color de fondo) }
  let crop = null;

  // El zoom va de "entra entera" (min) a 4 veces "llena el marco"; la barra es logarítmica.
  const zoomToScale = (t) => crop.min * Math.pow(crop.max / crop.min, t);
  const scaleToZoom = (s) => Math.log(s / crop.min) / Math.log(crop.max / crop.min);

  function clampCrop() {
    const sw = cropImg.naturalWidth * crop.scale;
    const sh = cropImg.naturalHeight * crop.scale;
    // Si la imagen es más grande que el marco no puede dejar huecos; si es más chica, no puede salirse.
    const clamp = (v, size, frame) => Math.min(Math.max(v, Math.min(0, frame - size)), Math.max(0, frame - size));
    crop.x = clamp(crop.x, sw, crop.w);
    crop.y = clamp(crop.y, sh, crop.h);
  }

  function renderCrop() {
    clampCrop();
    cropImg.style.transform = `translate(${crop.x}px, ${crop.y}px) scale(${crop.scale})`;
    cropFrame.style.background = crop.fill;
    cropZoom.value = scaleToZoom(crop.scale);
  }

  // Zoom manteniendo fijo el punto (ax, ay) del marco.
  function zoomTo(scale, ax = crop.w / 2, ay = crop.h / 2) {
    scale = Math.min(Math.max(scale, crop.min), crop.max);
    crop.x = ax - ((ax - crop.x) * scale) / crop.scale;
    crop.y = ay - ((ay - crop.y) * scale) / crop.scale;
    crop.scale = scale;
    renderCrop();
  }

  // Color promedio de la imagen: rellena los costados si no llena el marco.
  function averageColor(img) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  }

  function startCrop(src) {
    cropImg.onload = () => {
      coverEdit.hidden = true;
      cropper.hidden = false;
      const { width: w, height: h } = cropFrame.getBoundingClientRect();
      const iw = cropImg.naturalWidth;
      const ih = cropImg.naturalHeight;
      const cover = Math.max(w / iw, h / ih);
      crop = { w, h, min: Math.min(w / iw, h / ih), max: cover * 4, scale: cover, fill: averageColor(cropImg) };
      crop.x = (w - iw * cover) / 2;
      crop.y = (h - ih * cover) / 2;
      renderCrop();
      updateDirty();
      cropFrame.focus();
    };
    cropImg.src = src;
  }

  function endCrop() {
    crop = null;
    cropper.hidden = true;
    coverEdit.hidden = false;
    updateDirty();
  }

  function applyCrop() {
    const canvas = document.createElement('canvas');
    canvas.width = COVER_W;
    canvas.height = COVER_H;
    const ctx = canvas.getContext('2d');
    const k = COVER_W / crop.w;
    ctx.fillStyle = crop.fill;
    ctx.fillRect(0, 0, COVER_W, COVER_H);
    ctx.imageSmoothingQuality = 'high';
    const s = crop.scale * k;
    ctx.drawImage(cropImg, crop.x * k, crop.y * k, cropImg.naturalWidth * s, cropImg.naturalHeight * s);
    newCover = canvas.toDataURL('image/jpeg', 0.9);
    endCrop();
    showCover(newCover);
    updateDirty();
  }

  coverInput.addEventListener('change', () => {
    const file = coverInput.files[0];
    coverInput.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => startCrop(reader.result);
    reader.readAsDataURL(file);
  });

  let drag = null;
  cropFrame.addEventListener('pointerdown', (event) => {
    cropFrame.setPointerCapture(event.pointerId);
    drag = { px: event.clientX, py: event.clientY, x: crop.x, y: crop.y };
  });
  cropFrame.addEventListener('pointermove', (event) => {
    if (!drag || !crop) return;
    crop.x = drag.x + event.clientX - drag.px;
    crop.y = drag.y + event.clientY - drag.py;
    renderCrop();
  });
  const stopDrag = () => (drag = null);
  cropFrame.addEventListener('pointerup', stopDrag);
  cropFrame.addEventListener('pointercancel', stopDrag);

  cropFrame.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const rect = cropFrame.getBoundingClientRect();
      zoomTo(crop.scale * Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
    },
    { passive: false },
  );

  cropFrame.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 20 : 4;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[event.key]) {
      crop.x += moves[event.key][0];
      crop.y += moves[event.key][1];
      renderCrop();
    } else if (event.key === '+' || event.key === '=') zoomTo(crop.scale * 1.1);
    else if (event.key === '-') zoomTo(crop.scale / 1.1);
    else if (event.key === 'Enter') applyCrop();
    else return;
    event.preventDefault();
  });

  cropZoom.addEventListener('input', () => zoomTo(zoomToScale(Number(cropZoom.value))));
  document.getElementById('crop-ok').addEventListener('click', applyCrop);
  document.getElementById('crop-cancel').addEventListener('click', endCrop);

  async function save() {
    // Enter en un campo puede llegar con un guardado en curso (los botones están deshabilitados, el teclado no).
    if (saving) return;
    if (crop) applyCrop();
    const changes = changedFields();
    if (!Object.keys(changes).length) return;
    saving = true;
    const buttons = dialog.querySelectorAll('.actions button');
    buttons.forEach((b) => (b.disabled = true));
    bookStatus.classList.remove('error');
    bookStatus.textContent = 'guardando en el Kindle…';
    try {
      await api(`/api/books/${current.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(changes),
      });
      toast('guardado');
      const id = current.id;
      await loadBooks();
      const updated = books.find((b) => b.id === id);
      if (updated && dialog.open) openBook(updated);
    } catch (e) {
      bookStatus.classList.add('error');
      bookStatus.textContent = e.message;
    } finally {
      saving = false;
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  saveButton.addEventListener('click', save);
  discardButton.addEventListener('click', () => openBook(current));

  const confirmClose = () => !isDirty() || confirm('Hay cambios sin guardar. ¿Descartarlos?');
  dialog.addEventListener('cancel', (event) => {
    // Con la portada a medio acomodar, Esc solo cancela eso.
    if (crop) {
      event.preventDefault();
      endCrop();
    } else if (!confirmClose()) event.preventDefault();
  });

  deleteButton.addEventListener('click', async () => {
    if (!confirm(`¿Borrar "${current.title}" del Kindle? También se borran su progreso de lectura y notas.`)) return;
    deleteButton.disabled = true;
    bookStatus.classList.remove('error');
    bookStatus.textContent = 'borrando…';
    try {
      await api(`/api/books/${current.id}`, { method: 'DELETE' });
      dialog.close();
      toast(`borrado: ${current.title}`);
      await loadBooks();
    } catch (e) {
      bookStatus.classList.add('error');
      bookStatus.textContent = e.message;
    } finally {
      deleteButton.disabled = false;
    }
  });

  for (const d of [dialog, addDialog]) {
    const close = () => (d !== dialog || confirmClose()) && d.close();
    d.querySelector('[data-close]').addEventListener('click', close);
    d.addEventListener('click', (event) => {
      if (event.target === d) close();
    });
  }

  // --- agregar libros ---

  async function uploadFiles(files) {
    for (const file of files) {
      addStatus.classList.remove('error');
      addStatus.textContent = `mandando ${file.name}…`;
      toast(`mandando ${file.name}…`);
      try {
        const added = await api('/api/books', {
          method: 'POST',
          headers: { 'x-filename': encodeURIComponent(file.name) },
          body: file,
        });
        addStatus.textContent = `listo: ${added.title || file.name}`;
        toast(`en el Kindle: ${added.title || file.name}`);
      } catch (e) {
        addStatus.classList.add('error');
        addStatus.textContent = `${file.name}: ${e.message}`;
        toast(`${file.name}: ${e.message}`, true);
      }
    }
    await loadBooks();
  }

  addButton.addEventListener('click', () => {
    addStatus.textContent = '';
    addDialog.showModal();
  });

  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    uploadFiles(files);
  });

  dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropzone.classList.add('over');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropzone.classList.remove('over');
    uploadFiles([...event.dataTransfer.files]);
  });

  // Fuera del diálogo también se puede soltar un archivo en cualquier parte de la página.
  let dragDepth = 0;
  const hasFiles = (event) => connected && event.dataTransfer.types.includes('Files') && !addDialog.open;
  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    dragDepth++;
    dropOverlay.hidden = false;
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      dropOverlay.hidden = true;
    }
  });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    if (hasFiles(event)) uploadFiles([...event.dataTransfer.files]);
  });

  checkStatus();
  setInterval(checkStatus, 3000);
});
