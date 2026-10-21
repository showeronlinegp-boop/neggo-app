import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { useToast } from '../../context/ToastContext';
import { fmtInt } from '../../theme/tokens';
import useIsMobile from '../../hooks/useIsMobile';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Select from '../../components/common/Select';
import Modal from '../../components/common/Modal';
import * as Icon from '../../components/common/icons';
import LeadFicha from './LeadFicha';
import {
    STAGE_META, STAGE_ORDER, SOURCE_STATUS_META, SOURCE_STATUS_ORDER,
    fmtProxima, iniciales, hoyAr,
} from './clientesUi';

// Posibles clientes (D11): contactos con celular o mail que todavía no están en Odoo.
// Cuando compran y aparecen en Odoo con el mismo teléfono, pasan solos a Clientes.

const PAGE = 50;
const SORTS = [
    { value: 'accion', label: 'Próxima acción' },
    { value: 'recientes', label: 'Cargados más recientes' },
    { value: 'nombre', label: 'Nombre' },
];
// Posible cliente · origen · etapa · próxima acción
const COLUMNAS = 'minmax(220px, 2fr) minmax(120px, 1fr) 110px minmax(130px, 1fr)';

function NuevoLead({ abierto, onClose, onCreado, t }) {
    const { showToast } = useToast();
    const [form, setForm] = useState({ name: '', phone: '', email: '', city: '' });
    const [error, setError] = useState(null);
    const [guardando, setGuardando] = useState(false);
    const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

    useEffect(() => {
        if (abierto) { setForm({ name: '', phone: '', email: '', city: '' }); setError(null); }
    }, [abierto]);

    const guardar = async () => {
        setGuardando(true);
        setError(null);
        const res = await api.post('/clientes/leads', form);
        setGuardando(false);
        if (!res.success) { setError(res.error || 'No se pudo guardar'); return; }
        showToast('Posible cliente cargado', 'success');
        onCreado(res.data.id);
    };

    const campo = (label, k, props = {}) => (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: t.font.size.sm, color: t.color.text }}>
            {label}
            <Input value={form[k]} onChange={set(k)} {...props} />
        </label>
    );

    return (
        <Modal isOpen={abierto} onClose={onClose} title="Nuevo posible cliente" subtitle="Hace falta un celular o un mail para poder contactarlo."
            width={460}
            footer={(
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: t.space[2], flex: 1 }}>
                    <Button variant="ghost" onClick={onClose}>Cancelar</Button>
                    <Button variant="primary" disabled={guardando || !form.name.trim() || (!form.phone.trim() && !form.email.trim())} onClick={guardar}>
                        {guardando ? 'Guardando…' : 'Guardar'}
                    </Button>
                </div>
            )}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[4], fontFamily: t.font.family }}>
                {campo('Nombre', 'name', { placeholder: 'Ej: Librería El Sol', autoFocus: true })}
                {campo('Celular', 'phone', { placeholder: 'Ej: 2477 51-9062', inputMode: 'tel' })}
                {campo('Mail', 'email', { placeholder: 'Ej: libreria@gmail.com', type: 'email' })}
                {campo('Ciudad', 'city', { placeholder: 'Ej: Pergamino' })}
                {error && <div role="alert" style={{ fontSize: t.font.size.sm, color: t.color.danger }}>{error}</div>}
            </div>
        </Modal>
    );
}

