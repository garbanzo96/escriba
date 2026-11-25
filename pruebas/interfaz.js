// Recorre la app real como lo haría una persona: importar, transcribir, escuchar, editar, exportar, grabar, cerrar a medias y borrar.
// Uso: EJECUTABLE=<ruta de la app instalada> node pruebas/interfaz.js   (sin EJECUTABLE usa el Electron del proyecto)
const { _electron } = require('playwright-core');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');

const raiz = path.join(__dirname, '..');
const temporal = fs.mkdtempSync(path.join(os.tmpdir(), 'escriba-prueba-'));
const datos = path.join(temporal, 'datos con ñ');
const capturas = process.env.CAPTURAS || path.join(temporal, 'capturas');
fs.mkdirSync(capturas, { recursive: true });
const audio = path.join(temporal, 'Entrevista María ñandú.wav');
fs.copyFileSync(process.env.AUDIO || path.join(raiz, 'recursos', 'muestra.wav'), audio);

const errores = [];
async function abrir() {
  const extra = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-audio-output']; // micrófono y parlantes simulados
  const app = await _electron.launch({
    executablePath: process.env.EJECUTABLE || require('electron'),
    args: process.env.EJECUTABLE ? extra : [raiz, ...extra],
    env: { ...process.env, ESCRIBA_DATOS: datos }, timeout: 120000
  });
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; }); // «Cerrar» cuando pregunta
  const w = await app.firstWindow();
  w.on('pageerror', e => errores.push(e.message));
  w.on('console', m => m.type() === 'error' && errores.push(m.text()));
  await w.waitForFunction(() => typeof pintarLista === 'function');
  return { app, w };
}
const paso = t => console.log(`· ${t}`);
const lista = w => w.waitForFunction(() => S && (S.estado === 'lista' || S.estado === 'error'), null, { timeout: 15 * 60000 });

