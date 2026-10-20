import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR, fmtInt } from '../../theme/tokens';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import ProductThumb from '../../components/common/ProductThumb';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import FotoAmpliada from '../../components/common/FotoAmpliada';
import * as Icon from '../../components/common/icons';

// Pestaña «Órdenes» de Reposición: ventas y tickets de POS de Neggo de la última
// semana, como tareas. En cada una se marca qué reponer o archivar y se termina;
// las terminadas pasan a «Revisadas» (se pueden reabrir).

const ORIGEN_ORDEN = {
    venta: { label: 'Venta', tone: 'primary', icon: Icon.ClipboardList },
    pos:   { label: 'POS',   tone: 'accent',  icon: Icon.ShoppingBag },
};
const ORIGEN_COLA = {
    archivado: 'Agotado',
    reponer:   'Queda poco',
    recorrida: 'Recorrida',
};

const fmtFecha = (iso) => iso
    ? new Date(iso).toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';

const BTN_MOVIL = { flex: 1, minWidth: 0, height: 44 };

// Productos de la orden que ya tienen una decisión (en la cola o archivados)
function nMarcados(orden) {
    return orden.productos.filter(p => p.en_cola || p.active === false).length;
}

function EstadoProducto({ p }) {
    if (!p.en_cache) return <Badge tone="muted">No está en Neggo</Badge>;
    if (p.es_liquidar) return <Badge tone="muted">Liquidar</Badge>;
    if (p.estado_cola === 'encargado') return <Badge tone="accent" dot>Encargado</Badge>;
    if (p.estado_cola) {
        return <Badge tone={p.origen_cola === 'archivado' ? 'danger' : 'warn'} dot>{ORIGEN_COLA[p.origen_cola] || 'En la cola'}</Badge>;
    }
    if (p.active === false) return <Badge tone="danger">Archivado</Badge>;
    return null;
}

function AccionesProducto({ p, busy, onReponer, onQuitar, onArchivar, isMobile, t }) {
    if (!p.en_cache || p.es_liquidar || p.estado_cola === 'encargado') return null;
    const estilo = isMobile ? BTN_MOVIL : undefined;
    return (
        <div style={{ display: 'flex', gap: t.space[2], flexShrink: 0, width: isMobile ? '100%' : undefined }}>
            {p.en_cola ? (
                <Button size="sm" variant="ghost" leftIcon={<Icon.X size={13} />} disabled={busy}
                    onClick={() => onQuitar(p)} title="Sacarlo de la cola de reposición" style={estilo}>
                    Quitar
                </Button>
            ) : (
                <Button size="sm" variant="primary" leftIcon={<Icon.Plus size={13} />} disabled={busy}
                    onClick={() => onReponer(p)} style={estilo}>
                    Reponer
                </Button>
            )}
            {p.active !== false && (
                <Button size="sm" variant="danger" leftIcon={<Icon.Archive size={13} />} disabled={busy}
                    onClick={() => onArchivar(p)} style={estilo}>
                    Archivar
                </Button>
            )}
        </div>
    );
}

function FilaProducto({ p, busy, acciones, onVerFoto, isMobile, t }) {
    const thumb = p.image_url ? (
        <button type="button" onClick={() => onVerFoto(p)} aria-label={`Ver foto de ${p.name}`} title="Ver foto en grande"
            style={{ padding: 0, border: 'none', background: 'none', cursor: 'zoom-in', lineHeight: 0, flexShrink: 0 }}>
            <ProductThumb imageUrl={p.image_url} size={isMobile ? 44 : 36} />
        </button>
    ) : <ProductThumb imageUrl={p.image_url} size={isMobile ? 44 : 36} />;

    return (
        <div style={{
            display: 'flex', alignItems: isMobile ? 'stretch' : 'center', gap: t.space[3],
            flexDirection: isMobile ? 'column' : 'row',
            padding: isMobile ? '10px 12px' : '8px 16px',
            borderTop: `1px solid ${t.color.border}`,
            fontFamily: t.font.family,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: t.space[3], flex: 1, minWidth: 0 }}>
                {thumb}
                <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{
                        fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.text,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: isMobile ? 'normal' : 'nowrap',
                    }} title={p.name}>
                        {p.name || `Producto ${p.odoo_id}`}
                    </div>
                    <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, display: 'flex', flexWrap: 'wrap', gap: '0 8px' }}>
                        <span style={{ fontFamily: t.font.mono }}>{p.internal_ref || p.barcode || '—'}</span>
                        {p.vendor_name && <span>{p.vendor_name}</span>}
                    </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0, fontSize: t.font.size.sm, ...t.numericStyle }}>
                    <div style={{ fontWeight: t.font.weight.semibold, color: t.color.text }}>× {fmtInt(p.qty)}</div>
                    <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>{fmtAR(p.price_unit)}</div>
                </div>
            </div>
            <div style={{
                display: 'flex', alignItems: 'center', gap: t.space[2], flexShrink: 0,
                flexWrap: isMobile ? 'wrap' : 'nowrap', justifyContent: 'flex-end',
                minWidth: isMobile ? undefined : 260,
            }}>
                <EstadoProducto p={p} />
                <AccionesProducto p={p} busy={busy} isMobile={isMobile} t={t} {...acciones} />
            </div>
        </div>
    );
}

