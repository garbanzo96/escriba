// Puente mínimo entre la ventana y el programa.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const pedir = (canal, ...a) => ipcRenderer.invoke(canal, ...a);
contextBridge.exposeInMainWorld('escriba', {
  lista: () => pedir('lista'),
  abrir: id => pedir('abrir', id),
  accion: (id, a) => pedir('accion', id, a),
  grabar: (titulo, frecuencia) => pedir('grabar', titulo, frecuencia),
  audio: (id, pcm) => ipcRenderer.send('audio', id, pcm),
  terminar: id => pedir('terminar', id),
  descartar: id => pedir('descartar', id),
  importar: rutas => pedir('importar', rutas),
  rutaDe: archivo => webUtils.getPathForFile(archivo),
  transcribir: id => pedir('transcribir', id),
  reiniciar: id => pedir('reiniciar', id),
  cancelar: id => pedir('cancelar', id),
  exportar: (id, formato) => pedir('exportar', id, formato),
  carpeta: id => pedir('carpeta', id),
  mostrar: ruta => pedir('mostrar', ruta),
  borrar: id => pedir('borrar', id),
  micro: () => pedir('micro'),
  ajustesMicro: () => pedir('ajustes-micro'),
  info: () => pedir('info'),
  alCambiar: fn => ipcRenderer.on('cambio', (e, s) => fn(s)),
  alAvanzar: fn => ipcRenderer.on('avance', (e, d) => fn(d)),
  alFaltarEspacio: fn => ipcRenderer.on('sin-espacio', (e, id) => fn(id)),
  alPedirAyuda: fn => ipcRenderer.on('ayuda', fn)
});