function FilaLead({ l, onAbrir, isMobile, t }) {
    const etapa = STAGE_META[l.stage] || STAGE_META.frio;
    const origen = SOURCE_STATUS_META[l.source_status || 'sin_estado'];
    const proxima = fmtProxima(l.next_action_date);
    const vencida = l.next_action_date && l.next_action_date < hoyAr();
    const hover = {
        onMouseEnter: (e) => { e.currentTarget.style.background = t.color.surface2; },
        onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
    };
    const nombre = (
        <div style={{ display: 'flex', alignItems: 'center', gap: t.space[3], minWidth: 0, flex: 1 }}>
            <span aria-hidden="true" style={{
                width: 36, height: 36, borderRadius: t.radius.sm, flexShrink: 0,
                background: t.color.accentSoft, color: t.color.accent,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold,
            }}>
                {l.name ? iniciales(l.name) : '?'}
            </span>
            <div style={{ minWidth: 0 }}>
                <div style={{
                    fontSize: t.font.size.sm, fontWeight: t.font.weight.medium,
                    color: l.name ? t.color.text : t.color.textMuted,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                    {l.name || 'Sin nombre en la agenda'}
                </div>
                <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, display: 'flex', flexWrap: 'wrap', gap: '0 8px' }}>
                    <span style={{ fontFamily: t.font.mono }}>{l.phone || l.email}</span>
                    {l.city && <span>{l.city}</span>}
                </div>
            </div>
        </div>
    );
    const origenBadge = (
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <Badge tone={origen.tone}>{origen.label}</Badge>
            {l.source_list && <span style={{ fontSize: t.font.size.xs, color: t.color.textFaint, fontFamily: t.font.mono }}>{l.source_list}</span>}
        </span>
    );
    const accion = (
        <span style={{ fontSize: t.font.size.sm, color: vencida ? t.color.danger : proxima ? t.color.text : t.color.textFaint, ...t.numericStyle }}>
            {proxima || 'Sin programar'}
        </span>
    );
    const estilos = {
        width: '100%', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left',
        fontFamily: t.font.family, borderTop: `1px solid ${t.color.border}`,
    };
    if (isMobile) {
        return (
            <button type="button" onClick={() => onAbrir(l)} {...hover}
                style={{ ...estilos, padding: 12, display: 'flex', flexDirection: 'column', gap: t.space[3] }}>
                <div style={{ display: 'flex', gap: t.space[3], width: '100%', alignItems: 'flex-start' }}>
                    {nombre}
                    <Badge tone={etapa.tone} dot>{etapa.label}</Badge>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', gap: t.space[3] }}>
                    {origenBadge}
                    {accion}
                </div>
            </button>
        );
    }
    return (
        <button type="button" onClick={() => onAbrir(l)} {...hover}
            style={{ ...estilos, padding: '10px 16px', display: 'grid', gridTemplateColumns: COLUMNAS, gap: t.space[4], alignItems: 'center' }}>
            {nombre}
            {origenBadge}
            <span><Badge tone={etapa.tone} dot>{etapa.label}</Badge></span>
            {accion}
        </button>
    );
}

