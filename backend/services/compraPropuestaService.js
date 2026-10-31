// Motor de propuestas de compra (plan de reposición automática, punto 6 / Etapa 1).
// De la cola de reposición (pendientes) y los encargues de clientes arma un pedido por proveedor,
// eligiendo a quién comprarle cada producto por COSTO TOTAL, no solo por precio unitario:
//   1. Entra cada producto con cantidad (venta semanal × semanas + lo encargado). Los C flojos o
//      sin ventas y sin encargue salen como "no reponer" (sugerencia: no se compran solos).
//   2. Ofertas válidas: web confirmadas, disponibles, con precio de menos de 7 días; si el
//      proveedor de Odoo no tiene oferta fresca, entra su costo de Odoo.
//   3. Costo efectivo = precio por unidad × (1 + flete del proveedor), cantidad redondeada al pack.
//   4. Cambiar de proveedor solo si el otro es UMBRAL_CAMBIO más barato que el de siempre.
//   5. Cierre de canastas con un optimizador (MILP, HiGHS): cada pedido tiene que llegar al
//      mínimo del proveedor; si no conviene, el renglón queda "esperando mínimo".
//   6. Cada renglón explica por qué se eligió y cuál era la alternativa.
// Solo lee: la propuesta se arma en el momento. Aprobar guarda lo aprobado y pasa los ítems
// de la cola a "encargado" (como el botón de hoy). No escribe en Odoo.

const pool = require('../config/database');
const reposicion = require('./reposicionService');
const { ofertasPorProducto } = require('./tablaMaestraService');

// Flete cuando el proveedor no tiene uno cargado (lo que se usa hoy)
const FLETE_DEFECTO = 1.5;
// Cuánto más barato tiene que ser otro proveedor para dejar al de siempre
const UMBRAL_CAMBIO = 0.05;
// Esperar al mínimo "cuesta" como pagar esto de más; con un cliente esperando, mucho más
const PEN_ESPERA = 0.25;
const PEN_ESPERA_ENCARGUE = 1.0;
// Un encargue con más días que esto se marca para decidir a mano
const DIAS_ENCARGUE_MANUAL = 7;
const SIN_PROVEEDOR = 'Sin proveedor';
const MOTIVOS = ['habitual', 'mas_barato', 'minimo', 'unico', 'manual'];

const redondear2 = n => Math.round(n * 100) / 100;
const DIA_MS = 24 * 3600 * 1000;

function redondearPack(qty, pack) {
    const p = Math.max(1, Math.round(Number(pack) || 1));
    return Math.ceil(qty / p) * p;
}

function condicionDe(condiciones, canasta) {
    return (condiciones && condiciones[canasta]) || { pedido_minimo: null, flete_pct: null, demora_dias: null };
}

/**
 * Junta los ítems de la cola con los encargues de clientes y arma los renglones con sus
 * opciones de compra (pasos 1, 2, 3 y 5). Pura.
 * @param {{ cola: object[], encargues: object[], condiciones: object, ahora?: Date }} p
 */
