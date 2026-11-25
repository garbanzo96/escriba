'use strict';
const api = window.escriba;
const $ = s => document.querySelector(s);
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
const dos = n => String(n).padStart(2, '0');
const mmss = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600); return (h ? h + ':' + dos(Math.floor(s / 60) % 60) : dos(Math.floor(s / 60))) + ':' + dos(s % 60); };
const durLarga = s => s < 60 ? `${Math.round(s)} segundos` : `${Math.round(s / 60)} min`;
const fecha = iso => { const d = new Date(iso); return `${d.getDate()} ${MESES[d.getMonth()]} ${d.getFullYear()}, ${dos(d.getHours())}:${dos(d.getMinutes())}`; };
function el(tag, attrs = {}, ...hijos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const h of hijos.flat()) if (h !== null && h !== undefined) e.append(h);
  return e;
}

// ---------- avisos y diálogos ----------
function toast(txt) {
  const t = $('#toast');
  t.textContent = txt;
  t.classList.add('ver');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove('ver'), 2800);
}
function confirmar({ titulo, texto, accion }) {
  const d = $('#d-confirma');
  $('#dc-titulo').textContent = titulo;
  $('#dc-texto').textContent = texto;
  $('#dc-si').textContent = accion;
  d.showModal();
  return new Promise(r => {
    $('#dc-si').onclick = () => { d.close(); r(true); };
    $('#dc-no').onclick = () => { d.close(); r(false); };
    d.oncancel = () => r(false);
  });
}
function ayuda() { $('#d-ayuda').showModal(); }
$('#da-ok').onclick = () => $('#d-ayuda').close();
$('#b-ayuda').onclick = ayuda;
api.alPedirAyuda(ayuda);

// ---------- navegación ----------
let vista = 'lista', S = null;
function ver(nombre) {
  vista = nombre;
  for (const v of ['lista', 'grabar', 'editor']) $('#v-' + v).hidden = v !== nombre;
  cerrarMenus();
  if (nombre === 'lista') { $('#audio').pause(); pintarLista(); }
}

// ---------- lista ----------
const ESTADOS = { lista: 'Lista', transcribiendo: 'Transcribiendo', 'por-transcribir': 'En espera', grabando: 'Grabando', error: 'Hubo un problema' };
async function pintarLista() {
  const l = await api.lista();
  $('#vacia').hidden = l.length > 0;
  $('#lista').replaceChildren(...l.map(s => {
    const pct = s.estado === 'transcribiendo' ? ` ${Math.round(s.progreso * 100)}%` : '';
    return el('li', {}, el('button', { class: 'entrevista', 'data-id': s.id, onclick: () => abrirEditor(s.id) },
      el('b', {}, s.titulo),
      el('span', { class: `pastilla ${s.estado}`, 'data-pastilla': s.id }, ESTADOS[s.estado] + pct),
      el('span', { class: 'sub' }, `${fecha(s.creada)}${s.duracion ? ', ' + durLarga(s.duracion) : ''}`, s.extracto ? el('em', {}, '  ' + s.extracto) : null)));
  }));
}
let esperaLista;
function refrescarLista() { clearTimeout(esperaLista); esperaLista = setTimeout(pintarLista, 350); }
$('#b-nueva').onclick = () => abrirGrabar();
$('#b-importar').onclick = async () => importar(await api.importar());
async function importar(ids) {
  if (!ids || !ids.length) return;
  if (ids.length === 1) abrirEditor(ids[0]); else { ver('lista'); toast(`${ids.length} grabaciones en espera para transcribir`); }
}
for (const ev of ['dragover', 'drop']) document.addEventListener(ev, e => { e.preventDefault(); document.body.classList.toggle('arrastrando', ev === 'dragover' && vista === 'lista'); });
document.addEventListener('dragleave', () => document.body.classList.remove('arrastrando'));
document.addEventListener('drop', async e => {
  document.body.classList.remove('arrastrando');
  const rutas = [...(e.dataTransfer?.files || [])].map(f => api.rutaDe(f)).filter(Boolean);
  if (rutas.length && vista === 'lista') importar(await api.importar(rutas));
});
api.alCambiar(s => {
  if (vista === 'editor' && S && S.id === s.id) actualizarEditor(s);
  if (vista === 'lista') refrescarLista();
});
api.alAvanzar(({ id, progreso }) => {
  const p = document.querySelector(`[data-pastilla="${CSS.escape(id)}"]`);
  if (p) p.textContent = `${ESTADOS.transcribiendo} ${Math.round(progreso * 100)}%`;
  if (vista === 'editor' && S && S.id === id) { S.progreso = progreso; pintarEstado(); }
});

