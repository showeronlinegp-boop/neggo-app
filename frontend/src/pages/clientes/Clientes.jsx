import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR, fmtInt } from '../../theme/tokens';
import useIsMobile from '../../hooks/useIsMobile';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Select from '../../components/common/Select';
import Toggle from '../../components/common/Toggle';
import * as Icon from '../../components/common/icons';
import BarrasMensuales from './BarrasMensuales';
import ClienteFicha from './ClienteFicha';
import {
    HEALTH_META, HEALTH_ORDER, SORT_OPTIONS,
    fmtHace, fmtIntervalo, fmtActualizado, iniciales,
} from './clientesUi';

// CRM de clientes, fase 1: quién compra, a qué ritmo y quién se está enfriando.
// Las métricas salen de los tickets del POS de Neggo; las cotizaciones abiertas, de Neggo y Preventas.

const PAGE = 50;
// Cliente · estado · última compra · 12 meses · tendencia · cotización
const COLUMNAS = 'minmax(190px, 2fr) 118px minmax(104px, 1fr) 160px 72px minmax(104px, 1.1fr)';

function Tendencia({ trend, pct, t }) {
    if (!trend) return <span style={{ color: t.color.textFaint }}>—</span>;
    const color = trend === 'sube' ? t.color.success : trend === 'baja' ? t.color.danger : t.color.textMuted;
    const Flecha = trend === 'sube' ? Icon.TrendUp : trend === 'baja' ? Icon.TrendDown : Icon.ArrowRight;
    const texto = pct == null ? 'Nuevo' : `${pct > 0 ? '+' : ''}${Math.round(pct)}%`;
    return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color, fontWeight: t.font.weight.medium, ...t.numericStyle }}
            title="Últimos 90 días contra los 90 anteriores">
            <Flecha size={14} /> {texto}
        </span>
    );
}

function Avatar({ nombre, size, t }) {
    return (
        <span aria-hidden="true" style={{
            width: size, height: size, borderRadius: t.radius.sm, flexShrink: 0,
            background: t.color.primarySoft, color: t.color.primary,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold,
        }}>
            {iniciales(nombre)}
        </span>
    );
}

function FilaCliente({ c, onAbrir, isMobile, t }) {
    const meta = HEALTH_META[c.health] || HEALTH_META.sin_compras;
    const cotizaciones = c.open_quotations || [];
    const totalCot = cotizaciones.reduce((s, q) => s + (Number(q.amount) || 0), 0);

    const nombre = (
        <div style={{ display: 'flex', alignItems: 'center', gap: t.space[3], minWidth: 0, flex: 1 }}>
            <Avatar nombre={c.partner_name} size={isMobile ? 40 : 36} t={t} />
            <div style={{ minWidth: 0 }}>
                <div style={{
                    fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.text,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: isMobile ? 'normal' : 'nowrap',
                }} title={c.partner_name}>
                    {c.partner_name}
                </div>
                <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, display: 'flex', flexWrap: 'wrap', gap: '0 8px' }}>
                    <span style={{ fontFamily: t.font.mono }}>{c.phone || 'Sin teléfono'}</span>
                    {c.city && <span>{c.city}</span>}
                </div>
            </div>
        </div>
    );

    const ultima = (
        <div style={{ fontSize: t.font.size.sm, color: t.color.text, ...t.numericStyle }}>
            <div>{fmtHace(c.days_since_last_purchase)}</div>
            <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>
                {c.purchase_count > 0 ? fmtIntervalo(c.median_interval_days, c.interval_is_default) : 'Sin compras en el POS'}
            </div>
        </div>
    );

    const cotizacion = cotizaciones.length > 0 ? (
        <Badge tone="warn" style={{ ...t.numericStyle, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {cotizaciones.length === 1 ? cotizaciones[0].name : `${cotizaciones.length} cotiz.`} · {fmtAR(totalCot)}
        </Badge>
    ) : null;

    const estilosBoton = {
        width: '100%', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left',
        fontFamily: t.font.family, borderTop: `1px solid ${t.color.border}`,
    };
    const hover = {
        onMouseEnter: (e) => { e.currentTarget.style.background = t.color.surface2; },
        onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
    };

    if (isMobile) {
        return (
            <button type="button" onClick={() => onAbrir(c)} {...hover}
                style={{ ...estilosBoton, padding: '12px', display: 'flex', flexDirection: 'column', gap: t.space[3] }}>
                <div style={{ display: 'flex', gap: t.space[3], alignItems: 'flex-start', width: '100%' }}>
                    {nombre}
                    <Badge tone={meta.tone} dot>{meta.label}</Badge>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: t.space[3], width: '100%' }}>
                    {ultima}
                    <div style={{ textAlign: 'right', fontSize: t.font.size.sm, ...t.numericStyle }}>
                        <div style={{ fontWeight: t.font.weight.semibold, color: t.color.text }}>{fmtAR(c.revenue_12m)}</div>
                        <Tendencia trend={c.trend} pct={c.trend_pct} t={t} />
                    </div>
                </div>
                {cotizacion}
            </button>
        );
    }

    return (
        <button type="button" onClick={() => onAbrir(c)} {...hover}
            style={{
                ...estilosBoton, padding: '10px 16px', display: 'grid', alignItems: 'center', gap: t.space[4],
                gridTemplateColumns: COLUMNAS,
            }}>
            {nombre}
            <span><Badge tone={meta.tone} dot>{meta.label}</Badge></span>
            {ultima}
            <div style={{ display: 'flex', alignItems: 'center', gap: t.space[3], justifyContent: 'flex-end' }}>
                <BarrasMensuales data={c.monthly_revenue || []} compacto />
                <span style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.text, minWidth: 84, textAlign: 'right', ...t.numericStyle }}>
                    {fmtAR(c.revenue_12m)}
                </span>
            </div>
            <span style={{ fontSize: t.font.size.sm, textAlign: 'right' }}><Tendencia trend={c.trend} pct={c.trend_pct} t={t} /></span>
            <span style={{ textAlign: 'right' }}>{cotizacion}</span>
        </button>
    );
}

