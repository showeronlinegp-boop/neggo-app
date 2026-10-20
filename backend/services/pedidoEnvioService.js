// Armado y control de pedidos (2-step adentro de Neggo App).
// Al empezar a armar: confirma la sale.order en Odoo (si no está sale/done)
// y ata el envío 1 (primer stock.picking outgoing). No crea pickings extra.
// Armado → control en la app. Al saldar: la sale.order de Odoo queda con lo
// controlado (qty, incluso 0; nunca unlink) y, si sobra, un pedido draft con
// los pendientes. Idempotente: lock + reusar backorder si ya existe.
// Archivar/reponer reusa reposicionService. No usa updateSaleOrderLines.

const fs = require('fs');
const path = require('path');
const pool = require('../config/database');
const odooService = require('./odooService');

const SCHEMA_032 = fs.readFileSync(
    path.join(__dirname, '..', 'sql', 'migrations', '032_pedido_envios.sql'), 'utf8'
);
const SCHEMA_034 = fs.readFileSync(
    path.join(__dirname, '..', 'sql', 'migrations', '034_pedido_envios_odoo_state.sql'), 'utf8'
);
const SCHEMA_035 = fs.readFileSync(
    path.join(__dirname, '..', 'sql', 'migrations', '035_pedido_envios_picking.sql'), 'utf8'
);

const ESTADOS = ['pendiente', 'armando', 'armado', 'controlando', 'saldado'];
const COMPANIES = new Set(['neggo', 'preventas']);
const MOTIVOS = new Set(['archivado', 'reponer', 'faltante']);

const SELECT_ENVIO = `
    SELECT e.*,
           ua.display_name AS assembled_by_name,
           uc.display_name AS checked_by_name,
           us.display_name AS saldado_by_name
      FROM pedido_envios e
      LEFT JOIN users ua ON ua.id = e.assembled_by
      LEFT JOIN users uc ON uc.id = e.checked_by
      LEFT JOIN users us ON us.id = e.saldado_by
`;

function httpError(message, statusCode) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}

function companyKeyOf(value) {
    const k = String(value || 'neggo').toLowerCase();
    if (!COMPANIES.has(k)) throw httpError('Empresa inválida: usá neggo o preventas', 400);
    return k;
}

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function clampQty(value, max) {
    const tope = Math.max(0, num(max));
    const v = Math.round(num(value));
    if (v < 0) return 0;
    if (v > tope) return tope;
    return v;
}

function tabDeEstado(estado) {
    if (estado === 'pendiente' || estado === 'armando') return 'armar';
    if (estado === 'armado' || estado === 'controlando') return 'controlar';
    return 'hechos';
}

function normalizarCode(s) {
    const raw = String(s || '').trim();
    if (!raw) return '';
    const sinCeros = raw.replace(/^0+/, '');
    return sinCeros || raw;
}

function itemPorCodigo(items, code) {
    const raw = String(code || '').trim();
    if (!raw) return null;
    const n = normalizarCode(raw);
    return items.find((it) => {
        const codes = [it.barcode, it.internal_ref]
            .filter(Boolean)
            .map((c) => String(c).trim());
        return codes.includes(raw) || codes.map(normalizarCode).includes(n);
    }) || null;
}

function qtyCampoDeFase(estado) {
    if (estado === 'controlando') return 'qty_controlada';
    return 'qty_armada';
}

function previewSaldar(items) {
    const queda = [];
    const pendientes = [];
    const iguales = [];
    for (const it of items || []) {
        const pedida = num(it.qty_pedida);
        const controlada = clampQty(it.qty_controlada, pedida);
        const resto = Math.round((pedida - controlada) * 100) / 100;
        if (controlada === pedida) {
            iguales.push({
                id: it.id,
                odoo_line_id: it.odoo_line_id,
                odoo_product_id: it.odoo_product_id,
                product_name: it.product_name,
                qty_pedida: pedida,
                qty_nueva: controlada,
            });
        } else {
            queda.push({
                id: it.id,
                odoo_line_id: it.odoo_line_id,
                odoo_product_id: it.odoo_product_id,
                product_name: it.product_name,
                qty_pedida: pedida,
                qty_nueva: controlada,
            });
        }
        if (resto > 0) {
            pendientes.push({
                id: it.id,
                odoo_line_id: it.odoo_line_id,
                odoo_product_id: it.odoo_product_id,
                product_name: it.product_name,
                price_unit: num(it.price_unit),
                qty_pedida: pedida,
                qty_controlada: controlada,
                qty_pendiente: resto,
            });
        }
    }
    return {
        queda,
        pendientes,
        iguales,
        cancela_original: iguales.length === 0 && queda.every((l) => l.qty_nueva <= 0),
    };
}