// ---------- grabar ----------
const g = { estado: 'lista', id: null, ctx: null, stream: null, muestras: 0, acumulado: [], largo: 0, nivel: 0, ultimoSonido: 0, sinSonido: false };
function abrirGrabar() {
  Object.assign(g, { estado: 'lista', id: null, muestras: 0, nivel: 0, sinSonido: false });
  $('#g-titulo').value = '';
  $('#g-final').hidden = true;
  $('#g-descartar').hidden = false;
  aviso('');
  pintarGrabar();
  ver('grabar');
  listarMicros();
  $('#g-titulo').focus();
}
function aviso(txt, error) { const a = $('#g-aviso'); a.textContent = txt; a.classList.toggle('error', !!error); }
async function listarMicros() {
  try {
    const todos = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
    const antes = $('#g-micro').value;
    $('#g-micro').replaceChildren(el('option', { value: '' }, 'El que usa el computador'), ...todos.filter(d => d.deviceId && d.deviceId !== 'default').map((d, i) => el('option', { value: d.deviceId }, d.label || `Micrófono ${i + 1}`)));
    if (antes) $('#g-micro').value = antes;
  } catch { /* sin permisos aún: queda el predeterminado */ }
}
async function abrirCaptura() {
  const dispositivo = $('#g-micro').value;
  if (!(await api.micro())) { throw Object.assign(new Error('permiso'), { name: 'NotAllowedError' }); }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: dispositivo ? { exact: dispositivo } : undefined, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  });
  const ctx = new AudioContext({ sampleRate: 48000 });
  await ctx.audioWorklet.addModule('worklet.js');
  const fuente = ctx.createMediaStreamSource(stream);
  const nodo = new AudioWorkletNode(ctx, 'captura');
  const mudo = ctx.createGain();
  mudo.gain.value = 0;
  fuente.connect(nodo).connect(mudo).connect(ctx.destination);
  await ctx.resume();
  nodo.port.onmessage = e => recibir(e.data);
  stream.getAudioTracks()[0].onended = () => { if (g.estado === 'grabando') perdioMicro('El micrófono se desconectó. Lo grabado está guardado: conecta el micrófono y pulsa Seguir.'); };
  Object.assign(g, { ctx, stream });
  listarMicros();
}
function cerrarCaptura() {
  g.stream?.getTracks().forEach(t => t.stop());
  g.ctx?.close();
  Object.assign(g, { ctx: null, stream: null });
}
function recibir(x) {
  let suma = 0, pico = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i]; suma += v * v; const a = v < 0 ? -v : v; if (a > pico) pico = a; }
  if (pico > 0.00004) g.ultimoSonido = performance.now();
  g.nivel = Math.max(g.nivel * 0.92, Math.min(1, Math.sqrt(suma / x.length) * 7));
  if (g.estado !== 'grabando') return;
  g.acumulado.push(x);
  g.largo += x.length;
  if (g.largo >= 4800) enviarAudio();
}
function enviarAudio() {
  if (!g.largo) return;
  const x = new Int16Array(g.largo);
  let o = 0;
  for (const b of g.acumulado) for (let i = 0; i < b.length; i++) x[o++] = Math.max(-1, Math.min(1, b[i])) * 32767;
  g.muestras += x.length;
  g.acumulado = []; g.largo = 0;
  api.audio(g.id, x.buffer);
}
function perdioMicro(txt) {
  enviarAudio();
  cerrarCaptura();
  g.estado = 'pausa';
  pintarGrabar();
  aviso(txt, true);
}
api.alFaltarEspacio(id => { if (id === g.id && g.estado === 'grabando') { cerrarCaptura(); g.estado = 'pausa'; pintarGrabar(); aviso('Se acabó el espacio en el disco. Lo grabado está guardado: pulsa Terminar y transcribir, o libera espacio y sigue.', true); } });
async function empezar() {
  if (g.ocupado) return; // un doble clic no abre dos grabaciones
  g.ocupado = true;
  aviso('Preparando el micrófono…');
  try {
    await abrirCaptura();
    if (vista !== 'grabar') throw new Error('se salió de la pantalla');
    if (!g.id) {
      const id = await api.grabar($('#g-titulo').value.trim() || '', g.ctx.sampleRate);
      if (id && id.sinEspacio) throw Object.assign(new Error(), { name: 'SinEspacio' });
      g.id = id;
    }
    g.ultimoSonido = performance.now();
    g.estado = 'grabando';
    aviso('');
    pintarGrabar();
  } catch (e) { cerrarCaptura(); avisoMicro(e); }
  g.ocupado = false;
}
function avisoMicro(e) {
  const a = $('#g-aviso');
  a.classList.add('error');
  if (e && e.name === 'NotAllowedError') {
    a.replaceChildren('Escriba no tiene permiso para usar el micrófono. ', el('button', { class: 'quieto', onclick: () => api.ajustesMicro() }, 'Abrir los ajustes'), ' Después vuelve a pulsar Grabar.');
  } else if (e && e.name === 'SinEspacio') a.textContent = 'Queda muy poco espacio en el disco para grabar. Libera espacio y vuelve a intentar.';
  else if (e && e.name === 'NotFoundError') a.textContent = 'No se encontró ningún micrófono. Conecta uno y vuelve a intentar.';
  else a.textContent = 'No se pudo usar el micrófono. Revisa que no lo esté usando otro programa y vuelve a intentar.';
}
function pausar() {
  enviarAudio();
  cerrarCaptura(); // en pausa no se retiene el micrófono
  g.estado = 'pausa';
  pintarGrabar();
}
function pintarGrabar() {
  const b = $('#g-boton');
  $('#v-grabar').classList.toggle('grabando', g.estado === 'grabando');
  b.setAttribute('aria-label', g.estado === 'grabando' ? 'Pausar' : g.estado === 'pausa' ? 'Seguir grabando' : 'Grabar');
  $('#g-leyenda').textContent = g.estado === 'grabando' ? 'Pausar' : g.estado === 'pausa' ? 'Seguir' : 'Grabar';
  $('#g-final').hidden = g.estado === 'lista';
  $('#g-micro').disabled = g.estado === 'grabando';
}
$('#g-boton').onclick = () => g.estado === 'grabando' ? pausar() : empezar();
$('#g-titulo').addEventListener('change', e => { if (g.id) api.accion(g.id, { tipo: 'titulo', titulo: e.target.value }); }); // el título se puede escribir mientras graba
$('#g-terminar').onclick = async () => {
  enviarAudio();
  cerrarCaptura();
  const id = g.id;
  g.estado = 'lista';
  await api.terminar(id);
  abrirEditor(id);
};
$('#g-descartar').onclick = async () => {
  if (!await confirmar({ titulo: '¿Descartar esta grabación?', texto: 'Se borra lo grabado hasta ahora y no se puede recuperar.', accion: 'Descartar' })) return;
  cerrarCaptura();
  g.estado = 'lista';
  await api.descartar(g.id);
  ver('lista');
};
$('#g-volver').onclick = async () => {
  if (g.estado !== 'lista' && !await confirmar({ titulo: '¿Salir de la grabación?', texto: 'Lo grabado hasta ahora queda guardado en Mis entrevistas.', accion: 'Guardar y salir' })) return;
  if (g.estado !== 'lista') { enviarAudio(); cerrarCaptura(); g.estado = 'lista'; await api.terminar(g.id); }
  ver('lista');
};
function cuadroGrabar() {
  if (vista === 'grabar') {
    $('#g-reloj').textContent = mmss(g.muestras / 48000);
    g.nivel *= 0.94;
    $('#g-nivel').style.width = Math.round((g.estado === 'grabando' ? g.nivel : 0) * 100) + '%';
    if (g.estado === 'grabando') {
      const sin = performance.now() - g.ultimoSonido > 4000;
      if (sin !== g.sinSonido) { g.sinSonido = sin; aviso(sin ? 'No llega sonido del micrófono. Revisa que esté conectado y que no esté silenciado.' : '', sin); }
    }
  }
  requestAnimationFrame(cuadroGrabar);
}
cuadroGrabar();

