// Validación, teléfonos y auth de la API del agente. Sin base ni Odoo.
// node backend/services/agenteValidacion.test.js

const assert = require('assert');
const v = require('./agenteValidacion');
const { phoneKey, phoneDisplay } = require('./crmContacts');
const { agenteAuth } = require('../middleware/agenteAuth');

const NOW = new Date('2026-10-22T13:00:00Z'); // 10:00 en Argentina

function campos(errors) {
    return errors.map((e) => e.campo).sort();
}

function testDias() {
    for (const malo of ['0', '91', 'abc', '15x', '-3', '1.5']) {
        assert.strictEqual(v.validarDias(malo).errors.length, 1, `dias=${malo} tendría que fallar`);
    }
    for (const [bueno, n] of [['1', 1], ['15', 15], ['90', 90]]) {
        assert.deepStrictEqual(v.validarDias(bueno), { value: n, errors: [] });
    }
    assert.strictEqual(v.validarDias(undefined).value, 21);
}

function testQueryNuevos() {
    const ok = v.validarQueryNuevos({ dias: '7', etapa: 'dia_7', no_contactar: 'false', page: '2', limit: '50' });
    assert.deepStrictEqual(ok.errors, []);
    assert.deepStrictEqual(ok.value, { dias: 7, page: 2, limit: 50, offset: 50, refresh: false, etapa: 'dia_7', no_contactar: false });
    // Por defecto no vienen los que pidieron no recibir mensajes; todos los trae a todos
    assert.strictEqual(v.validarQueryNuevos({}).value.no_contactar, false);
    assert.strictEqual(v.validarQueryNuevos({}).value.dias, 21);
    assert.strictEqual(v.validarQueryNuevos({ no_contactar: 'todos' }).value.no_contactar, null);
    assert.strictEqual(v.validarQueryNuevos({ para_hoy: 'true' }).value.para_hoy, true);
    assert.deepStrictEqual(campos(v.validarQueryNuevos({ para_hoy: 'hoy' }).errors), ['para_hoy']);
    const prod = v.validarQueryProductos({ orden: 'nombre', excluir_compras_de: '1596', solo_publicados: 'true', rubro: 'Bazar, Tecnología', precio_min: '1000' });
    assert.deepStrictEqual(prod.errors, []);
    assert.strictEqual(prod.value.excluir_compras_de, 1596);
    assert.deepStrictEqual(prod.value.rubros, ['Bazar', 'Tecnología']);
    assert.strictEqual(prod.value.precio_min, 1000);
    assert.strictEqual(v.validarQueryProductos({}).value.orden, 'facturacion');
    assert.deepStrictEqual(campos(v.validarQueryProductos({ orden: 'precio', excluir_compras_de: 'x', precio_min: '-1' }).errors), ['excluir_compras_de', 'orden', 'precio_min']);
    assert.strictEqual(v.validarQueryNuevos({ con_respuesta_pendiente: 'true' }).value.con_respuesta_pendiente, true);
    assert.deepStrictEqual(campos(v.validarQueryProductos({ rubro: 'a,b,c,d,e,f' }).errors), ['rubro']);
    const mal = v.validarQueryNuevos({ etapa: 'dia_3', no_contactar: 'si', limit: '101', page: '0' });
    assert.deepStrictEqual(campos(mal.errors), ['etapa', 'limit', 'no_contactar', 'page']);
    assert.strictEqual(v.validarQueryProductos({ stock: 'quizas' }).errors[0].campo, 'stock');
    assert.deepStrictEqual(v.validarQueryProductos({ stock: 'true', rubro: ' Librería ' }).value.rubros, ['Librería']);
}

function testFechasIso() {
    assert.strictEqual(v.parseIso('2026-10-17T10:00:00-03:00').toISOString(), '2026-10-17T13:00:00.000Z');
    assert.strictEqual(v.parseIso('2026-10-17T13:00:00Z').toISOString(), '2026-10-17T13:00:00.000Z');
    // Sin offset es hora de Argentina; una fecha sola es ese día a las 00:00 de Argentina
    assert.strictEqual(v.parseIso('2026-10-17T10:00').toISOString(), '2026-10-17T13:00:00.000Z');
    assert.strictEqual(v.parseIso('2026-10-17').toISOString(), '2026-10-17T03:00:00.000Z');
    for (const malo of ['2026-02-30', '17/10/2026', '2026-10-17T25:00:00', 'ayer', '', 12345]) {
        assert.strictEqual(v.parseIso(malo), null, `${malo} no es ISO`);
    }
    assert.ok(v.esFechaSimple('2026-10-25'));
    assert.ok(!v.esFechaSimple('2026-10-25T10:00:00'));
}

