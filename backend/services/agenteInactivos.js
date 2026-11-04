// API del agente: clientes inactivos (más de dias_min días sin comprar) y su seguimiento.
// Lógica pura, sin base ni Odoo. Tests en agenteInactivos.test.js.
//
// inactivo = dias_sin_comprar > dias_min AND dias_sin_comprar <= dias_max
//            AND total_historico >= monto_historico_min AND cantidad_compras >= compras_min
//            AND NOT excluido (marca manual, pedido activo, cadencia de nuevos o importante)
//
// Seguimiento por ciclo: un ciclo arranca con la última compra. primer_toque → (reintento_dias
// sin respuesta ni compra) → segundo_toque → cerrado. Si vuelve a comprar, el ciclo viejo
// queda atrás: cuando vuelva a pasar los dias_min, arranca otro con toques_enviados = 0.

const fs = require('fs');
const path = require('path');
const health = require('./clientHealth');
const { round2 } = require('./agenteNuevos');

const DEFAULTS = {
    dias_min: 60,
    dias_max: 365,
    monto_historico_min: 0,
    compras_min: 1,
    reintento_dias: 15,
    max_toques: 2,
    pausa_entre_flujos_dias: 3,
};

const DIAS_MIN_MAX = 730;
const DIAS_MAX_MAX = 1825;
const COMPRAS_MIN_MAX = 100000;
const LIMIT_DEFAULT = 50;
const TOP_PRODUCTOS = 10;
const MIN_COMPRAS_INTERVALO = 3;
const HABILES_VIGENCIA = 2;
const RECUPERO_DIAS = 30;
const NOTA_MAX = 500;
const TIPOS = ['primer_toque', 'segundo_toque'];
const MARCAS = ['excluido'];
const ORDENES = ['dias_sin_comprar_asc', 'dias_sin_comprar_desc', 'total_historico_desc', 'ultima_compra_desc', 'nombre'];
const ORDEN_DEFAULT = 'dias_sin_comprar_asc';
// Por qué un cliente que cumple la regla no entra (en orden de prioridad)
const EXCLUSIONES = ['manual', 'pedido_activo', 'en_flujo_nuevos', 'es_importante'];
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'inactivos.json');

function enteroEn(n, min, max) {
    return Number.isInteger(n) && n >= min && n <= max;
}

/** Config con defaults: una clave que falta o está fuera de rango usa el default (con aviso). */
function cargarConfig(file = CONFIG_PATH) {
    let raw = {};
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) { /* sin archivo: todo default */ }
    const cfg = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
        if (raw[k] === undefined || raw[k] === null) continue;
        const n = Number(raw[k]);
        if (Number.isFinite(n)) cfg[k] = n;
    }
    const fuera = [];
    if (!enteroEn(cfg.dias_min, 1, DIAS_MIN_MAX)) { fuera.push('dias_min'); cfg.dias_min = DEFAULTS.dias_min; }
    if (!enteroEn(cfg.dias_max, cfg.dias_min + 1, DIAS_MAX_MAX)) { fuera.push('dias_max'); cfg.dias_max = Math.max(DEFAULTS.dias_max, cfg.dias_min + 1); }
    if (!(cfg.monto_historico_min >= 0)) { fuera.push('monto_historico_min'); cfg.monto_historico_min = DEFAULTS.monto_historico_min; }
    if (!enteroEn(cfg.compras_min, 1, COMPRAS_MIN_MAX)) { fuera.push('compras_min'); cfg.compras_min = DEFAULTS.compras_min; }
    if (!enteroEn(cfg.reintento_dias, 1, 365)) { fuera.push('reintento_dias'); cfg.reintento_dias = DEFAULTS.reintento_dias; }
    // TipoInactivo tiene dos valores: no hay un tercer toque
    if (!enteroEn(cfg.max_toques, 1, TIPOS.length)) { fuera.push('max_toques'); cfg.max_toques = DEFAULTS.max_toques; }
    if (!enteroEn(cfg.pausa_entre_flujos_dias, 0, 60)) { fuera.push('pausa_entre_flujos_dias'); cfg.pausa_entre_flujos_dias = DEFAULTS.pausa_entre_flujos_dias; }
    if (fuera.length) console.warn(`⚠️ Agente: config/inactivos.json fuera de rango (${fuera.join(', ')}): uso el default`);
    return cfg;
}