// ---------- editor: abrir y pintar ----------
async function abrirEditor(id) {
  await asegurar();
  S = await api.abrir(id);
  if (!S) return ver('lista');
  ver('editor');
  $('#audio').pause();
  $('#e-texto').replaceChildren();
  $('#e-texto').scrollTop = 0;
  fuente = '';
  audio.removeAttribute('src');
  audio.load();
  $('#r-ahora').textContent = $('#r-total').textContent = '00:00';
  $('#r-barra').value = 0;
  $('#r-barra').style.setProperty('--p', '0%');
  $('#r-vel').value = '1';
  pintarEditor();
}
function pintarEditor() {
  if (document.activeElement !== $('#e-titulo')) $('#e-titulo').value = S.titulo;
  pintarEstado();
  pintarParrafos();
  ponerAudio();
}
function actualizarEditor(s) {
  S = s;
  for (const [pid, { texto }] of pendientes) { const p = S.parrafos.find(x => x.id === pid); if (p) p.texto = texto; } // lo recién escrito manda
  pintarEditor();
}
function pintarEstado() {
  const c = $('#e-estado');
  const { estado, progreso, error } = S;
  c.hidden = estado === 'lista';
  c.classList.toggle('error', estado === 'error');
  if (estado === 'transcribiendo') {
    const pct = Math.round(progreso * 100) + '%';
    if (!c.querySelector('.progreso')) c.replaceChildren('Transcribiendo', el('div', { class: 'progreso' }, el('i')), el('span', { class: 'pct' }), el('button', { class: 'quieto', onclick: () => api.cancelar(S.id) }, 'Detener'));
    c.querySelector('i').style.width = pct;
    c.querySelector('.pct').textContent = pct;
  } else if (estado === 'por-transcribir') {
    c.replaceChildren('En espera para transcribir.', el('button', { class: 'quieto', onclick: () => api.transcribir(S.id) }, 'Transcribir ahora'));
  } else if (estado === 'error') {
    c.replaceChildren(error || 'Algo no salió bien.', el('button', { class: 'quieto', onclick: () => api.transcribir(S.id) }, 'Reintentar'));
  }
}
const parrafosDom = () => [...document.querySelectorAll('#e-texto .parrafo')];
const nombreHablante = h => (S.hablantes.find(x => x.id === h) || {}).nombre || '';
const colorHablante = h => { const i = S.hablantes.findIndex(x => x.id === h); return i < 0 ? '' : `var(--h${i % 6 + 1})`; };

