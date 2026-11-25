// Escriba: graba y transcribe entrevistas en este computador. No se conecta a internet.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, powerSaveBlocker, protocol, session, systemPreferences } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { Almacen } = require('./lib/almacen');
const { Transcriptor } = require('./lib/transcriptor');
const { docx } = require('./lib/exportar');

const PRUEBA = process.argv.find(a => a.startsWith('--autotest='));
const RECURSOS = app.isPackaged ? process.resourcesPath : __dirname;
const DATOS = process.env.ESCRIBA_DATOS || path.join(os.homedir(), 'Escriba'); // fuera de Documentos: no lo sincroniza OneDrive ni iCloud
const AUDIOS = ['wav', 'mp3', 'm4a', 'mp4', 'aac', 'ogg', 'oga', 'opus', 'flac', 'webm', 'amr', '3gp', 'wma', 'mov', 'avi', 'mkv', 'aif', 'aiff', 'caf'];

let ventana = null, almacen, transcriptor, despierto = null;

protocol.registerSchemesAsPrivileged([{ scheme: 'escriba', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
if (PRUEBA) app.disableHardwareAcceleration();

if (!PRUEBA && !app.requestSingleInstanceLock()) app.exit(0); // ya hay una abierta: se muestra esa
app.on('second-instance', () => { if (ventana) { if (ventana.isMinimized()) ventana.restore(); ventana.focus(); } });

// los problemas quedan anotados en un archivo, sin ventanas de error incomprensibles
function anotar(txt) { try { fs.appendFileSync(path.join(DATOS, 'registro-de-problemas.txt'), `${new Date().toISOString()} ${app.getVersion()} ${process.platform} ${txt}\n`); } catch { /* sin disco no hay registro */ } }
process.on('uncaughtException', e => anotar(e.stack || e.message));
process.on('unhandledRejection', e => anotar((e && e.stack) || String(e)));

function enviar(canal, dato) { if (ventana && !ventana.isDestroyed()) ventana.webContents.send(canal, dato); }
function avisar(id) {
  const s = almacen.obtener(id);
  if (s) enviar('cambio', limpia(s));
}
function limpia(s) { return JSON.parse(JSON.stringify(s, (k, v) => (k === 'wav' ? undefined : v))); }

// mientras se graba o se transcribe, el computador no se duerme
function vigilia() {
  const ocupado = [...almacen.sesiones.values()].some(s => s.estado === 'grabando' || s.estado === 'transcribiendo');
  if (ocupado && despierto === null) despierto = powerSaveBlocker.start('prevent-app-suspension');
  if (!ocupado && despierto !== null) { powerSaveBlocker.stop(despierto); despierto = null; }
}

function carpetaValida(id) { return almacen.obtener(id) && path.basename(id) === id; }

// ---------- protocolo del audio, con salto a cualquier punto ----------
const abiertos = new Map(); // entrevista → lecturas de audio en curso (se cierran antes de borrar)
async function servirAudio(pedido) {
  const id = decodeURIComponent(new URL(pedido.url).pathname.slice(1));
  const s = almacen.obtener(id);
  if (!s || !s.archivo) return new Response('', { status: 404 });
  const archivo = path.join(almacen.carpeta(id), s.escucha || s.archivo);
  if (!fs.existsSync(archivo)) return new Response('', { status: 404 });
  const total = fs.statSync(archivo).size;
  const tipo = { wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'audio/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm', aac: 'audio/aac' }[path.extname(archivo).slice(1).toLowerCase()] || 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(pedido.headers.get('range') || '');
  const ini = m && m[1] ? +m[1] : 0, fin = m && m[2] ? Math.min(+m[2], total - 1) : total - 1;
  if (ini > fin) return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
  const flujo = fs.createReadStream(archivo, { start: ini, end: fin });
  if (!abiertos.has(id)) abiertos.set(id, new Set());
  abiertos.get(id).add(flujo);
  flujo.on('close', () => abiertos.get(id)?.delete(flujo));
  flujo.on('error', () => {});
  const cuerpo = Readable.toWeb(flujo);
  return new Response(cuerpo, {
    status: m ? 206 : 200,
    headers: { 'Content-Type': tipo, 'Accept-Ranges': 'bytes', 'Content-Length': String(fin - ini + 1), ...(m ? { 'Content-Range': `bytes ${ini}-${fin}/${total}` } : {}) }
  });
}

// ---------- ventana ----------
function menu() {
  const ayuda = { label: 'Ayuda', submenu: [{ label: 'Cómo usar Escriba', click: () => enviar('ayuda') }, { label: 'Abrir la carpeta de mis entrevistas', click: () => shell.openPath(DATOS) }] };
  const editar = { label: 'Edición', submenu: [{ role: 'undo', label: 'Deshacer' }, { role: 'redo', label: 'Rehacer' }, { type: 'separator' }, { role: 'cut', label: 'Cortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Pegar' }, { role: 'selectAll', label: 'Seleccionar todo' }] };
  const app_ = { label: 'Escriba', submenu: [{ role: 'about', label: 'Acerca de Escriba' }, { type: 'separator' }, { role: 'hide', label: 'Ocultar Escriba' }, { role: 'quit', label: 'Salir de Escriba' }] };
  const ver = { label: 'Ver', submenu: [{ role: 'zoomIn', label: 'Acercar' }, { role: 'zoomOut', label: 'Alejar' }, { role: 'resetZoom', label: 'Tamaño normal' }, { role: 'togglefullscreen', label: 'Pantalla completa' }] };
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([app_, editar, ver, ayuda]) : null); // en Windows, Alt abriría el menú en medio de los atajos
}

function crearVentana() {
  ventana = new BrowserWindow({
    width: 1120, height: 780, minWidth: 720, minHeight: 520, title: 'Escriba', backgroundColor: '#eef3f1', show: false,
    icon: path.join(__dirname, 'ui', 'icono.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  });
  ventana.once('ready-to-show', () => ventana.show());
  ventana.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  ventana.webContents.on('will-navigate', e => e.preventDefault());
  ventana.webContents.on('before-input-event', (e, t) => { // sin menú, Windows conserva Ctrl + y Ctrl − para agrandar la letra
    if (process.platform === 'darwin' || t.type !== 'keyDown' || !t.control || t.alt) return;
    const z = ventana.webContents.getZoomLevel();
    if (t.key === '+' || t.key === '=') { ventana.webContents.setZoomLevel(Math.min(3, z + 0.5)); e.preventDefault(); }
    if (t.key === '-') { ventana.webContents.setZoomLevel(Math.max(-2, z - 0.5)); e.preventDefault(); }
    if (t.key === '0') { ventana.webContents.setZoomLevel(0); e.preventDefault(); }
  });
  ventana.loadFile(path.join(__dirname, 'ui', 'index.html'));
  ventana.on('close', e => { // no perder una grabación en curso
    const grabando = [...almacen.sesiones.values()].find(s => s.estado === 'grabando');
    if (!grabando) {
      if (!transcriptor.actual) return;
      const r = dialog.showMessageBoxSync(ventana, { type: 'question', buttons: ['Dejar abierto', 'Cerrar'], defaultId: 0, cancelId: 0, message: 'Todavía se está transcribiendo', detail: 'Si cierras Escriba, no se pierde nada: seguirá donde quedó la próxima vez que lo abras.' });
      if (r === 0) e.preventDefault();
      return;
    }
    const r = dialog.showMessageBoxSync(ventana, { type: 'question', buttons: ['Seguir grabando', 'Terminar y guardar'], defaultId: 0, cancelId: 0, message: 'Hay una grabación en curso', detail: 'Si cierras Escriba, la grabación termina y queda guardada.' });
    if (r === 0) return e.preventDefault();
    almacen.terminarWav(grabando.id);
  });
}

// ---------- puente con la interfaz ----------
function conectar() {
  const manejar = (canal, fn) => ipcMain.handle(canal, async (e, ...a) => {
    if (e.senderFrame && !e.senderFrame.url.startsWith('file:')) return null; // solo la propia ventana
    return fn(...a);
  });

  manejar('lista', () => almacen.lista());
  manejar('abrir', id => (carpetaValida(id) ? limpia(almacen.obtener(id)) : null));
  manejar('accion', (id, a) => { const r = almacen.accion(id, a); return r; });

  manejar('grabar', (titulo, frecuencia) => {
    const libre = fs.statfsSync(DATOS);
    if (libre.bavail * libre.bsize < 500e6) return { sinEspacio: true };
    const s = almacen.crear({ titulo, origen: 'grabada' });
    almacen.abrirWav(s.id, frecuencia);
    vigilia();
    return s.id;
  });
  ipcMain.on('audio', (e, id, pcm) => {
    try { almacen.agregarAudio(id, Buffer.from(pcm)); } catch (err) { anotar(`grabando ${id}: ${err.message}`); enviar('sin-espacio', id); }
  });
  manejar('terminar', async id => {
    almacen.terminarWav(id);
    transcriptor.encolar(id);
    vigilia();
    return limpia(almacen.obtener(id));
  });
  manejar('descartar', async id => {
    const s = almacen.obtener(id);
    if (!s || !s.wav) return;
    fs.closeSync(s.wav.fd);
    delete s.wav;
    await borrar(id);
  });

  manejar('importar', async rutas => {
    if (!rutas) {
      const r = await dialog.showOpenDialog(ventana, { title: 'Elegir grabaciones', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Audio o video', extensions: AUDIOS }, { name: 'Todos', extensions: ['*'] }] });
      if (r.canceled) return [];
      rutas = r.filePaths;
    }
    const ids = [];
    for (const r of rutas) {
      const ext = path.extname(r).slice(1).toLowerCase();
      const nombre = path.basename(r, path.extname(r)).replace(/[_-]+/g, ' ').trim();
      const s = almacen.crear({ titulo: nombre, origen: 'importada' });
      s.archivo = `original.${AUDIOS.includes(ext) ? ext : 'audio'}`;
      try {
        await fs.promises.copyFile(r, path.join(almacen.carpeta(s.id), s.archivo));
      } catch (e) {
        s.estado = 'error'; s.error = 'No se pudo copiar el archivo.';
      }
      almacen.guardar(s.id);
      ids.push(s.id);
      if (s.estado !== 'error') {
        transcriptor.copiaParaEscuchar(s.id); // en paralelo
        transcriptor.encolar(s.id);
      }
    }
    vigilia();
    return ids;
  });

  manejar('transcribir', id => transcriptor.encolar(id));
  manejar('reiniciar', id => transcriptor.volverAEmpezar(id));
  manejar('cancelar', id => transcriptor.cancelar(id));
  manejar('exportar', async (id, formato) => {
    const s = almacen.obtener(id);
    if (!s) return null;
    const ext = formato === 'word' ? 'docx' : 'txt';
    const r = await dialog.showSaveDialog(ventana, { title: 'Guardar transcripción', defaultPath: path.join(app.getPath('desktop'), s.titulo.replace(/[<>:"/\\|?*]/g, ' ').slice(0, 60) + '.' + ext), filters: [{ name: ext === 'docx' ? 'Word' : 'Texto', extensions: [ext] }] });
    if (r.canceled) return null;
    try {
      fs.writeFileSync(r.filePath, formato === 'word' ? await docx(s) : almacen.texto(id));
    } catch (e) { anotar(`exportar: ${e.message}`); return { error: 'No se pudo guardar. Si ese archivo está abierto en Word, ciérralo y vuelve a intentar.' }; }
    return { ruta: r.filePath };
  });
  manejar('carpeta', id => { if (carpetaValida(id)) shell.openPath(almacen.carpeta(id)); });
  manejar('mostrar', ruta => shell.showItemInFolder(ruta));
  manejar('borrar', borrar);
  manejar('micro', async () => {
    if (process.platform !== 'darwin' || process.argv.includes('--use-fake-device-for-media-stream')) return true;
    return systemPreferences.getMediaAccessStatus('microphone') === 'granted' || systemPreferences.askForMediaAccess('microphone');
  });
  manejar('ajustes-micro', () => shell.openExternal(process.platform === 'darwin' ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone' : 'ms-settings:privacy-microphone'));
  manejar('info', () => ({ version: app.getVersion(), datos: DATOS, plataforma: process.platform }));
}

async function borrar(id) {
  if (!carpetaValida(id)) return true;
  const s = almacen.obtener(id);
  s.borrada = true;
  await transcriptor.soltar(id);
  for (let intento = 0; intento < 6; intento++) { // Windows no mueve una carpeta mientras algo la lee
    for (const f of abiertos.get(id) || []) f.destroy();
    try {
      await shell.trashItem(almacen.carpeta(id));
      almacen.sesiones.delete(id);
      vigilia();
      return true;
    } catch (e) { if (intento === 5) anotar(`borrar ${id}: ${e.message}`); await new Promise(r => setTimeout(r, 350)); }
  }
  delete s.borrada;
  almacen.guardar(id);
  return false;
}

// ---------- arranque ----------
function revisarInstalacion() {
  const faltan = [];
  const exe = path.join(RECURSOS, 'bin', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
  for (const f of [exe, path.join(RECURSOS, 'modelo', 'ggml-large-v3-turbo-q5_0.bin'), path.join(RECURSOS, 'modelo', 'ggml-silero-v5.1.2.bin'), path.join(RECURSOS, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')]) {
    if (!fs.existsSync(f)) faltan.push(path.basename(f));
  }
  if (faltan.length && !PRUEBA) {
    dialog.showErrorBox('Falta parte de Escriba', `No se encontraron: ${faltan.join(', ')}.\n\nVuelve a instalar Escriba desde el archivo original.`);
    app.exit(1);
  }
  return faltan;
}

app.whenReady().then(async () => {
  protocol.handle('escriba', servirAudio);
  // ninguna conexión sale de este computador
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(file|escriba|blob|data|devtools):/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((wc, permiso, cb, d) => cb(permiso === 'media' && (d.mediaTypes || []).every(t => t === 'audio')));
  session.defaultSession.setPermissionCheckHandler((wc, permiso) => permiso === 'media');

  almacen = new Almacen(DATOS);
  transcriptor = new Transcriptor(almacen, RECURSOS);
  transcriptor.on('problema', anotar);
  transcriptor.on('cambio', id => { avisar(id); vigilia(); });
  transcriptor.on('avance', id => { const s = almacen.obtener(id); if (s) enviar('avance', { id, progreso: s.progreso }); });
  const faltan = revisarInstalacion();

  if (PRUEBA) return autoprueba(PRUEBA.split('=')[1], faltan);

  menu();
  conectar();
  crearVentana();
  for (const s of [...almacen.sesiones.values()].sort((a, b) => a.creada.localeCompare(b.creada))) { // reanuda lo pendiente
    if (transcriptor.faltaCopia(s)) transcriptor.copiaParaEscuchar(s.id);
    if (s.estado === 'por-transcribir' && s.archivo) transcriptor.encolar(s.id);
  }
  vigilia();
});

app.on('window-all-closed', () => { transcriptor && transcriptor.detener(); app.quit(); });
app.on('before-quit', () => transcriptor && transcriptor.detener());

// ---------- autoprueba (para GitHub): instala, transcribe una muestra y comprueba el resultado ----------
async function autoprueba(ruta, faltan) {
  const listo = (ok, txt) => { console.log((ok ? 'AUTOPRUEBA OK: ' : 'AUTOPRUEBA FALLA: ') + txt); app.exit(ok ? 0 : 1); };
  if (faltan.length) return listo(false, 'faltan ' + faltan.join(', '));
  const t0 = Date.now();
  const s = almacen.crear({ titulo: 'autoprueba', origen: 'importada' });
  s.archivo = 'original' + path.extname(ruta);
  fs.copyFileSync(path.isAbsolute(ruta) ? ruta : path.join(app.isPackaged ? process.cwd() : __dirname, ruta), path.join(almacen.carpeta(s.id), s.archivo));
  transcriptor.on('cambio', id => {
    const x = almacen.obtener(id);
    if (id !== s.id || !['lista', 'error'].includes(x.estado)) return;
    const texto = x.parrafos.map(p => p.texto).join(' ');
    const exporta = docx(x).then(b => b.length > 1000);
    exporta.then(ok => listo(x.estado === 'lista' && texto.length > 10 && ok && fs.existsSync(path.join(almacen.carpeta(id), 'transcripcion.txt')),
      `estado=${x.estado} ${x.error || ''} | ${Math.round(x.duracion)} s de audio en ${((Date.now() - t0) / 1000).toFixed(0)} s | ${texto.slice(0, 160)}`));
  });
  transcriptor.encolar(s.id);
  setTimeout(() => listo(false, 'tiempo agotado'), 15 * 60 * 1000);
}