function fechaDe(compra) {
    return compra && compra.fecha ? String(compra.fecha).slice(0, 10) : null;
}

/** Número de toque (1 o 2) de un TipoInactivo. */
function numeroToque(tipo) {
    return TIPOS.indexOf(tipo) + 1;
}

/** Fecha + n días hábiles (lunes a viernes, sin feriados). */
function habilesDespues(fecha, n) {
    let d = fecha;
    let faltan = n;
    while (faltan > 0) {
        d = health.addDays(d, 1);
        const dow = new Date(Date.parse(d)).getUTCDay();
        if (dow !== 0 && dow !== 6) faltan--;
    }
    return d;
}

/**
 * Lo que solía llevar: hasta 10 productos, por cantidad de compras en que aparece y después
 * por cantidad total.
 */
function topProductos(compras, max = TOP_PRODUCTOS) {
    const porId = new Map();
    for (const c of compras || []) {
        const fecha = fechaDe(c);
        const vistos = new Set();
        for (const p of c.productos || []) {
            const prev = porId.get(p.id) || { id: p.id, nombre: p.nombre, cantidad_total: 0, veces: 0, ultima_vez: null };
            prev.cantidad_total += Number(p.cantidad) || 0;
            if (!vistos.has(p.id)) {
                prev.veces += 1;
                vistos.add(p.id);
            }
            if (fecha && (!prev.ultima_vez || fecha > prev.ultima_vez)) {
                prev.ultima_vez = fecha;
                prev.nombre = p.nombre || prev.nombre;
            }
            porId.set(p.id, prev);
        }
    }
    return [...porId.values()]
        .map((p) => ({ ...p, cantidad_total: round2(p.cantidad_total) }))
        .sort((a, b) => b.veces - a.veces || b.cantidad_total - a.cantidad_total || a.id - b.id)
        .slice(0, max);
}

/** Mediana de días entre compras de toda la historia; null con menos de 3 compras. */
function intervaloHabitual(compras) {
    const fechas = (compras || []).map(fechaDe).filter(Boolean).sort();
    if (fechas.length < MIN_COMPRAS_INTERVALO) return null;
    const gaps = [];
    for (let i = 1; i < fechas.length; i++) gaps.push(health.daysBetween(fechas[i - 1], fechas[i]));
    return health.median(gaps);
}

/**
 * Métricas de toda la historia de un cliente.
 * @param {object} cliente — { compras[] } de la más nueva a la más vieja, como sale de calcularClientesNuevos
 */
function metricas(cliente, hoy) {
    const compras = cliente.compras || [];
    const ultima = compras[0] || null;
    const total = round2(compras.reduce((s, c) => s + (Number(c.monto) || 0), 0));
    const cantidad = compras.length;
    return {
        ultima_compra: ultima ? ultima.fecha : null,
        ultima_fecha: fechaDe(ultima),
        dias_sin_comprar: ultima ? health.daysBetween(fechaDe(ultima), hoy) : null,
        monto_ultima_compra: ultima ? round2(ultima.monto) : null,
        primera_compra: cliente.fecha_primera_compra || (cantidad ? fechaDe(compras[cantidad - 1]) : null),
        cantidad_compras: cantidad,
        total_historico: total,
        ticket_promedio: cantidad ? round2(total / cantidad) : null,
        intervalo_habitual_dias: intervaloHabitual(compras),
        top_productos: topProductos(compras),
    };
}

/** Cumple la regla de días y montos (sin mirar exclusiones). */
function cumpleRegla(m, { dias_min, dias_max, monto_historico_min, compras_min }) {
    return m.dias_sin_comprar !== null
        && m.dias_sin_comprar > dias_min
        && m.dias_sin_comprar <= dias_max
        && m.total_historico >= monto_historico_min
        && m.cantidad_compras >= compras_min;
}