function crearParrafo(p) {
  return el('div', { class: 'parrafo', 'data-p': p.id },
    el('div', { class: 'lado' },
      el('button', { class: 'hablante', 'data-h': '', title: 'Quién habla (Alt + 1, 2, 3…)' }),
      el('button', { class: 'minuto', 'data-m': '', title: 'Escuchar desde aquí' }, mmss(p.t0))),
    el('div', { class: 'cuerpo', contenteditable: 'plaintext-only', spellcheck: 'false', role: 'textbox', 'aria-label': 'Texto del párrafo' }));
}
function refrescar(fila, p) {
  const h = fila.querySelector('.hablante'), c = fila.querySelector('.cuerpo'), n = nombreHablante(p.hablante);
  h.textContent = n || 'Quién habla';
  h.classList.toggle('vacio', !n);
  h.style.setProperty('--c', n ? colorHablante(p.hablante) : '');
  fila.querySelector('.minuto').textContent = mmss(p.t0);
  if (document.activeElement !== c && c.textContent !== p.texto) c.textContent = p.texto;
}
function pintarParrafos() {
  const cont = $('#e-texto');
  const filas = new Map(parrafosDom().map(f => [f.dataset.p, f]));
  let previo = null;
  const ids = new Set(S.parrafos.map(p => p.id));
  for (const [id, f] of filas) if (!ids.has(id)) f.remove();
  for (const p of S.parrafos) {
    let f = filas.get(p.id);
    if (!f) f = crearParrafo(p);
    if (!f.isConnected || (previo ? previo.nextSibling : cont.firstChild) !== f) cont.insertBefore(f, previo ? previo.nextSibling : cont.firstChild);
    refrescar(f, p);
    previo = f;
  }
  let fin = cont.querySelector('.fin');
  if (!S.parrafos.length) {
    if (!fin) cont.append(fin = el('p', { class: 'fin' }));
    fin.textContent = { lista: 'No se detectó habla en esta grabación.', error: '' }[S.estado] ?? 'El texto irá apareciendo aquí mientras se transcribe.';
  } else if (fin) fin.remove();
}

