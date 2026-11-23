import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { useToast } from '../../context/ToastContext';
import { fmtAR, fmtInt } from '../../theme/tokens';
import useIsMobile from '../../hooks/useIsMobile';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Select from '../../components/common/Select';
import Toggle from '../../components/common/Toggle';
import Tabs from '../../components/common/Tabs';
import * as Icon from '../../components/common/icons';
import BarrasMensuales from './BarrasMensuales';
import ClienteFicha from './ClienteFicha';
import Importancia from './Importancia';
import PosiblesClientes from './PosiblesClientes';
import EmbudoWhatsapp from './EmbudoWhatsapp';
import BotSeguimiento from './BotSeguimiento';
import BotLeads from './BotLeads';
import RespuestasFrecuentes from './RespuestasFrecuentes';
import Contactos from './Contactos';
import Chats from './Chats';
import {
    HEALTH_META, HEALTH_ORDER, SORT_OPTIONS, STAGE_META, STAGE_ORDER, IMPORTANCIA_FILTRO,
    fmtHace, fmtIntervalo, fmtActualizado, fmtProxima, hoyAr, iniciales,
} from './clientesUi';

// CRM de clientes: quién compra, a qué ritmo, quién se está enfriando y en qué etapa
// del seguimiento está cada uno (fase 2). La pestaña Posibles clientes tiene los que
// todavía no están en Odoo. La pestaña Bot de seguimiento monitorea al bot de WhatsApp (Grok Bot).
// Las métricas salen de los tickets del POS de Neggo; las cotizaciones abiertas de los últimos
// 60 días, de Neggo y Preventas, aparecen como motivo para hablarle al cliente.

const PAGE = 50;
// Cliente · estado · etapa · última compra · compras · 12 meses · tendencia · cotización
const COLUMNAS = 'minmax(190px, 2fr) 118px 112px minmax(104px, 1fr) 64px 160px 72px minmax(104px, 1.1fr)';
// Medio: sin el gráfico de barras y con la tendencia abajo del monto de 12 meses
const COLUMNAS_MEDIO = 'minmax(170px, 2fr) 112px 96px minmax(92px, 1fr) 52px 104px minmax(88px, 1fr)';
// Ancho de la tabla (con la estrella) desde el que entra cada diseño; más angosto, tarjetas
const ANCHO_MIN = { ancho: 1110, medio: 860 };
// Alto mínimo de la lista con scroll propio: en pantallas muy bajas scrollea la página entera
const ALTO_MIN_LISTA = 240;

// Ancho disponible de un elemento, actualizado al cambiar la ventana o el menú lateral
function useAnchoDe(el) {
    const [ancho, setAncho] = useState(0);
    useEffect(() => {
        if (!el) return undefined;
        const ro = new ResizeObserver(([entry]) => setAncho(entry.contentRect.width));
        ro.observe(el);
        return () => ro.disconnect();
    }, [el]);
    return ancho;
}
const ETAPAS = [{ value: '', label: 'Todas las etapas' }, ...STAGE_ORDER.map((s) => ({ value: s, label: STAGE_META[s].label }))];
const SORTS = [...SORT_OPTIONS, { value: 'importancia', label: 'Más importantes' }, { value: 'accion', label: 'Próxima acción' }];

function Etapa({ c, t }) {
    const meta = STAGE_META[c.stage] || STAGE_META.frio;
    const proxima = fmtProxima(c.next_action_date);
    const vencida = c.next_action_date && c.next_action_date < hoyAr();
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
            <Badge tone={meta.tone}>{meta.label}</Badge>
            {proxima && (
                <span style={{ fontSize: t.font.size.xs, color: vencida ? t.color.danger : t.color.textMuted, ...t.numericStyle }}>
                    {proxima}
                </span>
            )}
        </div>
    );
}

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

// Fondo verde para los clientes con un contacto cargado: fuerte el mismo día y más claro
// a medida que pasan los días, hasta desaparecer a los DIAS_VERDE (así se ve con quién ya se habló)
const DIAS_VERDE = 14;
const VERDE_MAX = 24; // % de verde sobre el fondo el día del contacto
function fondoContacto(dias, t) {
    if (dias == null || dias >= DIAS_VERDE) return undefined;
    const pct = Math.round(VERDE_MAX * (1 - Math.max(dias, 0) / DIAS_VERDE));
    return `color-mix(in srgb, ${t.color.success} ${pct}%, ${t.color.surface})`;
}