function armarRenglones({ cola, encargues = [], condiciones = {}, ahora = new Date() }) {
    const porId = new Map();
    for (const it of cola || []) {
        porId.set(it.odoo_id, {
            reposicion_item_id: it.id,
            odoo_id: it.odoo_id,
            nombre: it.name,
            ref: it.internal_ref || null,
            image_url: it.image_url || null,
            vendor_name: it.vendor_name || SIN_PROVEEDOR,
            costo_odoo: Number(it.standard_price) > 0 ? Number(it.standard_price) : null,
            origen: it.origen || null,
            abc: it.abc || 'C',
            ritmo: it.ritmo || 'sin_datos',
            avg_weekly: Number(it.avg_weekly) || 0,
            qty_sugerida: Number(it.qty_sugerida_calc) || 0,
            qty_decidida: Number(it.qty_decidida) > 0 ? Number(it.qty_decidida) : null,
            qty_encargue: 0,
            cotizaciones: [],
            ofertas: it.ofertas?.ofertas || [],
        });
    }
    for (const e of encargues || []) {
        if (e.estado_cola === 'encargado') continue; // ya se pidió
        const r = porId.get(e.odoo_id) || {
            reposicion_item_id: null,
            odoo_id: e.odoo_id,
            nombre: e.name,
            ref: e.internal_ref || null,
            image_url: e.image_url || null,
            vendor_name: e.vendor_name || SIN_PROVEEDOR,
            costo_odoo: Number(e.standard_price) > 0 ? Number(e.standard_price) : null,
            origen: 'encargue',
            abc: e.abc || 'C',
            ritmo: e.ritmo || 'sin_datos',
            avg_weekly: 0,
            qty_sugerida: 0,
            qty_decidida: null,
            qty_encargue: 0,
            cotizaciones: [],
            ofertas: e.ofertas?.ofertas || [],
        };
        r.qty_encargue += Number(e.qty_total) || 0;
        r.cotizaciones.push(...(e.cotizaciones || []));
        porId.set(e.odoo_id, r);
    }

    const limiteViejo = ahora.getTime() - DIAS_ENCARGUE_MANUAL * DIA_MS;
    return [...porId.values()].map(r => {
        // La cantidad que decidió una persona manda sobre la sugerida
        const base = r.qty_decidida != null ? r.qty_decidida : r.qty_sugerida;
        const qty = Math.ceil(base + r.qty_encargue);
        const encargueViejo = r.cotizaciones.some(c => c.date_order && new Date(c.date_order).getTime() < limiteViejo);

        let noReponer = null;
        if (!r.qty_encargue && r.qty_decidida == null && r.abc === 'C' && ['flojo', 'sin_datos'].includes(r.ritmo)) {
            noReponer = 'C con ritmo flojo o sin ventas, y sin encargue: mejor no reponer';
        } else if (qty <= 0) {
            noReponer = 'Sin ventas recientes ni encargues: decidí la cantidad a mano';
        }

        const { opciones, preciosViejos } = opcionesDe(r, qty, condiciones);
        const { ofertas, ...resto } = r;
        return {
            ...resto,
            qty_total: Math.max(qty, 0),
            encargue_viejo: encargueViejo,
            precios_viejos: preciosViejos,
            no_reponer: noReponer,
            opciones,
        };
    });
}

/**
 * Opciones de compra de un renglón, una por pedido (canasta = proveedor de Odoo). De varias
 * ofertas del mismo pedido queda la más barata. Pura.
 */
function opcionesDe(r, qty, condiciones) {
    const porCanasta = new Map();
    let preciosViejos = 0;
    const agregar = (op) => {
        const prev = porCanasta.get(op.canasta);
        if (!prev || op.total < prev.total) porCanasta.set(op.canasta, op);
    };
    const armar = ({ canasta, proveedor, supplier_product_id, origen, precio, pack, scrapeado_at }) => {
        const cond = condicionDe(condiciones, canasta);
        const flete = cond.flete_pct != null ? Number(cond.flete_pct) : FLETE_DEFECTO;
        const q = redondearPack(Math.max(qty, 1), pack);
        const costoUnit = precio * (1 + flete / 100);
        return {
            canasta, proveedor, supplier_product_id, origen,
            precio: redondear2(precio), pack: Math.max(1, Math.round(pack || 1)), qty: q,
            flete_pct: flete, costo_unit: redondear2(costoUnit), total: redondear2(costoUnit * q),
            habitual: canasta === r.vendor_name, scrapeado_at: scrapeado_at || null,
        };
    };

    for (const o of r.ofertas || []) {
        if (!o.disponible || !(o.precio > 0)) continue;
        if (o.precio_viejo) { preciosViejos++; continue; }
        agregar(armar({
            canasta: o.proveedor_odoo || o.proveedor, proveedor: o.proveedor,
            supplier_product_id: o.supplier_product_id, origen: 'web',
            precio: Number(o.precio), pack: o.pack, scrapeado_at: o.scrapeado_at,
        }));
    }
    // Sin oferta fresca de su proveedor, entra el costo de Odoo (proveedores sin scraper incluidos)
    if (r.vendor_name !== SIN_PROVEEDOR && r.costo_odoo > 0 && !porCanasta.has(r.vendor_name)) {
        agregar(armar({
            canasta: r.vendor_name, proveedor: r.vendor_name, supplier_product_id: null,
            origen: 'costo_odoo', precio: r.costo_odoo, pack: 1,
        }));
    }
    const opciones = [...porCanasta.values()].sort((a, b) => a.total - b.total);
    return { opciones, preciosViejos };
}

