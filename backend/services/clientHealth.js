// Reglas del CRM de clientes: intervalo habitual, estado (salud), tendencia y prioridad.
// Lógica pura, sin base ni Odoo. Las definiciones están en docs/plan-crm-clientes.md (sección 3).

// Intervalo que se usa con menos de 3 compras (decisión D5)
const DEFAULT_INTERVAL_DAYS = 15;
// Piso del intervalo: un cliente que compra a diario no pasa a "enfriándose" por faltar 3 días
const MIN_INTERVAL_DAYS = 7;
const NEW_CLIENT_DAYS = 30;
const LOST_DAYS = 120;
const DESFASAJE_FACTOR = 1.5;
const ENFRIANDO_FACTOR = 2.5;
const TREND_THRESHOLD_PCT = 20;
const MONTHS_IN_SERIES = 12;
// Cotizaciones abiertas que se muestran como motivo para hablarle al cliente (D19)
const QUOTATION_DAYS = 60;
// Categorías de Odoo que no son un rubro (servicios, gastos y las genéricas de fábrica)
const NOT_RUBRO = new Set(['deliveries', 'expenses', 'services', 'goods', 'food', 'all']);

const HEALTH = {
    nuevo: 'nuevo',
    activo: 'activo',
    desfasaje: 'desfasaje',
    enfriandose: 'enfriandose',
    perdido: 'perdido',
    sinCompras: 'sin_compras',
};

const DAY_MS = 24 * 60 * 60 * 1000;
// Argentina no tiene horario de verano: UTC-3 fijo
const AR_OFFSET_MS = -3 * 60 * 60 * 1000;

/**
 * Fecha local de Argentina (YYYY-MM-DD) de un datetime de Odoo, que viene en UTC
 * como "2026-10-20 20:41:28". Acepta también Date.
 */
function toArDate(value) {
    if (!value) return null;
    const ms = value instanceof Date
        ? value.getTime()
        : Date.parse(String(value).trim().replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(value)) ? '' : 'Z'));
    if (Number.isNaN(ms)) return null;
    return new Date(ms + AR_OFFSET_MS).toISOString().slice(0, 10);
}

function daysBetween(fromDate, toDate) {
    return Math.round((Date.parse(toDate) - Date.parse(fromDate)) / DAY_MS);
}

function addDays(date, days) {
    return new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
}

function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Intervalo habitual entre compras: mediana de días entre días distintos con compra.
 * Usa los últimos 12 meses; si ahí hay menos de 3 días con compra, mira toda la historia.
 * Con menos de 3 días con compra devuelve el valor por defecto.
 * @param {string[]} dates — fechas YYYY-MM-DD (pueden repetirse)
 * @param {string} today — YYYY-MM-DD
 * @returns {{ days: number, isDefault: boolean }}
 */
function usualInterval(dates, today) {
    const all = [...new Set(dates.filter(Boolean))].sort();
    const since = addDays(today, -365);
    const recent = all.filter((d) => d >= since);
    const base = recent.length >= 3 ? recent : all;
    if (base.length < 3) return { days: DEFAULT_INTERVAL_DAYS, isDefault: true };
    const gaps = [];
    for (let i = 1; i < base.length; i++) gaps.push(daysBetween(base[i - 1], base[i]));
    return { days: Math.max(MIN_INTERVAL_DAYS, median(gaps)), isDefault: false };
}

/**
 * Estado del cliente medido contra su propio ritmo.
 * @param {{ daysSinceLast: number|null, daysSinceFirst: number|null, intervalDays: number }} p
 */
function classifyHealth({ daysSinceLast, daysSinceFirst, intervalDays }) {
    if (daysSinceLast == null) return HEALTH.sinCompras;
    if (daysSinceLast > LOST_DAYS) return HEALTH.perdido;
    if (daysSinceFirst != null && daysSinceFirst <= NEW_CLIENT_DAYS) return HEALTH.nuevo;
    if (daysSinceLast <= DESFASAJE_FACTOR * intervalDays) return HEALTH.activo;
    if (daysSinceLast <= ENFRIANDO_FACTOR * intervalDays) return HEALTH.desfasaje;
    return HEALTH.enfriandose;
}