// ---------- guardar lo que se escribe ----------
const pendientes = new Map(); // párrafo → texto y temporizador
function guardarTexto(pid, texto) {
  const id = S.id, p = S.parrafos.find(x => x.id === pid);
  if (p) p.texto = texto;
  clearTimeout(pendientes.get(pid)?.h);
  pendientes.set(pid, { texto, id, h: setTimeout(() => { pendientes.delete(pid); api.accion(id, { tipo: 'texto', pid, texto }); }, 400) });
}
function asegurar() { // todo lo escrito queda guardado antes de mover párrafos o salir
  const envios = [...pendientes].map(([pid, { h, texto, id }]) => { clearTimeout(h); return api.accion(id, { tipo: 'texto', pid, texto }); });
  pendientes.clear();
  return Promise.all(envios);
}
addEventListener('beforeunload', () => { if (vista === 'editor') { if (S && $('#e-titulo').value.trim() !== S.titulo) api.accion(S.id, { tipo: 'titulo', titulo: $('#e-titulo').value }); asegurar(); } });
const leer = c => c.innerText.replace(/\s*\n+\s*/g, ' ').replace(/ /g, ' ').replace(/ {2,}/g, ' ');
const posicion = c => {
  const sel = getSelection();
  if (!sel.rangeCount) return 0;
  const r = document.createRange();
  r.selectNodeContents(c);
  r.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  return r.toString().length;
};
function poner(c, pos) {
  c.focus();
  let n = c.firstChild, resto = pos;
  const r = document.createRange();
  while (n) { if (n.nodeType === 3) { if (resto <= n.length) break; resto -= n.length; } n = n.nextSibling; }
  if (n) r.setStart(n, Math.min(resto, n.length)); else r.selectNodeContents(c);
  r.collapse(true);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}