/** Primer motivo de exclusión, o null. */
function motivoExclusion({ marca = null, pedidoActivo = false, enFlujoNuevos = false, esImportante = false }) {
    if (marca && marca.marca === 'excluido') return 'manual';
    if (pedidoActivo) return 'pedido_activo';
    if (enFlujoNuevos) return 'en_flujo_nuevos';
    if (esImportante) return 'es_importante';
    return null;
}

/**
 * Estado del ciclo actual. La fila guardada vale solo si es del ciclo de la última compra;
 * si el cliente volvió a comprar después, el ciclo arranca de cero.
 * @param {object|null} row — fila de crm_bot_seguimiento_inactivo (ciclo_desde_compra como YYYY-MM-DD)
 */
function cicloActual(row, ultimaFecha) {
    const mismo = Boolean(row && row.ciclo_desde_compra && ultimaFecha && row.ciclo_desde_compra === ultimaFecha);
    return {
        ciclo_desde_compra: ultimaFecha || null,
        toques_enviados: mismo ? Number(row.toques_enviados) || 0 : 0,
        ultimo_contacto: mismo ? row.ultimo_contacto || null : null,
        ultimo_tipo: mismo ? row.ultimo_tipo || null : null,
        proxima_accion: mismo ? row.proxima_accion || null : null,
        cerrado: mismo ? Boolean(row.cerrado) : false,
        actualizado: mismo ? row.updated_at || null : null,
    };
}

/**
 * Qué toque le corresponde hoy. Devuelve { toca, motivo, codigo, proxima_accion, cerrado, vence }.
 * codigo: por qué no se puede reservar (null si toca): no_es_inactivo, ciclo_cerrado,
 * respuesta_pendiente, no_contactar, ya_contactado_hoy, pausa_entre_flujos, todavia_no.
 * @param {object} p
 * @param {boolean} p.esInactivo
 * @param {number|null} p.diasSinComprar
 * @param {object} p.ciclo — cicloActual()
 * @param {string} p.hoy
 * @param {object} p.cfg — reintento_dias, max_toques, pausa_entre_flujos_dias
 * @param {boolean} p.noContactar
 * @param {boolean} p.respuestaPendiente
 * @param {string|Date|null} p.ultimoRecibido — último mensaje del cliente (cualquier flujo)
 * @param {string|null} p.ultimoContactoDia — día (YYYY-MM-DD, Argentina) del último mensaje enviado por cualquier flujo
 */
