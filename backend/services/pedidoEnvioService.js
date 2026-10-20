// Armado y control de pedidos (2-step adentro de Neggo App).
// Al empezar a armar: confirma la sale.order en Odoo (si no está sale/done)
// y ata el envío 1 (primer picking de la orden: Recolectar en pick_ship,
// outgoing en ship_only). Lo deja ABIERTO. No crea pickings extra.
// Al terminar el armado: escribe stock.move.quantity = qty_armada, picked,
// y valida el envío 1. Si falta mercadería Odoo abre backorder (ask).
// Armado → control en la app. Al saldar: si el envío 1 ya está done, no
// reescribe líneas; si no, la sale.order queda con lo controlado y un
// pedido draft con pendientes. Archivar/reponer reusa reposicionService.

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
const SCHEMA_036 = fs.readFileSync(
    path.join(__dirname, '..', 'sql', 'migrations', '036_pedido_envios_picking_state.sql'), 'utf8'
);
const SCHEMA_037 = fs.readFileSync(
    path.join(__dirname, '..', 'sql', 'migrations', '037_pedido_envios_cotizacion.sql'), 'utf8'
);
const SCHEMA_038 = fs.readFileSync(
    path.join(__dirname, '..', 'sql', 'migrations', '038_pedido_envios_pago.sql'), 'utf8'
);
const SCHEMA_039 = fs.readFileSync(
    path.join(__dirname, '..', 'sql', 'migrations', '039_pedido_envios_factura_pos.sql'), 'utf8'
);

const ESTADOS = ['pendiente', 'armando', 'armado', 'controlando', 'saldado'];
const COMPANIES = new Set(['neggo', 'preventas']);
const SOLAPAS = new Set(['pedidos', 'esperando_pago']);
const MOTIVOS = new Set(['archivado', 'reponer', 'faltante']);