/**
 * Costo con el que compite cada opción: si el de siempre tiene precio válido, los demás
 * cargan el umbral (para no cambiar por diferencias chicas). Pura.
 */
function costoObjetivo(renglon, opcion, umbral = UMBRAL_CAMBIO) {
    const hayHabitual = renglon.opciones.some(o => o.habitual);
    return opcion.total * (hayHabitual && !opcion.habitual ? 1 + umbral : 1);
}

// Esperar no ahorra la compra: igual se paga después (la opción más barata) más la penalidad
function penalidadEspera(renglon) {
    const minimo = Math.min(...renglon.opciones.map(o => o.total));
    return minimo * (1 + (renglon.qty_encargue > 0 ? PEN_ESPERA_ENCARGUE : PEN_ESPERA));
}

/**
 * Elección simple (sin mínimos): la opción de menor costo objetivo. Es el respaldo si el
 * optimizador falla. Pura. @returns {number[]} índice de opción por renglón
 */
function resolverSimple(renglones, { umbral = UMBRAL_CAMBIO } = {}) {
    return renglones.map(r => {
        let mejor = 0;
        r.opciones.forEach((o, j) => { if (costoObjetivo(r, o, umbral) < costoObjetivo(r, r.opciones[mejor], umbral)) mejor = j; });
        return mejor;
    });
}

const numLp = n => (Math.round(n * 100) / 100).toFixed(2);

/**
 * Modelo MILP en formato LP (CPLEX) para HiGHS. Pura.
 *   x_i_j = 1 si el renglón i se compra con la opción j; w_i = 1 si espera al mínimo;
 *   y_k = 1 si se hace el pedido de la canasta k (solo canastas con mínimo).
 *   min Σ costo_objetivo·x + Σ penalidad·w
 *   Σ_j x_i_j + w_i = 1;  Σ total·x (canasta k) ≥ mínimo_k·y_k;  Σ x (canasta k) ≤ N·y_k
 */
function construirModelo(renglones, condiciones, { umbral = UMBRAL_CAMBIO } = {}) {
    const obj = [];
    const filas = [];
    const binarios = [];
    const porCanasta = new Map();
    renglones.forEach((r, i) => {
        const fila = [];
        r.opciones.forEach((o, j) => {
            const v = `x_${i}_${j}`;
            binarios.push(v);
            obj.push(`${numLp(costoObjetivo(r, o, umbral))} ${v}`);
            fila.push(v);
            if (!porCanasta.has(o.canasta)) porCanasta.set(o.canasta, []);
            porCanasta.get(o.canasta).push({ v, total: o.total });
        });
        binarios.push(`w_${i}`);
        obj.push(`${numLp(penalidadEspera(r))} w_${i}`);
        filas.push(` r_${i}: ${[...fila, `w_${i}`].join(' + ')} = 1`);
    });
    const canastas = [...porCanasta.keys()];
    canastas.forEach((c, k) => {
        const minimo = Number(condicionDe(condiciones, c).pedido_minimo) || 0;
        if (minimo <= 0) return;
        const vars = porCanasta.get(c);
        binarios.push(`y_${k}`);
        filas.push(` m_${k}: ${vars.map(x => `${numLp(x.total)} ${x.v}`).join(' + ')} - ${numLp(minimo)} y_${k} >= 0`);
        filas.push(` u_${k}: ${vars.map(x => x.v).join(' + ')} - ${vars.length} y_${k} <= 0`);
    });
    const lp = [
        'Minimize',
        ` obj: ${obj.join(' + ') || '0 w_0'}`,
        'Subject To',
        ...filas,
        'Binary',
        ...binarios.map(b => ` ${b}`),
        'End',
    ].join('\n');
    return { lp, canastas };
}

/**
 * Lee la solución de HiGHS: índice de opción por renglón, o -1 si espera al mínimo. Pura.
 */
function leerSolucion(renglones, columnas) {
    const vale = v => (columnas[v]?.Primal ?? 0) > 0.5;
    return renglones.map((r, i) => {
        const j = r.opciones.findIndex((_, jj) => vale(`x_${i}_${jj}`));
        return j >= 0 ? j : -1;
    });
}

let highsCargado = null;
function cargarHighs() {
    if (!highsCargado) highsCargado = require('highs')();
    return highsCargado;
}