const SALDAR_LOCK = 832019;

function qtyCasiIgual(a, b) {
    return Math.abs(num(a) - num(b)) < 0.0001;
}

function esLineaDownPayment(line) {
    return /down payment/i.test(String(line?.product_name || line?.name || ''));
}

function refPendientes(orderName) {
    return `Pendientes de ${orderName || ''}`.trim();
}

function ordenFacturada(odoo) {
    if (!odoo) return false;
    if (odoo.invoice_status === 'invoiced') return true;
    return (odoo.lines || []).some((l) => num(l.qty_invoiced) > 0);
}

// Para armar: cotización enviada, todavía no facturada. Las sale confirmadas/facturadas no.
function esCotizacionParaArmar(odoo) {
    return !!odoo && odoo.state === 'sent' && !ordenFacturada(odoo);
}

function odooNecesitaConfirmar(state) {
    const s = String(state || '');
    return s === 'draft' || s === 'sent';
}

function odooYaConfirmada(state) {
    const s = String(state || '');
    return s === 'sale' || s === 'done';
}

function primerPickingSalida(pickings) {
    const outgoing = (pickings || [])
        .filter((p) => p && Number.isInteger(Number(p.id)))
        .filter((p) => !p.picking_type_code || p.picking_type_code === 'outgoing')
        .slice()
        .sort((a, b) => Number(a.id) - Number(b.id));
    if (!outgoing.length) return null;
    const first = outgoing[0];
    return { id: Number(first.id), name: first.name || null };
}

function auditarEmpezarArmar(odoo) {
    if (!odoo) return { ok: false, error: 'No encontré la orden en Odoo', statusCode: 404 };
    if (odoo.state === 'cancel') {
        return {
            ok: false,
            error: `La orden ${odoo.name || ''} en Odoo está cancelada, no se puede armar`.replace(/\s+/g, ' ').trim(),
            statusCode: 409,
        };
    }
    if (odooNecesitaConfirmar(odoo.state) || odooYaConfirmada(odoo.state)) {
        return { ok: true, needsConfirm: odooNecesitaConfirmar(odoo.state) };
    }
    return {
        ok: false,
        error: `La orden ${odoo.name || ''} en Odoo está en estado ${odoo.state}, no se puede armar`,
        statusCode: 409,
    };
}

function errorDesdeOdoo(err, fallback) {
    if (err?.statusCode) return err;
    const msg = String(err?.message || '');
    const red = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|network|socket|HTTP \d|después de \d+ intentos/i.test(msg)
        || msg.startsWith('HTTP');
    if (red || !msg) {
        return httpError('No pude hablar con Odoo. Probá de nuevo en un rato.', 503);
    }
    return httpError(`${fallback}: ${msg}`, 502);
}

async function leerHeaderOdoo(envio) {
    try {
        return await odooService.getSaleOrderHeader(envio.odoo_sale_order_id, envio.company_key);
    } catch (err) {
        throw errorDesdeOdoo(err, 'No pude hablar con Odoo para confirmar el pedido');
    }
}

async function buscarEnvio1(envio) {
    try {
        const raw = await odooService.getFirstOutgoingPicking(
            envio.odoo_sale_order_id,
            envio.company_key,
            envio.odoo_order_name
        );
        return primerPickingSalida(raw ? [raw] : []);
    } catch (err) {
        throw errorDesdeOdoo(err, 'No pude leer el envío 1 en Odoo');
    }
}

