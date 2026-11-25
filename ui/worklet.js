// Captura el micrófono en bloques y los manda a la página.
registerProcessor('captura', class extends AudioWorkletProcessor {
  process(entradas) {
    const c = entradas[0] && entradas[0][0];
    if (c) this.port.postMessage(c.slice(0));
    return true;
  }
});
