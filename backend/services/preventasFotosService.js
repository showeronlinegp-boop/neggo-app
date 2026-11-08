// Subir fotos que faltan en Odoo Preventas (nota 182).
// Al aplicar, la foto del proveedor solo se sube si se crea el producto o si se aplica un cambio;
// los "sin cambios" nunca la recibían. Esto recorre los vinculados cuyo producto de Odoo no tiene
// foto y les sube la del proveedor. Nunca pisa una foto existente: antes de escribir pregunta a
// Odoo si el template ya tiene una. Corre en segundo plano, de a una foto y con pausa (Odoo
// devuelve 429 si se lo apura), y se puede frenar.
const pool = require('../config/database');
const { callOdoo, getCompanyIds } = require('../config/odoo');
const { getImageBase64, SIN_FOTO_SQL } = require('./preventasSyncService');
const { olvidarFotoOdoo } = require('./odooImageService');
const { detectMime } = require('./whatsappMessage');

const LOTE_LECTURA = 50;
const PAUSA_MS = 300;
const MAX_FALLIDOS = 100;

let job = { running: false, frenar: false, progreso: null, result: null, error: null, startedAt: null, finishedAt: null };

function getEstadoFotos() {
    const { frenar, ...estado } = job;
    return { ...estado, frenando: frenar && job.running };
}

// Un template por fila (las variantes del mismo template comparten la foto)
async function buscarSinFoto(db, supplierId) {
    const sid = supplierId ? parseInt(supplierId, 10) : null;
    const { rows } = await db.query(`
        SELECT DISTINCT ON (opc.template_id)
            opc.template_id, pss.odoo_product_id, sp.image_url, sp.sku, sp.name
        FROM preventas_sync_state pss
        JOIN supplier_products sp ON sp.id = pss.supplier_product_id
        JOIN odoo_products_cache opc ON opc.odoo_id = pss.odoo_product_id AND opc.company = 'preventas'
        WHERE ${SIN_FOTO_SQL}
          AND opc.template_id IS NOT NULL
          ${sid ? 'AND pss.supplier_id = $1' : ''}
        ORDER BY opc.template_id, pss.supplier_product_id
    `, sid ? [sid] : []);
    return rows;
}

// Templates que YA tienen foto en Odoo (el cache puede estar viejo)
async function conFotoEnOdoo(odoo, templateIds, ctx) {
    const data = await odoo('product.template', 'read', [templateIds, ['image_128']],
        { context: { ...ctx, active_test: false } });
    return new Set((data || []).filter(t => t.image_128).map(t => t.id));
}

async function marcarConFoto(db, templateIds) {
    if (!templateIds.length) return;
    await db.query(
        `UPDATE odoo_products_cache SET has_image = true WHERE template_id = ANY($1::int[]) AND company = 'preventas'`,
        [templateIds]
    );
}

// deps se inyecta en los tests
async function subirFotosFaltantes({ supplierId } = {}, deps = {}) {
    const odoo = deps.callOdoo || callOdoo;
    const db = deps.pool || pool;
    const leerFoto = deps.getImageBase64 || getImageBase64;
    const olvidar = deps.olvidarFotoOdoo || olvidarFotoOdoo;
    const pausa = deps.pausa || (() => new Promise(r => setTimeout(r, PAUSA_MS)));
    const onProgreso = deps.onProgreso || (() => {});
    const debeFrenar = deps.debeFrenar || (() => false);

    const { preventas: preventasId } = await (deps.getCompanyIds || getCompanyIds)();
    if (!preventasId) throw new Error('No se encontró la empresa Preventas en Odoo');
    const ctx = { allowed_company_ids: [preventasId] };

    const pendientes = await buscarSinFoto(db, supplierId);
    const r = { total: pendientes.length, subidas: 0, ya_tenian: 0, errores: 0, frenado: false, fallidos: [] };
    const fallo = (p, motivo) => {
        r.errores++;
        if (r.fallidos.length < MAX_FALLIDOS) r.fallidos.push({ sku: p.sku, nombre: p.name, motivo });
    };
    let hechos = 0;
    onProgreso({ hechos, ...resumen(r) });

    for (let i = 0; i < pendientes.length; i += LOTE_LECTURA) {
        if (debeFrenar()) { r.frenado = true; break; }
        const lote = pendientes.slice(i, i + LOTE_LECTURA);

        let yaConFoto;
        try {
            yaConFoto = await conFotoEnOdoo(odoo, lote.map(p => p.template_id), ctx);
        } catch (err) {
            // Sin poder confirmar que no tienen foto no se escribe nada de este lote
            for (const p of lote) fallo(p, `No se pudo consultar Odoo: ${err.message}`);
            hechos += lote.length;
            onProgreso({ hechos, ...resumen(r) });
            continue;
        }
        r.ya_tenian += yaConFoto.size;
        await marcarConFoto(db, [...yaConFoto]);

        for (const p of lote) {
            if (yaConFoto.has(p.template_id)) { hechos++; continue; }
            if (debeFrenar()) { r.frenado = true; break; }
            try {
                let base64 = null;
                try { base64 = await leerFoto(p.image_url); } catch (err) { /* se informa abajo */ }
                if (!base64) { fallo(p, 'No se pudo descargar la foto del proveedor'); continue; }
                if (!detectMime(Buffer.from(base64, 'base64'))) { fallo(p, 'Lo que devolvió el proveedor no es una foto'); continue; }

                await odoo('product.template', 'write', [[p.template_id], { image_1920: base64 }], { context: ctx });
                await marcarConFoto(db, [p.template_id]);
                olvidar('preventas', 'template', p.template_id);
                r.subidas++;
                await pausa();
            } catch (err) {
                fallo(p, err.message);
            } finally {
                hechos++;
                onProgreso({ hechos, ...resumen(r) });
            }
        }
        if (r.frenado) break;
        onProgreso({ hechos, ...resumen(r) });
    }
    return r;
}

function resumen(r) {
    return { total: r.total, subidas: r.subidas, ya_tenian: r.ya_tenian, errores: r.errores };
}

// Lanza la subida en segundo plano. Devuelve false si ya hay una corriendo.
function iniciarFotos({ supplierId } = {}) {
    if (job.running) return false;
    const startedAt = new Date();
    job = { running: true, frenar: false, progreso: { hechos: 0, total: 0, subidas: 0, ya_tenian: 0, errores: 0 },
            result: null, error: null, startedAt, finishedAt: null };
    subirFotosFaltantes({ supplierId }, { onProgreso: p => { job.progreso = p; }, debeFrenar: () => job.frenar })
        .then(result => {
            job = { running: false, frenar: false, progreso: null, result, error: null, startedAt, finishedAt: new Date() };
            console.log(`✅ Fotos a Odoo Preventas: ${result.subidas} subidas, ${result.ya_tenian} ya tenían, ${result.errores} errores${result.frenado ? ' (frenado)' : ''}`);
        })
        .catch(err => {
            job = { running: false, frenar: false, progreso: null, result: null, error: err.message, startedAt, finishedAt: new Date() };
            console.error('❌ Fotos a Odoo Preventas:', err.message);
        });
    return true;
}

function frenarFotos() {
    if (!job.running) return false;
    job.frenar = true;
    return true;
}

module.exports = { subirFotosFaltantes, iniciarFotos, frenarFotos, getEstadoFotos };