/**
 * Resuelve con el optimizador; si falla, cae a la elección simple (sin mínimos).
 * @returns {Promise<{ elecciones: number[], solver: string, aviso?: string }>}
 */
async function resolver(renglones, condiciones, opts = {}) {
    if (!renglones.length) return { elecciones: [], solver: 'highs' };
    try {
        const highs = await cargarHighs();
        const { lp } = construirModelo(renglones, condiciones, opts);
        const r = highs.solve(lp, { time_limit: 20, mip_rel_gap: 0.001 });
        if (r.Status !== 'Optimal') throw new Error(`HiGHS terminó con estado ${r.Status}`);
        return { elecciones: leerSolucion(renglones, r.Columns), solver: 'highs' };
    } catch (err) {
        console.warn(`⚠️ Propuestas: el optimizador falló (${err.message}); se usa la elección simple`);
        return { elecciones: resolverSimple(renglones, opts), solver: 'simple', aviso: err.message };
    }
}

/**
 * Motivo de cada elección y la alternativa (paso 7). Pura.
 */
function explicar(renglon, elegido, { umbral = UMBRAL_CAMBIO } = {}) {
    if (elegido < 0) return { motivo: 'esperando_minimo', alternativa: null };
    const op = renglon.opciones[elegido];
    const otras = renglon.opciones.filter((_, j) => j !== elegido);
    const alt = otras.length ? otras.reduce((a, b) => (b.total < a.total ? b : a)) : null;
    const alternativa = alt ? {
        proveedor: alt.canasta, total: alt.total, costo_unit: alt.costo_unit,
        diferencia_pct: op.total > 0 ? Math.round((alt.total / op.total - 1) * 1000) / 10 : null,
    } : null;
    if (!otras.length) return { motivo: 'unico', alternativa };
    let mejor = 0;
    renglon.opciones.forEach((o, j) => { if (costoObjetivo(renglon, o, umbral) < costoObjetivo(renglon, renglon.opciones[mejor], umbral)) mejor = j; });
    if (elegido !== mejor) return { motivo: 'minimo', alternativa };
    return { motivo: op.habitual ? 'habitual' : 'mas_barato', alternativa };
}

/**
 * Pedidos por proveedor a partir de las elecciones: total, mínimo y cuánto falta. Pura.
 */
function armarCanastas(renglones, condiciones) {
    const porCanasta = new Map();
    for (const r of renglones) {
        if (r.elegido == null || r.elegido < 0) continue;
        const op = r.opciones[r.elegido];
        if (!porCanasta.has(op.canasta)) {
            const cond = condicionDe(condiciones, op.canasta);
            porCanasta.set(op.canasta, { proveedor: op.canasta, condiciones: cond, odoo_ids: [], total: 0 });
        }
        const c = porCanasta.get(op.canasta);
        c.odoo_ids.push(r.odoo_id);
        c.total = redondear2(c.total + op.total);
    }
    return [...porCanasta.values()].map(c => {
        const minimo = Number(c.condiciones.pedido_minimo) || 0;
        return { ...c, llega_minimo: c.total >= minimo, falta: minimo > c.total ? redondear2(minimo - c.total) : 0 };
    }).sort((a, b) => b.total - a.total);
}

// =============================================
// Con base de datos
// =============================================

/**
 * Condiciones por pedido (proveedor de Odoo). Varios proveedores de la app pueden ir al mismo
 * pedido ("Parnassa" y "Parnassa Web"): se toma el mínimo más alto y el primer flete cargado.
 */
async function leerCondiciones(db = pool) {
    const { rows } = await db.query(
        `SELECT id, name, COALESCE(NULLIF(odoo_vendor_name, ''), name) AS canasta,
                pedido_minimo, flete_pct, demora_dias, condiciones_nota
         FROM suppliers WHERE active
         ORDER BY (name = COALESCE(NULLIF(odoo_vendor_name, ''), name)) DESC, id`
    );
    const out = {};
    for (const s of rows) {
        const prev = out[s.canasta];
        if (!prev) {
            out[s.canasta] = {
                supplier_id: s.id,
                pedido_minimo: s.pedido_minimo != null ? Number(s.pedido_minimo) : null,
                flete_pct: s.flete_pct != null ? Number(s.flete_pct) : null,
                demora_dias: s.demora_dias,
                nota: s.condiciones_nota || null,
            };
            continue;
        }
        if (s.pedido_minimo != null && (prev.pedido_minimo == null || Number(s.pedido_minimo) > prev.pedido_minimo)) {
            prev.pedido_minimo = Number(s.pedido_minimo);
        }
        if (prev.flete_pct == null && s.flete_pct != null) prev.flete_pct = Number(s.flete_pct);
        if (prev.demora_dias == null && s.demora_dias != null) prev.demora_dias = s.demora_dias;
    }
    return out;
}

