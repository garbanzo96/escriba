// Guarda cada entrevista en su propia carpeta: audio, texto y datos. Se escribe después de cada cambio.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const ENCABEZADO = 44;
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const dos = n => String(n).padStart(2, '0');
const mmss = s => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  return (h ? h + ':' + dos(Math.floor(s / 60) % 60) : dos(Math.floor(s / 60))) + ':' + dos(s % 60);
};

function escribirSeguro(ruta, texto) {
  const tmp = ruta + '.tmp'; // escribir y renombrar: un corte de luz no deja el archivo a medias
  fs.writeFileSync(tmp, texto);
  fs.renameSync(tmp, ruta);
}

function fechaLarga(iso) {
  const d = new Date(iso);
  return `${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}, ${dos(d.getHours())}:${dos(d.getMinutes())}`;
}

class Almacen {
  constructor(base) {
    this.base = base;
    fs.mkdirSync(base, { recursive: true });
    this.sesiones = new Map();
    for (const d of fs.readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(base, d.name, 'sesion.json'), 'utf8'));
        if (s.estado === 'grabando') this.recuperarGrabacion(d.name, s); // la app se cerró grabando: el audio está entero
        if (s.estado === 'transcribiendo') s.estado = 'por-transcribir'; // se reanuda donde quedó
        this.sesiones.set(d.name, s);
      } catch { /* carpeta ajena o datos ilegibles: se deja tal cual */ }
    }
  }

  carpeta(id) { return path.join(this.base, id); }
  obtener(id) { return this.sesiones.get(id); }
  audio(id) { const s = this.obtener(id); return s && s.archivo ? path.join(this.carpeta(id), s.archivo) : null; }

  crear({ titulo, origen, archivo = null }) {
    const ahora = new Date();
    const sello = `${ahora.getFullYear()}-${dos(ahora.getMonth() + 1)}-${dos(ahora.getDate())} ${dos(ahora.getHours())}.${dos(ahora.getMinutes())}`;
    const limpio = (titulo || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50).replace(/[. ]+$/, '');
    let id = [sello, limpio].filter(Boolean).join(' ');
    for (let n = 2; this.sesiones.has(id) || fs.existsSync(this.carpeta(id)); n++) id = `${[sello, limpio].filter(Boolean).join(' ')} (${n})`;
    fs.mkdirSync(this.carpeta(id), { recursive: true });
    const s = {
      id, titulo: titulo || `Entrevista del ${fechaLarga(ahora.toISOString())}`, creada: ahora.toISOString(), origen, archivo,
      duracion: 0, estado: origen === 'grabada' ? 'grabando' : 'por-transcribir', progreso: 0, error: '',
      hablantes: [{ id: 'h1', nombre: 'Entrevistadora' }, { id: 'h2', nombre: 'Entrevistado/a' }], parrafos: [], cortes: null, hechos: 0
    };
    this.sesiones.set(id, s);
    this.guardar(id);
    return s;
  }

  guardar(id) {
    const s = this.obtener(id);
    if (!s || s.borrada) return;
    escribirSeguro(path.join(this.carpeta(id), 'sesion.json'), JSON.stringify(s, (k, v) => (k === 'wav' ? undefined : v), 1));
    escribirSeguro(path.join(this.carpeta(id), 'transcripcion.txt'), this.texto(id));
  }

  texto(id) {
    const s = this.obtener(id);
    const nombre = h => (s.hablantes.find(x => x.id === h) || {}).nombre;
    const lineas = s.parrafos.map(p => `[${mmss(p.t0)}] ${nombre(p.hablante) ? nombre(p.hablante) + ': ' : ''}${p.texto}`);
    return `${s.titulo}\n${fechaLarga(s.creada)}, duración ${mmss(s.duracion)}\n\n${lineas.join('\n\n')}\n`;
  }

  // ---------- grabación ----------
  abrirWav(id, frecuencia) {
    const s = this.obtener(id);
    s.archivo = 'grabacion.wav';
    const fd = fs.openSync(path.join(this.carpeta(id), s.archivo), 'w');
    fs.writeSync(fd, this.encabezadoWav(0, frecuencia));
    s.wav = { fd, frecuencia, bytes: 0, desdeParche: 0 };
    this.guardar(id);
  }

  encabezadoWav(bytes, frecuencia) {
    const b = Buffer.alloc(ENCABEZADO);
    b.write('RIFF', 0); b.writeUInt32LE(36 + bytes, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(frecuencia, 24); b.writeUInt32LE(frecuencia * 2, 28);
    b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(bytes, 40);
    return b;
  }

  agregarAudio(id, pcm) {
    const s = this.obtener(id);
    if (!s || !s.wav) return;
    fs.writeSync(s.wav.fd, pcm);
    s.wav.bytes += pcm.length;
    s.wav.desdeParche += pcm.length;
    s.duracion = s.wav.bytes / 2 / s.wav.frecuencia;
    if (s.wav.desdeParche > s.wav.frecuencia * 4) this.parchar(id); // cada ~2 s el archivo queda válido aunque se corte la luz
  }

  parchar(id) {
    const { wav } = this.obtener(id);
    fs.writeSync(wav.fd, this.encabezadoWav(wav.bytes, wav.frecuencia), 0, ENCABEZADO, 0);
    wav.desdeParche = 0;
  }

  terminarWav(id) {
    const s = this.obtener(id);
    if (!s || !s.wav) return;
    this.parchar(id);
    fs.closeSync(s.wav.fd);
    delete s.wav;
    s.estado = s.duracion > 0.5 ? 'por-transcribir' : 'error';
    if (s.estado === 'error') s.error = 'No se alcanzó a grabar audio.';
    this.guardar(id);
  }

  recuperarGrabacion(id, s) {
    const ruta = path.join(this.carpeta(id), 'grabacion.wav');
    try {
      const b = Buffer.alloc(ENCABEZADO), fd = fs.openSync(ruta, 'r+');
      fs.readSync(fd, b, 0, ENCABEZADO, 0);
      const frecuencia = b.readUInt32LE(24), bytes = fs.fstatSync(fd).size - ENCABEZADO;
      fs.writeSync(fd, this.encabezadoWav(bytes - bytes % 2, frecuencia), 0, ENCABEZADO, 0);
      fs.closeSync(fd);
      s.archivo = 'grabacion.wav';
      s.duracion = bytes / 2 / frecuencia;
    } catch { /* sin audio: queda como estaba */ }
    s.estado = 'por-transcribir';
  }

  // ---------- edición ----------
  accion(id, a) {
    const s = this.obtener(id);
    if (!s) return;
    const p = a.pid && s.parrafos.find(x => x.id === a.pid);
    const i = p ? s.parrafos.indexOf(p) : -1;
    if (a.tipo === 'titulo') s.titulo = (a.titulo || '').replace(/\s+/g, ' ').trim() || s.titulo;
    if (a.tipo === 'texto' && p) { p.texto = a.texto; p.editado = true; }
    if (a.tipo === 'hablante' && p) { p.hablante = s.hablantes.some(h => h.id === a.hablante) ? a.hablante : null; p.editado = true; }
    if (a.tipo === 'dividir' && p) { // corta un párrafo en dos, con un tiempo proporcional a los caracteres
      const frac = a.largo ? a.pos / a.largo : 0.5;
      const nuevo = { id: randomUUID().slice(0, 8), t0: p.t0 + (p.t1 - p.t0) * frac, t1: p.t1, texto: a.resto, hablante: p.hablante, trozo: p.trozo, editado: true };
      p.texto = a.texto; p.t1 = nuevo.t0; p.editado = true;
      s.parrafos.splice(i + 1, 0, nuevo);
      this.guardar(id);
      return { nuevo };
    }
    if (a.tipo === 'unir' && i > 0) { // une con el párrafo anterior
      const antes = s.parrafos[i - 1];
      const junto = (antes.texto + ' ' + p.texto).replace(/\s+/g, ' ').trim();
      const pos = antes.texto.length;
      antes.texto = junto; antes.t1 = p.t1; antes.editado = true;
      s.parrafos.splice(i, 1);
      this.guardar(id);
      return { pid: antes.id, texto: junto, pos };
    }
    if (a.tipo === 'quitar' && p) s.parrafos.splice(i, 1);
    if (a.tipo === 'agregar-hablante') {
      const n = Math.max(0, ...s.hablantes.map(h => +h.id.slice(1))) + 1;
      s.hablantes.push({ id: 'h' + n, nombre: (a.nombre || `Hablante ${n}`).trim() });
    }
    if (a.tipo === 'renombrar-hablante') {
      const h = s.hablantes.find(x => x.id === a.hid);
      if (h && a.nombre.trim()) h.nombre = a.nombre.trim();
    }
    this.guardar(id);
    return { ok: true };
  }

  resumen(s) {
    return {
      id: s.id, titulo: s.titulo, creada: s.creada, duracion: s.duracion, origen: s.origen, estado: s.estado, progreso: s.progreso,
      error: s.error, extracto: s.parrafos.slice(0, 2).map(p => p.texto).join(' ').slice(0, 160)
    };
  }

  lista() {
    return [...this.sesiones.values()].map(s => this.resumen(s)).sort((a, b) => b.creada.localeCompare(a.creada));
  }
}

module.exports = { Almacen, mmss, fechaLarga };