function testSeguimiento() {
    const ok = v.validarSeguimiento({ etapa: 'dia_7', ultimo_contacto: '2026-10-17T10:00:00-03:00', proxima_accion: '2026-10-25' }, NOW);
    assert.deepStrictEqual(ok.errors, []);
    assert.strictEqual(ok.value.ultimo_contacto.toISOString(), '2026-10-17T13:00:00.000Z');
    // Solo los campos que vinieron
    assert.deepStrictEqual(Object.keys(v.validarSeguimiento({ proxima_accion: null }, NOW).value), ['proxima_accion']);
    // ultimo_contacto no se puede borrar
    assert.deepStrictEqual(campos(v.validarSeguimiento({ ultimo_contacto: null }, NOW).errors), ['ultimo_contacto']);
    assert.deepStrictEqual(campos(v.validarSeguimiento({}, NOW).errors), ['body']);
    assert.deepStrictEqual(campos(v.validarSeguimiento({ etapa: 'dia_3' }, NOW).errors), ['etapa']);
    assert.deepStrictEqual(campos(v.validarSeguimiento({ etapa: 'dia_1', notas: 'x' }, NOW).errors), ['notas']);
    assert.deepStrictEqual(campos(v.validarSeguimiento({ proxima_accion: '25/10/2026' }, NOW).errors), ['proxima_accion']);
    // Hasta 5 minutos en el futuro se acepta (relojes desfasados); más, no
    assert.deepStrictEqual(v.validarSeguimiento({ ultimo_contacto: '2026-10-22T10:04:00-03:00' }, NOW).errors, []);
    assert.deepStrictEqual(campos(v.validarSeguimiento({ ultimo_contacto: '2026-10-22T10:06:00-03:00' }, NOW).errors), ['ultimo_contacto']);
    assert.deepStrictEqual(campos(v.validarSeguimiento([], NOW).errors), ['body']);
}

function testInteraccion() {
    const ok = v.validarInteraccion({ tipo: 'enviado', etapa: 'dia_7', mensaje: ' Hola José ', id_externo: 'wa:ABC-123' }, NOW);
    assert.deepStrictEqual(ok.errors, []);
    assert.strictEqual(ok.value.mensaje, 'Hola José');
    assert.strictEqual(ok.value.fecha, NOW);
    assert.strictEqual(ok.value.id_externo, 'wa:ABC-123');
    assert.strictEqual(v.validarInteraccion({ tipo: 'recibido', mensaje: 'x' }, NOW).value.id_externo, null);
    assert.deepStrictEqual(campos(v.validarInteraccion({ tipo: 'recibido', mensaje: 'x', id_externo: 'con espacio' }, NOW).errors), ['id_externo']);
    assert.deepStrictEqual(campos(v.validarInteraccion({ mensaje: 'x' }, NOW).errors), ['tipo']);
    assert.deepStrictEqual(campos(v.validarInteraccion({ tipo: 'leido', mensaje: '' }, NOW).errors), ['mensaje', 'tipo']);
    assert.deepStrictEqual(campos(v.validarInteraccion({ tipo: 'recibido', mensaje: 'x'.repeat(4001) }, NOW).errors), ['mensaje']);
    // respuesta ya no existe: la respuesta del cliente es otra interacción con tipo recibido
    assert.deepStrictEqual(campos(v.validarInteraccion({ tipo: 'recibido', mensaje: 'x', respuesta: 'y' }, NOW).errors), ['respuesta']);
    assert.deepStrictEqual(campos(v.validarInteraccion({ tipo: 'enviado', mensaje: 'Hola! �C�mo' }, NOW).errors), ['mensaje']);
    assert.deepStrictEqual(v.validarInteraccion({ tipo: 'enviado', mensaje: 'Hola! ¿Cómo te fue?' }, NOW).errors, []);
    assert.deepStrictEqual(campos(v.validarInteraccion({ tipo: 'recibido', mensaje: 'x', fecha: 'hoy' }, NOW).errors), ['fecha']);
    assert.deepStrictEqual(campos(v.validarInteraccion({ tipo: 'recibido', mensaje: 'x', canal: 'wa' }, NOW).errors), ['canal']);
}