/**
 * Encargues de clientes de Neggo (cotizaciones con etiqueta "Pendiente"), con sus ofertas.
 * Si Odoo no responde, la propuesta sale igual sin encargues.
 */
async function leerEncargues() {
    try {
        const cotizaciones = require('./reposicionCotizacionesService');
        const { productos, cotizaciones: lista } = await cotizaciones.listar({});
        const fechas = new Map(lista.map(c => [c.name, c.date_order]));
        const neggo = productos
            .filter(p => p.company === 'neggo')
            .map(p => ({ ...p, cotizaciones: p.cotizaciones.map(c => ({ ...c, date_order: fechas.get(c.name) || null })) }));
        const ofertas = await ofertasPorProducto(neggo.map(p => ({ odoo_id: p.odoo_id, standard_price: p.standard_price })));
        return { encargues: neggo.map(p => ({ ...p, ofertas: ofertas.get(p.odoo_id) || null })), aviso: null };
    } catch (err) {
        console.warn(`⚠️ Propuestas: no se pudieron leer los encargues: ${err.message}`);
        return { encargues: [], aviso: `No se pudieron leer los encargues de Odoo: ${err.message}` };
    }
}

/**
 * Arma las propuestas del momento.
 */
async function proponer() {
    const { items: cola } = await reposicion.colaParaAgente({ estado: 'pendiente' });
    const [{ encargues, aviso }, condiciones] = await Promise.all([leerEncargues(), leerCondiciones()]);
    const renglones = armarRenglones({ cola, encargues, condiciones });

    const activos = renglones.filter(r => !r.no_reponer && r.opciones.length);
    const { elecciones, solver, aviso: avisoSolver } = await resolver(activos, condiciones);
    activos.forEach((r, i) => {
        r.elegido = elecciones[i];
        Object.assign(r, explicar(r, r.elegido));
    });

    const canastas = armarCanastas(activos, condiciones);
    const esperando = activos.filter(r => r.elegido < 0);
    return {
        generado_at: new Date().toISOString(),
        solver,
        parametros: { umbral_cambio_pct: UMBRAL_CAMBIO * 100, flete_defecto_pct: FLETE_DEFECTO, dias_encargue_manual: DIAS_ENCARGUE_MANUAL },
        avisos: [aviso, avisoSolver && `Optimizador: ${avisoSolver}`].filter(Boolean),
        condiciones,
        renglones: activos,
        canastas,
        sin_precio: renglones.filter(r => !r.no_reponer && !r.opciones.length),
        no_reponer: renglones.filter(r => r.no_reponer),
        resumen: {
            renglones: activos.length - esperando.length,
            esperando_minimo: esperando.length,
            pedidos: canastas.length,
            total: redondear2(canastas.reduce((s, c) => s + c.total, 0)),
            precios_viejos: renglones.reduce((s, r) => s + r.precios_viejos, 0),
            cambian_de_proveedor: activos.filter(r => r.elegido >= 0 && !r.opciones[r.elegido].habitual).length,
        },
    };
}

function httpError(message, statusCode) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}

/**
 * Valida lo que manda la pantalla al aprobar un pedido. Pura.
 * @returns {{ valores?: object, error?: string }}
 */
