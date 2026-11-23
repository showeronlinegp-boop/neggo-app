// Tests de leadObjetivos.js (ficha comercial del prospecto). Uso: node services/leadObjetivos.test.js
const assert = require('assert');
const o = require('./leadObjetivos');

const ahora = new Date('2026-11-22T20:00:00Z');
const hace = (dias) => new Date(ahora.getTime() - dias * 86400000);

// Grupos de charla
assert.strictEqual(o.grupoDeCharla(null, ahora), 'sinchat');
assert.strictEqual(o.grupoDeCharla(hace(0.1), ahora), 'activos');
assert.strictEqual(o.grupoDeCharla(hace(7), ahora), 'activos');
assert.strictEqual(o.grupoDeCharla(hace(7.5), ahora), 'abiertos');
assert.strictEqual(o.grupoDeCharla(hace(15), ahora), 'abiertos');
assert.strictEqual(o.grupoDeCharla(hace(40), ahora), 'dormidos');

// ¿El mensaje ya cuenta la respuesta?
const minimo = 'El mínimo de compra es $50.000.';
const horario = 'Nuestro horario comercial es:\nLunes a viernes: 9:00 a 18:00\nSábado: 9:00 a 14:00';
const presentacion = 'Buenas, ¿todo bien?\nSoy Mariano de Neggo Mayorista. El mínimo de compra es $50.000.\n\nNuestro horario comercial es:\nLunes a viernes: 9:00 a 18:00\nSábado: 9:00 a 14:00';
assert.strictEqual(o.cuentaLaRespuesta(minimo, presentacion), true);
assert.strictEqual(o.cuentaLaRespuesta(horario, presentacion), true);
assert.strictEqual(o.cuentaLaRespuesta(minimo, 'Hola, ¿cómo andás? Te paso la lista'), false);
// Otro monto no cuenta
assert.strictEqual(o.cuentaLaRespuesta(minimo, 'El mínimo de compra es $80.000'), false);
assert.strictEqual(o.cuentaLaRespuesta('', presentacion), false);

const informados = o.informadosEnMensajes(
    [{ id: 1, respuesta: minimo }, { id: 2, respuesta: horario }, { id: 3, respuesta: 'Estamos en San Martín 123, Pergamino.' }],
    [{ texto: 'hola', fuente: 'chat', fecha: 'a' }, { texto: presentacion, fuente: 'bot', fecha: 'b' }],
);
assert.deepStrictEqual([...informados.keys()], [1, 2]);
assert.strictEqual(informados.get(1).fuente, 'bot');

// Objetivos: conocer + informar, el siguiente es el primero sin hacer
const respuestas = [{ id: 1, pregunta: '¿Mínimo?', respuesta: minimo }, { id: 3, pregunta: '¿Dónde están?', respuesta: 'San Martín 123' }];
let ob = o.objetivos({ perfil: null, lead: { city: 'Pergamino' }, respuestas, informados: new Map([[1, { fuente: 'manual', fecha: 'x' }]]) });
assert.deepStrictEqual(ob.conocer.map((c) => c.hecho), [true, false]);
assert.strictEqual(ob.conocer[0].valor, 'Pergamino');
assert.deepStrictEqual(ob.informar.map((i) => i.hecho), [true, false]);
assert.strictEqual(ob.hechos, 2);
assert.strictEqual(ob.total, 5);
assert.strictEqual(ob.listo_para_precios, false);
// Nota 227: el primer objetivo es mandarle la presentación
assert.strictEqual(ob.presentar[0].hecho, false);
assert.deepStrictEqual(ob.siguiente, { grupo: 'presentar', id: 'presentacion', titulo: 'Mandarle la presentación' });
ob = o.objetivos({ perfil: null, lead: { city: 'Pergamino' }, respuestas, informados: new Map(), presentacion: { fecha: 'f', fuente: 'bot' } });
assert.deepStrictEqual([ob.presentar[0].hecho, ob.presentar[0].fuente], [true, 'bot']);
assert.deepStrictEqual(ob.siguiente, { grupo: 'conocer', id: 'rubro', titulo: 'Saber su rubro e interés' });