$('#e-texto').addEventListener('input', e => {
  const c = e.target.closest('.cuerpo');
  if (c) guardarTexto(c.closest('.parrafo').dataset.p, leer(c).trim() ? leer(c) : '');
});
$('#e-texto').addEventListener('focusout', e => {
  const c = e.target.closest('.cuerpo');
  if (!c) return;
  const f = c.closest('.parrafo'), p = S.parrafos.find(x => x.id === f.dataset.p);
  const texto = leer(c).trim();
  if (p && texto !== p.texto) guardarTexto(p.id, texto);
  if (p && c.textContent !== texto) c.textContent = texto;
});
async function dividir(c) {
  const f = c.closest('.parrafo'), pid = f.dataset.p, pos = posicion(c), todo = leer(c);
  const texto = todo.slice(0, pos).trim(), resto = todo.slice(pos).trim();
  if (!texto || !resto) return;
  await asegurar();
  const r = await api.accion(S.id, { tipo: 'dividir', pid, texto, resto, pos, largo: todo.length });
  const p = S.parrafos.find(x => x.id === pid);
  p.texto = texto;
  S.parrafos.splice(S.parrafos.indexOf(p) + 1, 0, r.nuevo);
  c.textContent = texto;
  pintarParrafos();
  poner(document.querySelector(`.parrafo[data-p="${r.nuevo.id}"] .cuerpo`), 0);
}
async function unir(c) {
  const f = c.closest('.parrafo'), i = S.parrafos.findIndex(x => x.id === f.dataset.p);
  if (i < 1) return false;
  await asegurar();
  const r = await api.accion(S.id, { tipo: 'unir', pid: f.dataset.p });
  if (!r || !r.pid) return false;
  S.parrafos.splice(i, 1);
  S.parrafos[i - 1].texto = r.texto;
  pintarParrafos();
  const antes = document.querySelector(`.parrafo[data-p="${r.pid}"] .cuerpo`);
  antes.textContent = r.texto;
  poner(antes, r.pos + 1);
  return true;
}
// las flechas pasan de un párrafo al siguiente, como en cualquier documento
function saltarParrafo(e, c, abajo) {
  const cursor = getSelection().getRangeAt(0).getClientRects()[0], caja = c.getBoundingClientRect();
  if (cursor && (abajo ? caja.bottom - cursor.bottom : cursor.top - caja.top) > 16) return; // quedan líneas dentro del párrafo
  const otro = (abajo ? c.closest('.parrafo').nextElementSibling : c.closest('.parrafo').previousElementSibling)?.querySelector('.cuerpo');
  if (!otro) return;
  e.preventDefault();
  poner(otro, abajo ? 0 : otro.textContent.length);
  otro.scrollIntoView({ block: 'nearest' });
}
$('#e-texto').addEventListener('keydown', e => {
  const c = e.target.closest('.cuerpo');
  if (!c) return;
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); dividir(c); }
  if (e.key === 'Backspace' && getSelection().isCollapsed && posicion(c) === 0) { e.preventDefault(); unir(c); }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey) saltarParrafo(e, c, e.key === 'ArrowDown');
});
$('#e-texto').addEventListener('click', e => {
  const f = e.target.closest('.parrafo');
  if (!f) return;
  const p = S.parrafos.find(x => x.id === f.dataset.p);
  if (e.target.closest('.minuto')) reproducirDesde(p.t0);
  if (e.target.closest('.hablante')) abrirHablante(e.target.closest('.hablante'), p);
});
$('#e-titulo').addEventListener('change', e => { S.titulo = e.target.value.trim() || S.titulo; api.accion(S.id, { tipo: 'titulo', titulo: e.target.value }); });
$('#e-titulo').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
$('#e-volver').onclick = async () => { await asegurar(); ver('lista'); };

// ---------- quién habla ----------
const pop = $('#pop');
function cerrarPop() { pop.hidden = true; }
function abrirHablante(ancla, p) {
  const botones = S.hablantes.map((h, i) => el('button', { style: `--c:${colorHablante(h.id)}`, onclick: () => { asignar(p.id, h.id); cerrarPop(); } }, h.nombre, i < 9 ? el('kbd', {}, `Alt ${i + 1}`) : null));
  const campo = el('input', { placeholder: 'Agregar otra persona, y Enter', 'aria-label': 'Nombre de la nueva persona' });
  campo.onkeydown = async e => { if (e.key === 'Enter' && campo.value.trim()) { await agregarHablante(campo.value.trim(), p.id); cerrarPop(); } };
  const actual = S.hablantes.find(h => h.id === p.hablante);
  pop.replaceChildren(el('p', {}, '¿Quién habla en este párrafo?'), ...botones, campo,
    ...(actual ? [el('p', {}, `Cambiar el nombre de «${actual.nombre}» en toda la entrevista`), renombrar(actual)] : []));
  pop.hidden = false;
  const r = ancla.getBoundingClientRect();
  pop.style.left = Math.min(r.left, innerWidth - pop.offsetWidth - 12) + 'px';
  pop.style.top = Math.max(8, Math.min(r.bottom + 6, innerHeight - pop.offsetHeight - 90)) + 'px';
  campo.focus();
}
function renombrar(h) {
  const i = el('input', { value: h.nombre, 'aria-label': 'Nombre' });
  i.onkeydown = async e => { if (e.key === 'Enter') { h.nombre = i.value.trim() || h.nombre; await api.accion(S.id, { tipo: 'renombrar-hablante', hid: h.id, nombre: h.nombre }); cerrarPop(); pintarParrafos(); } };
  return i;
}
async function agregarHablante(nombre, pid) {
  await api.accion(S.id, { tipo: 'agregar-hablante', nombre });
  S = await api.abrir(S.id);
  asignar(pid, S.hablantes[S.hablantes.length - 1].id);
}
function asignar(pid, hid) {
  const p = S.parrafos.find(x => x.id === pid);
  p.hablante = hid;
  api.accion(S.id, { tipo: 'hablante', pid, hablante: hid });
  const f = document.querySelector(`.parrafo[data-p="${pid}"]`);
  if (f) refrescar(f, p);
}