function validarAprobacion(body) {
    const proveedor = String(body?.proveedor || '').trim();
    if (!proveedor) return { error: 'Falta el proveedor' };
    const renglones = Array.isArray(body?.renglones) ? body.renglones : [];
    if (!renglones.length) return { error: 'El pedido no tiene renglones' };
    const vistos = new Set();
    const valores = [];
    for (const r of renglones) {
        const odooId = Number(r.odoo_id);
        const qty = Number(r.qty);
        if (!Number.isInteger(odooId) || odooId <= 0) return { error: 'Hay un renglón sin producto' };
        if (vistos.has(odooId)) return { error: `El producto ${odooId} está dos veces` };
        vistos.add(odooId);
        if (!Number.isInteger(qty) || qty <= 0) return { error: `La cantidad de «${r.nombre || odooId}» tiene que ser un entero mayor a 0` };
        const num = v => (v == null || v === '' ? null : Number(v));
        const precio = num(r.precio);
        const costo = num(r.costo_unit);
        if ((precio != null && !(precio >= 0)) || (costo != null && !(costo >= 0))) return { error: `Precio inválido en «${r.nombre || odooId}»` };
        valores.push({
            odoo_id: odooId,
            reposicion_item_id: Number.isInteger(Number(r.reposicion_item_id)) && Number(r.reposicion_item_id) > 0 ? Number(r.reposicion_item_id) : null,
            supplier_product_id: Number.isInteger(Number(r.supplier_product_id)) && Number(r.supplier_product_id) > 0 ? Number(r.supplier_product_id) : null,
            nombre: r.nombre ? String(r.nombre).slice(0, 300) : null,
            qty,
            pack: Math.max(1, Math.round(Number(r.pack) || 1)),
            precio, costo_unit: costo,
            motivo: MOTIVOS.includes(r.motivo) ? r.motivo : 'manual',
            alternativa: r.alternativa && typeof r.alternativa === 'object' ? r.alternativa : null,
        });
    }
    return { valores: { proveedor, solver: body.solver ? String(body.solver).slice(0, 20) : null, renglones: valores } };
}

/**
 * Guarda un pedido aprobado y pasa sus ítems de la cola a "encargado" con la cantidad pedida.
 */
async function aprobar(body, userId) {
    const { valores, error } = validarAprobacion(body);
    if (error) throw httpError(error, 400);
    const condiciones = await leerCondiciones();
    const cond = condicionDe(condiciones, valores.proveedor);
    const total = redondear2(valores.renglones.reduce((s, r) => s + (r.costo_unit ?? r.precio ?? 0) * r.qty, 0));

    const db = await pool.connect();
    try {
        await db.query('BEGIN');
        const { rows: [p] } = await db.query(
            `INSERT INTO compra_propuestas (proveedor, supplier_id, estado, total_estimado, pedido_minimo_snapshot, solver, aprobada_at, aprobada_por)
             VALUES ($1, $2, 'aprobada', $3, $4, $5, NOW(), $6) RETURNING id`,
            [valores.proveedor, cond.supplier_id || null, total, cond.pedido_minimo ?? null, valores.solver, userId]
        );
        let encargados = 0;
        for (const r of valores.renglones) {
            await db.query(
                `INSERT INTO compra_propuesta_items
                    (propuesta_id, reposicion_item_id, odoo_id, supplier_product_id, nombre, qty, pack,
                     precio_esperado, costo_efectivo, motivo, alternativa)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [p.id, r.reposicion_item_id, r.odoo_id, r.supplier_product_id, r.nombre, r.qty, r.pack,
                 r.precio, r.costo_unit, r.motivo, r.alternativa ? JSON.stringify(r.alternativa) : null]
            );
            if (!r.reposicion_item_id) continue;
            // Igual que "Se pidió" en la cola: pasa a encargado con la cantidad del pedido
            const { rowCount } = await db.query(
                `UPDATE reposicion_items
                 SET estado = 'encargado', qty_decidida = $2, encargado_at = NOW(), encargado_by = $3
                 WHERE id = $1 AND estado = 'pendiente' AND company = 'neggo'`,
                [r.reposicion_item_id, r.qty, userId]
            );
            encargados += rowCount;
        }
        await db.query('COMMIT');
        console.log(`✅ Propuesta ${p.id} aprobada: ${valores.proveedor}, ${valores.renglones.length} renglón(es), $${total}`);
        return { id: p.id, proveedor: valores.proveedor, renglones: valores.renglones.length, encargados, total };
    } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        db.release();
    }
}

module.exports = {
    FLETE_DEFECTO, UMBRAL_CAMBIO,
    // Puros, para tests
    redondearPack, armarRenglones, opcionesDe, costoObjetivo, resolverSimple, construirModelo,
    leerSolucion, explicar, armarCanastas, validarAprobacion,
    // Con base de datos / optimizador
    resolver, leerCondiciones, proponer, aprobar,
};
