// Exportar a Word y a texto simple.
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
const { mmss, fechaLarga } = require('./almacen');

function docx(s) {
  const nombre = h => (s.hablantes.find(x => x.id === h) || {}).nombre;
  const parrafos = s.parrafos.map(p => {
    const quien = nombre(p.hablante);
    return new Paragraph({
      spacing: { after: 180, line: 320 },
      children: [
        new TextRun({ text: `${mmss(p.t0)}  `, color: '6b7a78', size: 18 }),
        ...(quien ? [new TextRun({ text: `${quien}: `, bold: true })] : []),
        new TextRun(p.texto)
      ]
    });
  });
  const doc = new Document({
    creator: 'Escriba',
    title: s.titulo,
    styles: { default: { document: { run: { font: 'Calibri', size: 23 } } } },
    sections: [{
      children: [
        new Paragraph({ text: s.titulo, heading: HeadingLevel.TITLE }),
        new Paragraph({ spacing: { after: 360 }, children: [new TextRun({ text: `${fechaLarga(s.creada)}, duración ${mmss(s.duracion)}`, color: '6b7a78' })] }),
        ...parrafos
      ]
    }]
  });
  return Packer.toBuffer(doc);
}

module.exports = { docx };