// ---------- reproductor ----------
const audio = $('#audio');
let fuente = '';
function ponerAudio() {
  if (!S.archivo) return;
  const src = `escriba://audio/${encodeURIComponent(S.id)}${S.escucha ? '?e' : ''}`;
  if (src === fuente || (fuente && !audio.paused)) return;
  const t = fuente ? audio.currentTime : 0;
  fuente = src;
  audio.src = src;
  if (t) audio.currentTime = t;
}
const sonar = () => audio.play().catch(() => {}); // pausar justo al empezar no es un error
function reproducirDesde(t) { audio.currentTime = t; sonar(); }
const VEL = [0.5, 0.75, 1, 1.25, 1.5, 2];
let pausada = false;
function alternar() { audio.paused ? tocar() : audio.pause(); }
function tocar() {
  if (audio.currentTime > 1 && pausada) audio.currentTime -= 1; // al seguir se retrocede 1 segundo: no se pierde el hilo
  sonar();
}
audio.onpause = () => { pausada = true; pintarPlay(); };
audio.onplay = () => { pausada = false; pintarPlay(); };
function pintarPlay() {
  $('#r-play use').setAttribute('href', audio.paused ? '#i-play' : '#i-pausa');
  $('#r-play').setAttribute('aria-label', audio.paused ? 'Reproducir' : 'Pausar');
}
$('#r-play').onclick = alternar;
$('#r-atras').onclick = () => { audio.currentTime = Math.max(0, audio.currentTime - 3); };
$('#r-adelante').onclick = () => { audio.currentTime += 3; };
audio.onloadedmetadata = () => { $('#r-total').textContent = mmss(audio.duration); audio.playbackRate = +$('#r-vel').value; };
$('#r-vel').onchange = e => { audio.playbackRate = +e.target.value; };
$('#r-barra').oninput = e => { audio.currentTime = e.target.value / 1000 * (audio.duration || 0); };
audio.ontimeupdate = () => {
  const d = audio.duration || 1;
  $('#r-ahora').textContent = mmss(audio.currentTime);
  if (document.activeElement !== $('#r-barra')) $('#r-barra').value = Math.round(audio.currentTime / d * 1000);
  $('#r-barra').style.setProperty('--p', (audio.currentTime / d * 100) + '%');
  iluminar();
};
let ultimoScroll = 0;
addEventListener('wheel', () => { ultimoScroll = Date.now(); }, { passive: true });
function iluminar() {
  if (vista !== 'editor' || !S) return;
  const t = audio.currentTime + 0.05;
  let p = null;
  for (const x of S.parrafos) { if (x.t0 <= t) p = x; else break; }
  const f = p && document.querySelector(`.parrafo[data-p="${p.id}"]`);
  const antes = document.querySelector('.parrafo.actual');
  if (antes === f) return;
  antes?.classList.remove('actual');
  if (!f) return;
  f.classList.add('actual');
  const r = f.getBoundingClientRect();
  if (!audio.paused && (r.top < 90 || r.bottom > innerHeight - 110) && Date.now() - ultimoScroll > 4000) f.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
document.addEventListener('keydown', e => {
  if (vista !== 'editor' || document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') { if (!pop.hidden || document.querySelector('.menu:not([hidden])')) { cerrarPop(); cerrarMenus(); return; } e.preventDefault(); return alternar(); }
  if (!e.altKey || e.metaKey || e.ctrlKey) return;
  const n = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
  if (e.code === 'ArrowLeft') { e.preventDefault(); audio.currentTime = Math.max(0, audio.currentTime - 3); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); audio.currentTime += 3; }
  else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
    e.preventDefault();
    const i = Math.max(0, Math.min(VEL.length - 1, VEL.indexOf(audio.playbackRate) + (e.code === 'ArrowUp' ? 1 : -1)));
    audio.playbackRate = VEL[i];
    $('#r-vel').value = String(VEL[i]);
    toast(`Velocidad ${String(VEL[i]).replace('.', ',')}×`);
  } else if (n && +n[1] >= 1) {
    const f = document.activeElement?.closest?.('.parrafo') || document.querySelector('.parrafo.actual'); // el del cursor o el que está sonando
    if (f && S.hablantes[+n[1] - 1]) { e.preventDefault(); asignar(f.dataset.p, S.hablantes[+n[1] - 1].id); }
  }
});

