// API del agente: cálculo de clientes importantes (fase 1).
// Lógica pura, sin base ni Odoo. Tests en agenteImportantes.test.js.
// importante = (monto_acumulado OR pedido_grande OR manual) AND NOT excluido.
// Fase 1: sin marcas manuales (marca_manual siempre null; el motivo "manual" no aparece).

const fs = require('fs');
const path = require('path');
const health = require('./clientHealth');
const { desdeVentana, round2, categoriasCompradas, DIAS_DEFAULT: NUEVOS_DIAS } = require('./agenteNuevos');

const DEFAULTS = {
    dias: 60,
    monto_minimo: 1000000,
    monto_pedido_minimo: 500000,
    dias_pedido: 60,
    toque_cada_dias: 30,
    factor_atraso: 1.5,
    caida_pct: 30,
    min_compras_intervalo: 3,
    pausa_entre_flujos_dias: 3,
};

const DIAS_MAX = 730;
const TOP_MAX = 500;
const LIMIT_DEFAULT = 50;
const MOTIVOS = ['monto_acumulado', 'pedido_grande', 'manual'];
const ORDENES = ['monto_desc', 'dias_sin_comprar_desc', 'tendencia_asc', 'ultima_compra_desc', 'nombre'];
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'importantes.json');

function cargarConfig(file = CONFIG_PATH) {
    let raw = {};
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) { /* si falta el archivo o una clave, se usa el default */ }
    const cfg = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
        if (raw[k] === undefined || raw[k] === null) continue;
        const n = Number(raw[k]);
        if (Number.isFinite(n)) cfg[k] = n;
    }
    return cfg;
}

function fechaCompra(compra) {
    return compra && compra.fecha ? String(compra.fecha).slice(0, 10) : null;
}

function comprasEntre(compras, desde, hasta) {
    return (compras || []).filter((c) => {
        const f = fechaCompra(c);
        return f && f >= desde && f <= hasta;
    });
}

/** Ventana actual y la anterior del mismo largo (para la tendencia). */
function ventanas(hoy, dias) {
    const hasta = hoy;
    const desde = desdeVentana(hoy, dias);
    const hastaAnterior = health.addDays(desde, -1);
    const desdeAnterior = desdeVentana(hastaAnterior, dias);
    return {
        ventana: { desde, hasta },
        ventana_anterior: { desde: desdeAnterior, hasta: hastaAnterior },
    };
}

/**
 * Tendencia: compara el total de la ventana con el de la anterior.
 * sin_datos si no hubo compras (total 0) en el período anterior.
 */
function calcularTendencia(totalActual, totalAnterior) {
    const periodo_anterior = round2(totalAnterior || 0);
    if (!periodo_anterior) {
        return { periodo_anterior, variacion_pct: null, direccion: 'sin_datos' };
    }
    const variacion_pct = Math.round(((totalActual - periodo_anterior) / periodo_anterior) * 100);
    let direccion = 'estable';
    if (variacion_pct > 10) direccion = 'sube';
    else if (variacion_pct < -10) direccion = 'baja';
    return { periodo_anterior, variacion_pct, direccion };
}

/**
 * Mediana de días entre compras de los últimos 365 días.
 * null si hay menos de minCompras compras en ese lapso.
 */
function intervaloHabitualDias(compras, hoy, minCompras) {
    const since = health.addDays(hoy, -365);
    const recientes = comprasEntre(compras, since, hoy)
        .slice()
        .sort((a, b) => a.fecha.localeCompare(b.fecha) || String(a.id).localeCompare(String(b.id)));
    if (recientes.length < minCompras) return null;
    const gaps = [];
    for (let i = 1; i < recientes.length; i++) {
        gaps.push(health.daysBetween(fechaCompra(recientes[i - 1]), fechaCompra(recientes[i])));
    }
    return health.median(gaps);
}

/**
 * Métricas y motivos de un cliente. No filtra: eso lo hace calcularImportantes.
 * @param {object} cliente — { id, nombre, compras[] } como sale de calcularClientesNuevos
 * @param {object} opts
 * @param {object|null} marca — { tipo: 'fijo'|'excluido', nota, at } o null
 */
