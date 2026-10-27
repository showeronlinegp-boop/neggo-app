// API del agente: datos de reposición para que una IA ayude a armar los pedidos de la semana.
// Solo lectura: la cola (pendientes y encargados, con ventas y cantidad sugerida), los
// proveedores con sus conteos y las cotizaciones con la etiqueta "Pendiente" (encargues
// de clientes y mercadería que faltó en un pedido, de Neggo y de Preventas).
// Las decisiones (marcar encargado, resolver) se siguen tomando en la app.

const reposicion = require('./reposicionService');
const cotizaciones = require('./reposicionCotizacionesService');
const { AgenteError } = require('./agenteService');

// El origen de la cola, en palabras: por qué el producto está para reponer
const MOTIVO = {
    archivado: 'agotado',
    reponer: 'queda_poco',
    recorrida: 'recorrida',
};

function numero(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function iso(v) {
    return v ? new Date(v).toISOString() : null;
}

/** Un ítem de la cola con métricas → formato de la API. */
function formatItem(it) {
    return {
        id: it.id,
        odoo_id: it.odoo_id,
        producto: it.name,
        codigo: it.internal_ref || null,
        barcode: it.barcode || null,
        proveedor: it.vendor_name,
        categoria: it.categ_name || null,
        motivo: MOTIVO[it.origen] || it.origen,
        estado: it.estado,
        activo_en_odoo: it.active !== false,
        precio_venta: numero(it.list_price),
        costo: numero(it.standard_price),
        nota: it.nota || null,
        cantidad_decidida: numero(it.qty_decidida),
        desde: iso(it.created_at),
        marcado_por: it.created_by_name || null,
        encargado_el: iso(it.encargado_at),
        encargado_por: it.encargado_by_name || null,
        ventas: {
            ultima_semana: numero(it.qty_7d) || 0,
            promedio_semanal: numero(it.avg_weekly) || 0,
            ultimas_5_semanas: numero(it.qty_30d) || 0,
        },
        ritmo: it.ritmo,
        abc: it.abc,
        cantidad_sugerida: it.qty_sugerida_calc,
        ingreso: it.llego_ingreso
            ? { comprobante: it.ingreso_comprobante, fecha: iso(it.ingreso_at), cantidad: numero(it.ingreso_qty) }
            : null,
    };
}

async function leerCola(estado, { proveedor }) {
    const { items, ventas, cobertura_semanas: cobertura } = await reposicion.colaParaAgente({ estado, proveedor });
    return {
        data: items.map(formatItem),
        meta: {
            total: items.length,
            proveedor: proveedor || null,
            cobertura_semanas: cobertura,
            ventas_actualizadas: ventas?.last_sync || null,
        },
    };
}

async function listarPendientes(filtro) {
    return leerCola('pendiente', filtro);
}

async function listarEncargados(filtro) {
    return leerCola('encargado', filtro);
}

async function listarProveedores() {
    const rows = await reposicion.listarProveedores();
    return rows
        .filter(p => p.n_pendientes > 0 || p.n_encargados > 0)
        .map(p => ({
            proveedor: p.vendor_name,
            pendientes: p.n_pendientes,
            agotados: p.n_agotados,
            encargados: p.n_encargados,
            productos_activos: p.n_activos,
            productos_archivados: p.n_archivados,
        }));
}

async function listarCotizaciones({ proveedor }) {
    let res;
    try {
        res = await cotizaciones.listar({ proveedor });
    } catch (err) {
        console.error('❌ Agente: error leyendo cotizaciones pendientes de Odoo:', err.message);
        throw new AgenteError(502, 'No pude leer Odoo', 'odoo_caido');
    }
    const producto = (p) => ({
        odoo_id: p.odoo_id,
        producto: p.name,
        codigo: p.internal_ref || null,
        proveedor: p.vendor_name,
        cantidad: p.qty,
        precio_unitario: numero(p.price_unit),
        en_cola: p.estado_cola || null,
    });
    return {
        data: {
            cotizaciones: res.cotizaciones.map(c => ({
                odoo_id: c.odoo_order_id,
                numero: c.name,
                empresa: c.company,
                estado: c.estado,
                cliente: c.partner_name,
                vendedor: c.vendedor,
                pedido_origen: c.origen,
                fecha: c.date_order,
                total: c.amount_total,
                productos: c.productos.map(producto),
            })),
            productos: res.productos.map(p => ({
                odoo_id: p.odoo_id,
                empresa: p.company,
                producto: p.name,
                codigo: p.internal_ref,
                proveedor: p.vendor_name,
                cantidad_total: p.qty_total,
                en_cola: p.estado_cola,
                cotizaciones: p.cotizaciones.map(c => ({ numero: c.name, cliente: c.partner_name, cantidad: c.qty })),
            })),
        },
        meta: {
            etiqueta: res.etiqueta,
            total_cotizaciones: res.cotizaciones.length,
            total_productos: res.productos.length,
            proveedor: proveedor || null,
        },
    };
}

module.exports = {
    listarPendientes,
    listarEncargados,
    listarProveedores,
    listarCotizaciones,
    // Puro, para tests
    formatItem,
};
