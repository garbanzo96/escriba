// Convierte el audio, lo parte en trozos de unos minutos y lo transcribe con Whisper, uno tras otro.
// Todo ocurre en este computador. Cada trozo listo se guarda: si la app se cierra, se sigue desde ahí.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');

const SR = 16000;
const LARGO_TROZO = 300; // segundos
const LINEA = /^\[(\d+):(\d+):(\d+)\.(\d{3}) --> (\d+):(\d+):(\d+)\.(\d{3})\]\s*(.*)$/;
// frases que Whisper inventa en los silencios; solo se descartan si son la línea completa
const RUIDO = /amara\.org|^subt[ií]tulos (realizados|por|creados)\b|^¡?suscr[ií]b(ete|anse)( al canal| a nuestro canal)?[.!]*$|^¡?(muchas )?gracias por (ver|mirar)( el| este)?( v[ií]deo)?[.!]*$/i;
const PAUSA_PARRAFO = 1.0; // una pausa de 1 s abre un párrafo nuevo
const HUECO = '[tramo sin transcribir]';
const INSTRUCCION_ILEGAL = 3221225501; // Windows: el procesador es antiguo (sin AVX2)
const EXE = process.platform === 'win32' ? '.exe' : '';

class Transcriptor extends EventEmitter {
  constructor(almacen, recursos) {
    super();
    this.almacen = almacen;
    this.recursos = recursos; // carpeta con bin/ y modelo/
    this.cola = [];
    this.actual = null;
    this.hijo = null;
    this.copias = new Map(); // entrevista → proceso que prepara su copia para escuchar
    this.deteniendo = false;
    this.antiguo = false;
  }

  programa(nombre) { return path.join(this.recursos, 'bin', nombre + EXE); }

  encolar(id) {
    const s = this.almacen.obtener(id);
    if (!s || s.estado === 'grabando' || this.actual === id || this.cola.includes(id)) return;
    s.estado = 'por-transcribir';
    s.error = '';
    this.almacen.guardar(id);
    this.emit('cambio', id);
    this.cola.push(id);
    this.seguir();
  }

  async seguir() {
    if (this.actual || !this.cola.length) return;
    this.actual = this.cola.shift();
    const id = this.actual;
    try {
      await this.procesar(id);
    } catch (e) {
      const s = this.almacen.obtener(id);
      if (s && s.estado === 'transcribiendo') {
        const parada = this.deteniendo || this.cancelada === id;
        s.estado = parada ? 'por-transcribir' : 'error';
        s.error = parada ? '' : e.message;
        if (!parada) this.emit('problema', `${id}: ${e.message} ${e.detalle || ''}`);
        this.almacen.guardar(id);
      }
    }
    this.actual = null;
    this.hijo = null;
    this.emit('cambio', id);
    if (!this.deteniendo) this.seguir();
  }

  async cancelar(id) { // termina cuando ya nadie usa los archivos de la entrevista
    this.cola = this.cola.filter(x => x !== id);
    if (this.actual === id) {
      this.cancelada = id;
      if (this.hijo) this.hijo.kill();
      while (this.actual === id) await new Promise(r => setTimeout(r, 40));
    }
  }

  detener() { // al cerrar la app
    this.deteniendo = true;
    this.cola = [];
    if (this.hijo) this.hijo.kill();
    for (const p of this.copias.values()) p.kill();
  }

  async soltar(id) { // antes de borrar: nada de Escriba queda usando la carpeta
    await this.cancelar(id);
    const p = this.copias.get(id);
    if (p) await new Promise(r => { p.once('close', r); p.kill(); });
  }

  async volverAEmpezar(id) {
    await this.cancelar(id);
    const s = this.almacen.obtener(id);
    if (!s) return;
    s.parrafos = []; s.cortes = null; s.hechos = 0; s.progreso = 0; s.error = '';
    this.almacen.guardar(id);
    this.encolar(id);
  }