const SELECT_ENVIO = `
    SELECT e.*,
           ua.display_name AS assembled_by_name,
           uc.display_name AS checked_by_name,
           us.display_name AS saldado_by_name,
           uq.display_name AS cotizacion_enviada_by_name,
           up.display_name AS pago_recibido_by_name
      FROM pedido_envios e
      LEFT JOIN users ua ON ua.id = e.assembled_by
      LEFT JOIN users uc ON uc.id = e.checked_by
      LEFT JOIN users us ON us.id = e.saldado_by
      LEFT JOIN users uq ON uq.id = e.cotizacion_enviada_by
      LEFT JOIN users up ON up.id = e.pago_recibido_by
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

// Ya tiene factura o se cobró en el POS: se resolvió por otro lado, no se arma acá.
function ordenCobradaAparte(odoo) {
    if (!odoo) return false;
    return ordenFacturada(odoo) || num(odoo.invoice_count) > 0 || num(odoo.pos_order_count) > 0;
}

// Para armar: cotización enviada, sin factura ni POS. Las sale confirmadas/facturadas no.
function esCotizacionParaArmar(odoo) {
    return !!odoo && odoo.state === 'sent' && !ordenCobradaAparte(odoo);
}

function odooNecesitaConfirmar(state) {
    const s = String(state || '');
    return s === 'draft' || s === 'sent';
}

function odooYaConfirmada(state) {
    const s = String(state || '');
    return s === 'sale' || s === 'done';
}

function armandoRequiereConfirmado(envio) {
    if (!envio || envio.estado !== 'armando') return { ok: true };
    if (odooYaConfirmada(envio.odoo_state)) return { ok: true };
    const nombre = envio.odoo_order_name || 'este pedido';
    return {
        ok: false,
        error: `${nombre} tiene que estar confirmado en Odoo para armarlo`,
        statusCode: 409,
    };
}

function exigirArmandoConfirmado(envio) {
    const r = armandoRequiereConfirmado(envio);
    if (!r.ok) throw httpError(r.error, r.statusCode);
}

function primerPickingSalida(pickings) {
    const vivos = (pickings || [])
        .filter((p) => p && Number.isInteger(Number(p.id)))
        .filter((p) => p.state !== 'cancel')
        .filter((p) => {
            const code = p.picking_type_code;
            return !code || code === 'outgoing' || code === 'internal';
        })
        .slice()
        .sort((a, b) => Number(a.id) - Number(b.id));
    if (!vivos.length) return null;
    const first = vivos[0];
    return {
        id: Number(first.id),
        name: first.name || null,
        state: first.state || null,
        picking_type_code: first.picking_type_code || null,
    };
}

function esWizardBackorder(result) {
    return !!(result && typeof result === 'object' && result.type === 'ir.actions.act_window'
        && result.res_model === 'stock.backorder.confirmation');
}

function hayFaltanteEnMoves(writes) {
    return (writes || []).some((w) => num(w.quantity) + 0.0001 < num(w.demand));
}

// qty_armada (o qty_controlada) → stock.move.quantity, matcheando sale_line_id y si no product_id.
function planQtyMovesArmado(moves, items, campo = 'qty_armada') {
    const restantesLinea = new Map();
    const restantesProd = new Map();
    for (const it of items || []) {
        const qty = clampQty(it[campo], it.qty_pedida);
        if (it.odoo_line_id) {
            restantesLinea.set(it.odoo_line_id, (restantesLinea.get(it.odoo_line_id) || 0) + qty);
        }
        if (it.odoo_product_id) {
            restantesProd.set(it.odoo_product_id, (restantesProd.get(it.odoo_product_id) || 0) + qty);
        }
    }

    const writes = [];
    for (const mv of (moves || []).filter((m) => m && m.state !== 'cancel')) {
        const demand = Math.max(0, num(mv.product_uom_qty));
        let take = 0;
        if (mv.sale_line_id && restantesLinea.has(mv.sale_line_id)) {
            const hay = restantesLinea.get(mv.sale_line_id);
            take = Math.min(demand, hay);
            restantesLinea.set(mv.sale_line_id, hay - take);
            if (mv.product_id && restantesProd.has(mv.product_id)) {
                restantesProd.set(mv.product_id, Math.max(0, restantesProd.get(mv.product_id) - take));
            }
        } else if (mv.product_id && restantesProd.has(mv.product_id)) {
            const hay = restantesProd.get(mv.product_id);
            take = Math.min(demand, hay);
            restantesProd.set(mv.product_id, hay - take);
        }
        writes.push({
            id: mv.id,
            quantity: take,
            demand,
            sale_line_id: mv.sale_line_id || null,
            product_id: mv.product_id || null,
        });
    }
    return {
        writes,
        hayFaltante: hayFaltanteEnMoves(writes),
        hayAlgo: writes.some((w) => num(w.quantity) > 0),
    };
}

function auditarTerminarArmado({ envio, picking }) {
    if (!envio) return { ok: false, error: 'Pedido no encontrado', statusCode: 404 };
    if (envio.estado !== 'armando') {
        return { ok: false, error: 'Sólo se valida el envío 1 al terminar el armado', statusCode: 409 };
    }
    if (!picking?.id && !envio.odoo_picking_id) {
        return {
            ok: false,
            error: 'Este pedido todavía no tiene envío 1 en Odoo. Confirmalo y volvé a terminar el armado.',
            statusCode: 409,
        };
    }
    if ((picking?.state || envio.odoo_picking_state) === 'cancel') {
        return {
            ok: false,
            error: `El envío 1 ${picking?.name || envio.odoo_picking_name || ''} está cancelado en Odoo`.trim(),
            statusCode: 409,
        };
    }
    return { ok: true, alreadyDone: (picking?.state || envio.odoo_picking_state) === 'done' };
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

// Eliminar una orden que no se va a hacer = cancelar la sale.order en Odoo.
// Sólo mientras está para armar, sin facturar y con el envío 1 sin validar.
function auditarCancelarEstado(envio) {
    if (!envio) return { ok: false, error: 'Pedido no encontrado', statusCode: 404 };
    if (envio.estado === 'pendiente' || envio.estado === 'armando') return { ok: true };
    return {
        ok: false,
        error: `${envio.odoo_order_name || 'El pedido'} ya está ${envio.estado}, sólo se eliminan pedidos para armar`,
        statusCode: 409,
    };
}

function auditarCancelarOrden({ envio, odoo }) {
    const porEstado = auditarCancelarEstado(envio);
    if (!porEstado.ok) return porEstado;
    if (!odoo) return { ok: false, error: 'No encontré la orden en Odoo', statusCode: 404 };
    const nombre = odoo.name || envio.odoo_order_name || '';
    if (odoo.state === 'cancel') return { ok: true, alreadyCancelled: true };
    if (odoo.invoice_status === 'invoiced') {
        return { ok: false, error: `${nombre} ya está facturada en Odoo, no se puede eliminar`, statusCode: 409 };
    }
    if (odoo.state === 'done') {
        return { ok: false, error: `${nombre} está bloqueada en Odoo, no se puede eliminar`, statusCode: 409 };
    }
    if (envio.odoo_picking_state === 'done') {
        return {
            ok: false,
            error: `El envío ${envio.odoo_picking_name || ''} de ${nombre} ya está validado en Odoo, no se puede eliminar`
                .replace(/\s+/g, ' '),
            statusCode: 409,
        };
    }
    return { ok: true, alreadyCancelled: false };
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
        return primerPickingSalida(raw ? [raw] : []) || (raw?.id ? {
            id: Number(raw.id),
            name: raw.name || null,
            state: raw.state || null,
            picking_type_code: raw.picking_type_code || null,
        } : null);
    } catch (err) {
        throw errorDesdeOdoo(err, 'No pude leer el envío 1 en Odoo');
    }
}

function esperar(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function confirmarEnOdooParaArmar(envio) {
    let header = await leerHeaderOdoo(envio);
    const audit = auditarEmpezarArmar(header);
    if (!audit.ok) throw httpError(audit.error, audit.statusCode || 409);

    if (audit.needsConfirm) {
        try {
            await odooService.confirmSaleOrder(envio.odoo_sale_order_id, envio.company_key);
        } catch (err) {
            throw errorDesdeOdoo(err, `Odoo no pudo confirmar ${envio.odoo_order_name || 'el pedido'}`);
        }
        header = await leerHeaderOdoo(envio);
    }
    if (!odooYaConfirmada(header?.state)) {
        throw httpError(
            `Odoo no confirmó ${envio.odoo_order_name || 'el pedido'} (sigue en ${header?.state || 'sin estado'}). No se puede armar.`,
            409
        );
    }
    if (envio.id) {
        await persistirOdooPicking(envio.id, {
            odoo_state: header.state,
            invoice_status: header.invoice_status || null,
        });
    }
    return header;
}

async function asegurarConfirmacionYPicking(envio) {
    if (!envio.odoo_sale_order_id) {
        throw httpError('Este pedido no tiene orden de Odoo', 400);
    }

    const header = await confirmarEnOdooParaArmar(envio);
    const odooState = header.state;
    const invoiceStatus = header.invoice_status || envio.invoice_status || null;

    if (envio.odoo_picking_id) {
        return {
            picking: {
                id: envio.odoo_picking_id,
                name: envio.odoo_picking_name || null,
                state: envio.odoo_picking_state || null,
            },
            odoo_state: odooState,
            invoice_status: invoiceStatus,
        };
    }

    let picking = await buscarEnvio1(envio);
    if (!picking?.id) {
        await esperar(500);
        picking = await buscarEnvio1(envio);
    }
    if (!picking?.id) {
        throw httpError(
            `Odoo no creó el envío 1 de ${envio.odoo_order_name || 'este pedido'}. Revisá el pedido ahí y volvé a intentar.`,
            409
        );
    }

    return {
        picking,
        odoo_state: odooState,
        invoice_status: invoiceStatus,
    };
}

async function persistirOdooPicking(envioId, patch) {
    if (!patch) return;
    const sets = ['updated_at = NOW()'];
    const params = [envioId];
    if (patch.picking?.id) {
        params.push(patch.picking.id);
        sets.push(`odoo_picking_id = COALESCE(odoo_picking_id, $${params.length})`);
        params.push(patch.picking.name || null);
        sets.push(`odoo_picking_name = COALESCE(odoo_picking_name, $${params.length})`);
    }
    if (patch.picking?.state || patch.odoo_picking_state) {
        params.push(patch.picking?.state || patch.odoo_picking_state);
        sets.push(`odoo_picking_state = $${params.length}`);
    }
    if (patch.odoo_state) {
        params.push(patch.odoo_state);
        sets.push(`odoo_state = $${params.length}`);
    }
    if (patch.invoice_status != null) {
        params.push(patch.invoice_status);
        sets.push(`invoice_status = $${params.length}`);
    }
    if (patch.backorder?.id) {
        params.push(patch.backorder.id);
        sets.push(`odoo_picking_backorder_id = COALESCE(odoo_picking_backorder_id, $${params.length})`);
        params.push(patch.backorder.name || null);
        sets.push(`odoo_picking_backorder_name = COALESCE(odoo_picking_backorder_name, $${params.length})`);
    }
    if (sets.length === 1) return;
    await pool.query(`UPDATE pedido_envios SET ${sets.join(', ')} WHERE id = $1`, params);
}

async function validarEnvio1AlTerminar(envio) {
    let pickingRef = envio.odoo_picking_id
        ? { id: envio.odoo_picking_id, name: envio.odoo_picking_name || null, state: envio.odoo_picking_state || null }
        : null;
    let odooState = envio.odoo_state || null;
    let invoiceStatus = envio.invoice_status || null;

    if (!pickingRef?.id) {
        const linked = await asegurarConfirmacionYPicking(envio);
        pickingRef = linked.picking;
        odooState = linked.odoo_state;
        invoiceStatus = linked.invoice_status;
        await persistirOdooPicking(envio.id, linked);
    }

    let picking = null;
    try {
        picking = await odooService.getPicking(pickingRef.id, envio.company_key);
    } catch (err) {
        throw errorDesdeOdoo(err, 'No pude leer el envío 1 en Odoo');
    }

    const audit = auditarTerminarArmado({ envio, picking: picking || pickingRef });
    if (!audit.ok) throw httpError(audit.error, audit.statusCode || 409);

    if (audit.alreadyDone || picking?.state === 'done') {
        let backorder = null;
        try {
            backorder = await odooService.getPickingBackorder(pickingRef.id, envio.company_key);
        } catch {
            backorder = null;
        }
        return {
            picking: picking || pickingRef,
            backorder,
            odoo_state: odooState,
            invoice_status: invoiceStatus,
            alreadyDone: true,
        };
    }

    let moves = [];
    try {
        moves = await odooService.getPickingMoves(pickingRef.id, envio.company_key);
    } catch (err) {
        throw errorDesdeOdoo(err, 'No pude leer las líneas del envío 1');
    }

    const plan = planQtyMovesArmado(moves, envio.items || []);
    if (!plan.hayAlgo) {
        return {
            picking: picking || pickingRef,
            backorder: null,
            odoo_state: odooState,
            invoice_status: invoiceStatus,
            skippedEmpty: true,
        };
    }

    try {
        await odooService.writePickingMoveQuantities(plan.writes, envio.company_key);
        const validated = await odooService.validateSalePicking(pickingRef.id, envio.company_key, {
            createBackorder: true,
        });
        return {
            picking: validated.picking || picking || pickingRef,
            backorder: validated.backorder || null,
            odoo_state: odooState,
            invoice_status: invoiceStatus,
            alreadyDone: !!validated.alreadyDone,
            hayFaltante: plan.hayFaltante,
        };
    } catch (err) {
        throw errorDesdeOdoo(err, `Odoo no pudo validar el envío 1 de ${envio.odoo_order_name || 'este pedido'}`);
    }
}

// Depósito 2 pasos: el envío 1 es el Recolectar (internal), validado al terminar
// el armado. Al cerrar el control se valida la entrega (outgoing) con lo
// controlado; si falta algo Odoo deja el resto en backorder. En 1 paso no hace nada.
async function validarSalidaAlSaldar(envio) {
    if (!envio.odoo_picking_id) return null;
    let salida = null;
    try {
        const pick = await odooService.getPicking(envio.odoo_picking_id, envio.company_key);
        if (!pick || pick.picking_type_code !== 'internal') return null;
        salida = await odooService.getSalidaDePicking(envio.odoo_picking_id, envio.company_key);
    } catch (err) {
        throw errorDesdeOdoo(err, 'No pude leer la entrega en Odoo');
    }
    if (!salida?.id) return null;
    if (salida.state === 'done') return { picking: salida, backorder: null, alreadyDone: true };

    let moves = [];
    try {
        moves = await odooService.getPickingMoves(salida.id, envio.company_key);
    } catch (err) {
        throw errorDesdeOdoo(err, `No pude leer las líneas de ${salida.name || 'la entrega'}`);
    }
    const plan = planQtyMovesArmado(moves, envio.items || [], 'qty_controlada');
    if (!plan.hayAlgo) {
        throw httpError(
            `No hay nada controlado para entregar en ${salida.name || 'la entrega de Odoo'}. Controlá los productos antes de cerrar.`,
            409
        );
    }

    try {
        await odooService.writePickingMoveQuantities(plan.writes, envio.company_key);
        const validated = await odooService.validateSalePicking(salida.id, envio.company_key, {
            createBackorder: true,
        });
        return {
            picking: validated.picking || salida,
            backorder: validated.backorder || null,
            alreadyDone: !!validated.alreadyDone,
            hayFaltante: plan.hayFaltante,
        };
    } catch (err) {
        throw errorDesdeOdoo(err, `Odoo no pudo validar ${salida.name || 'la entrega'}`);
    }
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
    await db.query(SCHEMA_036);
    await db.query(SCHEMA_037);
    await db.query(SCHEMA_038);
    await db.query(SCHEMA_039);
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

function companiesDe(value) {
    const k = String(value || 'ambas').toLowerCase();
    if (k === 'ambas') return [...COMPANIES];
    return [companyKeyOf(k)];
}

// WHERE del listado sin el filtro de estado (así sirve también para los conteos).
// Solapa "pedidos": lo que no tiene cotización enviada (más los pagados si se piden).
// Solapa "esperando_pago": cotización enviada y pago todavía no recibido.
function condicionesListado({ solapa = 'pedidos', companies, q = '', dias = null, incluirPagados = false }) {
    const params = [companies];
    // Los cancelados (pedido que no se hace) no se listan
    const where = ['e.company_key = ANY($1::text[])', "e.estado <> 'cancelado'"];
    const texto = String(q || '').trim();
    if (texto) {
        params.push(`%${texto}%`);
        where.push(`(e.odoo_order_name ILIKE $${params.length} OR e.partner_name ILIKE $${params.length})`);
    }
    const nDias = parseInt(dias, 10);
    if (Number.isFinite(nDias) && nDias > 0) {
        params.push(nDias);
        where.push(`e.date_order >= NOW() - ($${params.length}::int * INTERVAL '1 day')`);
    }
    // Para armar: solo cotizaciones enviadas en Odoo, sin factura ni cobro en el POS
    where.push(`(e.estado NOT IN ('pendiente', 'armando') OR (
        COALESCE(e.invoice_status, '') <> 'invoiced'
        AND COALESCE(e.odoo_invoice_count, 0) = 0
        AND COALESCE(e.odoo_pos_count, 0) = 0
        AND (e.odoo_state IS NULL OR e.odoo_state IN ('sent', 'sale', 'done'))
    ))`);
    if (solapa === 'esperando_pago') {
        where.push('e.cotizacion_enviada_at IS NOT NULL AND e.pago_recibido_at IS NULL');
    } else if (incluirPagados) {
        where.push('(e.cotizacion_enviada_at IS NULL OR e.pago_recibido_at IS NOT NULL)');
    } else {
        where.push('e.cotizacion_enviada_at IS NULL');
    }
    return { where, params };
}

function ordenListado(orden, solapa) {
    // En "Esperando pago" la fecha que manda es la del envío de la cotización
    const fecha = solapa === 'esperando_pago' ? 'x.cotizacion_enviada_at' : 'x.date_order';
    const ordenes = {
        viejos: `${fecha} ASC NULLS LAST, x.id ASC`,
        nuevos: `${fecha} DESC NULLS LAST, x.id DESC`,
        monto: 'x.amount_total DESC NULLS LAST, x.id ASC',
        unidades: 'qty_pedida DESC, x.id ASC',
    };
    return ordenes[orden] || ordenes.viejos;
}

async function listar({
    solapa = 'pedidos',
    companyKey = 'ambas',
    estado = 'todos',
    q = '',
    dias = null,
    orden = 'viejos',
    incluirPagados = false,
    offset = 0,
    limit = 100,
} = {}) {
    const sol = SOLAPAS.has(solapa) ? solapa : 'pedidos';
    const est = ESTADOS.includes(estado) ? estado : 'todos';
    const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 200);
    const off = Math.max(parseInt(offset, 10) || 0, 0);
    const base = { companies: companiesDe(companyKey), q, dias, incluirPagados };
    const { where, params } = condicionesListado({ ...base, solapa: sol });

    // Conteos por estado para los filtros
    const { rows: porEstado } = await pool.query(
        `SELECT e.estado, COUNT(*)::int AS n FROM pedido_envios e
          WHERE ${where.join(' AND ')} GROUP BY e.estado`,
        params
    );
    const conteos = { todos: 0 };
    ESTADOS.forEach((s) => { conteos[s] = 0; });
    porEstado.forEach((r) => {
        conteos[r.estado] = r.n;
        conteos.todos += r.n;
    });

    // Total de la otra solapa (para el número de la solapa)
    const otraSolapa = sol === 'pedidos' ? 'esperando_pago' : 'pedidos';
    const otra = condicionesListado({ ...base, solapa: otraSolapa });
    const { rows: [{ n: nOtra }] } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM pedido_envios e WHERE ${otra.where.join(' AND ')}`,
        otra.params
    );

    const listaWhere = [...where];
    const listaParams = [...params];
    if (est !== 'todos') {
        listaParams.push(est);
        listaWhere.push(`e.estado = $${listaParams.length}`);
    }
    listaParams.push(lim, off);
    const { rows } = await pool.query(
        `WITH s AS (
            SELECT envio_id,
                   COUNT(*)::int AS n_items,
                   COALESCE(SUM(qty_pedida), 0) AS qty_pedida,
                   COALESCE(SUM(qty_armada), 0) AS qty_armada,
                   COALESCE(SUM(qty_controlada), 0) AS qty_controlada
              FROM pedido_envio_items
             GROUP BY envio_id
        )
        SELECT x.*,
               COALESCE(s.n_items, 0) AS n_items,
               COALESCE(s.qty_pedida, 0) AS qty_pedida,
               COALESCE(s.qty_armada, 0) AS qty_armada,
               COALESCE(s.qty_controlada, 0) AS qty_controlada
          FROM (${SELECT_ENVIO} WHERE ${listaWhere.join(' AND ')}) x
          LEFT JOIN s ON s.envio_id = x.id
         ORDER BY ${ordenListado(orden, sol)}
         LIMIT $${listaParams.length - 1} OFFSET $${listaParams.length}`,
        listaParams
    );

    return {
        items: rows.map((r) => ({ ...r, tab: tabDeEstado(r.estado) })),
        conteos,
        total: est === 'todos' ? conteos.todos : conteos[est],
        solapas: {
            pedidos: sol === 'pedidos' ? conteos.todos : nOtra,
            esperando_pago: sol === 'esperando_pago' ? conteos.todos : nOtra,
        },
        offset: off,
        limit: lim,
    };
}