function esperar(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function asegurarConfirmacionYPicking(envio) {
    if (!envio.odoo_sale_order_id) {
        throw httpError('Este pedido no tiene orden de Odoo', 400);
    }

    const header = await leerHeaderOdoo(envio);
    const audit = auditarEmpezarArmar(header);
    if (!audit.ok) throw httpError(audit.error, audit.statusCode || 409);

    if (audit.needsConfirm) {
        try {
            await odooService.confirmSaleOrder(envio.odoo_sale_order_id, envio.company_key);
        } catch (err) {
            throw errorDesdeOdoo(err, `Odoo no pudo confirmar ${envio.odoo_order_name || 'el pedido'}`);
        }
    }

    const odooState = audit.needsConfirm ? 'sale' : (header.state || envio.odoo_state || null);
    const invoiceStatus = header.invoice_status || envio.invoice_status || null;

    if (envio.odoo_picking_id) {
        return {
            picking: { id: envio.odoo_picking_id, name: envio.odoo_picking_name || null },
            odoo_state: odooState,
            invoice_status: invoiceStatus,
        };
    }

    let picking = await buscarEnvio1(envio);
    if (!picking?.id && audit.needsConfirm) {
        await esperar(500);
        picking = await buscarEnvio1(envio);
    }
    if (!picking?.id) {
        throw httpError(
            `Odoo no creó el envío 1 de ${envio.odoo_order_name || 'este pedido'}. Revisá el pedido ahí y volvé a intentar.`,
            409
        );
    }

    return { picking, odoo_state: odooState, invoice_status: invoiceStatus };
}

function lineasProductoOdoo(odoo) {
    return (odoo?.lines || []).filter((l) => l.product_id && !esLineaDownPayment(l));
}

function auditarFallo(error, statusCode = 409) {
    return { ok: false, error, statusCode, alreadyCancelled: false, writes: [] };
}

function objetivoPorItem(item, plan) {
    const todas = [...(plan.queda || []), ...(plan.iguales || [])];
    const marcada = todas.find((l) => l.odoo_line_id === item.odoo_line_id);
    if (marcada) return marcada.qty_nueva;
    return clampQty(item.qty_controlada, item.qty_pedida);
}

// Compara el envío local contra la sale.order viva. Sin I/O.
function auditarSaldar({ envio, odoo, plan }) {
    if (!odoo) return auditarFallo('No encontré la orden en Odoo', 404);

    if (odoo.state === 'cancel') {
        if (plan.cancela_original) {
            return { ok: true, alreadyCancelled: true, writes: [] };
        }
        return auditarFallo(
            `La orden ${odoo.name} en Odoo está en estado cancel, no se puede saldar`
        );
    }

    if (odoo.locked) {
        return auditarFallo(
            `La orden ${odoo.name} está bloqueada en Odoo. Desbloqueala ahí y volvé a saldar.`
        );
    }

    const lineas = lineasProductoOdoo(odoo);
    if (ordenFacturada(odoo)) {
        return auditarFallo(
            `La orden ${odoo.name} ya está facturada en Odoo. No la tocamos.`
        );
    }
    if (lineas.some((l) => num(l.qty_delivered) > 0)) {
        return auditarFallo(
            'Esta orden ya tiene cantidad entregada en Odoo. No la tocamos para no romper el stock.'
        );
    }
    if (odoo.state !== 'sent' && odoo.state !== 'sale') {
        return auditarFallo(
            `La orden ${odoo.name} en Odoo está en estado ${odoo.state}, no se puede saldar`
        );
    }

    const items = envio.items || [];
    const odooById = new Map(lineas.map((l) => [l.id, l]));
    const localById = new Map(items.map((it) => [it.odoo_line_id, it]));

    for (const it of items) {
        const o = odooById.get(it.odoo_line_id);
        if (!o) {
            return auditarFallo(
                `En Odoo no está el renglón de «${it.product_name}». Alguien editó la orden después de traerla.`
            );
        }
        if (o.product_id !== it.odoo_product_id) {
            return auditarFallo(
                `En Odoo cambió el producto de «${it.product_name}». No escribimos cantidades viejas.`
            );
        }
    }
    for (const o of lineas) {
        if (!localById.has(o.id)) {
            return auditarFallo(
                `En Odoo hay un renglón que acá no está (${o.product_name}). Alguien editó la orden después de traerla.`
            );
        }
    }

    const writes = [];
    for (const it of items) {
        const o = odooById.get(it.odoo_line_id);
        const target = objetivoPorItem(it, plan);
        const odooQty = num(o.quantity);
        const pedida = num(it.qty_pedida);
        if (qtyCasiIgual(odooQty, target)) continue;
        if (qtyCasiIgual(odooQty, pedida)) {
            writes.push({
                odoo_line_id: it.odoo_line_id,
                qty: target,
                product_name: it.product_name,
            });
            continue;
        }
        return auditarFallo(
            `Odoo tiene cantidad ${odooQty} en «${it.product_name}», nosotros partimos de ${pedida}. Alguien editó la orden después de traerla.`
        );
    }

    return { ok: true, alreadyCancelled: false, writes };
}

async function ensureSchema(db = pool) {
    await db.query(SCHEMA_032);
    await db.query(SCHEMA_034);
    await db.query(SCHEMA_035);
}

if (!String(process.argv[1] || '').includes('.test.js')) {
    ensureSchema().catch((err) => {
        console.error('❌ Schema pedido_envios:', err.message);
    });
}

async function logActividad(userId, action, envioId, metadata) {
    await pool.query(
        `INSERT INTO activity_log (user_id, module, action, entity_type, entity_id, metadata)
         VALUES ($1, 'armado_pedidos', $2, 'pedido_envio', $3, $4)`,
        [userId || null, action, envioId || null, JSON.stringify(metadata || {})]
    ).catch((err) => console.error('⚠️ activity log armado:', err.message));
}

async function cachePorProductos(companyKey, productIds) {
    const ids = [...new Set((productIds || []).map(Number).filter(Number.isInteger))];
    if (ids.length === 0) return new Map();
    const { rows } = await pool.query(
        `SELECT odoo_id, name, barcode, internal_ref, image_url, active
           FROM odoo_products_cache
          WHERE company = $1 AND odoo_id = ANY($2::int[])`,
        [companyKey, ids]
    );
    return new Map(rows.map((r) => [r.odoo_id, r]));
}

async function upsertItems(client, envioId, companyKey, lines, { freezeQty = false } = {}) {
    const utiles = (lines || []).filter((l) => {
        if (num(l.quantity) <= 0) return false;
        const nombre = String(l.product_name || '');
        if (/down payment/i.test(nombre)) return false;
        return true;
    });
    const cache = await cachePorProductos(companyKey, utiles.map((l) => l.product_id));
    const lineIds = [];
    for (const line of utiles) {
        const prod = cache.get(line.product_id) || {};
        lineIds.push(line.id);
        await client.query(
            `INSERT INTO pedido_envio_items (
                 envio_id, odoo_line_id, odoo_product_id, product_name,
                 barcode, internal_ref, image_url, price_unit, qty_pedida
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (envio_id, odoo_line_id) DO UPDATE SET
                 odoo_product_id = EXCLUDED.odoo_product_id,
                 product_name    = EXCLUDED.product_name,
                 barcode         = COALESCE(EXCLUDED.barcode, pedido_envio_items.barcode),
                 internal_ref    = COALESCE(EXCLUDED.internal_ref, pedido_envio_items.internal_ref),
                 image_url       = COALESCE(EXCLUDED.image_url, pedido_envio_items.image_url),
                 price_unit      = EXCLUDED.price_unit,
                 qty_pedida      = CASE WHEN $10 THEN pedido_envio_items.qty_pedida ELSE EXCLUDED.qty_pedida END`,
            [
                envioId,
                line.id,
                line.product_id,
                line.product_name || prod.name || `Producto ${line.product_id}`,
                prod.barcode || null,
                prod.internal_ref || null,
                prod.image_url || null,
                num(line.unit_price),
                num(line.quantity),
                freezeQty,
            ]
        );
    }
    if (lineIds.length > 0) {
        await client.query(
            `DELETE FROM pedido_envio_items
              WHERE envio_id = $1 AND NOT (odoo_line_id = ANY($2::int[]))`,
            [envioId, lineIds]
        );
    } else {
        await client.query('DELETE FROM pedido_envio_items WHERE envio_id = $1', [envioId]);
    }
}

async function listar({ tab = 'armar', companyKey = 'neggo', q = '' } = {}) {
    const company = companyKeyOf(companyKey);
    const estados = tab === 'controlar'
        ? ['armado', 'controlando']
        : tab === 'hechos'
            ? ['saldado']
            : ['pendiente', 'armando'];
    const like = `%${String(q || '').trim()}%`;
    const soloEnviadas = tab === 'armar';
    const { rows } = await pool.query(
        `${SELECT_ENVIO}
          WHERE e.company_key = $1
            AND e.estado = ANY($2::text[])
            AND (
                $3 = '%%'
                OR e.odoo_order_name ILIKE $3
                OR e.partner_name ILIKE $3
            )
            AND (
                NOT $4
                OR (
                    COALESCE(e.invoice_status, '') <> 'invoiced'
                    AND (e.odoo_state IS NULL OR e.odoo_state IN ('sent', 'sale', 'done'))
                )
            )
          ORDER BY e.date_order DESC NULLS LAST, e.id DESC
          LIMIT 200`,
        [company, estados, like, soloEnviadas]
    );
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const { rows: items } = await pool.query(
        `SELECT envio_id,
                COUNT(*)::int AS n_items,
                COALESCE(SUM(qty_pedida), 0) AS qty_pedida,
                COALESCE(SUM(qty_armada), 0) AS qty_armada,
                COALESCE(SUM(qty_controlada), 0) AS qty_controlada
           FROM pedido_envio_items
          WHERE envio_id = ANY($1::int[])
          GROUP BY envio_id`,
        [ids]
    );
    const byId = new Map(items.map((i) => [i.envio_id, i]));
    return rows.map((r) => {
        const s = byId.get(r.id) || { n_items: 0, qty_pedida: 0, qty_armada: 0, qty_controlada: 0 };
        return { ...r, ...s, tab: tabDeEstado(r.estado) };
    });
}

async function obtener(id) {
    const { rows: [envio] } = await pool.query(`${SELECT_ENVIO} WHERE e.id = $1`, [id]);
    if (!envio) throw httpError('Pedido no encontrado', 404);
    const { rows: items } = await pool.query(
        `SELECT i.*, opc.active AS product_active
           FROM pedido_envio_items i
           LEFT JOIN odoo_products_cache opc
             ON opc.odoo_id = i.odoo_product_id AND opc.company = $2
          WHERE i.envio_id = $1
          ORDER BY i.id`,
        [id, envio.company_key]
    );
    return { ...envio, items, preview: previewSaldar(items) };
}

async function syncDesdeOdoo(companyKey = 'neggo', userId = null) {
    const company = companyKeyOf(companyKey);
    const enviadas = await odooService.getSaleOrdersWithLines(company, {
        states: ['sent'],
        days: 30,
        limit: 80,
    });
    const { rows: locales } = await pool.query(
        `SELECT odoo_sale_order_id FROM pedido_envios
          WHERE company_key = $1 AND estado IN ('pendiente', 'armando')
          ORDER BY date_order DESC NULLS LAST
          LIMIT 80`,
        [company]
    );
    const idsLocales = locales.map((r) => r.odoo_sale_order_id).filter(Boolean);
    const vivos = idsLocales.length
        ? await odooService.getSaleOrdersWithLines(company, { ids: idsLocales, days: null, limit: idsLocales.length })
        : [];
    const porId = new Map();
    for (const order of [...enviadas, ...vivos]) porId.set(order.id, order);
    const orders = [...porId.values()];

    let creados = 0;
    let actualizados = 0;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const order of orders) {
            const { rows: [existente] } = await client.query(
                `SELECT id, estado FROM pedido_envios
                  WHERE company_key = $1 AND odoo_sale_order_id = $2`,
                [company, order.id]
            );
            if (existente && existente.estado === 'saldado') continue;

            const paraArmar = esCotizacionParaArmar(order);
            if (!existente && (!paraArmar || !order.lines.length)) continue;

            let envioId;
            if (!existente) {
                const { rows: [row] } = await client.query(
                    `INSERT INTO pedido_envios (
                         company_key, odoo_sale_order_id, odoo_order_name,
                         partner_id, partner_name, date_order, amount_total,
                         odoo_state, invoice_status
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                     RETURNING id`,
                    [
                        company, order.id, order.name,
                        order.partner_id, order.client,
                        order.date || null, num(order.total),
                        order.state || null, order.invoice_status || null,
                    ]
                );
                envioId = row.id;
                creados++;
            } else {
                await client.query(
                    `UPDATE pedido_envios
                        SET odoo_order_name = $2,
                            partner_id = $3,
                            partner_name = $4,
                            date_order = $5,
                            amount_total = $6,
                            odoo_state = $7,
                            invoice_status = $8,
                            updated_at = NOW()
                      WHERE id = $1`,
                    [
                        existente.id, order.name, order.partner_id, order.client,
                        order.date || null, num(order.total),
                        order.state || null, order.invoice_status || null,
                    ]
                );
                envioId = existente.id;
                actualizados++;
            }
            if (paraArmar) {
                await upsertItems(client, envioId, company, order.lines, {
                    freezeQty: !!(existente && existente.estado !== 'pendiente'),
                });
            }
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
    await logActividad(userId, 'SYNC', null, { company, creados, actualizados, leidos: orders.length });
    return { creados, actualizados, leidos: orders.length };
}

async function cambiarEstado(id, estado, userId) {
    if (!ESTADOS.includes(estado)) throw httpError('Estado inválido', 400);
    const envio = await obtener(id);
    const actual = envio.estado;
    const ok =
        (actual === 'pendiente' && estado === 'armando')
        || (actual === 'armando' && (estado === 'armado' || estado === 'pendiente' || estado === 'armando'))
        || (actual === 'armado' && (estado === 'controlando' || estado === 'armando'))
        || (actual === 'controlando' && estado === 'armado');
    if (!ok) throw httpError(`No se puede pasar de ${actual} a ${estado}`, 409);

    let odooPatch = null;
    if (estado === 'armando' && (actual === 'pendiente' || !envio.odoo_picking_id)) {
        odooPatch = await asegurarConfirmacionYPicking(envio);
    }

    const sets = ['estado = $2', 'updated_at = NOW()'];
    const params = [id, estado];
    if (estado === 'armando') {
        sets.push('assembled_by = $3', 'assembled_at = COALESCE(assembled_at, NOW())');
        params.push(userId);
    } else if (estado === 'armado' && actual === 'armando') {
        sets.push('assembled_by = COALESCE(assembled_by, $3)', 'assembled_at = COALESCE(assembled_at, NOW())');
        params.push(userId);
    } else if (estado === 'controlando') {
        sets.push('checked_by = $3', 'checked_at = NOW()');
        params.push(userId);
    }
    if (odooPatch?.picking?.id) {
        params.push(odooPatch.picking.id);
        sets.push(`odoo_picking_id = COALESCE(odoo_picking_id, $${params.length})`);
        params.push(odooPatch.picking.name || null);
        sets.push(`odoo_picking_name = COALESCE(odoo_picking_name, $${params.length})`);
    }
    if (odooPatch?.odoo_state) {
        params.push(odooPatch.odoo_state);
        sets.push(`odoo_state = $${params.length}`);
    }
    if (odooPatch?.invoice_status != null) {
        params.push(odooPatch.invoice_status);
        sets.push(`invoice_status = $${params.length}`);
    }

    await pool.query(
        `UPDATE pedido_envios SET ${sets.join(', ')} WHERE id = $1`,
        params
    );

    if (estado === 'controlando' && actual === 'armado') {
        await pool.query(
            `UPDATE pedido_envio_items SET qty_controlada = 0 WHERE envio_id = $1`,
            [id]
        );
    }

    await logActividad(userId, `ESTADO_${estado.toUpperCase()}`, id, { de: actual, a: estado });
    return obtener(id);
}

async function setQty(itemId, campo, qty, userId) {
    if (campo !== 'qty_armada' && campo !== 'qty_controlada') {
        throw httpError('Campo de cantidad inválido', 400);
    }
    const { rows: [item] } = await pool.query(
        `SELECT i.*, e.estado, e.id AS envio_id
           FROM pedido_envio_items i
           JOIN pedido_envios e ON e.id = i.envio_id
          WHERE i.id = $1`,
        [itemId]
    );
    if (!item) throw httpError('Ítem no encontrado', 404);
    if (campo === 'qty_armada' && item.estado !== 'armando') {
        throw httpError('Sólo se arma en la etapa de armado', 409);
    }
    if (campo === 'qty_controlada' && item.estado !== 'controlando') {
        throw httpError('Sólo se controla en la etapa de control', 409);
    }
    const nueva = clampQty(qty, item.qty_pedida);
    await pool.query(
        `UPDATE pedido_envio_items SET ${campo} = $2 WHERE id = $1`,
        [itemId, nueva]
    );
    await pool.query('UPDATE pedido_envios SET updated_at = NOW() WHERE id = $1', [item.envio_id]);
    await logActividad(userId, 'SET_QTY', item.envio_id, {
        item_id: itemId, campo, qty: nueva, product: item.product_name,
    });
    return obtener(item.envio_id);
}

async function escanear(envioId, code, userId) {
    const envio = await obtener(envioId);
    const campo = qtyCampoDeFase(envio.estado);
    if (envio.estado !== 'armando' && envio.estado !== 'controlando') {
        throw httpError('Escaneá cuando el pedido está en armado o control', 409);
    }
    const item = itemPorCodigo(envio.items, code);
    if (!item) throw httpError(`El código ${String(code || '').trim()} no está en este pedido`, 404);
    const actual = num(item[campo]);
    if (actual >= num(item.qty_pedida)) {
        throw httpError(`«${item.product_name}» ya está completo`, 409);
    }
    return setQty(item.id, campo, actual + 1, userId);
}

async function marcarFaltante(itemId, motivo, userId, qty = null) {
    if (!MOTIVOS.has(motivo)) throw httpError('Motivo inválido', 400);
    const { rows: [item] } = await pool.query(
        `SELECT i.*, e.estado, e.id AS envio_id, e.company_key
           FROM pedido_envio_items i
           JOIN pedido_envios e ON e.id = i.envio_id
          WHERE i.id = $1`,
        [itemId]
    );
    if (!item) throw httpError('Ítem no encontrado', 404);
    if (item.estado !== 'armando' && item.estado !== 'controlando') {
        throw httpError('Sólo se marca faltante durante el armado o el control', 409);
    }
    if (!item.odoo_product_id) throw httpError('Este renglón no tiene producto de Odoo', 400);

    const campo = item.estado === 'controlando' ? 'qty_controlada' : 'qty_armada';
    const qtyFinal = qty == null ? num(item[campo]) : clampQty(qty, item.qty_pedida);

    if (item.company_key === 'neggo') {
        const reposicion = require('./reposicionService');
        if (motivo === 'archivado') {
            try {
                await reposicion.archivarYEncolar(item.odoo_product_id, userId);
            } catch (err) {
                if (err.statusCode !== 409) throw err;
            }
        } else if (motivo === 'reponer') {
            try {
                await reposicion.agregarReponer(item.odoo_product_id, userId, `Pedido ${item.envio_id}`, 'reponer');
            } catch (err) {
                if (err.statusCode !== 409) throw err;
            }
        }
    }

    await pool.query(
        `UPDATE pedido_envio_items
            SET faltante_motivo = $2,
                ${campo} = $3
          WHERE id = $1`,
        [itemId, motivo, qtyFinal]
    );
    await logActividad(userId, 'FALTANTE', item.envio_id, {
        item_id: itemId, motivo, product: item.product_name, qty: qtyFinal,
    });
    return obtener(item.envio_id);
}

async function preview(id) {
    const envio = await obtener(id);
    return { ...previewSaldar(envio.items), envio_id: envio.id, odoo_order_name: envio.odoo_order_name };
}

async function withSaldarLock(envioId, fn) {
    const client = await pool.connect();
    try {
        await client.query('SELECT pg_advisory_lock($1, $2)', [SALDAR_LOCK, envioId]);
        return await fn();
    } finally {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [SALDAR_LOCK, envioId]).catch(() => {});
        client.release();
    }
}