// modo: ancho (todas las columnas) · medio (más compacta) · tarjeta (celular o pantalla angosta)
function FilaCliente({ c, onAbrir, onImportancia, modo, t }) {
    const isMobile = modo === 'tarjeta';
    const medio = modo === 'medio';
    const meta = HEALTH_META[c.health] || HEALTH_META.sin_compras;
    const cotizaciones = c.open_quotations || [];
    const totalCot = cotizaciones.reduce((s, q) => s + (Number(q.amount) || 0), 0);

    const nombre = (
        <div style={{ display: 'flex', alignItems: 'center', gap: t.space[3], minWidth: 0, flex: 1 }}>
            <Avatar nombre={c.partner_name} size={isMobile ? 40 : 28} t={t} />
            <div style={{ minWidth: 0 }}>
                <div style={{
                    fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.text,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: isMobile ? 'normal' : 'nowrap',
                }} title={c.partner_name}>
                    {c.partner_name}
                </div>
                <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0 8px' }}>
                    {/* En la tabla la importancia va en el mismo renglón que el teléfono (nota #223: filas más bajas) */}
                    {!isMobile && <Importancia value={c.importance} size={12} onChange={(n) => onImportancia(c, n)} />}
                    <span style={{ fontFamily: t.font.mono }}>{c.phone || 'Sin teléfono'}</span>
                    {c.city && <span>{c.city}</span>}
                    {c.rubro && <span>{c.rubro}</span>}
                </div>
                {isMobile && (
                    <div style={{ marginTop: 6 }}>
                        <Importancia value={c.importance} size={20} onChange={(n) => onImportancia(c, n)} />
                    </div>
                )}
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

    const compras = (
        <span style={{ fontSize: t.font.size.sm, color: c.purchase_count > 0 ? t.color.text : t.color.textFaint, ...t.numericStyle }}
            title="Compras en el POS de Neggo, en total">
            {fmtInt(c.purchase_count || 0)}
        </span>
    );

    const cotizacion = cotizaciones.length > 0 ? (
        <Badge tone="warn" style={{ ...t.numericStyle, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {cotizaciones.length === 1 ? cotizaciones[0].name : `${cotizaciones.length} cotiz.`} · {fmtAR(totalCot)}
        </Badge>
    ) : null;

    const estilosBoton = {
        width: '100%', boxSizing: 'border-box', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left',
        fontFamily: t.font.family, borderTop: `1px solid ${t.color.border}`,
    };
    // La fila es un div clickeable (no un <button>) porque adentro van los botones de importancia
    const hover = {
        role: 'button',
        tabIndex: 0,
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAbrir(c); } },
        onMouseEnter: (e) => { e.currentTarget.style.background = t.color.surface2; },
        onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
    };

    if (isMobile) {
        return (
            <div onClick={() => onAbrir(c)} {...hover}
                style={{ ...estilosBoton, padding: '12px', display: 'flex', flexDirection: 'column', gap: t.space[3] }}>
                <div style={{ display: 'flex', gap: t.space[3], alignItems: 'flex-start', width: '100%' }}>
                    {nombre}
                    <Badge tone={meta.tone} dot>{meta.label}</Badge>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: t.space[3], width: '100%' }}>
                    <div>
                        {ultima}
                        {c.purchase_count > 0 && (
                            <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: 2, ...t.numericStyle }}>
                                {fmtInt(c.purchase_count)} {c.purchase_count === 1 ? 'compra' : 'compras'} en total
                            </div>
                        )}
                    </div>
                    <div style={{ textAlign: 'right', fontSize: t.font.size.sm, ...t.numericStyle }}>
                        <div style={{ fontWeight: t.font.weight.semibold, color: t.color.text }}>{fmtAR(c.revenue_12m)}</div>
                        <Tendencia trend={c.trend} pct={c.trend_pct} t={t} />
                    </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: t.space[3], width: '100%' }}>
                    <Etapa c={c} t={t} />
                    {cotizacion}
                </div>
            </div>
        );
    }

    return (
        <div onClick={() => onAbrir(c)} {...hover}
            style={{
                ...estilosBoton, padding: '6px 16px', display: 'grid', alignItems: 'center', gap: medio ? t.space[3] : t.space[4],
                gridTemplateColumns: medio ? COLUMNAS_MEDIO : COLUMNAS,
            }}>
            {nombre}
            <span><Badge tone={meta.tone} dot>{meta.label}</Badge></span>
            <Etapa c={c} t={t} />
            {ultima}
            <span style={{ textAlign: 'right' }}>{compras}</span>
            {medio ? (
                <div style={{ textAlign: 'right', fontSize: t.font.size.sm, ...t.numericStyle }}>
                    <div style={{ fontWeight: t.font.weight.semibold, color: t.color.text }}>{fmtAR(c.revenue_12m)}</div>
                    <Tendencia trend={c.trend} pct={c.trend_pct} t={t} />
                </div>
            ) : (
            <>
            <div style={{ display: 'flex', alignItems: 'center', gap: t.space[3], justifyContent: 'flex-end' }}>
                <BarrasMensuales data={c.monthly_revenue || []} compacto />
                <span style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.text, minWidth: 84, textAlign: 'right', ...t.numericStyle }}>
                    {fmtAR(c.revenue_12m)}
                </span>
            </div>
            <span style={{ fontSize: t.font.size.sm, textAlign: 'right' }}><Tendencia trend={c.trend} pct={c.trend_pct} t={t} /></span>
            </>
            )}
            <span style={{ textAlign: 'right', minWidth: 0 }}>{cotizacion}</span>
        </div>
    );
}