async function obtener(id, { syncOdoo = false } = {}) {
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
    const base = { ...envio, items, preview: previewSaldar(items) };

    const faltaEnvio1 = base.estado === 'armando'
        && (!base.odoo_picking_id || !odooYaConfirmada(base.odoo_state));
    if (!syncOdoo || !faltaEnvio1) return base;

    try {
        const patch = await asegurarConfirmacionYPicking(base);
        await persistirOdooPicking(base.id, patch);
        return obtener(id);
    } catch (err) {
        return { ...base, odoo_sync_error: err.message };
    }
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
            AND odoo_sale_order_id IS NOT NULL
          ORDER BY date_order DESC NULLS LAST`,
        [company]
    );
    const idsTodos = locales.map((r) => r.odoo_sale_order_id);
    // Los 80 más nuevos con líneas; del resto alcanza con el encabezado (factura / POS / estado)
    const idsLocales = idsTodos.slice(0, 80);
    const vivos = idsLocales.length
        ? await odooService.getSaleOrdersWithLines(company, { ids: idsLocales, days: null, limit: idsLocales.length })
        : [];
    const porId = new Map();
    for (const order of [...enviadas, ...vivos]) porId.set(order.id, order);
    const orders = [...porId.values()];
    const cabeceras = await odooService.getSaleOrderHeaders(
        company,
        idsTodos.filter((id) => !porId.has(id))
    );

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
            // Cancelada desde la app: no vuelve salvo que en Odoo la reactiven como cotización enviada
            if (existente?.estado === 'cancelado' && !paraArmar) continue;
            if (!existente && (!paraArmar || !order.lines.length)) continue;

            let envioId;
            const soltarArmando = existente?.estado === 'armando' && odooNecesitaConfirmar(order.state);
            if (!existente) {
                const { rows: [row] } = await client.query(
                    `INSERT INTO pedido_envios (
                         company_key, odoo_sale_order_id, odoo_order_name,
                         partner_id, partner_name, date_order, amount_total,
                         odoo_state, invoice_status, odoo_invoice_count, odoo_pos_count
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                     RETURNING id`,
                    [
                        company, order.id, order.name,
                        order.partner_id, order.client,
                        order.date || null, num(order.total),
                        order.state || null, order.invoice_status || null,
                        num(order.invoice_count), num(order.pos_order_count),
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
                            odoo_invoice_count = $9,
                            odoo_pos_count = $10,
                            updated_at = NOW()
                      WHERE id = $1`,
                    [
                        existente.id, order.name, order.partner_id, order.client,
                        order.date || null, num(order.total),
                        order.state || null, order.invoice_status || null,
                        num(order.invoice_count), num(order.pos_order_count),
                    ]
                );
                envioId = existente.id;
                actualizados++;
                if (existente.estado === 'cancelado') {
                    await client.query(
                        `UPDATE pedido_envios SET estado = 'pendiente', updated_at = NOW()
                          WHERE id = $1 AND estado = 'cancelado'`,
                        [existente.id]
                    );
                }
                if (soltarArmando) {
                    await client.query(
                        `UPDATE pedido_envios
                            SET estado = 'pendiente',
                                odoo_picking_id = NULL,
                                odoo_picking_name = NULL,
                                odoo_picking_state = NULL,
                                updated_at = NOW()
                          WHERE id = $1 AND estado = 'armando'`,
                        [existente.id]
                    );
                }
            }
            if (paraArmar) {
                await upsertItems(client, envioId, company, order.lines, {
                    freezeQty: !!(existente && existente.estado !== 'pendiente'),
                });
            }
        }
        for (const cab of cabeceras) {
            const { rowCount } = await client.query(
                `UPDATE pedido_envios
                    SET odoo_state = $3,
                        invoice_status = $4,
                        odoo_invoice_count = $5,
                        odoo_pos_count = $6,
                        updated_at = NOW()
                  WHERE company_key = $1 AND odoo_sale_order_id = $2
                    AND estado IN ('pendiente', 'armando')`,
                [company, cab.id, cab.state || null, cab.invoice_status, cab.invoice_count, cab.pos_order_count]
            );
            actualizados += rowCount;
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
    const leidos = orders.length + cabeceras.length;
    await logActividad(userId, 'SYNC', null, { company, creados, actualizados, leidos });
    return { creados, actualizados, leidos };
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
    if (estado === 'armando') {
        if (!odooYaConfirmada(envio.odoo_state) || !envio.odoo_picking_id) {
            odooPatch = await asegurarConfirmacionYPicking(envio);
        }
        const state = odooPatch?.odoo_state || envio.odoo_state;
        if (!odooYaConfirmada(state)) {
            throw httpError(
                `El pedido ${envio.odoo_order_name || ''} tiene que estar confirmado en Odoo para armarlo`.replace(/\s+/g, ' ').trim(),
                409
            );
        }
    } else if (estado === 'armado' && actual === 'armando') {
        odooPatch = await validarEnvio1AlTerminar(envio);
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
    if (odooPatch?.picking?.state) {
        params.push(odooPatch.picking.state);
        sets.push(`odoo_picking_state = $${params.length}`);
    }
    if (odooPatch?.backorder?.id) {
        params.push(odooPatch.backorder.id);
        sets.push(`odoo_picking_backorder_id = COALESCE(odoo_picking_backorder_id, $${params.length})`);
        params.push(odooPatch.backorder.name || null);
        sets.push(`odoo_picking_backorder_name = COALESCE(odoo_picking_backorder_name, $${params.length})`);
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

    await logActividad(userId, `ESTADO_${estado.toUpperCase()}`, id, {
        de: actual,
        a: estado,
        odoo_picking: odooPatch?.picking?.name || envio.odoo_picking_name || null,
        odoo_picking_state: odooPatch?.picking?.state || null,
        picking_backorder: odooPatch?.backorder?.name || null,
    });
    return obtener(id);
}

async function marcasCotizacionPago(id) {
    const { rows: [envio] } = await pool.query(`${SELECT_ENVIO} WHERE e.id = $1`, [id]);
    return {
        id: envio.id,
        estado: envio.estado,
        cotizacion_enviada_at: envio.cotizacion_enviada_at,
        cotizacion_enviada_by: envio.cotizacion_enviada_by,
        cotizacion_enviada_by_name: envio.cotizacion_enviada_by_name,
        pago_recibido_at: envio.pago_recibido_at,
        pago_recibido_by: envio.pago_recibido_by,
        pago_recibido_by_name: envio.pago_recibido_by_name,
    };
}

// Marca/desmarca que la cotización ya se le mandó al cliente (solo en la app, no toca Odoo).
// Solo con el pedido controlado (saldado). Desmarcar también borra el pago recibido.
async function marcarCotizacionEnviada(id, enviada, userId) {
    const { rows: [actual] } = await pool.query('SELECT estado FROM pedido_envios WHERE id = $1', [id]);
    if (!actual) throw httpError('Pedido no encontrado', 404);
    if (enviada && actual.estado !== 'saldado') {
        throw httpError('La cotización se marca como enviada cuando el pedido ya está controlado', 409);
    }
    await pool.query(
        `UPDATE pedido_envios
            SET cotizacion_enviada_at = CASE WHEN $2 THEN COALESCE(cotizacion_enviada_at, NOW()) END,
                cotizacion_enviada_by = CASE WHEN $2 THEN COALESCE(cotizacion_enviada_by, $3) END,
                pago_recibido_at = CASE WHEN $2 THEN pago_recibido_at END,
                pago_recibido_by = CASE WHEN $2 THEN pago_recibido_by END,
                updated_at = NOW()
          WHERE id = $1`,
        [id, Boolean(enviada), userId]
    );
    await logActividad(userId, enviada ? 'COTIZACION_ENVIADA' : 'COTIZACION_NO_ENVIADA', id, {});
    return marcasCotizacionPago(id);
}

// Marca/desmarca que el cliente ya pagó (solo en la app, no toca Odoo)
async function marcarPagoRecibido(id, recibido, userId) {
    const { rows: [actual] } = await pool.query(
        'SELECT cotizacion_enviada_at FROM pedido_envios WHERE id = $1', [id]
    );
    if (!actual) throw httpError('Pedido no encontrado', 404);
    if (recibido && !actual.cotizacion_enviada_at) {
        throw httpError('Primero marcá la cotización como enviada', 409);
    }
    await pool.query(
        `UPDATE pedido_envios
            SET pago_recibido_at = CASE WHEN $2 THEN COALESCE(pago_recibido_at, NOW()) END,
                pago_recibido_by = CASE WHEN $2 THEN COALESCE(pago_recibido_by, $3) END,
                updated_at = NOW()
          WHERE id = $1`,
        [id, Boolean(recibido), userId]
    );
    await logActividad(userId, recibido ? 'PAGO_RECIBIDO' : 'PAGO_NO_RECIBIDO', id, {});
    return marcasCotizacionPago(id);
}

async function cancelarOrden(id, userId) {
    const { rows: [envio] } = await pool.query(`${SELECT_ENVIO} WHERE e.id = $1`, [id]);
    const porEstado = auditarCancelarEstado(envio);
    if (!porEstado.ok) throw httpError(porEstado.error, porEstado.statusCode);

    let odoo;
    try {
        odoo = await odooService.getSaleOrderHeader(envio.odoo_sale_order_id, envio.company_key);
    } catch (err) {
        throw errorDesdeOdoo(err, 'No pude leer la orden en Odoo');
    }
    const audit = auditarCancelarOrden({ envio, odoo });
    if (!audit.ok) throw httpError(audit.error, audit.statusCode);

    if (!audit.alreadyCancelled) {
        try {
            await odooService.cancelSaleOrder(envio.odoo_sale_order_id, envio.company_key);
        } catch (err) {
            throw errorDesdeOdoo(err, 'Odoo no dejó cancelar la orden');
        }
    }

    await pool.query(
        `UPDATE pedido_envios
            SET estado = 'cancelado',
                odoo_state = 'cancel',
                updated_at = NOW()
          WHERE id = $1`,
        [id]
    );
    await logActividad(userId, 'CANCELAR_ORDEN', id, {
        odoo_sale_order_id: envio.odoo_sale_order_id,
        odoo_order_name: envio.odoo_order_name,
        estado_previo: envio.estado,
        ya_cancelada: audit.alreadyCancelled,
    });
    return { id, odoo_order_name: envio.odoo_order_name, estado: 'cancelado', ya_cancelada: audit.alreadyCancelled };
}

async function setQty(itemId, campo, qty, userId) {
    if (campo !== 'qty_armada' && campo !== 'qty_controlada') {
        throw httpError('Campo de cantidad inválido', 400);
    }
    const { rows: [item] } = await pool.query(
        `SELECT i.*, e.estado, e.id AS envio_id, e.odoo_state, e.odoo_order_name
           FROM pedido_envio_items i
           JOIN pedido_envios e ON e.id = i.envio_id
          WHERE i.id = $1`,
        [itemId]
    );
    if (!item) throw httpError('Ítem no encontrado', 404);
    exigirArmandoConfirmado(item);
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
    exigirArmandoConfirmado(envio);
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
        `SELECT i.*, e.estado, e.id AS envio_id, e.company_key, e.odoo_state, e.odoo_order_name
           FROM pedido_envio_items i
           JOIN pedido_envios e ON e.id = i.envio_id
          WHERE i.id = $1`,
        [itemId]
    );
    if (!item) throw httpError('Ítem no encontrado', 404);
    exigirArmandoConfirmado(item);
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
    const pickingYaValidado = envio.odoo_picking_state === 'done';

    let backorder = null;
    let salida = null;
    if (pickingYaValidado) {
        salida = await validarSalidaAlSaldar(envio);
    } else {
        const vivos = await odooService.getSaleOrdersWithLines(envio.company_key, {
            ids: [envio.odoo_sale_order_id],
            days: null,
        });
        const audit = auditarSaldar({ envio, odoo: vivos[0], plan });
        if (!audit.ok) throw httpError(audit.error, audit.statusCode || 409);

        for (const linea of audit.writes) {
            await odooService.writeSaleOrderLineQty(linea.odoo_line_id, linea.qty, envio.company_key);
        }

        if (plan.pendientes.length > 0) {
            backorder = await asegurarBackorder(envio, plan);
        }

        if (plan.cancela_original && !audit.alreadyCancelled) {
            await odooService.cancelSaleOrder(envio.odoo_sale_order_id, envio.company_key);
        }
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
        odoo_salida: salida?.picking?.name || null,
        odoo_salida_backorder: salida?.backorder?.name || null,
    });
    const final = await obtener(id);
    return salida ? { ...final, odoo_salida: salida } : final;
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
    ordenCobradaAparte,
    esCotizacionParaArmar,
    odooNecesitaConfirmar,
    odooYaConfirmada,
    armandoRequiereConfirmado,
    primerPickingSalida,
    planQtyMovesArmado,
    hayFaltanteEnMoves,
    esWizardBackorder,
    auditarTerminarArmado,
    auditarEmpezarArmar,
    auditarSaldar,
    auditarCancelarOrden,
    listar,
    obtener,
    syncDesdeOdoo,
    cambiarEstado,
    marcarCotizacionEnviada,
    marcarPagoRecibido,
    condicionesListado,
    ordenListado,
    cancelarOrden,
    setQty,
    escanear,
    marcarFaltante,
    preview,
    saldar,
};