function testEnvio() {
    const ok = v.validarEnvio({ etapa: 'dia_7', mensaje: 'Hola', id_externo: 'grok-1001-dia_7', productos_recomendados: [12473, 12473, 9] });
    assert.deepStrictEqual(ok.errors, []);
    assert.deepStrictEqual(ok.value.productos_recomendados, [12473, 9]);
    // La fecha ya no se acepta: manda la hora del servidor
    assert.deepStrictEqual(campos(v.validarEnvio({ etapa: 'dia_7', mensaje: 'Hola', id_externo: 'x', fecha: '2026-10-22' }).errors), ['fecha']);
    assert.deepStrictEqual(campos(v.validarEnvio({ etapa: 'dia_7', mensaje: 'Hola', id_externo: 'x', productos_recomendados: ['a'] }).errors), ['productos_recomendados']);
    assert.deepStrictEqual(v.validarIdExternoRuta('grok-1-dia_1').errors, []);
    assert.strictEqual(v.validarIdExternoRuta('con espacio').errors.length, 1);
    // Solo etapas de la cadencia, y el id_externo es obligatorio
    assert.deepStrictEqual(campos(v.validarEnvio({ etapa: 'finalizado', mensaje: 'Hola' }, NOW).errors), ['etapa', 'id_externo']);
    assert.deepStrictEqual(campos(v.validarEnvio({ etapa: 'dia_1', mensaje: '', id_externo: 'x', tipo: 'enviado' }, NOW).errors), ['mensaje', 'tipo']);
    // El mensaje no puede hablar del IVA ni de impuestos (nota #93)
    for (const mensaje of ['Precio final $1.200, IVA incluido', 'Todo con iva', 'Precios con I.V.A.', 'Sin impuestos extra']) {
        assert.deepStrictEqual(campos(v.validarEnvio({ etapa: 'dia_1', mensaje, id_externo: 'x' }).errors), ['mensaje'], mensaje);
    }
    for (const mensaje of ['¡Hola! Te escribimos de Neggo Mayorista', 'La oferta sigue activa', 'Precio final $1.200']) {
        assert.deepStrictEqual(v.validarEnvio({ etapa: 'dia_1', mensaje, id_externo: 'x' }).errors, [], mensaje);
    }
}

function testClientePatch() {
    assert.deepStrictEqual(v.validarClientePatch({ no_contactar: true }), { value: { no_contactar: true }, errors: [] });
    assert.deepStrictEqual(v.validarClientePatch({ contacto: '  José Pérez ' }).value, { contacto: 'José Pérez' });
    assert.deepStrictEqual(v.validarClientePatch({ contacto: '' }).value, { contacto: null });
    assert.deepStrictEqual(campos(v.validarClientePatch({}).errors), ['body']);
    assert.deepStrictEqual(campos(v.validarClientePatch({ no_contactar: 'true' }).errors), ['no_contactar']);
    assert.deepStrictEqual(campos(v.validarClientePatch({ no_contactar: true, etapa: 'finalizado' }).errors), ['etapa']);
    assert.deepStrictEqual(campos(v.validarFeedback({ tipo: 'mejora' }).errors), ['mensaje']);
    assert.deepStrictEqual(v.validarFeedback({ tipo: 'falta', endpoint: '/productos', mensaje: 'Quiero el stock' }).errors, []);
}

function testId() {
    assert.strictEqual(v.validarId('123').value, 123);
    for (const malo of ['0', '-1', 'abc', '1.5', '99999999999']) assert.strictEqual(v.validarId(malo).errors.length, 1);
}

function testTelefonos() {
    for (const raw of ['02477 15-123456', '+54 9 2477 123456', '2477123456']) {
        assert.strictEqual(phoneDisplay(phoneKey(raw)), '+5492477123456', raw);
    }
    assert.strictEqual(phoneDisplay(phoneKey('2477 1234')), null);
}

/** req/res falsos para el middleware. */
function correrAuth(header) {
    const req = { headers: header ? { authorization: header } : {} };
    const res = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
    let siguio = false;
    agenteAuth(req, res, () => { siguio = true; });
    return { req, res, siguio };
}

function testAuth() {
    const clave = 'a'.repeat(64);
    const previa = process.env.AGENTE_API_KEY;
    try {
        delete process.env.AGENTE_API_KEY;
        let r = correrAuth(`Bearer ${clave}`);
        assert.strictEqual(r.res.statusCode, 503);
        assert.strictEqual(r.res.body.error, 'API del agente deshabilitada');
        assert.strictEqual(r.res.body.codigo, 'deshabilitada');

        process.env.AGENTE_API_KEY = 'corta';
        assert.strictEqual(correrAuth('Bearer corta').res.statusCode, 503);

        process.env.AGENTE_API_KEY = clave;
        r = correrAuth(null);
        assert.strictEqual(r.res.statusCode, 401);
        assert.deepStrictEqual(r.res.body, { success: false, error: 'API key inválida', codigo: 'api_key_invalida' });
        assert.strictEqual(correrAuth(`Bearer ${'b'.repeat(64)}`).res.statusCode, 401);
        assert.strictEqual(correrAuth('Bearer otra').res.statusCode, 401);
        assert.strictEqual(correrAuth(clave).res.statusCode, 401);

        r = correrAuth(`Bearer ${clave}`);
        assert.ok(r.siguio);
        assert.strictEqual(r.req.agente, true);
    } finally {
        if (previa === undefined) delete process.env.AGENTE_API_KEY;
        else process.env.AGENTE_API_KEY = previa;
    }
}

const tests = [testDias, testQueryNuevos, testFechasIso, testSeguimiento, testInteraccion, testEnvio, testClientePatch, testId, testTelefonos, testAuth];
for (const t of tests) t();
console.log(`✅ agenteValidacion: ${tests.length} tests OK`);