function TarjetaOrden({ orden, abierta, onToggle, revisada, trabajando, acciones, onTerminar, onReabrir, onVerFoto, isMobile, t }) {
    const meta = ORIGEN_ORDEN[orden.origen];
    const IconoOrden = meta.icon;
    const marcados = nMarcados(orden);
    const busyOrden = trabajando === orden.key;

    return (
        <Card padding={false} style={{ overflow: 'hidden' }}>
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={abierta}
                style={{
                    display: 'flex', alignItems: 'center', gap: t.space[3], width: '100%',
                    padding: isMobile ? '12px' : '12px 16px', border: 'none', background: 'transparent',
                    cursor: 'pointer', textAlign: 'left', fontFamily: t.font.family, flexWrap: 'wrap',
                    minHeight: isMobile ? 56 : undefined,
                }}
                onMouseEnter={e => { e.currentTarget.style.background = t.color.surface2; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
                <span style={{
                    width: isMobile ? 36 : 28, height: isMobile ? 36 : 28, borderRadius: t.radius.md, flexShrink: 0,
                    background: meta.tone === 'accent' ? t.color.accentSoft : t.color.primarySoft,
                    color: meta.tone === 'accent' ? t.color.accent : t.color.primary,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}>
                    <IconoOrden size={isMobile ? 18 : 14} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: t.space[2], flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: t.font.weight.semibold, fontSize: t.font.size.base, color: t.color.text, fontFamily: t.font.mono }}>
                            {orden.name}
                        </span>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                    </span>
                    <span style={{ display: 'block', fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: 2, ...t.numericStyle }}>
                        {fmtFecha(orden.date_order)}
                        {orden.partner_name ? ` · ${orden.partner_name}` : ''}
                        {orden.vendedor ? ` · ${orden.vendedor}` : ''}
                        {revisada && orden.revisada_by_name ? ` · revisó ${orden.revisada_by_name}` : ''}
                    </span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: t.space[2], flexShrink: 0 }}>
                    {marcados > 0 && <Badge tone="success">{marcados} marcado{marcados === 1 ? '' : 's'}</Badge>}
                    <Badge tone="muted">{orden.productos.length} prod.</Badge>
                    {!isMobile && (
                        <span style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.primary, minWidth: 90, textAlign: 'right', ...t.numericStyle }}>
                            {fmtAR(orden.amount_total)}
                        </span>
                    )}
                    {abierta ? <Icon.ChevronDown size={16} /> : <Icon.ChevronRight size={16} />}
                </span>
            </button>

            {abierta && (
                <>
                    {orden.productos.map(p => (
                        <FilaProducto
                            key={p.odoo_id}
                            p={p}
                            busy={trabajando === p.odoo_id || busyOrden}
                            acciones={acciones(orden)}
                            onVerFoto={onVerFoto}
                            isMobile={isMobile}
                            t={t}
                        />
                    ))}
                    <div style={{
                        display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: t.space[3],
                        padding: isMobile ? '10px 12px' : '10px 16px', borderTop: `1px solid ${t.color.border}`,
                        background: t.color.surface2, flexWrap: 'wrap',
                    }}>
                        <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family, flex: 1, minWidth: 160 }}>
                            {revisada
                                ? 'Ya la revisaste. Si te faltó algo, reabrila.'
                                : 'Cuando decidas qué reponer o archivar, terminala y sale de la lista.'}
                        </span>
                        {revisada ? (
                            <Button size="sm" variant="ghost" leftIcon={<Icon.Refresh size={13} />} disabled={busyOrden}
                                onClick={() => onReabrir(orden)} style={isMobile ? BTN_MOVIL : undefined}>
                                Reabrir
                            </Button>
                        ) : (
                            <Button size="sm" variant="success" leftIcon={<Icon.Check size={13} />} disabled={busyOrden}
                                onClick={() => onTerminar(orden)} style={isMobile ? BTN_MOVIL : undefined}>
                                Terminar
                            </Button>
                        )}
                    </div>
                </>
            )}
        </Card>
    );
}

