import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR } from '../../theme/tokens';
import useIsMobile from '../../hooks/useIsMobile';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Tabs from '../../components/common/Tabs';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import * as Icon from '../../components/common/icons';

// "Controlado" = pedido saldado (el control ya terminó)
const ESTADO = {
    pendiente:   { label: 'Para armar',     tone: 'muted' },
    armando:     { label: 'Armando',        tone: 'accent' },
    armado:      { label: 'Para controlar', tone: 'warn' },
    controlando: { label: 'Controlando',    tone: 'primary' },
    saldado:     { label: 'Controlado',     tone: 'success' },
};
const FILTROS_ESTADO = ['todos', 'pendiente', 'armando', 'armado', 'controlando', 'saldado'];
const EMPRESAS = [
    { value: 'neggo', label: 'Neggo' },
    { value: 'preventas', label: 'Preventas' },
    { value: 'ambas', label: 'Ambas' },
];
const DIAS = [
    { value: '', label: 'Todo' },
    { value: '1', label: 'Últimas 24 h' },
    { value: '7', label: 'Últimos 7 días' },
    { value: '30', label: 'Últimos 30 días' },
];
const ORDENES = [
    { value: 'viejos', label: 'Más viejos primero' },
    { value: 'nuevos', label: 'Más nuevos primero' },
    { value: 'monto', label: 'Mayor monto' },
    { value: 'unidades', label: 'Más unidades' },
];
const DOS_DIAS_MS = 2 * 24 * 60 * 60 * 1000;

const fmtHora = (iso) => (iso
    ? new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
    : '—');