/**
 * Tendencia: últimos 90 días contra los 90 anteriores.
 * @returns {{ trend: 'sube'|'estable'|'baja'|null, pct: number|null }}
 */
function classifyTrend(revenue90, revenuePrev90) {
    const now = Number(revenue90) || 0;
    const prev = Number(revenuePrev90) || 0;
    if (prev <= 0 && now <= 0) return { trend: null, pct: null };
    if (prev <= 0) return { trend: 'sube', pct: null };
    const pct = Math.round(((now - prev) / prev) * 1000) / 10;
    if (pct > TREND_THRESHOLD_PCT) return { trend: 'sube', pct };
    if (pct < -TREND_THRESHOLD_PCT) return { trend: 'baja', pct };
    return { trend: 'estable', pct };
}

/**
 * Orden para llamar: cuánto factura por lo pasado que está de su ritmo.
 * Un cliente al día (o nuevo, o perdido) no suma prioridad.
 */
function priorityScore({ revenue12m, daysSinceLast, intervalDays, health }) {
    if (health !== HEALTH.desfasaje && health !== HEALTH.enfriandose) return 0;
    const atraso = Math.max(0, daysSinceLast / intervalDays - 1);
    return Math.round((Number(revenue12m) || 0) * atraso * 100) / 100;
}

/** Últimos N meses (YYYY-MM) terminando en el mes de `today`, del más viejo al actual. */
function lastMonths(today, n = MONTHS_IN_SERIES) {
    const [y, m] = today.split('-').map(Number);
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
        const d = new Date(Date.UTC(y, m - 1 - i, 1));
        out.push(d.toISOString().slice(0, 7));
    }
    return out;
}

/**
 * Métricas de un cliente a partir de sus compras.
 * @param {Array<{ date: string, amount: number }>} purchases — date YYYY-MM-DD (hora AR)
 * @param {string} today — YYYY-MM-DD
 */
function buildMetrics(purchases, today) {
    const valid = purchases.filter((p) => p && p.date);
    const months = lastMonths(today);
    const monthly = new Map(months.map((mo) => [mo, 0]));

    if (!valid.length) {
        return {
            purchase_count: 0,
            total_revenue: 0,
            avg_ticket: 0,
            first_purchase_date: null,
            last_purchase_date: null,
            days_since_last_purchase: null,
            median_interval_days: DEFAULT_INTERVAL_DAYS,
            interval_is_default: true,
            revenue_90d: 0,
            revenue_prev_90d: 0,
            revenue_12m: 0,
            health: HEALTH.sinCompras,
            trend: null,
            trend_pct: null,
            priority: 0,
            monthly_revenue: months.map((month) => ({ month, amount: 0 })),
        };
    }

    const dates = valid.map((p) => p.date).sort();
    const first = dates[0];
    const last = dates[dates.length - 1];
    const d90 = addDays(today, -90);
    const d180 = addDays(today, -180);
    const d365 = addDays(today, -365);

    let total = 0;
    let rev90 = 0;
    let revPrev90 = 0;
    let rev12m = 0;
    for (const p of valid) {
        const amount = Number(p.amount) || 0;
        total += amount;
        if (p.date > d90) rev90 += amount;
        else if (p.date > d180) revPrev90 += amount;
        if (p.date > d365) rev12m += amount;
        const mo = p.date.slice(0, 7);
        if (monthly.has(mo)) monthly.set(mo, monthly.get(mo) + amount);
    }

    const interval = usualInterval(dates, today);
    const daysSinceLast = daysBetween(last, today);
    const daysSinceFirst = daysBetween(first, today);
    const health = classifyHealth({ daysSinceLast, daysSinceFirst, intervalDays: interval.days });
    const { trend, pct } = classifyTrend(rev90, revPrev90);
    const round2 = (n) => Math.round(n * 100) / 100;

    return {
        purchase_count: valid.length,
        total_revenue: round2(total),
        avg_ticket: round2(total / valid.length),
        first_purchase_date: first,
        last_purchase_date: last,
        days_since_last_purchase: daysSinceLast,
        median_interval_days: interval.days,
        interval_is_default: interval.isDefault,
        revenue_90d: round2(rev90),
        revenue_prev_90d: round2(revPrev90),
        revenue_12m: round2(rev12m),
        health,
        trend,
        trend_pct: pct,
        priority: priorityScore({ revenue12m: rev12m, daysSinceLast, intervalDays: interval.days, health }),
        monthly_revenue: months.map((month) => ({ month, amount: round2(monthly.get(month)) })),
    };
}

