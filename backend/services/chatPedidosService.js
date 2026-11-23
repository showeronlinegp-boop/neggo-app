// Pedidos y cotizaciones de los contactos de Chats (nota 229): etiquetas «Pedido activo» y
// «Cotización abierta» en la lista y el detalle del botón «Pedidos» de la conversación.
// Solo lee la base de la app (nada de Odoo en vivo):
// - Pedido activo = orden confirmada en Odoo (sale) que todavía no se entregó: pedido_envios en
//   pendiente / armando / armado / controlando.
// - Cotización abierta = las de la caché de clientes (borrador o enviada, últimos 60 días, sin factura
//   ni ticket del POS) + las enviadas que trae pedido_envios + las creadas desde la ficha del prospecto
//   que todavía no se confirmaron.
// - Lo que pidió (solo prospectos) = renglones anotados que todavía no entraron en una cotización.
const pool = require('../config/database');

const ESTADOS_ACTIVOS = ['pendiente', 'armando', 'armado', 'controlando'];
const DIAS_COTIZACION = 60;

function idsValidos(lista) {
    return [...new Set((lista || []).map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0))];
}

/**
 * Lee todo lo necesario para un grupo de contactos.
 * @param {{ clientes: number[], prospectos: number[] }} ids  partner ids de Odoo y crm_leads.id
 * @returns {Promise<{ porCliente: Map, porProspecto: Map }>} cada valor: { activos: [], cotizaciones: [], pidio: [] }
 */