const fmtFecha = (iso) => (iso
    ? new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—');

// "Hoy · lunes 20/10", "Ayer · domingo 19/10", "sábado 18/10"
function etiquetaDia(iso) {
    if (!iso) return 'Sin fecha';
    const d = new Date(iso);
    const hoy = new Date();
    const inicio = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((inicio(hoy) - inicio(d)) / 86400000);
    const texto = d.toLocaleDateString('es-AR', { weekday: 'long', day: '2-digit', month: '2-digit' }).replace(',', '');
    if (diff === 0) return `Hoy · ${texto}`;
    if (diff === 1) return `Ayer · ${texto}`;
    return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function haceCuanto(iso) {
    if (!iso) return '—';
    const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (min < 60) return `hace ${min} min`;
    const h = Math.round(min / 60);
    if (h < 24) return `hace ${h} h`;
    const d = Math.round(h / 24);
    return d === 1 ? 'hace 1 día' : `hace ${d} días`;
}

function avanceDe(it) {
    const pedida = Number(it.qty_pedida) || 0;
    const hecha = it.estado === 'controlando' || it.estado === 'saldado'
        ? Number(it.qty_controlada) || 0
        : Number(it.qty_armada) || 0;
    return { pedida, hecha: Math.min(hecha, pedida), pct: pedida ? Math.min(100, Math.round((hecha / pedida) * 100)) : 0 };
}

export default function PedidoEnvios() {
    const { tokens: t } = useTheme();
    const isMobile = useIsMobile();
    const navigate = useNavigate();
    const [solapa, setSolapa] = useState('pedidos');
    const [company, setCompany] = useState('ambas');
    const [estado, setEstado] = useState('todos');
    const [q, setQ] = useState('');
    const [qDebounced, setQDebounced] = useState('');
    const [dias, setDias] = useState('');
    const [orden, setOrden] = useState('viejos');
    const [pagados, setPagados] = useState(false);
    const [data, setData] = useState({ items: [], conteos: {}, total: 0, solapas: {} });
    const [loading, setLoading] = useState(true);
    const [cargandoMas, setCargandoMas] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [marcando, setMarcando] = useState(null);
    const [sel, setSel] = useState(() => new Set());
    const [error, setError] = useState(null);
    const [aviso, setAviso] = useState(null);

    useEffect(() => {
        const id = setTimeout(() => setQDebounced(q), 250);
        return () => clearTimeout(id);
    }, [q]);

    const params = useMemo(() => ({
        solapa,
        company,
        estado: solapa === 'pedidos' ? estado : 'todos',
        q: qDebounced,
        dias,
        orden,
        pagados: solapa === 'pedidos' && pagados ? '1' : '',
    }), [solapa, company, estado, qDebounced, dias, orden, pagados]);

    const cargar = useCallback(async () => {
        setLoading(true);
        setError(null);
        const res = await api.get('/pedido-envios', params);
        setLoading(false);
        if (!res.success) {
            setError(res.error || 'No se pudieron cargar los pedidos');
            return;
        }
        setData(res.data);
        setSel(new Set());
    }, [params]);

    useEffect(() => { cargar(); }, [cargar]);

    const cargarMas = async () => {
        setCargandoMas(true);
        const res = await api.get('/pedido-envios', { ...params, offset: data.items.length });
        setCargandoMas(false);
        if (!res.success) {
            setError(res.error || 'No se pudieron cargar más pedidos');
            return;
        }
        setData((prev) => ({ ...res.data, items: [...prev.items, ...res.data.items] }));
    };

    const sync = async () => {
        setSyncing(true);
        setError(null);
        const empresas = company === 'ambas' ? ['neggo', 'preventas'] : [company];
        const tot = { leidos: 0, creados: 0, actualizados: 0 };
        for (const c of empresas) {
            const res = await api.post('/pedido-envios/sync', { company: c });
            if (!res.success) {
                setSyncing(false);
                setError(res.error || 'No pude hablar con Odoo');
                return;
            }
            tot.leidos += res.data.leidos;
            tot.creados += res.data.creados;
            tot.actualizados += res.data.actualizados;
        }
        setSyncing(false);
        setAviso(`Odoo: ${tot.leidos} órdenes, ${tot.creados} nuevas, ${tot.actualizados} actualizadas.`);
        cargar();
    };

    // Marca cotización enviada / pago recibido (solo en la app, no toca Odoo)
    const marcar = async (ids, ruta, body, okMsg) => {
        setMarcando(ids.length === 1 ? ids[0] : 'varios');
        setError(null);
        for (const id of ids) {
            const res = await api.post(`/pedido-envios/${id}/${ruta}`, body);
            if (!res.success) {
                setMarcando(null);
                setError(res.error || 'No se pudo guardar la marca');
                cargar();
                return;
            }
        }
        setMarcando(null);
        setAviso(okMsg);
        cargar();
    };

    // Eliminar un pedido que no se va a hacer: lo cancela en Odoo
    const [eliminando, setEliminando] = useState(null);
    const [cancelando, setCancelando] = useState(false);
    const eliminar = async () => {
        const it = eliminando;
        if (!it || cancelando) return;
        setCancelando(true);
        setError(null);
        const res = await api.post(`/pedido-envios/${it.id}/cancelar`);
        setCancelando(false);
        setEliminando(null);
        if (!res.success) {
            setError(res.error || 'No se pudo eliminar el pedido');
            return;
        }
        setAviso(`${it.odoo_order_name} eliminado: quedó cancelado en Odoo.`);
        cargar();
    };

    // Solo se elimina lo que todavía no se terminó de armar
    const botonEliminar = (it) => {
        if (it.estado !== 'pendiente' && it.estado !== 'armando') return null;
        return (
            <button
                type="button"
                aria-label={`Eliminar ${it.odoo_order_name}`}
                title="Eliminar pedido (se cancela en Odoo)"
                disabled={cancelando}
                onClick={(e) => { e.stopPropagation(); setEliminando(it); }}
                style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    width: 36, height: 36, padding: 0,
                    border: `1px solid ${t.color.borderStrong}`, background: t.color.surface,
                    color: t.color.danger, borderRadius: t.radius.full, cursor: 'pointer',
                }}
            >
                <Icon.Trash2 size={16} />
            </button>
        );
    };

    const items = data.items || [];
    const conteos = data.conteos || {};
    const controladosSel = items.filter((it) => sel.has(it.id) && it.estado === 'saldado').map((it) => it.id);
    const mostrarEmpresa = company === 'ambas';

    // Agrupar por día (solo en Pedidos ordenado por fecha)
    const grupos = useMemo(() => {
        if (solapa !== 'pedidos' || (orden !== 'viejos' && orden !== 'nuevos')) {
            return [{ label: null, rows: items }];
        }
        const out = [];
        items.forEach((it) => {
            const label = etiquetaDia(it.date_order);
            const g = out[out.length - 1];
            if (g && g.label === label) g.rows.push(it);
            else out.push({ label, rows: [it] });
        });
        return out;
    }, [items, solapa, orden]);

    const toggleSel = (id) => setSel((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
    });

    const pad = isMobile ? 12 : t.layout.cardPadX;
    const selectStyle = {
        height: isMobile ? 44 : t.layout.inputHeight, padding: '0 10px',
        border: `1px solid ${t.color.borderStrong}`, borderRadius: t.radius.sm,
        background: t.color.surface, color: t.color.text,
        fontFamily: t.font.family, fontSize: t.font.size.sm, flex: isMobile ? 1 : undefined, minWidth: 0,
    };
    const pill = (on) => ({
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
        height: isMobile ? 40 : 34, padding: '0 14px', borderRadius: t.radius.full, cursor: 'pointer',
        border: `1px solid ${on ? t.color.primary : t.color.borderStrong}`,
        background: on ? t.color.primary : t.color.surface,
        color: on ? '#fff' : t.color.text,
        fontFamily: t.font.family, fontSize: t.font.size.sm, fontWeight: t.font.weight.medium,
    });
    const etiquetaEmpresa = (it) => (
        <span style={{
            padding: '1px 6px', borderRadius: 4, fontSize: 10, fontWeight: t.font.weight.semibold,
            background: it.company_key === 'preventas' ? t.color.accentSoft : t.color.primarySoft,
            color: it.company_key === 'preventas' ? t.color.accent : t.color.primary,
        }}>
            {it.company_key === 'preventas' ? 'Preventas' : 'Neggo'}
        </span>
    );

    const botonCotizacion = (it) => {
        const habilitado = it.estado === 'saldado';
        return (
            <button
                type="button"
                disabled={!habilitado || marcando != null}
                onClick={(e) => {
                    e.stopPropagation();
                    marcar([it.id], 'cotizacion-enviada', { enviada: true },
                        `${it.odoo_order_name} pasó a «Esperando pago».`);
                }}
                title={habilitado ? 'Marcá cuando le mandes la cotización al cliente' : 'Se habilita cuando el pedido está controlado'}
                style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    height: isMobile ? 44 : 32, padding: '0 12px', borderRadius: t.radius.full,
                    fontFamily: t.font.family, fontSize: 12, fontWeight: t.font.weight.medium, whiteSpace: 'nowrap',
                    border: `1px solid ${habilitado ? t.color.primary : t.color.border}`,
                    background: habilitado ? t.color.surface : t.color.surface2,
                    color: habilitado ? t.color.primary : t.color.textFaint,
                    cursor: habilitado ? (marcando === it.id ? 'wait' : 'pointer') : 'not-allowed',
                    flex: isMobile ? 1 : undefined,
                }}
            >
                {habilitado ? 'Marcar cotización enviada' : 'Cotización: al controlar'}
            </button>
        );
    };

    const COLS_PEDIDOS = '40px 130px minmax(0, 1fr) 140px 160px 110px 244px 32px';
    const COLS_PAGO = '130px minmax(0, 1fr) 200px 120px 110px 250px';
    const header = (cols, labels) => (
        <div style={{
            display: 'grid', gridTemplateColumns: cols, alignItems: 'center', padding: `0 ${pad}px 0 12px`,
            height: 38, background: t.color.surface2, borderBottom: `1px solid ${t.color.border}`,
            fontSize: 11, fontWeight: t.font.weight.semibold, letterSpacing: '0.04em', textTransform: 'uppercase',
            color: t.color.textMuted,
        }}>
            {labels.map((l, i) => (
                <span key={i} style={l === 'Total' ? { textAlign: 'right', paddingRight: 16 } : undefined}>{l}</span>
            ))}
        </div>
    );

    const filaPedido = (it) => {
        const est = ESTADO[it.estado] || ESTADO.pendiente;
        const av = avanceDe(it);
        const seleccionado = sel.has(it.id);
        const abrir = () => navigate(`/pedidos/armado/${it.id}`);
        if (isMobile) {
            return (
                <div key={it.id} style={{
                    display: 'flex', flexDirection: 'column', gap: 10, padding: 14,
                    borderTop: `1px solid ${t.color.border}`, background: seleccionado ? t.color.primarySoft : t.color.surface,
                }}>
                    <button type="button" onClick={abrir} style={{
                        display: 'flex', flexDirection: 'column', gap: 8, padding: 0, border: 'none',
                        background: 'transparent', textAlign: 'left', cursor: 'pointer', fontFamily: t.font.family,
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: '100%' }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ fontFamily: t.font.mono, fontWeight: t.font.weight.semibold, color: t.color.text }}>{it.odoo_order_name}</span>
                                {mostrarEmpresa && etiquetaEmpresa(it)}
                            </span>
                            <Badge tone={est.tone} dot>{est.label}</Badge>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, width: '100%' }}>
                            <span style={{ fontSize: 15, color: t.color.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {it.partner_name || 'Sin cliente'}
                            </span>
                            <span style={{ fontSize: 15, fontWeight: t.font.weight.semibold, color: t.color.text, ...t.numericStyle }}>{fmtAR(it.amount_total)}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                            <div style={{ flex: 1, height: 6, background: t.color.surface2, borderRadius: t.radius.full, overflow: 'hidden' }}>
                                <div style={{ height: 6, width: `${av.pct}%`, background: t.color[est.tone === 'muted' ? 'textFaint' : est.tone] }} />
                            </div>
                            <span style={{ fontSize: 12, color: t.color.textMuted, ...t.numericStyle }}>{av.hecha}/{av.pedida} u. · {fmtHora(it.date_order)}</span>
                        </div>
                    </button>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 44, flexShrink: 0 }}>
                            <input type="checkbox" checked={seleccionado} onChange={() => toggleSel(it.id)}
                                aria-label={`Seleccionar ${it.odoo_order_name}`}
                                style={{ width: 18, height: 18, accentColor: t.color.primary }} />
                        </label>
                        {botonCotizacion(it)}
                        {botonEliminar(it)}
                    </div>
                </div>
            );
        }
        return (
            <div key={it.id} onClick={abrir} style={{
                display: 'grid', gridTemplateColumns: COLS_PEDIDOS, alignItems: 'center',
                padding: `8px ${pad}px 8px 12px`, minHeight: 60, borderTop: `1px solid ${t.color.border}`,
                background: seleccionado ? t.color.primarySoft : t.color.surface, cursor: 'pointer',
                fontFamily: t.font.family,
            }}>
                <label onClick={(e) => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 44, cursor: 'pointer' }}>
                    <input type="checkbox" checked={seleccionado} onChange={() => toggleSel(it.id)}
                        aria-label={`Seleccionar ${it.odoo_order_name}`}
                        style={{ width: 16, height: 16, accentColor: t.color.primary }} />
                </label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontFamily: t.font.mono, fontSize: 13, fontWeight: t.font.weight.semibold, color: t.color.text }}>{it.odoo_order_name}</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: t.color.textFaint, ...t.numericStyle }}>
                        {fmtHora(it.date_order)}
                        {mostrarEmpresa && etiquetaEmpresa(it)}
                    </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, paddingRight: 12 }}>
                    <span style={{ fontSize: t.font.size.base, fontWeight: t.font.weight.medium, color: t.color.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {it.partner_name || 'Sin cliente'}
                    </span>
                    <span style={{ fontSize: 11, color: t.color.textFaint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...t.numericStyle }}>
                        {it.n_items} ítems · {av.pedida} u.{it.odoo_picking_name ? ` · ${it.odoo_picking_name}${it.odoo_picking_state === 'done' ? ' ✓' : ''}` : ''}
                    </span>
                </div>
                <div><Badge tone={est.tone} dot>{est.label}</Badge></div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 16 }}>
                    <div style={{ flex: 1, height: 6, background: t.color.surface2, borderRadius: t.radius.full, overflow: 'hidden' }}>
                        <div style={{ height: 6, width: `${av.pct}%`, background: t.color[est.tone === 'muted' ? 'textFaint' : est.tone], borderRadius: t.radius.full }} />
                    </div>
                    <span style={{ fontSize: 12, color: t.color.textMuted, minWidth: 44, textAlign: 'right', ...t.numericStyle }}>
                        {it.estado === 'pendiente' ? '—' : `${av.hecha}/${av.pedida}`}
                    </span>
                </div>
                <span style={{ textAlign: 'right', paddingRight: 16, fontSize: t.font.size.base, fontWeight: t.font.weight.medium, color: t.color.text, ...t.numericStyle }}>
                    {fmtAR(it.amount_total)}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{botonCotizacion(it)}{botonEliminar(it)}</div>
                <span style={{ display: 'flex', justifyContent: 'center', color: t.color.textFaint }}><Icon.ChevronRight size={18} /></span>
            </div>
        );
    };

    const filaPago = (it) => {
        const atrasado = it.cotizacion_enviada_at && Date.now() - new Date(it.cotizacion_enviada_at).getTime() > DOS_DIAS_MS;
        const espera = (
            <Badge tone={atrasado ? 'warn' : 'muted'}>{haceCuanto(it.cotizacion_enviada_at)}</Badge>
        );
        const acciones = (
            <div style={{ display: 'flex', gap: 8, flex: isMobile ? 1 : undefined }}>
                <Button variant="primary" size="sm" disabled={marcando != null}
                    style={{ background: t.color.success, flex: isMobile ? 1 : undefined, height: isMobile ? 44 : undefined }}
                    onClick={(e) => {
                        e.stopPropagation();
                        marcar([it.id], 'pago-recibido', { recibido: true }, `${it.odoo_order_name}: pago recibido.`);
                    }}>
                    Pago recibido
                </Button>
                <Button variant="secondary" size="sm" disabled={marcando != null}
                    style={{ flex: isMobile ? 1 : undefined, height: isMobile ? 44 : undefined }}
                    onClick={(e) => {
                        e.stopPropagation();
                        marcar([it.id], 'cotizacion-enviada', { enviada: false }, `${it.odoo_order_name} volvió a Pedidos.`);
                    }}>
                    Volver a Pedidos
                </Button>
            </div>
        );
        const enviada = (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: t.font.size.sm, color: t.color.text, ...t.numericStyle }}>{fmtFecha(it.cotizacion_enviada_at)}</span>
                <span style={{ fontSize: 11, color: t.color.textFaint }}>por {it.cotizacion_enviada_by_name || '—'}</span>
            </div>
        );
        if (isMobile) {
            return (
                <div key={it.id} style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14, borderTop: `1px solid ${t.color.border}` }}>
                    <button type="button" onClick={() => navigate(`/pedidos/armado/${it.id}`)} style={{
                        display: 'flex', flexDirection: 'column', gap: 8, padding: 0, border: 'none',
                        background: 'transparent', textAlign: 'left', cursor: 'pointer', fontFamily: t.font.family,
                    }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, width: '100%' }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ fontFamily: t.font.mono, fontWeight: t.font.weight.semibold, color: t.color.text }}>{it.odoo_order_name}</span>
                                {mostrarEmpresa && etiquetaEmpresa(it)}
                            </span>
                            {espera}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, width: '100%' }}>
                            <span style={{ fontSize: 15, color: t.color.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.partner_name || 'Sin cliente'}</span>
                            <span style={{ fontSize: 15, fontWeight: t.font.weight.semibold, color: t.color.text, ...t.numericStyle }}>{fmtAR(it.amount_total)}</span>
                        </div>
                        {enviada}
                    </button>
                    {acciones}
                </div>
            );
        }
        return (
            <div key={it.id} onClick={() => navigate(`/pedidos/armado/${it.id}`)} style={{
                display: 'grid', gridTemplateColumns: COLS_PAGO, alignItems: 'center',
                padding: `10px ${pad}px 10px 12px`, minHeight: 60, borderTop: `1px solid ${t.color.border}`,
                cursor: 'pointer', fontFamily: t.font.family,
            }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontFamily: t.font.mono, fontSize: 13, fontWeight: t.font.weight.semibold, color: t.color.text }}>{it.odoo_order_name}</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: t.color.textFaint, ...t.numericStyle }}>
                        {fmtFecha(it.date_order)}
                        {mostrarEmpresa && etiquetaEmpresa(it)}
                    </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, paddingRight: 12 }}>
                    <span style={{ fontSize: t.font.size.base, fontWeight: t.font.weight.medium, color: t.color.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.partner_name || 'Sin cliente'}</span>
                    <span style={{ fontSize: 11, color: t.color.textFaint, ...t.numericStyle }}>{it.n_items} ítems · {Number(it.qty_pedida) || 0} u.</span>
                </div>
                {enviada}
                <div>{espera}</div>
                <span style={{ textAlign: 'right', paddingRight: 16, fontSize: t.font.size.base, fontWeight: t.font.weight.medium, color: t.color.text, ...t.numericStyle }}>{fmtAR(it.amount_total)}</span>
                {acciones}
            </div>
        );
    };

    return (
        <div style={{ padding: isMobile ? 12 : `${t.layout.cardPadY}px ${t.layout.cardPadX}px`, maxWidth: 1180, margin: '0 auto' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
                <div style={{ minWidth: 0 }}>
                    <h1 style={{ margin: 0, fontSize: isMobile ? 22 : t.font.size['2xl'], fontWeight: t.font.weight.semibold, color: t.color.text, fontFamily: t.font.family }}>
                        Armado y control
                    </h1>
                    <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 4, fontFamily: t.font.family }}>
                        {solapa === 'pedidos'
                            ? 'Todos los pedidos en un listado. Filtrá por estado, fecha o cliente.'
                            : 'Pedidos controlados a los que ya les mandaste la cotización y esperan el pago.'}
                    </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', width: isMobile ? '100%' : undefined }}>
                    <div role="group" aria-label="Empresa" style={{
                        display: 'flex', background: t.color.surface2, border: `1px solid ${t.color.border}`,
                        borderRadius: t.radius.full, padding: 3, flex: isMobile ? 1 : undefined,
                    }}>
                        {EMPRESAS.map((e) => {
                            const on = company === e.value;
                            return (
                                <button key={e.value} type="button" aria-pressed={on} onClick={() => setCompany(e.value)} style={{
                                    border: 'none', borderRadius: t.radius.full, padding: '0 14px', minHeight: isMobile ? 38 : 32,
                                    flex: isMobile ? 1 : undefined, cursor: 'pointer',
                                    background: on ? t.color.surface : 'transparent',
                                    color: on ? t.color.primary : t.color.textMuted,
                                    boxShadow: on ? t.shadow.card : 'none',
                                    fontFamily: t.font.family, fontSize: t.font.size.sm, fontWeight: t.font.weight.medium,
                                }}>
                                    {e.label}
                                </button>
                            );
                        })}
                    </div>
                    <Button variant="secondary" leftIcon={<Icon.Refresh size={16} />} disabled={syncing} onClick={sync}
                        aria-label="Traer de Odoo" style={isMobile ? { height: 44, flexShrink: 0 } : undefined}>
                        {syncing ? 'Odoo…' : isMobile ? '' : 'Traer de Odoo'}
                    </Button>
                </div>
            </div>

            <Tabs
                fullWidth={isMobile}
                tabs={[
                    { value: 'pedidos', label: 'Pedidos', count: data.solapas?.pedidos ?? null },
                    { value: 'esperando_pago', label: 'Esperando pago', count: data.solapas?.esperando_pago ?? null },
                ]}
                value={solapa}
                onChange={(v) => { setSolapa(v); setAviso(null); }}
            />

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '12px 0' }}>
                <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                    <Input
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Buscá por número o cliente…"
                        leftIcon={<Icon.Search size={14} />}
                    />
                </div>
                <select aria-label="Rango de fechas" value={dias} onChange={(e) => setDias(e.target.value)} style={selectStyle}>
                    {DIAS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
                <select aria-label="Ordenar" value={orden} onChange={(e) => setOrden(e.target.value)} style={selectStyle}>
                    {ORDENES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
            </div>

            {solapa === 'pedidos' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: isMobile ? 'nowrap' : 'wrap', overflowX: isMobile ? 'auto' : undefined, paddingBottom: isMobile ? 4 : 0 }}>
                    {FILTROS_ESTADO.map((k) => (
                        <button key={k} type="button" onClick={() => setEstado(k)} aria-pressed={estado === k} style={pill(estado === k)}>
                            {k === 'todos' ? 'Todos' : ESTADO[k].label}
                            <span style={{ fontWeight: t.font.weight.semibold, opacity: 0.8, ...t.numericStyle }}>{conteos[k] ?? 0}</span>
                        </button>
                    ))}
                    <label style={{
                        display: 'flex', alignItems: 'center', gap: 8, marginLeft: isMobile ? 8 : 'auto', flexShrink: 0,
                        fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family, cursor: 'pointer', minHeight: 40,
                    }}>
                        <input type="checkbox" checked={pagados} onChange={(e) => setPagados(e.target.checked)}
                            style={{ width: 16, height: 16, accentColor: t.color.primary }} />
                        Incluir pagados
                    </label>
                </div>
            )}

            {solapa === 'pedidos' && sel.size > 0 && (
                <div style={{
                    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 12,
                    padding: '10px 14px', background: t.color.primary, color: '#fff', borderRadius: t.radius.sm,
                    fontFamily: t.font.family,
                }}>
                    <span style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, ...t.numericStyle }}>
                        {sel.size} seleccionados <span style={{ fontWeight: t.font.weight.regular, opacity: 0.8 }}>· {controladosSel.length} controlados</span>
                    </span>
                    <span style={{ flex: 1 }} />
                    <button type="button"
                        disabled={controladosSel.length === 0 || marcando != null}
                        title="Solo se marcan los pedidos controlados"
                        onClick={() => marcar(controladosSel, 'cotizacion-enviada', { enviada: true },
                            `${controladosSel.length} pedidos pasaron a «Esperando pago».`)}
                        style={{
                            height: 36, padding: '0 14px', border: 'none', borderRadius: t.radius.sm,
                            fontFamily: t.font.family, fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold,
                            background: controladosSel.length ? t.color.surface : 'rgba(255,255,255,0.25)',
                            color: controladosSel.length ? t.color.primary : 'rgba(255,255,255,0.75)',
                            cursor: controladosSel.length ? 'pointer' : 'not-allowed',
                        }}>
                        Marcar cotización enviada ({controladosSel.length})
                    </button>
                    <button type="button" onClick={() => setSel(new Set())} style={{
                        height: 36, padding: '0 8px', border: 'none', background: 'transparent', color: '#fff',
                        fontFamily: t.font.family, fontSize: t.font.size.sm, textDecoration: 'underline', cursor: 'pointer',
                    }}>
                        Cancelar
                    </button>
                </div>
            )}

            {aviso && (
                <div style={{ marginBottom: 12, padding: '10px 12px', background: t.color.successSoft, color: t.color.success, borderRadius: t.radius.sm, fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                    {aviso}
                </div>
            )}
            {error && (
                <div style={{ marginBottom: 12, padding: '10px 12px', background: t.color.dangerSoft, color: t.color.danger, borderRadius: t.radius.sm, fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                    {error}
                </div>
            )}

            {loading ? (
                <div style={{ padding: 24, color: t.color.textMuted, fontFamily: t.font.family }}>Cargando pedidos…</div>
            ) : items.length === 0 ? (
                <Card style={{ textAlign: 'center', padding: 28 }}>
                    <div style={{ fontWeight: t.font.weight.medium, color: t.color.text, fontFamily: t.font.family }}>
                        {solapa === 'pedidos' ? 'No hay pedidos con estos filtros' : 'No hay pedidos esperando pago'}
                    </div>
                    <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 6, fontFamily: t.font.family }}>
                        {solapa === 'pedidos'
                            ? 'Probá con otro estado o fecha, o tocá «Traer de Odoo» para bajar las cotizaciones enviadas (hasta 80, últimos 30 días). Las que ya tienen factura o se cobraron en el POS no entran.'
                            : 'Cuando un pedido controlado tenga la cotización enviada, aparece acá.'}
                    </div>
                </Card>
            ) : (
                <Card padding={false} style={{ overflow: 'hidden' }}>
                    <div style={{ overflowX: isMobile ? 'visible' : 'auto' }}>
                        <div style={{ minWidth: isMobile ? 0 : 960 }}>
                            {!isMobile && (solapa === 'pedidos'
                                ? header(COLS_PEDIDOS, ['', 'Pedido', 'Cliente', 'Estado', 'Avance', 'Total', 'Cotización', ''])
                                : header(COLS_PAGO, ['Pedido', 'Cliente', 'Cotización enviada', 'Esperando', 'Total', 'Acciones']))}
                            {solapa === 'pedidos'
                                ? grupos.map((g, i) => (
                                    <div key={g.label || i}>
                                        {g.label && (
                                            <div style={{
                                                padding: `10px ${pad}px 6px`, fontSize: 12, fontWeight: t.font.weight.semibold,
                                                color: t.color.textMuted, background: t.color.bg, borderTop: `1px solid ${t.color.border}`,
                                                fontFamily: t.font.family,
                                            }}>
                                                {g.label} <span style={{ fontWeight: t.font.weight.regular, color: t.color.textFaint }}>· {g.rows.length} pedidos</span>
                                            </div>
                                        )}
                                        {g.rows.map(filaPedido)}
                                    </div>
                                ))
                                : items.map(filaPago)}
                        </div>
                    </div>
                </Card>
            )}

            {!loading && items.length > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginTop: 12, fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                    <span style={t.numericStyle}>Mostrando {items.length} de {data.total}</span>
                    {items.length < data.total && (
                        <Button variant="secondary" size="sm" disabled={cargandoMas} onClick={cargarMas}>
                            {cargandoMas ? 'Cargando…' : 'Cargar más'}
                        </Button>
                    )}
                </div>
            )}

            <ConfirmDialog
                isOpen={!!eliminando}
                onClose={() => { if (!cancelando) setEliminando(null); }}
                onConfirm={eliminar}
                title="Eliminar pedido"
                message={cancelando
                    ? 'Cancelando en Odoo…'
                    : `¿Eliminás ${eliminando?.odoo_order_name} de ${eliminando?.partner_name || 'sin cliente'}? Se cancela la orden en Odoo y sale de esta lista.`}
                confirmLabel={cancelando ? 'Eliminando…' : 'Eliminar pedido'}
                danger
            />
        </div>
    );
}