(async () => {
  let { app, w } = await abrir();
  let n = 0;
  const foto = nombre => w.screenshot({ path: path.join(capturas, `${++n}-${nombre}.png`) }).catch(() => {});
  await foto('inicio');

  // importar y transcribir
  const t0 = Date.now();
  const [id] = await w.evaluate(r => window.escriba.importar([r]), audio);
  await w.evaluate(i => abrirEditor(i), id);
  await w.waitForTimeout(2500); await foto('transcribiendo');
  await lista(w);
  const r = await w.evaluate(() => ({ estado: S.estado, error: S.error, n: S.parrafos.length, texto: S.parrafos.map(p => p.texto).join(' ') }));
  assert.equal(r.estado, 'lista', r.error);
  assert.ok(r.texto.length > 10, 'sin texto');
  paso(`transcrito en ${Math.round((Date.now() - t0) / 1000)} s: ${r.n} párrafos, «${r.texto.slice(0, 80)}…»`);

  // escuchar
  await w.waitForFunction(() => S.escucha, null, { timeout: 120000 });
  await w.waitForFunction(() => document.querySelector('#audio').readyState >= 1, null, { timeout: 20000 });
  await w.evaluate(() => { document.querySelector('#audio').muted = true; });
  await w.click('.parrafo .minuto');
  await w.waitForTimeout(1500);
  let a = await w.evaluate(() => { const x = document.querySelector('#audio'); return { suena: !x.paused, t: x.currentTime, d: x.duration, luz: !!document.querySelector('.parrafo.actual'), src: x.src }; });
  assert.ok(a.suena && a.t > 0.4 && a.d > 5 && a.luz && a.src.endsWith('?e'), JSON.stringify(a));
  await w.keyboard.press('Alt+ArrowUp'); await w.keyboard.press('Alt+ArrowUp');
  assert.equal(await w.evaluate(() => document.querySelector('#audio').playbackRate), 1.5);
  await w.keyboard.press('Escape'); await w.waitForTimeout(200);
  assert.ok(await w.evaluate(() => document.querySelector('#audio').paused));
  await w.evaluate(() => { document.querySelector('#audio').currentTime = 6; }); await w.keyboard.press('Alt+ArrowLeft'); await w.waitForTimeout(300);
  assert.ok(Math.abs(await w.evaluate(() => document.querySelector('#audio').currentTime) - 3) < 0.3);
  paso('audio: suena desde el minuto, ilumina, velocidad, pausa y salto');

  // editar, partir, unir, hablantes
  await w.locator('.parrafo .cuerpo').first().click(); await w.keyboard.press('End'); await w.keyboard.type(' corrección');
  const antes = await w.evaluate(() => S.parrafos.length);
  const medio = await w.evaluate(() => { const c = document.querySelector('.parrafo .cuerpo'), i = c.textContent.indexOf(' ', 12); poner(c, i); return i; });
  await w.keyboard.press('Enter'); await w.waitForFunction(x => S.parrafos.length === x + 1, antes);
  await w.keyboard.press('Alt+Digit2');
  await w.locator('.parrafo').first().locator('.hablante').click(); await w.waitForTimeout(200); await foto('hablante');
  await w.locator('#pop button').first().click();
  assert.deepEqual(await w.evaluate(() => S.parrafos.slice(0, 2).map(p => p.hablante)), ['h1', 'h2']);
  await w.evaluate(() => poner(document.querySelector('.parrafo .cuerpo'), 3)); await w.keyboard.press('ArrowDown');
  await w.waitForTimeout(600); await foto('editor');
  const txt = () => fs.readFileSync(path.join(datos, id, 'transcripcion.txt'), 'utf8');
  assert.ok(/\] Entrevistadora: /.test(txt()) && /\] Entrevistado\/a: /.test(txt()) && txt().includes('corrección'), txt());
  await w.evaluate(() => poner(document.querySelectorAll('.parrafo .cuerpo')[1], 0)); await w.keyboard.press('Backspace');
  await w.waitForFunction(x => S.parrafos.length === x, antes);
  paso(`edición: guardada en disco, partir en ${medio}, unir, hablantes`);

  // exportar
  for (const [f, ext] of [['word', 'docx'], ['texto', 'txt']]) {
    const destino = path.join(temporal, `salida.${ext}`);
    await app.evaluate(({ dialog, shell }, d) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: d }); shell.showItemInFolder = () => {}; }, destino);
    await w.click('#e-exportar'); await w.click(`[data-exportar=${f}]`); await w.waitForTimeout(1200);
    assert.ok(fs.statSync(destino).size > 60, f);
  }
  paso('exporta a Word y a texto');

  // grabar, pausar, seguir, terminar
  await w.click('#e-volver'); await w.click('#b-nueva'); await w.fill('#g-titulo', 'Grabación de prueba');
  const grabando = () => w.waitForFunction(() => g.estado === 'grabando', null, { timeout: 30000 });
  await w.dblclick('#g-boton'); await grabando(); await w.waitForTimeout(2500); await foto('grabando');
  await w.click('#g-boton'); await w.waitForTimeout(800); await w.click('#g-boton'); await grabando(); await w.waitForTimeout(2000);
  await w.click('#g-terminar');
  await w.waitForFunction(() => vista === 'editor' && S.titulo === 'Grabación de prueba');
  await lista(w);
  const g = await w.evaluate(() => ({ id: S.id, estado: S.estado, d: S.duracion, error: S.error }));
  const wav = fs.statSync(path.join(datos, g.id, 'grabacion.wav')).size;
  assert.ok(g.estado === 'lista' && g.d > 3.5 && g.d < 8 && !/\(2\)/.test(g.id) && Math.abs(wav - 44 - g.d * 96000) < 2000, JSON.stringify({ ...g, wav }));
  await w.waitForFunction(() => document.querySelector('#audio').duration > 3, null, { timeout: 20000 });
  paso(`grabación con pausa: ${g.d.toFixed(1)} s guardados y reproducibles`);

  // cerrar a mitad de una transcripción y retomar
  const [id2] = await w.evaluate(r => window.escriba.importar([r]), audio);
  await w.waitForTimeout(1500);
  await app.close();
  ({ app, w } = await abrir());
  await w.evaluate(i => abrirEditor(i), id2); await lista(w);
  const r2 = await w.evaluate(() => ({ estado: S.estado, n: S.parrafos.length, texto: S.parrafos.map(p => p.texto).join(' ') }));
  assert.ok(r2.estado === 'lista' && r2.n > 0);
  await w.waitForFunction(() => S.escucha, null, { timeout: 120000 });
  const iguales = await w.evaluate(i => window.escriba.abrir(i).then(s => s.parrafos[0].texto.includes('corrección') || s.parrafos.some(p => p.texto.includes('corrección'))), id);
  assert.ok(iguales, 'lo editado debe seguir al reabrir');
  assert.ok(!fs.readdirSync(path.join(datos, id2)).some(f => f.startsWith('temporal')), 'no quedan temporales');
  paso('cerrada a medias, retoma sola y conserva lo editado');

  // volver a transcribir
  await w.click('#e-mas'); await w.click('[data-mas=reiniciar]'); await w.click('#dc-si');
  await w.waitForFunction(() => S.estado !== 'lista', null, { timeout: 10000 }); await lista(w);
  assert.ok(await w.evaluate(() => S.estado === 'lista' && S.parrafos.length > 0));
  paso('volver a transcribir');

  // archivo que no es audio: mensaje claro, sin caídas
  const falso = path.join(temporal, 'apuntes.mp3'); fs.writeFileSync(falso, 'esto no es audio');
  const [id3] = await w.evaluate(r => window.escriba.importar([r]), falso);
  await w.evaluate(i => abrirEditor(i), id3); await lista(w);
  assert.ok(/no pudo leer este archivo/.test(await w.evaluate(() => S.error)));
  await foto('archivo-malo');
  paso('archivo que no es audio: avisa con claridad');

  // borrar mientras el audio está cargado
  await w.evaluate(i => abrirEditor(i), id2); await w.click('.parrafo .minuto'); await w.waitForTimeout(700);
  await w.click('#e-mas'); await w.click('[data-mas=borrar]'); await w.click('#dc-si');
  await w.waitForFunction(i => !document.querySelector(`[data-id="${CSS.escape(i)}"]`) && vista === 'lista', id2, { timeout: 15000 });
  await w.waitForTimeout(2500);
  assert.ok(!fs.existsSync(path.join(datos, id2)), 'la carpeta sigue ahí');
  await foto('lista');
  paso('borrar: a la papelera');

  await app.close();
  const raros = errores.filter(e => !/ERR_REQUEST_RANGE|MEDIA_ELEMENT|404|net::ERR_FAILED/.test(e));
  const registro = path.join(datos, 'registro-de-problemas.txt');
  if (fs.existsSync(registro)) console.log('registro:\n' + fs.readFileSync(registro, 'utf8'));
  assert.deepEqual(raros, []);
  console.log('INTERFAZ OK');
  fs.rmSync(temporal, { recursive: true, force: true });
})().catch(e => { console.error('INTERFAZ FALLA', e.stack); console.error('errores de la página:', errores); try { console.error(fs.readFileSync(path.join(datos, 'registro-de-problemas.txt'), 'utf8')); } catch { /* sin registro */ } process.exit(1); });