function ChipEstado({ valor, cantidad, activo, onClick, isMobile, t }) {
    const meta = HEALTH_META[valor];
    const tones = {
        success: t.color.success, primary: t.color.primary, warn: t.color.warn,
        danger: t.color.danger, muted: t.color.textMuted,
    };
    return (
        <button type="button" onClick={onClick} aria-pressed={activo} title={meta.hint}
            style={{
                display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4,
                padding: isMobile ? '10px 12px' : '12px 14px', minWidth: isMobile ? 0 : 128, flex: isMobile ? '1 1 40%' : '1 1 0',
                borderRadius: t.radius.md, cursor: 'pointer', textAlign: 'left', fontFamily: t.font.family,
                border: `1px solid ${activo ? t.color.primary : t.color.border}`,
                background: activo ? t.color.primarySoft : t.color.surface,
                boxShadow: t.shadow.card,
            }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: t.font.size.xs, color: t.color.textMuted }}>
                <span style={{ width: 8, height: 8, borderRadius: t.radius.full, background: tones[meta.tone] }} />
                {meta.label}
            </span>
            <span style={{ fontSize: t.font.size.xl, fontWeight: t.font.weight.semibold, color: t.color.text, letterSpacing: '-0.02em', ...t.numericStyle }}>
                {fmtInt(cantidad)}
            </span>
        </button>
    );
}