function tocaHoy({ esInactivo, diasSinComprar, ciclo, hoy, cfg, noContactar = false, respuestaPendiente = false, ultimoRecibido = null, ultimoContactoDia = null }) {
    const out = (extra) => ({ toca: null, motivo: null, codigo: null, proxima_accion: null, cerrado: false, vence: null, ...extra });
    if (!esInactivo) return out({ codigo: 'no_es_inactivo', motivo: 'No es inactivo' });

    const toques = ciclo.toques_enviados;
    // Respondió después de un toque de este ciclo: ya hubo conversación
    const respondio = Boolean(toques > 0 && ultimoRecibido && ciclo.ultimo_contacto
        && new Date(ultimoRecibido).getTime() > new Date(ciclo.ultimo_contacto).getTime());
    if (ciclo.cerrado || toques >= cfg.max_toques) {
        return out({ cerrado: true, codigo: 'ciclo_cerrado', motivo: `Ciclo cerrado: ${toques} ${toques === 1 ? 'toque' : 'toques'} sin que vuelva a comprar` });
    }
    if (respuestaPendiente) {
        return out({ codigo: 'respuesta_pendiente', motivo: 'El cliente contestó y todavía no se revisó su respuesta' });
    }
    if (respondio) {
        return out({ cerrado: true, codigo: 'ciclo_cerrado', motivo: 'Respondió al primer toque: no se manda el segundo en este ciclo' });
    }
    if (noContactar) return out({ codigo: 'no_contactar', motivo: 'El cliente pidió no recibir mensajes' });

    let tipo;
    let motivo;
    if (toques === 0) {
        tipo = 'primer_toque';
        motivo = `${diasSinComprar} días sin comprar; nunca contactado como inactivo`;
    } else {
        const ultimoDia = health.toArDate(ciclo.ultimo_contacto) || hoy;
        const desde = ciclo.proxima_accion && ciclo.proxima_accion > ultimoDia
            ? ciclo.proxima_accion
            : health.addDays(ultimoDia, cfg.reintento_dias);
        if (hoy < desde) {
            return out({ codigo: 'todavia_no', proxima_accion: desde, motivo: `Primer toque el ${ultimoDia}: el segundo va desde el ${desde}` });
        }
        tipo = TIPOS[toques];
        motivo = `${diasSinComprar} días sin comprar; primer toque el ${ultimoDia} sin respuesta ni compra`;
    }

    // Convivencia con los otros flujos: un mensaje por día y una pausa entre flujos
    if (ultimoContactoDia) {
        const dias = health.daysBetween(ultimoContactoDia, hoy);
        if (dias <= 0) {
            return out({ codigo: 'ya_contactado_hoy', proxima_accion: health.addDays(hoy, 1), motivo: 'Ya recibió un mensaje hoy' });
        }
        if (dias < cfg.pausa_entre_flujos_dias) {
            const desde = health.addDays(ultimoContactoDia, cfg.pausa_entre_flujos_dias);
            return out({ codigo: 'pausa_entre_flujos', proxima_accion: desde, motivo: `Recibió un mensaje el ${ultimoContactoDia}: pausa entre flujos hasta el ${desde}` });
        }
    }
    return { toca: tipo, motivo, codigo: null, proxima_accion: hoy, cerrado: false, vence: habilesDespues(hoy, HABILES_VIGENCIA) };
}