function evaluarCliente(cliente, {
    hoy,
    dias,
    monto_minimo,
    monto_pedido_minimo,
    dias_pedido,
    min_compras_intervalo,
    rubroPorProducto = null,
}, marca = null) {
    const { ventana, ventana_anterior } = ventanas(hoy, dias);
    const desdePedido = desdeVentana(hoy, dias_pedido);

    const enVentana = comprasEntre(cliente.compras, ventana.desde, ventana.hasta);
    const enAnterior = comprasEntre(cliente.compras, ventana_anterior.desde, ventana_anterior.hasta);
    const enPedido = comprasEntre(cliente.compras, desdePedido, hoy);

    const total_comprado = round2(enVentana.reduce((s, c) => s + (Number(c.monto) || 0), 0));
    const cantidad_compras = enVentana.length;
    const ticket_promedio = cantidad_compras ? round2(total_comprado / cantidad_compras) : null;
    const periodo_anterior_total = round2(enAnterior.reduce((s, c) => s + (Number(c.monto) || 0), 0));

    const pedidos_grandes = enPedido
        .filter((c) => (Number(c.monto) || 0) > monto_pedido_minimo)
        .sort((a, b) => b.fecha.localeCompare(a.fecha) || String(b.id).localeCompare(String(a.id)))
        .map((c) => ({
            id: c.id,
            referencia: c.referencia,
            monto: round2(c.monto),
            fecha: c.fecha,
        }));

    const motivo_importante = [];
    if (total_comprado >= monto_minimo) motivo_importante.push('monto_acumulado');
    if (pedidos_grandes.length) motivo_importante.push('pedido_grande');
    if (marca && marca.tipo === 'fijo') motivo_importante.push('manual');

    const ultima = (cliente.compras || [])[0] || null;
    const ultima_compra = ultima ? ultima.fecha : null;
    const dias_sin_comprar = ultima_compra
        ? health.daysBetween(fechaCompra(ultima), hoy)
        : null;

    const categorias = rubroPorProducto
        ? categoriasCompradas(enVentana, rubroPorProducto)
        : (cliente.categorias_compradas || []);

    const primera = cliente.fecha_primera_compra
        || (cliente.compras && cliente.compras.length
            ? fechaCompra(cliente.compras[cliente.compras.length - 1])
            : null);
    const en_ventana_nuevos = Boolean(primera && primera >= desdeVentana(hoy, NUEVOS_DIAS));

    return {
        id: cliente.id,
        nombre: cliente.nombre,
        motivo_importante,
        pedidos_grandes,
        marca_manual: marca || null,
        excluido: Boolean(marca && marca.tipo === 'excluido'),
        total_comprado,
        cantidad_compras,
        ticket_promedio,
        categorias_compradas: categorias,
        ultima_compra,
        dias_sin_comprar,
        intervalo_habitual_dias: intervaloHabitualDias(cliente.compras || [], hoy, min_compras_intervalo),
        tendencia: calcularTendencia(total_comprado, periodo_anterior_total),
        fecha_primera_compra: primera,
        en_ventana_nuevos,
        _en_ventana: enVentana.length > 0,
    };
}

/**
 * Lista de clientes importantes a partir de clientes ya armados (compras de toda la historia).
 * @param {{
 *   clientes: object[],
 *   hoy: string,
 *   dias: number,
 *   monto_minimo: number,
 *   monto_pedido_minimo: number,
 *   dias_pedido: number,
 *   min_compras_intervalo?: number,
 *   top?: number|null,
 *   marcas?: Map<number, object>|object,
 *   rubroPorProducto?: Map|null,
 * }} input
 * @returns {object[]} sin paginar ni ordenar por query (salvo el corte de top)
 */