async function persistBackorder(envioId, backorder) {
    if (!backorder?.id) return;
    await pool.query(
        `UPDATE pedido_envios
            SET backorder_odoo_id = $2,
                backorder_odoo_name = $3,
                updated_at = NOW()
          WHERE id = $1`,
        [envioId, backorder.id, backorder.name || null]
    );
}

async function asegurarBackorder(envio, plan) {
    if (envio.backorder_odoo_id) {
        return { id: envio.backorder_odoo_id, name: envio.backorder_odoo_name };
    }
    if (!envio.partner_id) {
        throw httpError('La orden no tiene cliente en Odoo; no puedo armar los pendientes', 409);
    }

    const origin = envio.odoo_order_name;
    const clientOrderRef = refPendientes(envio.odoo_order_name);
    const existentes = await odooService.findSaleOrdersByOriginRef(envio.company_key, {
        origin,
        clientOrderRef,
        states: ['draft', 'sent'],
    });
    if (existentes.length > 0) {
        const reused = { id: existentes[0].id, name: existentes[0].name };
        await persistBackorder(envio.id, reused);
        return reused;
    }

    const created = await odooService.createSaleOrder(
        envio.partner_id,
        plan.pendientes.map((p) => ({
            product_id: p.odoo_product_id,
            name: p.product_name,
            quantity: p.qty_pendiente,
            unit_price: p.price_unit,
        })),
        envio.company_key,
        {
            origin,
            client_order_ref: clientOrderRef,
            note: `Pendientes del control de ${envio.odoo_order_name} en Neggo App.`,
        }
    );
    await persistBackorder(envio.id, created);
    return created;
}