/** Clave sin tildes ni mayúsculas, para comparar ciudades. */
function claveTexto(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Filtros de la lista (sobre ClienteInactivo ya armado). */
function filtrar(lista, { rubro, ciudad, toca_hoy: tocaHoyFiltro, no_contactar: noContactar, con_respuesta_pendiente: conRespuesta, con_telefono: conTelefono }) {
    let out = lista;
    if (rubro) {
        const k = health.rubroKey(rubro) || claveTexto(rubro);
        out = out.filter((c) => health.rubroKey(c.rubro) === k
            || (c.categorias_compradas || []).some((x) => health.rubroKey(x.rubro) === k));
    }
    if (ciudad) {
        const k = claveTexto(ciudad);
        out = out.filter((c) => claveTexto(c.ciudad) === k);
    }
    if (tocaHoyFiltro !== undefined) out = out.filter((c) => Boolean(c.toca_hoy) === tocaHoyFiltro);
    if (noContactar !== undefined && noContactar !== null) out = out.filter((c) => c.no_contactar === noContactar);
    if (conRespuesta !== undefined) out = out.filter((c) => c.respuesta_pendiente === conRespuesta);
    if (conTelefono !== undefined) out = out.filter((c) => Boolean(c.telefono) === conTelefono);
    return out;
}

function ordenar(lista, orden = ORDEN_DEFAULT) {
    const copy = lista.slice();
    const porNombre = (a, b) => String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es') || a.id - b.id;
    switch (orden) {
    case 'dias_sin_comprar_desc':
        copy.sort((a, b) => b.dias_sin_comprar - a.dias_sin_comprar || b.total_historico - a.total_historico || porNombre(a, b));
        break;
    case 'total_historico_desc':
        copy.sort((a, b) => b.total_historico - a.total_historico || porNombre(a, b));
        break;
    case 'ultima_compra_desc':
        copy.sort((a, b) => String(b.ultima_compra || '').localeCompare(String(a.ultima_compra || '')) || porNombre(a, b));
        break;
    case 'nombre':
        copy.sort(porNombre);
        break;
    case 'dias_sin_comprar_asc':
    default:
        // Los que dejaron hace menos primero (los más fáciles de recuperar); empate: más total histórico
        copy.sort((a, b) => a.dias_sin_comprar - b.dias_sin_comprar || b.total_historico - a.total_historico || porNombre(a, b));
        break;
    }
    return copy;
}

/** Tramo de días sin comprar para el resumen. */
function tramo(dias) {
    if (dias <= 90) return '61_90';
    if (dias <= 180) return '91_180';
    if (dias <= 365) return '181_365';
    return 'mas_de_365';
}

/**
 * Clientes que recibieron un toque de inactivo y volvieron a comprar dentro de los 30 días
 * siguientes, con esa compra en los últimos 30 días.
 * @param {Array<{ id: number, fecha: string|Date }>} toques — toques confirmados
 * @param {Map<number, object[]>} comprasPorCliente — compras de cada cliente
 */
function recuperados(toques, comprasPorCliente, hoy, dias = RECUPERO_DIAS) {
    const desde = health.addDays(hoy, -(dias - 1));
    const ids = new Set();
    for (const t of toques) {
        const ms = new Date(t.fecha).getTime();
        const dia = health.toArDate(new Date(ms));
        const compras = comprasPorCliente.get(t.id) || [];
        const volvio = compras.some((c) => {
            const f = fechaDe(c);
            return f && f >= desde && new Date(c.fecha).getTime() > ms && health.daysBetween(dia, f) <= dias;
        });
        if (volvio) ids.add(t.id);
    }
    return ids.size;
}

/**
 * Resumen para el tablero.
 * @param {object[]} lista — ClienteInactivo de todos los inactivos (sin filtros ni paginar)
 * @param {object} excluidos — { manual, pedido_activo, en_flujo_nuevos, es_importante }
 */
function resumir(lista, excluidos, recuperados30) {
    const por_tramo = { '61_90': 0, '91_180': 0, '181_365': 0 };
    const toca = { primer_toque: 0, segundo_toque: 0 };
    const bloqueados = { respuesta_pendiente: 0, no_contactar: 0, sin_telefono: 0 };
    let monto = 0;
    let puede = 0;
    for (const c of lista) {
        const t = tramo(c.dias_sin_comprar);
        por_tramo[t] = (por_tramo[t] || 0) + 1;
        monto += c.total_historico;
        if (c.toca_hoy) toca[c.toca_hoy] += 1;
        if (c.puede_enviar_ahora) puede += 1;
        if (c.respuesta_pendiente) bloqueados.respuesta_pendiente += 1;
        if (c.no_contactar) bloqueados.no_contactar += 1;
        if (!c.telefono) bloqueados.sin_telefono += 1;
    }
    return {
        total_inactivos: lista.length,
        por_tramo,
        monto_historico_total: round2(monto),
        toca_hoy: toca,
        puede_enviar_ahora: puede,
        bloqueados,
        excluidos: {
            pedido_activo: excluidos.pedido_activo || 0,
            en_flujo_nuevos: excluidos.en_flujo_nuevos || 0,
            es_importante: excluidos.es_importante || 0,
            manual: excluidos.manual || 0,
        },
        recuperados_30d: recuperados30,
    };
}

module.exports = {
    DEFAULTS,
    DIAS_MIN_MAX,
    DIAS_MAX_MAX,
    COMPRAS_MIN_MAX,
    LIMIT_DEFAULT,
    TIPOS,
    MARCAS,
    ORDENES,
    ORDEN_DEFAULT,
    EXCLUSIONES,
    NOTA_MAX,
    HABILES_VIGENCIA,
    cargarConfig,
    numeroToque,
    habilesDespues,
    topProductos,
    intervaloHabitual,
    metricas,
    cumpleRegla,
    motivoExclusion,
    cicloActual,
    tocaHoy,
    filtrar,
    ordenar,
    tramo,
    recuperados,
    resumir,
};