export default function PosiblesClientes({ onResumen }) {
    const { tokens: t } = useTheme();
    const isMobile = useIsMobile();
    const [resumen, setResumen] = useState(null);
    const [rows, setRows] = useState([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [cargandoMas, setCargandoMas] = useState(false);
    const [error, setError] = useState(null);
    const [search, setSearch] = useState('');
    const [busqueda, setBusqueda] = useState('');
    const [status, setStatus] = useState('');
    const [stage, setStage] = useState('');
    const [city, setCity] = useState('');
    const [sort, setSort] = useState('accion');
    const [abierto, setAbierto] = useState(null);
    const [nuevo, setNuevo] = useState(false);

    useEffect(() => {
        const id = setTimeout(() => setBusqueda(search.trim()), 300);
        return () => clearTimeout(id);
    }, [search]);

    const filtros = useCallback((offset) => ({
        search: busqueda || undefined, status: status || undefined, stage: stage || undefined,
        city: city || undefined, sort, limit: PAGE, offset,
    }), [busqueda, status, stage, city, sort]);

    const cargarResumen = useCallback(async () => {
        const res = await api.get('/clientes/leads/resumen');
        if (res.success) { setResumen(res.data); onResumen?.(res.data); }
    }, [onResumen]);

    const cargarLista = useCallback(async () => {
        setLoading(true);
        setError(null);
        const res = await api.get('/clientes/leads', filtros(0));
        setLoading(false);
        if (!res.success) { setError(res.error || 'No se pudo cargar la lista'); return; }
        setRows(res.data || []);
        setTotal(res.pagination?.total ?? (res.data || []).length);
    }, [filtros]);

    useEffect(() => { cargarLista(); }, [cargarLista]);
    useEffect(() => { cargarResumen(); }, [cargarResumen]);

    const verMas = async () => {
        setCargandoMas(true);
        const res = await api.get('/clientes/leads', filtros(rows.length));
        setCargandoMas(false);
        if (!res.success) { setError(res.error || 'No se pudieron cargar más'); return; }
        setRows((prev) => [...prev, ...(res.data || [])]);
    };

    const refrescar = () => { cargarLista(); cargarResumen(); };
    // Lo que se cambia en la ficha se ve en la lista al cerrarla
    const huboCambios = useRef(false);
    const cerrarFicha = () => {
        setAbierto(null);
        if (huboCambios.current) { huboCambios.current = false; refrescar(); }
    };

    const estados = [{ value: '', label: 'Todos los estados de la agenda' },
        ...SOURCE_STATUS_ORDER.filter((k) => resumen?.status?.[k]).map((k) => ({
            value: k, label: `${SOURCE_STATUS_META[k].label} · ${fmtInt(resumen.status[k])}`,
        }))];
    const ciudades = [{ value: '', label: 'Todas las ciudades' },
        ...(resumen?.cities || []).map((c) => ({ value: c.city, label: `${c.city} · ${c.n}` }))];
    const filtrosActivos = busqueda || status || stage || city;

    return (
        <div>
            <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap', marginBottom: t.space[4] }}>
                {STAGE_ORDER.map((s) => {
                    const activo = stage === s;
                    return (
                        <button key={s} type="button" aria-pressed={activo} onClick={() => setStage(activo ? '' : s)}
                            style={{
                                display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 14px',
                                borderRadius: t.radius.md, cursor: 'pointer', fontFamily: t.font.family, fontSize: t.font.size.sm,
                                border: `1px solid ${activo ? t.color.primary : t.color.border}`,
                                background: activo ? t.color.primarySoft : t.color.surface, color: t.color.text,
                                boxShadow: t.shadow.card,
                            }}>
                            {STAGE_META[s].label}
                            <strong style={t.numericStyle}>{fmtInt(resumen?.stages?.[s] || 0)}</strong>
                        </button>
                    );
                })}
                <div style={{ flex: 1 }} />
                <Button variant="primary" leftIcon={<Icon.Plus size={16} />} onClick={() => setNuevo(true)}>Agregar posible cliente</Button>
            </div>

            <Card padding={false} style={{ padding: 14, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: t.space[4] }}>
                <div style={{ flex: '1 1 260px' }}>
                    <Input leftIcon={<Icon.Search size={16} />} placeholder="Buscá por nombre, celular o mail…"
                        value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Buscar posible cliente" />
                </div>
                <Select value={status} onChange={setStatus} options={estados} placeholder="Estado de la agenda" style={{ width: isMobile ? '100%' : 230 }} />
                <Select value={city} onChange={setCity} options={ciudades} placeholder="Ciudad" style={{ width: isMobile ? '100%' : 180 }} />
                <Select value={sort} onChange={setSort} options={SORTS} style={{ width: isMobile ? '100%' : 200 }} />
                {filtrosActivos && (
                    <Button variant="ghost" size="sm" leftIcon={<Icon.X size={14} />}
                        onClick={() => { setSearch(''); setStatus(''); setStage(''); setCity(''); }}>
                        Limpiar filtros
                    </Button>
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
                        gridTemplateColumns: COLUMNAS, fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold,
                        color: t.color.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em',
                    }}>
                        <span>Posible cliente</span>
                        <span>Estado en la agenda</span>
                        <span>Etapa</span>
                        <span>Próxima acción</span>
                    </div>
                )}
                {loading ? (
                    <div style={{ padding: 40, textAlign: 'center', color: t.color.textMuted, fontSize: t.font.size.sm }}>Cargando…</div>
                ) : rows.length === 0 ? (
                    <div style={{ padding: 40, textAlign: 'center', maxWidth: 380, margin: '0 auto' }}>
                        <div style={{ fontSize: 15, fontWeight: t.font.weight.medium, color: t.color.text }}>
                            {resumen?.total ? 'No hay posibles clientes con estos filtros' : 'Todavía no hay posibles clientes'}
                        </div>
                        <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 4 }}>
                            {resumen?.total ? 'Probá con otra búsqueda o sacá algún filtro.' : 'Cargá el primero con «Agregar posible cliente».'}
                        </div>
                    </div>
                ) : (
                    rows.map((l) => <FilaLead key={l.id} l={l} onAbrir={setAbierto} isMobile={isMobile} t={t} />)
                )}
                {!loading && rows.length > 0 && (
                    <div style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: t.space[3], flexWrap: 'wrap',
                        padding: '10px 16px', borderTop: `1px solid ${t.color.border}`, background: t.color.surface2,
                        fontSize: t.font.size.xs, color: t.color.textMuted, ...t.numericStyle,
                    }}>
                        <span>
                            Mostrando {fmtInt(rows.length)} de {fmtInt(total)}
                            {resumen?.convertidos ? ` · ${fmtInt(resumen.convertidos)} ya pasaron a Clientes` : ''}
                        </span>
                        {rows.length < total && (
                            <Button size="sm" variant="secondary" leftIcon={<Icon.ChevronDown size={14} />} disabled={cargandoMas} onClick={verMas}>
                                {cargandoMas ? 'Cargando…' : 'Ver más'}
                            </Button>
                        )}
                    </div>
                )}
            </Card>

            <NuevoLead abierto={nuevo} onClose={() => setNuevo(false)} t={t}
                onCreado={(id) => { setNuevo(false); refrescar(); setAbierto({ id }); }} />
            <LeadFicha leadId={abierto?.id} resumen={abierto} onClose={cerrarFicha} onCambio={() => { huboCambios.current = true; }} />
        </div>
    );
}