function calcularImportantes({
    clientes,
    hoy,
    dias,
    monto_minimo,
    monto_pedido_minimo,
    dias_pedido,
    min_compras_intervalo = DEFAULTS.min_compras_intervalo,
    top = null,
    marcas = null,
    rubroPorProducto = null,
}) {
    const marcaDe = (id) => {
        if (!marcas) return null;
        if (marcas instanceof Map) return marcas.get(id) || null;
        return marcas[id] || null;
    };
    const opts = {
        hoy, dias, monto_minimo, monto_pedido_minimo, dias_pedido, min_compras_intervalo, rubroPorProducto,
    };

    let lista = [];
    for (const c of clientes) {
        const marca = marcaDe(c.id);
        const ev = evaluarCliente(c, opts, marca);
        if (ev.excluido) continue;
        if (top != null) {
            // Sin umbral de monto: entran los que compraron en la ventana, o por pedido grande / manual
            if (!ev._en_ventana && !ev.motivo_importante.includes('pedido_grande')
                && !ev.motivo_importante.includes('manual')) continue;
        } else if (!ev.motivo_importante.length) {
            continue;
        }
        const { excluido, _en_ventana, ...rest } = ev;
        lista.push(rest);
    }

    if (top != null) {
        lista.sort((a, b) => b.total_comprado - a.total_comprado || a.id - b.id);
        lista = lista.slice(0, top);
    }

    return lista;
}

/** Orden de la lista según ?orden=. */
function ordenarImportantes(lista, orden = 'monto_desc') {
    const copy = lista.slice();
    const porNombre = (a, b) => String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es') || a.id - b.id;
    switch (orden) {
    case 'dias_sin_comprar_desc':
        copy.sort((a, b) => (b.dias_sin_comprar ?? -1) - (a.dias_sin_comprar ?? -1) || porNombre(a, b));
        break;
    case 'tendencia_asc':
        // Las caídas primero; sin_datos al final
        copy.sort((a, b) => {
            const va = a.tendencia && a.tendencia.direccion !== 'sin_datos' ? a.tendencia.variacion_pct : null;
            const vb = b.tendencia && b.tendencia.direccion !== 'sin_datos' ? b.tendencia.variacion_pct : null;
            if (va == null && vb == null) return porNombre(a, b);
            if (va == null) return 1;
            if (vb == null) return -1;
            return va - vb || porNombre(a, b);
        });
        break;
    case 'ultima_compra_desc':
        copy.sort((a, b) => String(b.ultima_compra || '').localeCompare(String(a.ultima_compra || '')) || porNombre(a, b));
        break;
    case 'nombre':
        copy.sort(porNombre);
        break;
    case 'monto_desc':
    default:
        copy.sort((a, b) => b.total_comprado - a.total_comprado || porNombre(a, b));
        break;
    }
    return copy;
}

/** Bloque `importante` de GET /clientes/{id} (defaults de config). */
function resumenImportante(cliente, cfg, hoy, marca = null) {
    const ev = evaluarCliente(cliente, {
        hoy,
        dias: cfg.dias,
        monto_minimo: cfg.monto_minimo,
        monto_pedido_minimo: cfg.monto_pedido_minimo,
        dias_pedido: cfg.dias_pedido,
        min_compras_intervalo: cfg.min_compras_intervalo,
    }, marca);
    if (ev.excluido) {
        return {
            es_importante: false,
            motivo_importante: [],
            pedidos_grandes: [],
            marca_manual: ev.marca_manual,
        };
    }
    return {
        es_importante: ev.motivo_importante.length > 0,
        motivo_importante: ev.motivo_importante,
        pedidos_grandes: ev.pedidos_grandes,
        marca_manual: ev.marca_manual,
    };
}

module.exports = {
    DEFAULTS,
    DIAS_MAX,
    TOP_MAX,
    LIMIT_DEFAULT,
    MOTIVOS,
    ORDENES,
    NUEVOS_DIAS,
    cargarConfig,
    ventanas,
    calcularTendencia,
    intervaloHabitualDias,
    evaluarCliente,
    calcularImportantes,
    ordenarImportantes,
    resumenImportante,
};