ob = o.objetivos({
    perfil: { ciudad: 'Rojas', tiene_local: 'local', intereses: 'termos' }, lead: { rubro: 'Kiosco' }, respuestas,
    informados: new Map([[1, { fuente: 'bot' }], [3, { fuente: 'manual' }]]),
});
assert.strictEqual(ob.listo_para_precios, false);
ob = o.objetivos({
    perfil: { ciudad: 'Rojas', tiene_local: 'local', intereses: 'termos' }, lead: { rubro: 'Kiosco' }, respuestas,
    informados: new Map([[1, { fuente: 'bot' }], [3, { fuente: 'manual' }]]), presentacion: { fecha: 'f', fuente: 'app' },
});
assert.strictEqual(ob.conocer[0].valor, 'Rojas · tiene local');
assert.strictEqual(ob.conocer[1].valor, 'Kiosco · termos');
assert.strictEqual(ob.listo_para_precios, true);
assert.strictEqual(ob.siguiente, null);

// La presentación mandada por el chat del negocio (aunque cambie el saludo)
const presMsj = 'Buenas Ana, ¿todo bien?\nSoy Mariano de Neggo Mayorista, polirrubros de Pergamino. Te dejo nuestro contacto por si algún día precisás algo:\nhttps://neggo.odoo.com';
assert.strictEqual(o.presentacionEnMensajes([{ texto: 'hola', fecha: '2026-11-20' }]), null);
assert.strictEqual(o.presentacionEnMensajes([
    { texto: presMsj, fecha: '2026-11-21T10:00:00Z' }, { texto: presMsj, fecha: '2026-11-20T10:00:00Z' },
]).fecha, '2026-11-20T10:00:00Z');

// Validación del perfil
let v = o.validarPerfil({ ciudad: '  Junín ', tiene_local: 'online', resumen: 'Busca termos.\r\nTiene kiosco.', rubro: '' });
assert.deepStrictEqual(v.errors, []);
assert.deepStrictEqual(v.value, { ciudad: 'Junín', rubro: null, resumen: 'Busca termos.\nTiene kiosco.', tiene_local: 'online' });
v = o.validarPerfil({ tiene_local: 'si', ciudad: 3 });
assert.deepStrictEqual(v.errors.map((e) => e.campo).sort(), ['ciudad', 'tiene_local']);
assert.deepStrictEqual(o.validarPerfil({}).errors.map((e) => e.campo), ['body']);

// Línea del resumen de Claude
let l = o.validarLineaResumen({ lead_id: 5, hasta: '2026-11-22T18:00:00Z', resumen: 'Kiosco en Rojas.', ciudad: 'Rojas' }, ahora);
assert.deepStrictEqual(l.errors, []);
assert.strictEqual(l.value.lead_id, 5);
assert.deepStrictEqual(l.value.perfil, { ciudad: 'Rojas', resumen: 'Kiosco en Rojas.' });
l = o.validarLineaResumen({ lead_id: 'x', hasta: '2030-01-01', resumen: '' }, ahora);
assert.deepStrictEqual(l.errors, ['lead_id inválido', 'hasta inválido', 'falta el resumen']);

// Items de lo que pidió
v = o.validarItem({ texto: ' Termo 1 L ', cantidad: '6', product_id: 812 });
assert.deepStrictEqual(v.errors, []);
assert.deepStrictEqual(v.value, { texto: 'Termo 1 L', cantidad: 6, product_id: 812 });
v = o.validarItem({ texto: '', cantidad: -1 });
assert.deepStrictEqual(v.errors.map((e) => e.campo), ['texto', 'cantidad']);
v = o.validarItem({ product_id: null }, { parcial: true });
assert.deepStrictEqual(v.value, { product_id: null });
assert.deepStrictEqual(o.separarCantidad('12 vasos térmicos'), { cantidad: 12, texto: 'vasos térmicos' });
assert.deepStrictEqual(o.separarCantidad('6 u. termos'), { cantidad: 6, texto: 'termos' });
assert.deepStrictEqual(o.separarCantidad('mates de calabaza'), { cantidad: null, texto: 'mates de calabaza' });

console.log('✅ leadObjetivos: todos los tests pasaron');
