// Asignar proveedor en Preventas con Odoo y base simulados (nota 142).
// node backend/services/preventasVendor.test.js

const assert = require('assert');
const { asignarProveedores } = require('./preventasVendorService');

function armar({ filas, partners, existentes = [], falla = () => false }) {
    const creados = [];
    const updates = [];
    const llamadasCreate = [];
    const pool = {
        async query(sql, params) {
            if (/^\s*SELECT/.test(sql)) return { rows: filas.map(f => ({ ...f })) };
            updates.push(params);
            return { rows: [] };
        },
    };
    async function callOdoo(model, method, args) {
        if (model === 'res.partner') {
            const nombre = args[0][0][2].toLowerCase();
            const p = partners.find(x => x.name.toLowerCase() === nombre);
            return p ? [p] : [];
        }
        if (model === 'product.product') return args[0][0][2].map(id => ({ id, product_tmpl_id: [id * 10, 'x'] }));
        if (model === 'product.supplierinfo' && method === 'search_read') {
            const ids = args[0][0][2];
            const partnerId = args[0][1][2];
            return existentes.filter(e => e.partner === partnerId && ids.includes(e.tmpl)).map(e => ({ product_tmpl_id: [e.tmpl, 'x'] }));
        }
        if (model === 'product.supplierinfo' && method === 'create') {
            const vals = Array.isArray(args[0]) ? args[0] : [args[0]];
            llamadasCreate.push(vals.length);
            if (falla(vals)) throw new Error('Odoo dijo que no');
            creados.push(...vals);
            return vals.map((_, i) => i + 1);
        }
        throw new Error(`llamada inesperada ${model}.${method}`);
    }
    const deps = { pool, callOdoo, getCompanyIds: async () => ({ neggo: 1, preventas: 50 }) };
    return { deps, creados, updates, llamadasCreate };
}

(async () => {
    // 1) Crea de a lotes, saltea los que ya tenían y no repite templates
    {
        const filas = [];
        for (let i = 1; i <= 250; i++) filas.push({ odoo_product_id: i, odoo_template_id: 1000 + i, supplier_id: 1, supplier_name: 'CastMayorista' });
        filas.push({ odoo_product_id: 999, odoo_template_id: 1001, supplier_id: 1, supplier_name: 'CastMayorista' }); // variante del mismo template
        const progresos = [];
        const m = armar({ filas, partners: [{ id: 1101, name: 'CastMayorista' }], existentes: [{ partner: 1101, tmpl: 1002 }] });
        const r = await asignarProveedores({}, { ...m.deps, onProgreso: p => progresos.push(p) });
        assert.strictEqual(r.total, 251);
        assert.strictEqual(r.omitidos, 1);
        assert.strictEqual(r.asignados, 249);
        assert.strictEqual(r.errores, 0);
        assert.strictEqual(new Set(m.creados.map(c => c.product_tmpl_id)).size, m.creados.length, 'sin templates repetidos');
        assert.ok(m.llamadasCreate.every(n => n <= 100), 'lotes de hasta 100');
        assert.ok(m.creados.every(c => c.partner_id === 1101 && c.company_id === 50));
        assert.strictEqual(m.updates[0][0], 'CastMayorista');
        assert.strictEqual(m.updates[0][1].length, 251);
        assert.deepStrictEqual(progresos[progresos.length - 1], { proveedor: null, hechos: 251, total: 251 });
    }

    // 2) Proveedor sin partner en Odoo: cuenta como error y no toca el cache
    {
        const m = armar({
            filas: [
                { odoo_product_id: 1, odoo_template_id: 11, supplier_id: 20, supplier_name: 'El Rey del Sahumerio' },
                { odoo_product_id: 2, odoo_template_id: null, supplier_id: 7, supplier_name: 'ZLE' },
            ],
            partners: [{ id: 1313, name: 'ZLE' }],
        });
        const r = await asignarProveedores({}, m.deps);
        assert.deepStrictEqual(r.sin_partner, ['El Rey del Sahumerio']);
        assert.strictEqual(r.errores, 1);
        assert.strictEqual(r.asignados, 1);
        assert.strictEqual(m.creados[0].product_tmpl_id, 20, 'template pedido a Odoo cuando falta en el cache');
        assert.strictEqual(m.updates.length, 1);
    }

    // 3) Si falla un lote, reintenta de a uno y solo pierde el que falla
    {
        const filas = [1, 2, 3].map(i => ({ odoo_product_id: i, odoo_template_id: i, supplier_id: 1, supplier_name: 'Babu' }));
        const m = armar({ filas, partners: [{ id: 5, name: 'Babu' }], falla: vals => vals.length > 1 || vals[0].product_tmpl_id === 2 });
        const r = await asignarProveedores({}, m.deps);
        assert.strictEqual(r.asignados, 2);
        assert.strictEqual(r.errores, 1);
    }

    console.log('✅ preventasVendor: 3 casos OK');
})().catch(err => { console.error('❌', err); process.exit(1); });