// Estrella a la izquierda de la fila: suma o saca al cliente de la lista de seguimiento cercano
function BotonCercano({ c, onToggle, modo, t }) {
    const isMobile = modo === 'tarjeta';
    const activo = Boolean(c.cercano);
    const texto = activo ? 'Sacar de seguimiento cercano' : 'Sumar a seguimiento cercano';
    return (
        <button type="button" onClick={() => onToggle(c)} aria-pressed={activo} aria-label={texto} title={texto}
            style={{
                width: 40, flexShrink: 0, border: 'none', borderTop: `1px solid ${t.color.border}`,
                background: 'transparent', cursor: 'pointer', padding: isMobile ? '14px 0 0 8px' : '0 0 0 8px',
                display: 'flex', alignItems: isMobile ? 'flex-start' : 'center', justifyContent: 'center',
                color: activo ? t.color.warn : t.color.textFaint,
            }}>
            <Icon.Star size={18} filled={activo} />
        </button>
    );
}

// En modo "Elegir varios" la estrella cede su lugar a una casilla
function CasillaElegir({ c, elegido, onToggle, modo, t }) {
    const isMobile = modo === 'tarjeta';
    return (
        <label title={elegido ? 'Quitar de los elegidos' : 'Elegir'}
            style={{
                width: 40, flexShrink: 0, boxSizing: 'border-box', borderTop: `1px solid ${t.color.border}`, cursor: 'pointer',
                padding: isMobile ? '14px 0 0 8px' : '0 0 0 8px',
                display: 'flex', alignItems: isMobile ? 'flex-start' : 'center', justifyContent: 'center',
            }}>
            <input type="checkbox" checked={elegido} onChange={() => onToggle(c)} aria-label={`Elegir a ${c.partner_name}`}
                style={{ width: 18, height: 18, margin: 0, cursor: 'pointer', accentColor: t.color.primary }} />
        </label>
    );
}

// Encabezado de columna que ordena la lista; tocarlo de nuevo vuelve a la prioridad para llamar
function Encabezado({ children, valor, sort, onSort, align = 'left', title, t }) {
    const activo = sort === valor;
    return (
        <button type="button" onClick={() => onSort(activo ? 'prioridad' : valor)} aria-pressed={activo}
            title={title ? `${title}. Tocá para ordenar` : 'Tocá para ordenar'}
            style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, justifySelf: align === 'right' ? 'end' : 'start',
                padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: t.font.family,
                fontSize: 'inherit', fontWeight: 'inherit', textTransform: 'inherit', letterSpacing: 'inherit',
                color: activo ? t.color.primary : 'inherit', textAlign: align,
            }}>
            {children}
            {activo && <Icon.ChevronDown size={12} />}
        </button>
    );
}

function ChipEstado({ valor, cantidad, activo, onClick, isMobile, t }) {
    const meta = HEALTH_META[valor];
    const tones = {
        success: t.color.success, primary: t.color.primary, warn: t.color.warn,
        danger: t.color.danger, muted: t.color.textMuted,
    };
    // En compu, un solo renglón (punto · estado · cantidad) para que la lista entre sin scrollear (nota #223)
    return (
        <button type="button" onClick={onClick} aria-pressed={activo} title={meta.hint}
            style={{
                display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: isMobile ? 'flex-start' : 'center',
                justifyContent: 'space-between', gap: isMobile ? 4 : 8,
                padding: isMobile ? '10px 12px' : '6px 12px', minWidth: isMobile ? 0 : 120, flex: isMobile ? '1 1 40%' : '1 1 0',
                borderRadius: t.radius.md, cursor: 'pointer', textAlign: 'left', fontFamily: t.font.family,
                border: `1px solid ${activo ? t.color.primary : t.color.border}`,
                background: activo ? t.color.primarySoft : t.color.surface,
                boxShadow: t.shadow.card,
            }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: t.font.size.xs, color: t.color.textMuted, whiteSpace: 'nowrap' }}>
                <span style={{ width: 8, height: 8, borderRadius: t.radius.full, background: tones[meta.tone] }} />
                {meta.label}
            </span>
            <span style={{ fontSize: isMobile ? t.font.size.xl : t.font.size.lg, fontWeight: t.font.weight.semibold, color: t.color.text, letterSpacing: '-0.02em', ...t.numericStyle }}>
                {fmtInt(cantidad)}
            </span>
        </button>
    );
}