// ---------- menús ----------
function cerrarMenus() {
  for (const [m, b] of [['#m-exportar', '#e-exportar'], ['#m-mas', '#e-mas']]) { $(m).hidden = true; $(b).setAttribute('aria-expanded', 'false'); }
}
for (const [boton, menu] of [['#e-exportar', '#m-exportar'], ['#e-mas', '#m-mas']]) {
  $(boton).onclick = e => { e.stopPropagation(); const abrir = $(menu).hidden; cerrarMenus(); if (abrir) { $(menu).hidden = false; $(boton).setAttribute('aria-expanded', 'true'); $(menu).querySelector('button').focus(); } };
}
document.addEventListener('click', e => { if (!e.target.closest('.menu-env')) cerrarMenus(); if (!pop.contains(e.target) && !e.target.closest('.hablante')) cerrarPop(); });
$('#m-exportar').onclick = async e => {
  const f = e.target.closest('[data-exportar]')?.dataset.exportar;
  if (!f) return;
  cerrarMenus();
  await asegurar();
  if (f === 'carpeta') return api.carpeta(S.id);
  const r = await api.exportar(S.id, f);
  if (r && r.error) toast(r.error);
  if (r && r.ruta) { toast('Guardado: ' + r.ruta.split(/[\\/]/).pop()); api.mostrar(r.ruta); }
};
$('#m-mas').onclick = async e => {
  const a = e.target.closest('[data-mas]')?.dataset.mas;
  if (!a) return;
  cerrarMenus();
  if (a === 'ayuda') return ayuda();
  if (a === 'reiniciar' && await confirmar({ titulo: '¿Volver a transcribir?', texto: 'Se reemplaza todo el texto actual, incluidas tus correcciones. El audio no cambia.', accion: 'Volver a transcribir' })) { pendientes.forEach(p => clearTimeout(p.h)); pendientes.clear(); api.reiniciar(S.id); }
  if (a === 'borrar' && await confirmar({ titulo: '¿Borrar esta entrevista?', texto: 'La carpeta con su audio y su texto se mueve a la papelera del computador.', accion: 'Borrar' })) {
    pendientes.forEach(p => clearTimeout(p.h));
    pendientes.clear();
    audio.pause(); audio.removeAttribute('src'); audio.load(); // suelta el archivo
    const id = S.id;
    S = null;
    ver('lista');
    if (!await api.borrar(id)) toast('No se pudo mover a la papelera. Cierra otros programas que la estén usando y vuelve a intentar.');
    pintarLista();
  }
};

pintarLista();