  async procesar(id) {
    const s = this.almacen.obtener(id);
    if (!s) return;
    s.estado = 'transcribiendo';
    this.cancelada = null;
    this.almacen.guardar(id);
    this.emit('cambio', id);

    const wav = await this.convertir(id);
    const { datos, duracion } = this.leerWav(wav);
    if (!s.duracion || Math.abs(s.duracion - duracion) > 1) s.duracion = duracion;
    if (!s.cortes) s.cortes = this.cortar(datos);
    const n = s.cortes.length - 1;
    const parada = () => this.cancelada === id || this.deteniendo;

    while (s.hechos < n) {
      const k = s.hechos, desde = s.cortes[k], hasta = s.cortes[k + 1];
      let fallo = null;
      for (let intento = 0; intento < 2 && !parada(); intento++) {
        s.parrafos = s.parrafos.filter(p => p.trozo !== k || p.editado); // se rehace lo que quedó a medias; lo corregido se respeta
        fallo = await this.trozo(s, k, datos.subarray(desde * 2, hasta * 2), desde / SR, (hasta - desde) / SR, intento);
        if (!fallo) break;
        if (!parada()) this.emit('problema', `${id}, trozo ${k}, intento ${intento}: ${fallo.message} ${fallo.detalle || ''}`);
      }
      if (parada()) {
        s.estado = 'por-transcribir';
        this.almacen.guardar(id);
        return;
      }
      if (fallo) {
        if (!s.parrafos.some(p => p.texto !== HUECO)) throw Object.assign(new Error('El transcriptor no pudo funcionar en este computador. Reinicia el computador y vuelve a intentar.'), { detalle: fallo.detalle });
        s.parrafos.push({ id: randomUUID().slice(0, 8), t0: desde / SR, t1: hasta / SR, texto: HUECO, trozo: k, hablante: null, editado: false }); // el hueco queda a la vista
      }
      s.hechos = k + 1;
      s.progreso = s.hechos / n;
      this.almacen.guardar(id);
      this.emit('cambio', id);
    }
    s.estado = 'lista';
    s.progreso = 1;
    this.almacen.guardar(id);
    fs.rmSync(wav, { force: true });
  }

  // ---------- audio ----------
  correr(programa, args, { cwd, entrada, copia } = {}, alDato) {
    return new Promise((resolver, fallar) => {
      const p = spawn(programa, args, { windowsHide: true, cwd });
      if (copia) this.copias.set(copia, p); else this.hijo = p;
      let error = '';
      p.stdout.setEncoding('utf8'); // una tilde partida entre dos lecturas no se rompe
      p.stderr.on('data', d => { error = (error + d).slice(-1500); });
      if (alDato) p.stdout.on('data', alDato); else p.stdout.resume();
      const mal = (txt, codigo) => fallar(Object.assign(new Error(txt), { codigo, detalle: `${path.basename(programa)} (${codigo}) ${error.trim().slice(-400)}` }));
      p.on('error', e => { if (copia) this.copias.delete(copia); mal(e.message, e.code); });
      p.on('close', codigo => { if (copia) this.copias.delete(copia); if (codigo === 0) resolver(); else mal('El programa terminó antes de tiempo.', codigo); });
      p.stdin.on('error', () => {});
      p.stdin.end(entrada);
    });
  }

