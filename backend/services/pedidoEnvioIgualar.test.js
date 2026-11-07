// Nota 169: unidades extra en el control. Igualar la orden no abre envíos nuevos en Odoo.
// Sin base ni Odoo. node backend/services/pedidoEnvioIgualar.test.js

const assert = require('assert');
const config = require('../config/odoo');
const odooService = require('./odooService');
const { igualarYPendientes, mensajeNadaParaEntregar } = require('./pedidoEnvioService');

async function testIgualarPideNoAbastecer() {
    const originales = {
        getSaleOrdersWithLines: odooService.getSaleOrdersWithLines,
        writeSaleOrderLineQty: odooService.writeSaleOrderLineQty,
    };
    const escrituras = [];
    odooService.getSaleOrdersWithLines = async () => [{
        lines: [{ id: 7, product_id: 70, product_name: 'Papel Afiche', quantity: 20, qty_delivered: 40 }],
    }];
    odooService.writeSaleOrderLineQty = async (...args) => { escrituras.push(args); };
    try {
        const { writes } = await igualarYPendientes({ odoo_sale_order_id: 1, company_key: 'neggo' });
        assert.strictEqual(writes.length, 1);
        assert.deepStrictEqual(escrituras, [[7, 40, 'neggo', { sinAbastecer: true }]]);
    } finally {
        Object.assign(odooService, originales);
    }
}

// sinAbastecer llega a Odoo como skip_procurement; sin él, la escritura queda como siempre
async function testContextoQueLlegaAOdoo() {
    const llamadas = [];
    const rutaServicio = require.resolve('./odooService');
    const originales = { callOdoo: config.callOdoo, getCompanyIds: config.getCompanyIds };
    const servicioCargado = require.cache[rutaServicio];
    config.callOdoo = async (...args) => { llamadas.push(args); };
    config.getCompanyIds = async () => ({ neggo: 1 });
    delete require.cache[rutaServicio];
    try {
        const fresco = require('./odooService');
        await fresco.writeSaleOrderLineQty(7, 40, 'neggo', { sinAbastecer: true });
        await fresco.writeSaleOrderLineQty(7, 40, 'neggo');
        assert.deepStrictEqual(llamadas[0][3].context, { skip_procurement: true, allowed_company_ids: [1] });
        assert.deepStrictEqual(llamadas[1][3].context, { allowed_company_ids: [1] });
    } finally {
        Object.assign(config, originales);
        require.cache[rutaServicio] = servicioCargado;
    }
}

// El cartel distingue una entrega de más de un control sin hacer
function testMensajeNadaParaEntregar() {
    const moves = [{ sale_line_id: 7, product_id: 70, state: 'assigned' }];
    const controlado = [{ odoo_line_id: 7, odoo_product_id: 70, qty_controlada: 40 }];
    const sinControlar = [{ odoo_line_id: 7, odoo_product_id: 70, qty_controlada: 0 }];
    assert.match(mensajeNadaParaEntregar(controlado, moves, 'WH/OUT/1'), /WH\/OUT\/1 está de más/);
    assert.match(mensajeNadaParaEntregar(sinControlar, moves, 'WH/OUT/1'), /Controlá los productos/);
    // Lo controlado es de otro producto: lo de esta entrega sigue sin controlar
    const otro = [{ odoo_line_id: 8, odoo_product_id: 80, qty_controlada: 5 }];
    assert.match(mensajeNadaParaEntregar(otro, moves, 'WH/OUT/1'), /Controlá los productos/);
    assert.match(mensajeNadaParaEntregar(controlado, [], 'WH/OUT/1'), /Controlá los productos/);
}

testMensajeNadaParaEntregar();
testIgualarPideNoAbastecer()
    .then(testContextoQueLlegaAOdoo)
    .then(() => {
        console.log('ok pedidoEnvioIgualar.test.js');
        process.exit(0);
    })
    .catch((err) => { console.error(err); process.exit(1); });