export default function Clientes() {
    const { tokens: t } = useTheme();
    const isMobile = useIsMobile();
    const [resumen, setResumen] = useState(null);
    const [rows, setRows] = useState([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [cargandoMas, setCargandoMas] = useState(false);
    const [error, setError] = useState(null);
    const [sincronizando, setSincronizando] = useState(false);
    const [abierto, setAbierto] = useState(null);

    const [search, setSearch] = useState('');
    const [busqueda, setBusqueda] = useState('');
    const [city, setCity] = useState('');
    const [health, setHealth] = useState('');
    const [soloAbiertas, setSoloAbiertas] = useState(false);
    const [sort, setSort] = useState('prioridad');
    const pollRef = useRef(null);

    // Espera 300 ms después de tipear antes de buscar
    useEffect(() => {
        const id = setTimeout(() => setBusqueda(search.trim()), 300);
        return () => clearTimeout(id);
    }, [search]);

    const filtros = useCallback((offset) => ({
        search: busqueda || undefined,
        city: city || undefined,
        health: health || undefined,
        open: soloAbiertas ? 1 : undefined,
        sort,
        limit: PAGE,
        offset,
    }), [busqueda, city, health, soloAbiertas, sort]);

    const cargarResumen = useCallback(async () => {
        const res = await api.get('/clientes/resumen');
        if (res.success) setResumen(res.data);
        return res.success ? res.data : null;
    }, []);

    const cargarLista = useCallback(async () => {
        setLoading(true);
        setError(null);
        const res = await api.get('/clientes', filtros(0));
        setLoading(false);
        if (!res.success) { setError(res.error || 'No se pudo cargar la lista de clientes'); return; }
        setRows(res.data || []);
        setTotal(res.pagination?.total ?? (res.data || []).length);
    }, [filtros]);

    // Si el backend está actualizando desde Odoo, mira cada 3 s hasta que termine y recarga
    const esperarSync = useCallback(async () => {
        clearTimeout(pollRef.current);
        const data = await cargarResumen();
        if (data?.syncing) {
            pollRef.current = setTimeout(esperarSync, 3000);
        } else {
            setSincronizando(false);
        }
        return data;
    }, [cargarResumen]);

    // La lista va primero: si los datos son viejos, ese pedido arranca el sync en el backend
    useEffect(() => {
        cargarLista()
            .then(() => esperarSync())
            .then((data) => { if (data?.syncing) setSincronizando(true); });
    }, [cargarLista, esperarSync]);

    useEffect(() => () => clearTimeout(pollRef.current), []);

    // Al terminar un sync que estaba corriendo, recarga la lista
    const prevSync = useRef(false);
    useEffect(() => {
        if (prevSync.current && !sincronizando) cargarLista();
        prevSync.current = sincronizando;
    }, [sincronizando, cargarLista]);

    const actualizar = async () => {
        setSincronizando(true);
        setError(null);
        const res = await api.post('/clientes/sync');
        if (!res.success) setError(res.error || 'No se pudo actualizar desde Odoo');
        await cargarResumen();
        setSincronizando(false);
    };

    const verMas = async () => {
        setCargandoMas(true);
        const res = await api.get('/clientes', filtros(rows.length));
        setCargandoMas(false);
        if (!res.success) { setError(res.error || 'No se pudieron cargar más clientes'); return; }
        setRows((prev) => [...prev, ...(res.data || [])]);
    };

    const ciudades = [{ value: '', label: 'Todas las ciudades' },
        ...(resumen?.cities || []).map((c) => ({ value: c.city, label: `${c.city} · ${c.n}` }))];

    const variacion90 = resumen && resumen.revenue_prev_90d > 0
        ? Math.round(((resumen.revenue_90d - resumen.revenue_prev_90d) / resumen.revenue_prev_90d) * 100)
        : null;

    const filtrosActivos = busqueda || city || health || soloAbiertas;
    const limpiar = () => { setSearch(''); setCity(''); setHealth(''); setSoloAbiertas(false); };

    return (
        <div style={{ padding: isMobile ? 12 : `${t.layout.cardPadY}px ${t.layout.cardPadX}px`, maxWidth: 1240, margin: '0 auto', fontFamily: t.font.family }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
                <div style={{ minWidth: 0 }}>
                    <h1 style={{ margin: 0, fontSize: isMobile ? 22 : t.font.size['2xl'], fontWeight: t.font.weight.semibold, color: t.color.text, letterSpacing: '-0.02em' }}>
                        Clientes
                    </h1>
                    <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 4 }}>
                        Cada cliente medido contra su propio ritmo de compra en el punto de venta de Neggo.
                    </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: t.space[3], flexWrap: 'wrap' }}>
                    <span style={{ fontSize: t.font.size.xs, color: t.color.textFaint }}>
                        {sincronizando ? 'Leyendo Odoo…' : fmtActualizado(resumen?.synced_at)}
                    </span>
                    <Button variant="secondary" leftIcon={<Icon.Refresh size={16} />} disabled={sincronizando} onClick={actualizar}>
                        {sincronizando ? 'Actualizando…' : 'Actualizar'}
                    </Button>
                </div>
            </div>

            <div style={{ display: 'flex', gap: t.space[3], flexWrap: 'wrap', marginBottom: t.space[4] }}>
                {HEALTH_ORDER.map((h) => (
                    <ChipEstado key={h} valor={h} cantidad={resumen?.health?.[h] ?? 0} activo={health === h}
                        onClick={() => setHealth(health === h ? '' : h)} isMobile={isMobile} t={t} />
                ))}
            </div>

            {resumen && (
                <div style={{
                    display: 'flex', gap: isMobile ? t.space[3] : t.space[10], flexWrap: 'wrap',
                    fontSize: t.font.size.sm, color: t.color.textMuted, marginBottom: t.space[4], ...t.numericStyle,
                }}>
                    <span title="Incluye las ventas a Consumidor Final">
                        Facturación 90 días: <strong style={{ color: t.color.text }}>{fmtAR(resumen.revenue_90d)}</strong>
                        {variacion90 != null && (
                            <span style={{ color: variacion90 >= 0 ? t.color.success : t.color.danger, marginLeft: 6 }}>
                                {variacion90 > 0 ? '+' : ''}{variacion90}% vs. 90 días anteriores
                            </span>
                        )}
                    </span>
                    <span>Nuevos este mes: <strong style={{ color: t.color.text }}>{fmtInt(resumen.nuevos_mes)}</strong></span>
                    <span>Con cotización abierta: <strong style={{ color: t.color.text }}>{fmtInt(resumen.con_cotizacion)}</strong></span>
                </div>
            )}

            <Card padding={false} style={{ padding: 14, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: t.space[4] }}>
                <div style={{ flex: '1 1 280px' }}>
                    <Input
                        leftIcon={<Icon.Search size={16} />}
                        placeholder="Buscá por nombre o teléfono…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        aria-label="Buscar cliente"
                    />
                </div>
                <Select value={city} onChange={setCity} options={ciudades} placeholder="Ciudad" style={{ width: isMobile ? '100%' : 200 }} />
                <Select value={sort} onChange={setSort} options={SORT_OPTIONS} style={{ width: isMobile ? '100%' : 210 }} />
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: t.font.size.sm, color: t.color.text, cursor: 'pointer' }}>
                    <Toggle checked={soloAbiertas} onChange={setSoloAbiertas} />
                    Solo con cotización abierta
                </label>
                {filtrosActivos && (
                    <Button variant="ghost" size="sm" leftIcon={<Icon.X size={14} />} onClick={limpiar}>Limpiar filtros</Button>
                )}
            </Card>

            {error && (
                <div role="alert" style={{
                    marginBottom: t.space[4], padding: '10px 14px', borderRadius: t.radius.md,
                    background: t.color.dangerSoft, color: t.color.danger, fontSize: t.font.size.sm,
                }}>
                    {error}
                </div>
            )}

            <Card padding={false} style={{ overflow: 'hidden' }}>
                {!isMobile && (
                    <div style={{
                        display: 'grid', gap: t.space[4], padding: '10px 16px', background: t.color.surface2,
                        gridTemplateColumns: COLUMNAS,
                        fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, color: t.color.textMuted,
                        textTransform: 'uppercase', letterSpacing: '0.04em',
                    }}>
                        <span>Cliente</span>
                        <span>Estado</span>
                        <span>Última compra</span>
                        <span style={{ textAlign: 'right' }}>Últimos 12 meses</span>
                        <span style={{ textAlign: 'right' }}>Tendencia</span>
                        <span style={{ textAlign: 'right' }}>Cotización</span>
                    </div>
                )}

                {loading ? (
                    <div style={{ padding: 40, textAlign: 'center', color: t.color.textMuted, fontSize: t.font.size.sm }}>Cargando clientes…</div>
                ) : rows.length === 0 ? (
                    <div style={{ padding: isMobile ? 28 : 40, textAlign: 'center', maxWidth: 380, margin: '0 auto' }}>
                        <div style={{ width: 48, height: 48, borderRadius: '50%', background: t.color.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', color: t.color.textMuted }}>
                            <Icon.Users size={22} />
                        </div>
                        <div style={{ fontSize: 15, fontWeight: t.font.weight.medium, color: t.color.text }}>
                            {resumen?.synced_at ? 'No hay clientes con estos filtros' : 'Todavía no hay datos de clientes'}
                        </div>
                        <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 4 }}>
                            {resumen?.synced_at
                                ? 'Probá con otra búsqueda o sacá algún filtro.'
                                : 'Tocá «Actualizar» para leer los tickets del POS desde Odoo.'}
                        </div>
                    </div>
                ) : (
                    rows.map((c) => (
                        <FilaCliente key={c.odoo_partner_id} c={c} onAbrir={setAbierto} isMobile={isMobile} t={t} />
                    ))
                )}

                {!loading && rows.length > 0 && (
                    <div style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: t.space[3], flexWrap: 'wrap',
                        padding: '10px 16px', borderTop: `1px solid ${t.color.border}`, background: t.color.surface2,
                        fontSize: t.font.size.xs, color: t.color.textMuted, ...t.numericStyle,
                    }}>
                        <span>Mostrando {fmtInt(rows.length)} de {fmtInt(total)}</span>
                        {rows.length < total && (
                            <Button size="sm" variant="secondary" leftIcon={<Icon.ChevronDown size={14} />} disabled={cargandoMas} onClick={verMas}>
                                {cargandoMas ? 'Cargando…' : 'Ver más'}
                            </Button>
                        )}
                    </div>
                )}
            </Card>

            <ClienteFicha partnerId={abierto?.odoo_partner_id} resumen={abierto} onClose={() => setAbierto(null)} />
        </div>
    );
}