  async convertir(id) {
    const origen = this.almacen.audio(id);
    if (!origen || !fs.existsSync(origen)) throw new Error('No se encontró el audio de esta entrevista.');
    const destino = path.join(this.almacen.carpeta(id), 'temporal.wav'), parcial = path.join(this.almacen.carpeta(id), 'temporal-parcial.wav');
    if (fs.existsSync(destino)) return destino;
    try {
      await this.correr(this.programa('ffmpeg'), ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', origen, '-vn',
        '-af', 'highpass=f=70,dynaudnorm=f=250:g=15:p=0.9:m=30', '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', parcial]);
    } catch (e) {
      e.message = /No space left/i.test(e.detalle) ? 'No queda espacio en el disco. Libera espacio y vuelve a intentar.' : 'Escriba no pudo leer este archivo. Comprueba que sea una grabación y que se escuche en otro programa.';
      throw e;
    }
    fs.renameSync(parcial, destino);
    return destino;
  }

  // copia para escuchar de lo importado: así todo formato suena y el texto calza con el audio
  faltaCopia(s) { return s.origen === 'importada' && s.archivo && !s.escucha && s.estado !== 'error'; }

  async copiaParaEscuchar(id) {
    const s = this.almacen.obtener(id);
    if (!s || !this.faltaCopia(s) || this.copias.has(id)) return;
    const parcial = path.join(this.almacen.carpeta(id), 'escucha-parcial.m4a'), destino = path.join(this.almacen.carpeta(id), 'escucha.m4a');
    try {
      await this.correr(this.programa('ffmpeg'), ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', this.almacen.audio(id), '-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', parcial], { copia: id });
      fs.renameSync(parcial, destino);
      s.escucha = 'escucha.m4a';
      this.almacen.guardar(id);
      this.emit('cambio', id);
    } catch (e) { if (!this.deteniendo && !s.borrada) this.emit('problema', `${id}, copia para escuchar: ${e.detalle || e.message}`); }
  }

  leerWav(ruta) {
    const b = fs.readFileSync(ruta);
    let i = 12;
    while (i < b.length - 8) {
      const id = b.toString('ascii', i, i + 4), largo = b.readUInt32LE(i + 4);
      if (id === 'data') {
        const d = b.subarray(i + 8, i + 8 + Math.floor((Math.min(b.length, i + 8 + largo) - i - 8) / 2) * 2);
        return { datos: d, duracion: d.length / 2 / SR };
      }
      i += 8 + largo + (largo % 2);
    }
    throw new Error('La grabación está vacía.');
  }

  // puntos de corte (en muestras): cada ~5 min, en el momento más callado de los 24 s alrededor
  cortar(datos) {
    const total = datos.length / 2, cortes = [0];
    const largo = LARGO_TROZO * SR;
    while (total - cortes[cortes.length - 1] > largo * 1.3) {
      const meta = cortes[cortes.length - 1] + largo;
      cortes.push(this.masCallado(datos, meta - 12 * SR, meta + 12 * SR));
    }
    cortes.push(total);
    return cortes;
  }

  masCallado(datos, desde, hasta) {
    const marco = Math.floor(SR * 0.4), paso = Math.floor(SR * 0.1);
    const total = datos.length / 2;
    let mejor = Math.max(desde, 1), menor = Infinity;
    for (let i = Math.max(0, desde); i + marco < Math.min(total, hasta); i += paso) {
      let e = 0;
      for (let k = i; k < i + marco; k += 4) { const v = datos.readInt16LE(k * 2); e += v * v; }
      if (e < menor) { menor = e; mejor = i + Math.floor(marco / 2); }
    }
    return mejor;
  }

  // ---------- Whisper ----------
  async trozo(s, k, pcm, inicio, duracion, intento) {
    // el audio entra por la entrada estándar y los modelos van con nombre relativo: así ninguna ruta con tildes llega a Whisper
    const args = ['-m', 'ggml-large-v3-turbo-q5_0.bin', '-l', 'es', '-f', '-', '-of', 'x', '-mc', '0', '-sns', '-t', String(this.hilos()),
      '--vad', '-vm', 'ggml-silero-v5.1.2.bin'];
    if (intento) args.push('-ng'); // segundo intento sin tarjeta gráfica
    const entrada = Buffer.concat([this.almacen.encabezadoWav(pcm.length, SR), pcm]);
    let resto = '', ultima = '', iguales = 0, latidos = 0;
    const alDato = d => {
      latidos = 0;
      resto += d;
      const lineas = resto.split(/\r?\n/);
      resto = lineas.pop();
      for (const l of lineas) {
        const m = LINEA.exec(l.trim());
        if (!m) continue;
        const t0 = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000, t1 = +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000;
        const texto = m[9].replace(/\s+/g, ' ').trim();
        if (!texto || RUIDO.test(texto)) continue;
        iguales = texto === ultima ? iguales + 1 : 0;
        ultima = texto;
        if (iguales >= 2) continue; // repetición en bucle
        this.agregar(s, k, inicio + t0, inicio + Math.min(t1, duracion), texto);
        s.progreso = (k + Math.min(1, t1 / duracion)) / (s.cortes.length - 1);
        this.emit('avance', s.id);
      }
    };
    // corta solo un proceso colgado (45 min sin avanzar); cuenta latidos y no la hora, para que cerrar la tapa no lo mate al despertar
    const reloj = setInterval(() => { if (++latidos > 90 && this.hijo) this.hijo.kill(); }, 30000);
    const lanzar = () => this.correr(this.programa(this.antiguo ? 'whisper-cli-compat' : 'whisper-cli'), args, { cwd: path.join(this.recursos, 'modelo'), entrada }, alDato);
    try {
      try {
        await lanzar();
      } catch (e) {
        if (e.codigo !== INSTRUCCION_ILEGAL || this.antiguo) throw e;
        this.antiguo = true;
        this.emit('problema', 'procesador sin AVX2: se usa la versión lenta');
        s.lento = true;
        this.emit('cambio', s.id);
        await lanzar();
      }
      return null;
    } catch (e) {
      return e;
    } finally {
      clearInterval(reloj);
    }
  }

  hilos() { return Math.max(2, Math.min(8, os.cpus().length > 4 ? Math.floor(os.cpus().length / 2) : os.cpus().length)); }

  // junta las frases en párrafos; una pausa, una pregunta o un párrafo ya largo abren otro
  agregar(s, k, t0, t1, texto) {
    const medio = (t0 + t1) / 2;
    if (s.parrafos.some(p => p.editado && medio >= p.t0 && medio < p.t1)) return; // ya está, y corregido a mano
    let i = s.parrafos.length;
    while (i && s.parrafos[i - 1].t0 > t0) i--;
    const p = s.parrafos[i - 1];
    const palabras = p ? p.texto.split(/\s+/).length : 0;
    const cierra = p && /[.!?…]$/.test(p.texto);
    const junta = p && !p.editado && p.trozo === k && t0 - p.t1 < PAUSA_PARRAFO && palabras < 90 && !(cierra && palabras >= 45) && !p.texto.endsWith('?');
    if (junta) {
      p.texto += ' ' + texto;
      p.t1 = t1;
    } else {
      s.parrafos.splice(i, 0, { id: randomUUID().slice(0, 8), t0, t1, texto, trozo: k, hablante: null, editado: false });
    }
    this.emit('cambio', s.id);
  }
}

module.exports = { Transcriptor };