async function saldar(id, userId) {
    const envioId = Number(id);
    if (!Number.isInteger(envioId) || envioId <= 0) throw httpError('Pedido inválido', 400);
    return withSaldarLock(envioId, () => saldarLocked(envioId, userId));
}

async function saldarLocked(id, userId) {
    const envio = await obtener(id);
    if (envio.estado === 'saldado') return envio;
    if (envio.estado !== 'controlando') {
        throw httpError('El pedido tiene que estar en control para saldarlo', 409);
    }
    if (!envio.odoo_sale_order_id) throw httpError('Este pedido no tiene orden de Odoo', 400);

    const plan = previewSaldar(envio.items);
    const vivos = await odooService.getSaleOrdersWithLines(envio.company_key, {
        ids: [envio.odoo_sale_order_id],
        days: null,
    });
    const audit = auditarSaldar({ envio, odoo: vivos[0], plan });
    if (!audit.ok) throw httpError(audit.error, audit.statusCode || 409);

    for (const linea of audit.writes) {
        await odooService.writeSaleOrderLineQty(linea.odoo_line_id, linea.qty, envio.company_key);
    }

    let backorder = null;
    if (plan.pendientes.length > 0) {
        backorder = await asegurarBackorder(envio, plan);
    }

    if (plan.cancela_original && !audit.alreadyCancelled) {
        await odooService.cancelSaleOrder(envio.odoo_sale_order_id, envio.company_key);
    }

    await pool.query(
        `UPDATE pedido_envios
            SET estado = 'saldado',
                saldado_at = NOW(),
                saldado_by = $2,
                checked_by = COALESCE(checked_by, $2),
                checked_at = COALESCE(checked_at, NOW()),
                backorder_odoo_id = COALESCE($3, backorder_odoo_id),
                backorder_odoo_name = COALESCE($4, backorder_odoo_name),
                updated_at = NOW()
          WHERE id = $1`,
        [id, userId, backorder?.id || null, backorder?.name || null]
    );
    await logActividad(userId, 'SALDAR', id, {
        odoo_order: envio.odoo_order_name,
        backorder: backorder?.name || envio.backorder_odoo_name || null,
        queda: plan.queda.length,
        pendientes: plan.pendientes.length,
        cancelo: plan.cancela_original,
    });
    return obtener(id);
}

module.exports = {
    ESTADOS,
    ensureSchema,
    clampQty,
    tabDeEstado,
    normalizarCode,
    itemPorCodigo,
    previewSaldar,
    qtyCampoDeFase,
    refPendientes,
    ordenFacturada,
    esCotizacionParaArmar,
    odooNecesitaConfirmar,
    odooYaConfirmada,
    primerPickingSalida,
    auditarEmpezarArmar,
    auditarSaldar,
    listar,
    obtener,
    syncDesdeOdoo,
    cambiarEstado,
    setQty,
    escanear,
    marcarFaltante,
    preview,
    saldar,
};