export default function Clientes() {
    const { tokens: t } = useTheme();
    const isMobile = useIsMobile();
    const { showToast } = useToast();
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
    const [rubro, setRubro] = useState('');
    const [health, setHealth] = useState('');
    const [stage, setStage] = useState('');
    const [importancia, setImportancia] = useState('');
    const [tab, setTab] = useState('chats');
    const [leadsTotal, setLeadsTotal] = useState(null);
    const huboCambios = useRef(false);
    const [soloAbiertas, setSoloAbiertas] = useState(false);
    const [soloCercanos, setSoloCercanos] = useState(false);
    const [sort, setSort] = useState('prioridad');
    // Elegir varios clientes para ponerles la misma importancia (nota #75)
    const [eligiendo, setEligiendo] = useState(false);
    const [elegidos, setElegidos] = useState(() => new Set());
    const [aplicando, setAplicando] = useState(false);
    const pollRef = useRef(null);

    // La tabla se arma según el ancho que tiene (cambia con la ventana y con el menú lateral)
    const [tablaEl, setTablaEl] = useState(null);
    const anchoTabla = useAnchoDe(tablaEl);
    const modo = isMobile || anchoTabla < ANCHO_MIN.medio ? 'tarjeta'
        : anchoTabla < ANCHO_MIN.ancho ? 'medio' : 'ancho';

    // Espera 300 ms después de tipear antes de buscar
    useEffect(() => {
        const id = setTimeout(() => setBusqueda(search.trim()), 300);
        return () => clearTimeout(id);
    }, [search]);

    const filtros = useCallback((offset) => ({
        search: busqueda || undefined,
        city: city || undefined,
        rubro: rubro || undefined,
        health: health || undefined,
        stage: stage || undefined,
        open: soloAbiertas ? 1 : undefined,
        cercanos: soloCercanos ? 1 : undefined,
        importancia: importancia || undefined,
        sort,
        limit: PAGE,
        offset,
    }), [busqueda, city, rubro, health, stage, importancia, soloAbiertas, soloCercanos, sort]);

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
        // Con otros filtros u otro orden, la elección arranca de cero: nada elegido fuera de la vista
        setElegidos(new Set());
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

    // Cantidad de prospectos con y sin chat de WhatsApp para las pestañas
    const cargarContadoresLeads = useCallback(() => {
        api.get('/clientes/leads/resumen').then((res) => { if (res.success) setLeadsTotal(res.data.whatsapp || null); });
    }, []);
    useEffect(() => { cargarContadoresLeads(); }, [cargarContadoresLeads]);

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
    const rubros = [{ value: '', label: 'Todos los rubros' },
        ...(resumen?.rubros || []).map((r) => ({ value: r.rubro, label: `${r.rubro} · ${r.n}` }))];

    const variacion90 = resumen && resumen.revenue_prev_90d > 0
        ? Math.round(((resumen.revenue_90d - resumen.revenue_prev_90d) / resumen.revenue_prev_90d) * 100)
        : null;

    const filtrosActivos = busqueda || city || rubro || health || stage || importancia || soloAbiertas || soloCercanos;
    const limpiar = () => { setSearch(''); setCity(''); setRubro(''); setHealth(''); setStage(''); setImportancia(''); setSoloAbiertas(false); setSoloCercanos(false); };

    // Estrella: se ve al instante y vuelve atrás si el backend no lo guarda.
    // Si se saca uno con el filtro puesto, queda en pantalla para poder deshacerlo.
    const toggleCercano = async (c) => {
        const cercano = !c.cercano;
        const aplicar = (valor) => {
            setRows((prev) => prev.map((r) => (r.odoo_partner_id === c.odoo_partner_id ? { ...r, cercano: valor } : r)));
            setResumen((prev) => (prev ? { ...prev, cercanos: Math.max(0, (prev.cercanos || 0) + (valor ? 1 : -1)) } : prev));
        };
        aplicar(cercano);
        const res = await api.put(`/clientes/cercanos/${c.odoo_partner_id}`, { cercano });
        if (!res.success) {
            aplicar(!cercano);
            setError(res.error || 'No se pudo cambiar la lista de seguimiento cercano');
        }
    };

    // Cambia la importancia desde la fila: se ve al instante y vuelve atrás si falla
    const cambiarImportancia = async (c, n) => {
        const antes = c.importance || 0;
        const poner = (valor) => setRows((prev) => prev.map((r) => (r.odoo_partner_id === c.odoo_partner_id ? { ...r, importance: valor } : r)));
        poner(n);
        const res = await api.put(`/clientes/seguimiento/cliente/${c.odoo_partner_id}/importancia`, { importance: n });
        if (!res.success) {
            poner(antes);
            showToast(res.error || 'No se pudo cambiar la importancia', 'error');
        }
    };

    const toggleElegido = (c) => setElegidos((prev) => {
        const sig = new Set(prev);
        if (sig.has(c.odoo_partner_id)) sig.delete(c.odoo_partner_id); else sig.add(c.odoo_partner_id);
        return sig;
    });
    const todosElegidos = rows.length > 0 && rows.every((r) => elegidos.has(r.odoo_partner_id));
    const elegirTodos = () => setElegidos(todosElegidos ? new Set() : new Set(rows.map((r) => r.odoo_partner_id)));
    const salirDeElegir = () => { setEligiendo(false); setElegidos(new Set()); };

    // La misma importancia a todos los elegidos; la lista se actualiza sin recargar
    const importanciaAElegidos = async (n) => {
        const ids = [...elegidos];
        if (!ids.length || aplicando) return;
        setAplicando(true);
        const res = await api.put('/clientes/importancia', { partner_ids: ids, importance: n });
        setAplicando(false);
        if (!res.success) { showToast(res.error || 'No se pudo cambiar la importancia', 'error'); return; }
        setRows((prev) => prev.map((r) => (elegidos.has(r.odoo_partner_id) ? { ...r, importance: n } : r)));
        const cuantos = res.data?.updated ?? ids.length;
        showToast(n
            ? `Importancia ${n} para ${fmtInt(cuantos)} ${cuantos === 1 ? 'cliente' : 'clientes'}`
            : `Sin importancia para ${fmtInt(cuantos)} ${cuantos === 1 ? 'cliente' : 'clientes'}`, 'success');
        salirDeElegir();
    };

    // ── Vista compacta en compu (nota #223): todo entra en la pantalla y la lista scrollea por dentro ──
    const compu = !isMobile;

    const resumenNumeros = resumen ? (
        <div style={{
            display: 'flex', gap: isMobile ? t.space[3] : `0 ${t.space[8]}px`, flexWrap: 'wrap',
            fontSize: compu ? t.font.size.xs : t.font.size.sm, color: t.color.textMuted,
            marginBottom: compu ? 0 : t.space[4], ...t.numericStyle,
        }}>
            <span title="Incluye las ventas a Consumidor Final">
                Facturación 90 días: <strong style={{ color: t.color.text }}>{fmtAR(resumen.revenue_90d)}</strong>
                {variacion90 != null && (
                    <span style={{ color: variacion90 >= 0 ? t.color.success : t.color.danger, marginLeft: 6 }}>
                        {variacion90 > 0 ? '+' : ''}{variacion90}%{compu ? '' : ' vs. 90 días anteriores'}
                    </span>
                )}
            </span>
            <span>Nuevos este mes: <strong style={{ color: t.color.text }}>{fmtInt(resumen.nuevos_mes)}</strong></span>
            <span title="Cotizaciones abiertas de los últimos 60 días: una excusa para hablarle">Con cotización reciente: <strong style={{ color: t.color.text }}>{fmtInt(resumen.con_cotizacion)}</strong></span>
        </div>
    ) : null;

    const estiloInterruptor = { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: t.font.size.sm, color: t.color.text, cursor: 'pointer', whiteSpace: 'nowrap' };
    const interruptores = (
        <>
            <label style={estiloInterruptor} title="Clientes con una cotización abierta de los últimos 60 días">
                <Toggle checked={soloAbiertas} onChange={setSoloAbiertas} />
                {compu ? 'Con cotización' : 'Solo con cotización reciente'}
            </label>
            <label style={estiloInterruptor} title="Los clientes que marcaste con la estrella">
                <Toggle checked={soloCercanos} onChange={setSoloCercanos} />
                <Icon.Star size={14} filled color={t.color.warn} />
                <span style={t.numericStyle}>{compu ? 'Cercanos' : 'Seguimiento cercano'} · {fmtInt(resumen?.cercanos ?? 0)}</span>
            </label>
        </>
    );

    const botonElegir = !eligiendo ? (
        <Button variant="secondary" size="sm" leftIcon={<Icon.Check size={14} />} onClick={() => setEligiendo(true)}
            title="Elegí varios clientes para ponerles la misma importancia">
            Elegir varios
        </Button>
    ) : null;

    // Alto de la lista: lo que queda del <main> debajo de los filtros, menos el pie de la tabla.
    // Se mide en cada render (cambian filtros, avisos, la barra de Elegir varios) y al cambiar la ventana.
    const [listaEl, setListaEl] = useState(null);
    const pieRef = useRef(null);
    const [altoLista, setAltoLista] = useState(null);
    const medirLista = useCallback(() => {
        const main = listaEl?.closest('[data-app-main]');
        if (!compu || !main) { setAltoLista(null); return; }
        const top = listaEl.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
        const padAbajo = parseFloat(getComputedStyle(main).paddingBottom) || 0;
        const pie = pieRef.current?.offsetHeight || 0;
        // 2 px: borde de la tarjeta
        const alto = Math.max(ALTO_MIN_LISTA, Math.floor(main.clientHeight - top - pie - padAbajo - 2));
        setAltoLista((prev) => (prev === alto ? prev : alto));
    }, [listaEl, compu]);
    useLayoutEffect(() => { medirLista(); });
    useEffect(() => {
        window.addEventListener('resize', medirLista);
        return () => window.removeEventListener('resize', medirLista);
    }, [medirLista]);

    // Lo que se cambia en la ficha (etapa, acciones) se ve en la lista al cerrarla
    const cerrarFicha = () => {
        setAbierto(null);
        if (huboCambios.current) { huboCambios.current = false; cargarLista(); }
    };

    return (
        // En compu el <main> del layout ya da el margen: sin padding propio, para ganar alto (nota #223)
        <div style={{ padding: isMobile ? 12 : 0, maxWidth: 1240, margin: '0 auto', fontFamily: t.font.family }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: compu ? t.space[2] : 12, marginBottom: compu ? t.space[2] : 16 }}>
                <div style={{ minWidth: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: compu ? `0 ${t.space[6]}px` : 0 }}>
                    <h1 title="Cada cliente medido contra su propio ritmo de compra en el punto de venta de Neggo"
                        style={{ margin: 0, fontSize: isMobile ? 22 : t.font.size.xl, fontWeight: t.font.weight.semibold, color: t.color.text, letterSpacing: '-0.02em' }}>
                        Clientes
                    </h1>
                    {isMobile && (
                        <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 4, width: '100%' }}>
                            Cada cliente medido contra su propio ritmo de compra en el punto de venta de Neggo.
                        </div>
                    )}
                    {compu && resumenNumeros}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: t.space[3], flexWrap: 'wrap' }}>
                    <span style={{ fontSize: t.font.size.xs, color: t.color.textFaint }}>
                        {sincronizando ? 'Leyendo Odoo…' : fmtActualizado(resumen?.synced_at)}
                    </span>
                    {compu && tab === 'clientes' && botonElegir}
                    <Button variant="secondary" size={compu ? 'sm' : undefined} leftIcon={<Icon.Refresh size={compu ? 14 : 16} />} disabled={sincronizando} onClick={actualizar}>
                        {sincronizando ? 'Actualizando…' : 'Actualizar'}
                    </Button>
                </div>
            </div>

            <Tabs
                scrollable
                value={tab}
                onChange={setTab}
                style={{ marginBottom: compu ? t.space[3] : t.space[6] }}
                tabs={[
                    { value: 'chats', label: 'Chats', icon: <Icon.MessageCircle size={16} /> },
                    { value: 'clientes', label: 'Clientes', icon: <Icon.Users size={16} />, count: resumen?.total_clientes ?? null },
                    { value: 'contactos', label: 'Contactos', icon: <Icon.MessageCircle size={16} /> },
                    { value: 'leads_chat', label: 'Prospectos con WhatsApp', icon: <Icon.MessageCircle size={16} />, count: leadsTotal?.con_whatsapp ?? null },
                    { value: 'leads', label: 'Prospectos sin chat', icon: <Icon.Plus size={16} />, count: leadsTotal?.sin_whatsapp ?? null },
                    { value: 'respuestas', label: 'Preguntas frecuentes', icon: <Icon.BookOpen size={16} /> },
                    { value: 'bot', label: 'Bot de seguimiento', icon: <Icon.Bot size={16} /> },
                    { value: 'bot_leads', label: 'Bot de leads', icon: <Icon.MessageCircle size={16} /> },
                ]}
            />

            {tab === 'chats' ? (
                <Chats />
            ) : tab === 'contactos' ? (
                <Contactos onCambio={cargarContadoresLeads} />
            ) : tab === 'leads_chat' ? (
                <EmbudoWhatsapp onCambio={cargarContadoresLeads} />
            ) : tab === 'leads' ? (
                <PosiblesClientes whatsapp="sin" onResumen={(r) => setLeadsTotal(r.whatsapp || null)} />
            ) : tab === 'respuestas' ? (
                <RespuestasFrecuentes />
            ) : tab === 'bot_leads' ? (
                <BotLeads />
            ) : tab === 'bot' ? (
                <BotSeguimiento />
            ) : (
            <>

            {/* En compu: estados en una tira de una línea, con los dos interruptores al final (nota #223) */}
            <div style={{ display: 'flex', gap: compu ? t.space[2] : t.space[3], flexWrap: 'wrap', alignItems: 'center', marginBottom: compu ? t.space[2] : t.space[4] }}>
                {HEALTH_ORDER.map((h) => (
                    <ChipEstado key={h} valor={h} cantidad={resumen?.health?.[h] ?? 0} activo={health === h}
                        onClick={() => setHealth(health === h ? '' : h)} isMobile={isMobile} t={t} />
                ))}
                {compu && interruptores}
            </div>

            {!compu && resumenNumeros}

            <Card padding={false} style={{
                padding: compu ? 0 : 14, display: 'flex', gap: compu ? t.space[2] : 10, flexWrap: 'wrap', alignItems: 'center',
                marginBottom: compu ? t.space[2] : t.space[4],
                ...(compu ? { border: 'none', background: 'transparent', boxShadow: 'none' } : null),
            }}>
                <div style={{ flex: compu ? '1 1 170px' : '1 1 280px' }}>
                    <Input
                        leftIcon={<Icon.Search size={16} />}
                        placeholder="Buscá por nombre o teléfono…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        aria-label="Buscar cliente"
                    />
                </div>
                <Select value={city} onChange={setCity} options={ciudades} placeholder="Ciudad" style={{ width: isMobile ? '100%' : compu ? 150 : 200 }} />
                <Select value={rubro} onChange={setRubro} options={rubros} placeholder="Rubro" style={{ width: isMobile ? '100%' : compu ? 150 : 200 }} />
                <Select value={stage} onChange={setStage} options={ETAPAS} placeholder="Etapa" style={{ width: isMobile ? '100%' : compu ? 140 : 170 }} />
                <Select value={importancia} onChange={setImportancia} options={IMPORTANCIA_FILTRO} placeholder="Importancia" style={{ width: isMobile ? '100%' : compu ? 170 : 200 }} />
                <Select value={sort} onChange={setSort} options={SORTS} style={{ width: isMobile ? '100%' : compu ? 180 : 210 }} />
                {!compu && interruptores}
                {filtrosActivos && (
                    <Button variant="ghost" size="sm" leftIcon={<Icon.X size={14} />} onClick={limpiar}>Limpiar filtros</Button>
                )}
                {!compu && botonElegir}
            </Card>

            {eligiendo && (
                <Card padding={false} style={{
                    padding: '10px 14px', display: 'flex', gap: t.space[4], flexWrap: 'wrap', alignItems: 'center',
                    marginBottom: t.space[4], border: `1px solid ${t.color.primary}`, background: t.color.primarySoft,
                }}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: t.font.size.sm, color: t.color.text, cursor: 'pointer', ...t.numericStyle }}>
                        <input type="checkbox" checked={todosElegidos} onChange={elegirTodos} disabled={!rows.length}
                            style={{ width: 18, height: 18, margin: 0, cursor: 'pointer', accentColor: t.color.primary }} />
                        <span>
                            <strong>{fmtInt(elegidos.size)}</strong> {elegidos.size === 1 ? 'elegido' : 'elegidos'}
                            <span style={{ color: t.color.textMuted }}> · {todosElegidos ? 'quitar todos' : `elegir los ${fmtInt(rows.length)} que se ven`}</span>
                        </span>
                    </label>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: t.space[3], fontSize: t.font.size.sm, color: elegidos.size ? t.color.text : t.color.textFaint }}>
                        Ponerles importancia
                        <Importancia value={0} size={isMobile ? 22 : 18} disabled={!elegidos.size || aplicando} onChange={importanciaAElegidos} />
                        <Button variant="ghost" size="sm" disabled={!elegidos.size || aplicando} onClick={() => importanciaAElegidos(0)}>
                            Sin importancia
                        </Button>
                    </div>
                    <div style={{ marginLeft: 'auto' }}>
                        <Button variant="secondary" size="sm" leftIcon={<Icon.X size={14} />} onClick={salirDeElegir}>
                            Terminar
                        </Button>
                    </div>
                </Card>
            )}

            {error && (
                <div role="alert" style={{
                    marginBottom: t.space[4], padding: '10px 14px', borderRadius: t.radius.md,
                    background: t.color.dangerSoft, color: t.color.danger, fontSize: t.font.size.sm,
                }}>
                    {error}
                </div>
            )}

            <div ref={setTablaEl}>
            <Card padding={false} style={{ overflow: 'hidden' }}>
                {/* En compu la lista scrollea por dentro con el encabezado fijo arriba (nota #223) */}
                <div ref={setListaEl} style={altoLista ? { maxHeight: altoLista, overflowY: 'auto' } : undefined}>
                {modo !== 'tarjeta' && (
                    <div style={{
                        position: 'sticky', top: 0, zIndex: 1,
                        display: 'grid', gap: modo === 'medio' ? t.space[3] : t.space[4], padding: '8px 16px 8px 56px', background: t.color.surface2,
                        gridTemplateColumns: modo === 'medio' ? COLUMNAS_MEDIO : COLUMNAS,
                        fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, color: t.color.textMuted,
                        textTransform: 'uppercase', letterSpacing: '0.04em',
                    }}>
                        <Encabezado valor="nombre" sort={sort} onSort={setSort} t={t}>Cliente</Encabezado>
                        <span>Estado</span>
                        <span>Etapa</span>
                        <Encabezado valor="ultima" sort={sort} onSort={setSort} title="Compra más reciente primero" t={t}>Última compra</Encabezado>
                        <Encabezado valor="compras" sort={sort} onSort={setSort} align="right" title="Más compras primero" t={t}>Compras</Encabezado>
                        {modo === 'medio' ? (
                            <Encabezado valor="facturacion" sort={sort} onSort={setSort} align="right" title="Facturación de los últimos 12 meses y tendencia" t={t}>12 meses</Encabezado>
                        ) : (
                            <>
                                <Encabezado valor="facturacion" sort={sort} onSort={setSort} align="right" title="Más facturación de los últimos 12 meses primero" t={t}>Últimos 12 meses</Encabezado>
                                <span style={{ textAlign: 'right' }}>Tendencia</span>
                            </>
                        )}
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
                            {soloCercanos && !resumen?.cercanos
                                ? 'Todavía no hay clientes en seguimiento cercano'
                                : resumen?.synced_at ? 'No hay clientes con estos filtros' : 'Todavía no hay datos de clientes'}
                        </div>
                        <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 4 }}>
                            {soloCercanos && !resumen?.cercanos
                                ? 'Sacá este filtro y tocá la estrella al lado de cada cliente que quieras seguir de cerca.'
                                : resumen?.synced_at
                                ? 'Probá con otra búsqueda o sacá algún filtro.'
                                : 'Tocá «Actualizar» para leer los tickets del POS desde Odoo.'}
                        </div>
                    </div>
                ) : (
                    rows.map((c) => {
                        const elegido = elegidos.has(c.odoo_partner_id);
                        return (
                            <div key={c.odoo_partner_id}
                                title={c.days_since_contact != null && c.days_since_contact < DIAS_VERDE
                                    ? `Último contacto: ${fmtHace(Math.floor(c.days_since_contact)).toLowerCase()}` : undefined}
                                style={{ display: 'flex', alignItems: 'stretch', background: elegido ? t.color.primarySoft : fondoContacto(c.days_since_contact, t) }}>
                                {eligiendo
                                    ? <CasillaElegir c={c} elegido={elegido} onToggle={toggleElegido} modo={modo} t={t} />
                                    : <BotonCercano c={c} onToggle={toggleCercano} modo={modo} t={t} />}
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <FilaCliente c={c} onAbrir={eligiendo ? toggleElegido : setAbierto} onImportancia={cambiarImportancia} modo={modo} t={t} />
                                </div>
                            </div>
                        );
                    })
                )}
                </div>

                {!loading && rows.length > 0 && (
                    <div ref={pieRef} style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: t.space[3], flexWrap: 'wrap',
                        padding: compu ? '6px 16px' : '10px 16px', borderTop: `1px solid ${t.color.border}`, background: t.color.surface2,
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
            </div>

            <ClienteFicha partnerId={abierto?.odoo_partner_id} resumen={abierto} onClose={cerrarFicha}
                onCambio={() => { huboCambios.current = true; }} />
            </>
            )}
        </div>
    );
}