export default function ReposicionOrdenes({ recargar, onCambioCola, onAviso, onError, isMobile }) {
    const { tokens: t } = useTheme();
    const [data, setData] = useState({ pendientes: [], revisadas: [], dias: 7 });
    const [loading, setLoading] = useState(true);
    const [vista, setVista] = useState('pendientes');
    const [filtro, setFiltro] = useState('todas');
    const [abiertas, setAbiertas] = useState(() => new Set());
    const [trabajando, setTrabajando] = useState(null);
    const [confirmar, setConfirmar] = useState(null);
    const [foto, setFoto] = useState(null);
    const cerrarFoto = useCallback(() => setFoto(null), []);

    const cargar = useCallback(async (refrescar = false) => {
        setLoading(true);
        const res = await api.get('/reposicion/ordenes', refrescar ? { refrescar: 1 } : undefined);
        if (res.success) setData(res.data);
        else onError(res.error || 'No se pudieron leer las órdenes de Odoo');
        setLoading(false);
    }, [onError]);

    useEffect(() => { cargar(false); }, [cargar]);
    // El botón «Actualizar» de la página vuelve a leer Odoo
    const recargaVista = useRef(recargar);
    useEffect(() => {
        if (recargar === recargaVista.current) return;
        recargaVista.current = recargar;
        cargar(true);
    }, [recargar, cargar]);

    // Un mismo producto puede estar en varias órdenes: se actualiza en todas
    const actualizarProducto = (odooId, cambios) => {
        const aplicar = (lista) => lista.map(o => ({
            ...o,
            productos: o.productos.map(p => p.odoo_id === odooId ? { ...p, ...cambios } : p),
        }));
        setData(prev => ({ ...prev, pendientes: aplicar(prev.pendientes), revisadas: aplicar(prev.revisadas) }));
    };

    const toggle = (key) => setAbiertas(prev => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
    });

    const etiquetaOrden = (orden) => `${ORIGEN_ORDEN[orden.origen].label} ${orden.name}`;

    const reponer = async (orden, p) => {
        setTrabajando(p.odoo_id);
        const res = await api.post('/reposicion', { odoo_id: p.odoo_id, nota: etiquetaOrden(orden) });
        setTrabajando(null);
        if (!res.success) { onError(res.error || 'No se pudo marcar para reponer'); return; }
        actualizarProducto(p.odoo_id, { en_cola: true, estado_cola: res.data?.estado || 'pendiente', origen_cola: res.data?.origen || 'reponer' });
        onAviso(`«${p.name}» entró a la cola como «${ORIGEN_COLA[res.data?.origen] || 'queda poco'}».`);
        onCambioCola();
    };

    const quitar = async (p) => {
        setTrabajando(p.odoo_id);
        const res = await api.del(`/reposicion/producto/${p.odoo_id}`);
        setTrabajando(null);
        if (!res.success) { onError(res.error || 'No se pudo sacar de la cola'); return; }
        actualizarProducto(p.odoo_id, { en_cola: false, estado_cola: null, origen_cola: null });
        const archivado = p.active === false ? ' En Odoo sigue archivado.' : '';
        onAviso(`«${p.name}» salió de la cola.${archivado}`);
        onCambioCola();
    };

    const archivar = async () => {
        const p = confirmar;
        if (!p) return;
        setConfirmar(null);
        setTrabajando(p.odoo_id);
        const res = await api.post('/reposicion/archivar', { odoo_id: p.odoo_id });
        setTrabajando(null);
        if (!res.success) { onError(res.error || 'No se pudo archivar en Odoo'); return; }
        actualizarProducto(p.odoo_id, { active: false, en_cola: true, estado_cola: res.data?.estado || 'pendiente', origen_cola: 'archivado' });
        onAviso(`«${p.name}» se archivó en Odoo y entró a la cola como «agotado».`);
        onCambioCola();
    };

    const terminar = async (orden) => {
        setTrabajando(orden.key);
        const res = await api.post('/reposicion/ordenes/revisar', {
            origen: orden.origen, odoo_order_id: orden.odoo_order_id, order_name: orden.name,
        });
        setTrabajando(null);
        if (!res.success) { onError(res.error || 'No se pudo terminar la orden'); return; }
        setData(prev => ({
            ...prev,
            pendientes: prev.pendientes.filter(o => o.key !== orden.key),
            revisadas: [{ ...orden, revisada_at: new Date().toISOString() }, ...prev.revisadas],
        }));
        onAviso(`${etiquetaOrden(orden)} quedó revisada.`);
    };

    const reabrir = async (orden) => {
        setTrabajando(orden.key);
        const res = await api.post('/reposicion/ordenes/reabrir', { origen: orden.origen, odoo_order_id: orden.odoo_order_id });
        setTrabajando(null);
        if (!res.success) { onError(res.error || 'No se pudo reabrir la orden'); return; }
        setData(prev => ({
            ...prev,
            revisadas: prev.revisadas.filter(o => o.key !== orden.key),
            pendientes: [{ ...orden, revisada_at: null, revisada_by_name: null }, ...prev.pendientes]
                .sort((a, b) => String(b.date_order || '').localeCompare(String(a.date_order || ''))),
        }));
        onAviso(`${etiquetaOrden(orden)} volvió a pendientes.`);
    };

    const acciones = (orden) => ({
        onReponer: (p) => reponer(orden, p),
        onQuitar: quitar,
        onArchivar: setConfirmar,
    });

    const lista = (vista === 'revisadas' ? data.revisadas : data.pendientes)
        .filter(o => filtro === 'todas' || o.origen === filtro);
    const cuenta = (origen) => (vista === 'revisadas' ? data.revisadas : data.pendientes)
        .filter(o => origen === 'todas' || o.origen === origen).length;

    const chip = (activo) => ({
        border: `1px solid ${activo ? t.color.primary : t.color.border}`,
        background: activo ? t.color.primarySoft : t.color.surface,
        color: activo ? t.color.primary : t.color.textMuted,
        borderRadius: t.radius.full, padding: '0 12px', height: isMobile ? 36 : 30,
        fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, fontFamily: t.font.family,
        cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, ...t.numericStyle,
    });

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[4] }}>
            <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: t.space[3], flexWrap: 'wrap',
                padding: isMobile ? '0 12px' : undefined,
            }}>
                <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap' }}>
                    <button type="button" style={chip(vista === 'pendientes')} onClick={() => setVista('pendientes')}>
                        Para revisar · {data.pendientes.length}
                    </button>
                    <button type="button" style={chip(vista === 'revisadas')} onClick={() => setVista('revisadas')}>
                        <Icon.Check size={13} /> Revisadas · {data.revisadas.length}
                    </button>
                </div>
                <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap' }}>
                    {[['todas', 'Todas'], ['venta', 'Ventas'], ['pos', 'POS']].map(([v, label]) => (
                        <button key={v} type="button" style={chip(filtro === v)} onClick={() => setFiltro(v)}>
                            {label} {cuenta(v)}
                        </button>
                    ))}
                </div>
            </div>

            <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family, marginTop: -4, padding: isMobile ? '0 12px' : undefined }}>
                Ventas confirmadas y tickets de POS de Neggo de los últimos {data.dias} días. Solo se ven productos: los cobros, señas y envíos no aparecen.
            </div>

            {loading ? (
                <Card><div style={{ padding: 40, textAlign: 'center', color: t.color.textMuted, fontFamily: t.font.family }}>Leyendo órdenes de Odoo…</div></Card>
            ) : lista.length === 0 ? (
                <Card>
                    <div style={{ padding: isMobile ? 28 : 40, textAlign: 'center', fontFamily: t.font.family, maxWidth: 380, margin: '0 auto' }}>
                        <div style={{ width: 48, height: 48, borderRadius: '50%', background: t.color.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', color: t.color.textMuted }}>
                            <Icon.Check size={22} />
                        </div>
                        <div style={{ fontSize: 15, fontWeight: t.font.weight.medium, color: t.color.text }}>
                            {vista === 'revisadas' ? 'Todavía no terminaste ninguna orden' : 'No quedan órdenes para revisar'}
                        </div>
                        <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 4 }}>
                            {vista === 'revisadas'
                                ? 'Las órdenes que termines quedan acá por si hay que reabrirlas.'
                                : 'Cuando entren ventas o tickets nuevos en Odoo, tocá «Actualizar».'}
                        </div>
                    </div>
                </Card>
            ) : (
                lista.map(orden => (
                    <TarjetaOrden
                        key={orden.key}
                        orden={orden}
                        abierta={abiertas.has(orden.key)}
                        onToggle={() => toggle(orden.key)}
                        revisada={vista === 'revisadas'}
                        trabajando={trabajando}
                        acciones={acciones}
                        onTerminar={terminar}
                        onReabrir={reabrir}
                        onVerFoto={setFoto}
                        isMobile={isMobile}
                        t={t}
                    />
                ))
            )}

            <FotoAmpliada
                imageUrl={foto?.image_url}
                nombre={foto?.name}
                detalle={foto ? (foto.internal_ref || foto.barcode) : null}
                onClose={cerrarFoto}
            />
            <ConfirmDialog
                isOpen={!!confirmar}
                onClose={() => setConfirmar(null)}
                onConfirm={archivar}
                danger
                title="Archivar en Odoo"
                confirmLabel="Sí, archivar"
                message={`«${confirmar?.name || ''}» se apaga en Odoo porque no queda stock, y entra a la cola como agotado.`}
            />
        </div>
    );
}