async function leer({ clientes = [], prospectos = [] }, db = pool) {
    const partnerIds = idsValidos(clientes);
    const leadIds = idsValidos(prospectos);
    const vacio = () => ({ activos: [], cotizaciones: [], pidio: [] });
    const porCliente = new Map(partnerIds.map((id) => [id, vacio()]));
    const porProspecto = new Map(leadIds.map((id) => [id, vacio()]));
    if (!partnerIds.length && !leadIds.length) return { porCliente, porProspecto };

    // Fichas de Odoo unificadas: los pedidos de cualquiera de las duplicadas cuentan para el contacto
    const partnerDe = new Map(partnerIds.map((id) => [id, { tipo: 'cliente', id }]));
    const cotizCache = [];
    if (partnerIds.length) {
        const { rows } = await db.query(
            `SELECT odoo_partner_id, merged_partners, open_quotations
               FROM client_metrics_cache WHERE odoo_partner_id = ANY($1::int[])`, [partnerIds]);
        for (const r of rows) {
            for (const m of r.merged_partners || []) {
                const mid = Number(m?.id);
                if (Number.isInteger(mid) && mid > 0 && !partnerDe.has(mid)) partnerDe.set(mid, { tipo: 'cliente', id: r.odoo_partner_id });
            }
            for (const q of r.open_quotations || []) cotizCache.push({ dueno: r.odoo_partner_id, q });
        }
    }

    // Cotizaciones creadas desde la ficha del prospecto: su partner de Odoo también es del prospecto
    let cotizLead = [];
    if (leadIds.length) {
        ({ rows: cotizLead } = await db.query(
            `SELECT lead_id, odoo_order_id, odoo_order_name, odoo_partner_id, created_at
               FROM crm_lead_cotizaciones WHERE lead_id = ANY($1::int[])`, [leadIds]));
        for (const c of cotizLead) {
            if (!partnerDe.has(c.odoo_partner_id)) partnerDe.set(c.odoo_partner_id, { tipo: 'prospecto', id: c.lead_id });
        }
    }
    const destino = (d) => (d.tipo === 'cliente' ? porCliente.get(d.id) : porProspecto.get(d.id));

    const vistas = new Set();
    const clave = (company, odooId, name) => `${company || ''}:${odooId || name}`;
    if (partnerDe.size) {
        const { rows: envios } = await db.query(
            `SELECT id, company_key, odoo_sale_order_id, odoo_order_name, partner_id, date_order, amount_total,
                    estado, odoo_state, odoo_picking_name
               FROM pedido_envios
              WHERE partner_id = ANY($1::int[])
                AND ((odoo_state = 'sale' AND estado = ANY($2::text[]))
                  OR (odoo_state = 'sent' AND estado = 'pendiente' AND date_order >= NOW() - ($3 || ' days')::interval))
              ORDER BY date_order DESC NULLS LAST`,
            [[...partnerDe.keys()], ESTADOS_ACTIVOS, String(DIAS_COTIZACION)]);
        for (const e of envios) {
            const d = destino(partnerDe.get(e.partner_id));
            if (!d) continue;
            vistas.add(clave(e.company_key, e.odoo_sale_order_id, e.odoo_order_name));
            const base = {
                company: e.company_key, odoo_id: e.odoo_sale_order_id, nombre: e.odoo_order_name,
                fecha: e.date_order, total: e.amount_total === null ? null : Number(e.amount_total),
            };
            if (e.odoo_state === 'sale') d.activos.push({ ...base, envio_id: e.id, estado: e.estado, entrega: e.odoo_picking_name || null });
            else d.cotizaciones.push({ ...base, estado: 'sent' });
        }
    }
    for (const { dueno, q } of cotizCache) {
        const k = clave(q.company, q.odoo_id, q.name);
        if (vistas.has(k)) continue;
        vistas.add(k);
        porCliente.get(dueno)?.cotizaciones.push({
            company: q.company, odoo_id: q.odoo_id, nombre: q.name, fecha: q.date, total: q.amount ? Number(q.amount) : null, estado: q.state,
        });
    }
    for (const c of cotizLead) {
        // Si ya se confirmó aparece arriba como pedido activo (o ya se entregó)
        const k = clave('neggo', c.odoo_order_id, c.odoo_order_name);
        if (vistas.has(k)) continue;
        const { rows: [conf] } = await db.query(
            `SELECT 1 FROM pedido_envios WHERE company_key = 'neggo' AND odoo_sale_order_id = $1
                AND (odoo_state IN ('sale', 'cancel') OR estado IN ('saldado', 'cancelado')) LIMIT 1`, [c.odoo_order_id]);
        if (conf) continue;
        vistas.add(k);
        porProspecto.get(c.lead_id)?.cotizaciones.push({
            company: 'neggo', odoo_id: c.odoo_order_id, nombre: c.odoo_order_name, fecha: c.created_at, total: null, estado: 'draft', desde_ficha: true,
        });
    }

    if (leadIds.length) {
        const { rows: items } = await db.query(
            `SELECT id, lead_id, texto, cantidad, product_name FROM crm_lead_pedido_items
              WHERE lead_id = ANY($1::int[]) AND cotizacion_id IS NULL ORDER BY created_at`, [leadIds]);
        for (const it of items) {
            porProspecto.get(it.lead_id)?.pidio.push({
                id: it.id, texto: it.texto, cantidad: it.cantidad === null ? null : Number(it.cantidad), producto: it.product_name || null,
            });
        }
    }
    for (const m of [...porCliente.values(), ...porProspecto.values()]) {
        m.cotizaciones.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
    }
    return { porCliente, porProspecto };
}

function resumen(m) {
    return { activos: m.activos.length, cotizaciones: m.cotizaciones.length, pidio: m.pidio.length };
}

/** Le suma a cada chat de la lista `pedidos: { activos, cotizaciones, pidio }` (cantidades). */
async function marcarChats(items, db = pool) {
    if (!items?.length) return items;
    const { porCliente, porProspecto } = await leer({
        clientes: items.filter((c) => c.tipo === 'cliente').map((c) => c.id),
        prospectos: items.filter((c) => c.tipo === 'prospecto').map((c) => c.id),
    }, db);
    return items.map((c) => {
        const m = c.tipo === 'cliente' ? porCliente.get(Number(c.id)) : porProspecto.get(Number(c.id));
        return m ? { ...c, pedidos: resumen(m) } : c;
    });
}

/** Detalle para el botón «Pedidos» de un contacto. */
async function deContacto(tipo, idRaw, db = pool) {
    const id = Number(idRaw);
    if (!['cliente', 'prospecto'].includes(tipo) || !Number.isInteger(id) || id <= 0) return null;
    const { porCliente, porProspecto } = await leer(tipo === 'cliente' ? { clientes: [id] } : { prospectos: [id] }, db);
    const m = (tipo === 'cliente' ? porCliente : porProspecto).get(id);
    return { tipo, id, ...m, resumen: resumen(m) };
}

module.exports = { leer, marcarChats, deContacto, ESTADOS_ACTIVOS };