/**
 * Productos más comprados (por importe) a partir de líneas de ticket.
 * Se guardan varios para que la ficha también pueda ordenarlos por cantidad.
 * @param {Array<{ product_id: number, name: string, qty: number, amount: number, date: string }>} lines
 */
function topProducts(lines, limit = 40) {
    const byProduct = new Map();
    for (const l of lines) {
        if (!l || !l.product_id) continue;
        const prev = byProduct.get(l.product_id) || { product_id: l.product_id, name: l.name, qty: 0, amount: 0, last_date: null };
        prev.qty += Number(l.qty) || 0;
        prev.amount += Number(l.amount) || 0;
        if (l.date && (!prev.last_date || l.date > prev.last_date)) prev.last_date = l.date;
        byProduct.set(l.product_id, prev);
    }
    return [...byProduct.values()]
        .sort((a, b) => b.amount - a.amount)
        .slice(0, limit)
        .map((p) => ({ ...p, qty: Math.round(p.qty * 100) / 100, amount: Math.round(p.amount * 100) / 100 }));
}

/**
 * Clave para agrupar categorías duplicadas de Odoo: sin tildes, sin números pegados,
 * sin "de" ("Accesorios de Moda" = "Accesorios Moda", "Tecnologia" = "Tecnología").
 */
function rubroKey(name) {
    const key = String(name || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\d+/g, ' ')
        .replace(/\bde\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return key && !NOT_RUBRO.has(key) ? key : null;
}

/** Entre variantes de un mismo rubro, el nombre con tilde y, si empatan, el más corto. */
function preferRubroLabel(a, b) {
    const clean = (x) => String(x).replace(/\d+/g, '').trim();
    const [ca, cb] = [clean(a), clean(b)];
    const accent = (x) => /[^\x20-\x7e]/.test(x);
    if (accent(ca) !== accent(cb)) return accent(ca) ? ca : cb;
    return ca.length <= cb.length ? ca : cb;
}

/**
 * Nombre único de rubro para cada categoría de Odoo, mirando todas juntas: así un cliente
 * que compró en "Tecnologia" y otro en "Tecnología" quedan en el mismo rubro.
 * @param {Iterable<string>} names
 * @returns {Map<string, string>} nombre de la categoría → nombre del rubro
 */
function rubroLabels(names) {
    const labelByKey = new Map();
    const all = [...new Set([...names].filter(Boolean))];
    for (const name of all) {
        const key = rubroKey(name);
        if (!key) continue;
        labelByKey.set(key, labelByKey.has(key) ? preferRubroLabel(labelByKey.get(key), name) : preferRubroLabel(name, name));
    }
    const out = new Map();
    for (const name of all) {
        const key = rubroKey(name);
        if (key) out.set(name, labelByKey.get(key));
    }
    return out;
}

/**
 * Rubro del cliente: la categoría de producto en la que más gastó (D6).
 * @param {Array<{ category: string, amount: number }>} lines
 * @returns {string|null}
 */
function topRubro(lines) {
    const byKey = new Map();
    for (const l of lines) {
        const key = rubroKey(l && l.category);
        if (!key) continue;
        const prev = byKey.get(key) || { label: String(l.category).replace(/\d+/g, '').trim(), amount: 0 };
        prev.label = preferRubroLabel(prev.label, l.category);
        prev.amount += Number(l.amount) || 0;
        byKey.set(key, prev);
    }
    let best = null;
    for (const r of byKey.values()) {
        if (r.amount > 0 && (!best || r.amount > best.amount)) best = r;
    }
    return best ? best.label : null;
}

module.exports = {
    DEFAULT_INTERVAL_DAYS,
    QUOTATION_DAYS,
    MIN_INTERVAL_DAYS,
    NEW_CLIENT_DAYS,
    LOST_DAYS,
    HEALTH,
    toArDate,
    daysBetween,
    addDays,
    median,
    usualInterval,
    classifyHealth,
    classifyTrend,
    priorityScore,
    lastMonths,
    buildMetrics,
    topProducts,
    rubroKey,
    rubroLabels,
    topRubro,
};
