// Limpieza de contactos y cruce con Odoo. Sin base ni Odoo. node backend/services/crmContacts.test.js

const assert = require('assert');
const {
    parseCsv, phoneKey, phoneDisplay, cleanContactName, parseContactStatus,
    cleanGoogleContacts, buildPhoneIndex, splitAgainstOdoo,
} = require('./crmContacts');

function testParseCsv() {
    const rows = parseCsv('﻿a,b,c\r\n"x, y","con ""comillas""",z\n\n1,2,3');
    assert.deepStrictEqual(rows, [['a', 'b', 'c'], ['x, y', 'con "comillas"', 'z'], ['1', '2', '3']]);
}

function testPhoneKey() {
    // Formatos de la agenda y de Odoo llegan a la misma clave
    assert.strictEqual(phoneKey('5492477519062'), '2477519062');
    assert.strictEqual(phoneKey('+5492477519062'), '2477519062');
    assert.strictEqual(phoneKey('+54 2477 51-9062'), '2477519062');
    assert.strictEqual(phoneKey('+54 9 236 461-0093'), '2364610093');
    assert.strictEqual(phoneKey('2477519062'), '2477519062');
    assert.strictEqual(phoneKey('02477519062'), '2477519062');
    // Cortos, especiales o de otro país: no sirven
    assert.strictEqual(phoneKey('911'), null);
    assert.strictEqual(phoneKey('23058161'), null);
    assert.strictEqual(phoneKey('8613912345678'), null);
    assert.strictEqual(phoneKey(''), null);
    assert.strictEqual(phoneDisplay('2477519062'), '+5492477519062');
}

function testNombreYEstado() {
    assert.strictEqual(cleanContactName('A Grafica Digital Estado: NRI NLD-04'), 'A Grafica Digital');
    assert.strictEqual(cleanContactName('Agusibrera  Estado: LEAD NLD-23'), 'Agusibrera');
    assert.strictEqual(cleanContactName('A  Estado: NRI NLD-21'), null);
    assert.strictEqual(cleanContactName('#N/A'), null);
    assert.strictEqual(cleanContactName('ESTADO: NRI LD-30 Colon'), null);

    assert.deepStrictEqual(parseContactStatus('Abi Estado: NRI NLD-05'), { status: 'nri', list: 'NLD-05', city: null });
    assert.deepStrictEqual(parseContactStatus('ESTADO: NRI LD-30 Colon'), { status: 'nri', list: 'LD-30', city: 'Colon' });
    assert.deepStrictEqual(parseContactStatus('Norma Estado: C.Recuperar SLD'), { status: 'recuperar', list: 'SLD', city: null });
    assert.strictEqual(parseContactStatus('Mirta Estado: Clientes').status, 'cliente');
    assert.strictEqual(parseContactStatus('Celeste Estado: NRO SLD').status, 'nri');
    assert.strictEqual(parseContactStatus('Jacke Estado: LEAD 🩷').status, 'lead');
    assert.strictEqual(parseContactStatus('Alejandra  Estado: Churn NLD-20').status, 'churn');
    assert.deepStrictEqual(parseContactStatus('Adriana Delgado'), { status: null, list: null, city: null });
}

function testCleanGoogleContacts() {
    const header = ['First Name', 'Middle Name', 'Last Name', 'Organization Name', 'Labels', 'Phone 1 - Value', 'Phone 2 - Value', 'Address 1 - City'];
    const rows = [
        header,
        ['Libreria Sol Estado: NRI NLD-04', '', '', '', '* myContacts', '5492477000001', '', ''],
        // Mismo teléfono: gana el nombre más largo y el estado más fuerte
        ['Sol Estado: Cliente NLD-04', '', '', '', '* myContacts', '+54 9 2477 00-0001', '', ''],
        ['ESTADO: NRI LD-30 Rojas', '', '', '', '* myContacts', '5492475000002', '', ''],
        ['Pepa', '', '', '', 'Pergamino ::: * myContacts', '911 ::: 5492477000003', '', ''],
        ['Beatriz Ramos (Rojas)', '', '', '', '* myContacts', '5492475000004', '', ''],
        ['Neggo', '', '', 'Neggo Mayorista', '* myContacts', '5492477999999', '', ''],
        ['Sin número', '', '', '', '* myContacts', '', '', ''],
        ['Raro', '', '', '', '* myContacts', '111', '', ''],
    ];
    const { contacts, discarded } = cleanGoogleContacts(rows);
    assert.deepStrictEqual(discarded, { sinTelefono: 1, telefonoInvalido: 1, propios: 1, repetidos: 1 });
    assert.strictEqual(contacts.length, 4);

    const beatriz = contacts.find((c) => c.phone_key === '2475000004');
    assert.strictEqual(beatriz.name, 'Beatriz Ramos');
    assert.strictEqual(beatriz.city, 'Rojas');

    const sol = contacts.find((c) => c.phone_key === '2477000001');
    assert.strictEqual(sol.name, 'Libreria Sol');
    assert.strictEqual(sol.source_status, 'cliente');
    assert.strictEqual(sol.source_list, 'NLD-04');
    assert.strictEqual(sol.phone, '+5492477000001');

    const rojas = contacts.find((c) => c.phone_key === '2475000002');
    assert.strictEqual(rojas.name, null);
    assert.strictEqual(rojas.city, 'Rojas');

    // Varios teléfonos en un campo: toma el primero válido; la etiqueta Pergamino da la ciudad
    const pepa = contacts.find((c) => c.name === 'Pepa');
    assert.strictEqual(pepa.phone_key, '2477000003');
    assert.strictEqual(pepa.city, 'Pergamino');
}

function testCruceConOdoo() {
    const index = buildPhoneIndex([
        { id: 1, name: 'Cliente Odoo', phone: '+54 2477 00-0001' },
        { id: 2, name: 'Corto', phone: '75000002' },
        { id: 3, name: 'Sin teléfono', phone: false },
    ]);
    const { nuevos, enOdoo } = splitAgainstOdoo([
        { phone_key: '2477000001' },
        { phone_key: '2475000002' },
        { phone_key: '2477000003' },
    ], index);
    assert.deepStrictEqual(enOdoo.map((m) => m.partner.id), [1, 2]);
    assert.deepStrictEqual(nuevos.map((c) => c.phone_key), ['2477000003']);
    assert.strictEqual(index.find(null), null);
}

testParseCsv();
testPhoneKey();
testNombreYEstado();
testCleanGoogleContacts();
testCruceConOdoo();
console.log('ok crmContacts.test.js');
