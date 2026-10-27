import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR, fmtInt } from '../../theme/tokens';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import ProductThumb from '../../components/common/ProductThumb';
import FotoAmpliada from '../../components/common/FotoAmpliada';
import * as Icon from '../../components/common/icons';

// Pestaña «Cotizaciones» de Reposición: cotizaciones de Odoo con la etiqueta «Pendiente»
// (encargues de clientes y mercadería que faltó en un pedido), de Neggo y de Preventas.
// Se ven por cotización o sumadas por producto. Un producto de Neggo que no está en la
// cola se puede mandar a reponer desde acá.

const EMPRESA = {
    neggo:     { label: 'Neggo',     tone: 'primary' },
    preventas: { label: 'Preventas', tone: 'accent' },
};
const ESTADO_COT = {
    borrador: { label: 'Borrador', tone: 'muted' },
    enviada:  { label: 'Enviada',  tone: 'success' },
};

const fmtFecha = (iso) => iso
    ? new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' })
    : '—';

function EstadoCola({ p, company }) {
    if (company !== 'neggo') return null;
    if (p.en_cache === false) return <Badge tone="muted">No está en Neggo</Badge>;
    if (p.es_liquidar) return <Badge tone="muted">Liquidar</Badge>;
    if (p.estado_cola === 'encargado') return <Badge tone="accent" dot>Encargado</Badge>;
    if (p.estado_cola === 'pendiente') return <Badge tone="warn" dot>En la cola</Badge>;
    return null;
}

function puedeReponer(p, company) {
    return company === 'neggo' && p.en_cache !== false && !p.es_liquidar && !p.estado_cola;
}

function FilaProducto({ p, company, busy, onReponer, onVerFoto, isMobile, t }) {
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
                justifyContent: 'flex-end', minWidth: isMobile ? undefined : 180,
            }}>
                <EstadoCola p={p} company={company} />
                {puedeReponer(p, company) && (
                    <Button size="sm" variant="primary" leftIcon={<Icon.Plus size={13} />} disabled={busy}
                        onClick={() => onReponer(p)} style={isMobile ? { flex: 1, height: 44 } : undefined}>
                        Reponer
                    </Button>
                )}
            </div>
        </div>
    );
}

function TarjetaCotizacion({ c, abierta, onToggle, trabajando, onReponer, onVerFoto, isMobile, t }) {
    const empresa = EMPRESA[c.company] || EMPRESA.neggo;
    const estado = ESTADO_COT[c.estado] || ESTADO_COT.borrador;
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
                    background: empresa.tone === 'accent' ? t.color.accentSoft : t.color.primarySoft,
                    color: empresa.tone === 'accent' ? t.color.accent : t.color.primary,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}>
                    <Icon.Tag size={isMobile ? 18 : 14} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: t.space[2], flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: t.font.weight.semibold, fontSize: t.font.size.base, color: t.color.text, fontFamily: t.font.mono }}>
                            {c.name}
                        </span>
                        <Badge tone={empresa.tone}>{empresa.label}</Badge>
                        <Badge tone={estado.tone}>{estado.label}</Badge>
                    </span>
                    <span style={{ display: 'block', fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: 2, ...t.numericStyle }}>
                        {fmtFecha(c.date_order)}
                        {c.partner_name ? ` · ${c.partner_name}` : ''}
                        {c.origen ? ` · de ${c.origen}` : ''}
                    </span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: t.space[2], flexShrink: 0 }}>
                    <Badge tone="muted">{c.productos.length} prod.</Badge>
                    {!isMobile && (
                        <span style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.primary, minWidth: 90, textAlign: 'right', ...t.numericStyle }}>
                            {fmtAR(c.amount_total)}
                        </span>
                    )}
                    {abierta ? <Icon.ChevronDown size={16} /> : <Icon.ChevronRight size={16} />}
                </span>
            </button>
            {abierta && c.productos.map(p => (
                <FilaProducto
                    key={p.odoo_id}
                    p={p}
                    company={c.company}
                    busy={trabajando === p.odoo_id}
                    onReponer={(prod) => onReponer(c, prod)}
                    onVerFoto={onVerFoto}
                    isMobile={isMobile}
                    t={t}
                />
            ))}
        </Card>
    );
}

// Total por producto, agrupado por proveedor: lo que hay que conseguir
function VistaProductos({ productos, isMobile, t }) {
    const grupos = [];
    for (const p of productos) {
        const ultimo = grupos[grupos.length - 1];
        if (ultimo && ultimo.vendor === p.vendor_name) ultimo.items.push(p);
        else grupos.push({ vendor: p.vendor_name, items: [p] });
    }
    return grupos.map(g => (
        <Card key={g.vendor} padding={false} style={{ overflow: 'hidden' }}>
            <div style={{
                padding: isMobile ? '10px 12px' : '10px 16px', background: t.color.surface2,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: t.space[2],
                fontFamily: t.font.family, ...t.numericStyle,
            }}>
                <span style={{ fontWeight: t.font.weight.semibold, color: t.color.text, fontSize: t.font.size.sm }}>{g.vendor}</span>
                <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>
                    {g.items.length} producto{g.items.length === 1 ? '' : 's'}
                </span>
            </div>
            {g.items.map(p => {
                const empresa = EMPRESA[p.company] || EMPRESA.neggo;
                return (
                    <div key={`${p.company}|${p.odoo_id}`} style={{
                        display: 'flex', alignItems: 'center', gap: t.space[3],
                        padding: isMobile ? '10px 12px' : '8px 16px', borderTop: `1px solid ${t.color.border}`,
                        fontFamily: t.font.family,
                    }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.text }}>
                                {p.name || `Producto ${p.odoo_id}`}
                            </div>
                            <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, display: 'flex', flexWrap: 'wrap', gap: '0 8px', ...t.numericStyle }}>
                                <span style={{ fontFamily: t.font.mono }}>{p.internal_ref || '—'}</span>
                                <span>{p.cotizaciones.map(c => `${c.name}${c.partner_name ? ` (${c.partner_name})` : ''} × ${fmtInt(c.qty)}`).join(' · ')}</span>
                            </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: t.space[2], flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                            <Badge tone={empresa.tone}>{empresa.label}</Badge>
                            {p.company === 'neggo' && p.estado_cola === 'encargado' && <Badge tone="accent" dot>Encargado</Badge>}
                            {p.company === 'neggo' && p.estado_cola === 'pendiente' && <Badge tone="warn" dot>En la cola</Badge>}
                            <span style={{ fontWeight: t.font.weight.semibold, color: t.color.text, fontSize: t.font.size.sm, minWidth: 48, textAlign: 'right', ...t.numericStyle }}>
                                × {fmtInt(p.qty_total)}
                            </span>
                        </div>
                    </div>
                );
            })}
        </Card>
    ));
}

export default function ReposicionCotizaciones({ recargar, onCambioCola, onAviso, onError, isMobile }) {
    const { tokens: t } = useTheme();
    const [data, setData] = useState({ cotizaciones: [], productos: [], etiqueta: 'Pendiente' });
    const [loading, setLoading] = useState(true);
    const [vista, setVista] = useState('cotizaciones');
    const [empresa, setEmpresa] = useState('todas');
    const [abiertas, setAbiertas] = useState(() => new Set());
    const [trabajando, setTrabajando] = useState(null);
    const [foto, setFoto] = useState(null);
    const cerrarFoto = useCallback(() => setFoto(null), []);

    const cargar = useCallback(async (refrescar = false) => {
        setLoading(true);
        const res = await api.get('/reposicion/cotizaciones', refrescar ? { refrescar: 1 } : undefined);
        if (res.success) setData(res.data);
        else onError(res.error || 'No se pudieron leer las cotizaciones de Odoo');
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

    const toggle = (id) => setAbiertas(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });

    // Un mismo producto de Neggo puede estar en varias cotizaciones: se actualiza en todas
    const marcarEnCola = (odooId, estado) => setData(prev => ({
        ...prev,
        cotizaciones: prev.cotizaciones.map(c => c.company !== 'neggo' ? c : {
            ...c,
            productos: c.productos.map(p => p.odoo_id === odooId ? { ...p, estado_cola: estado } : p),
        }),
        productos: prev.productos.map(p => p.company === 'neggo' && p.odoo_id === odooId ? { ...p, estado_cola: estado } : p),
    }));

    const reponer = async (c, p) => {
        setTrabajando(p.odoo_id);
        const res = await api.post('/reposicion', { odoo_id: p.odoo_id, nota: `Cotización pendiente ${c.name}` });
        setTrabajando(null);
        if (!res.success) { onError(res.error || 'No se pudo marcar para reponer'); return; }
        marcarEnCola(p.odoo_id, res.data?.estado || 'pendiente');
        onAviso(`«${p.name}» entró a la cola de reposición.`);
        onCambioCola();
    };

    const deEmpresa = (company) => empresa === 'todas' || company === empresa;
    const cotizaciones = data.cotizaciones.filter(c => deEmpresa(c.company));
    const productos = data.productos.filter(p => deEmpresa(p.company));
    const cuenta = (e) => data.cotizaciones.filter(c => e === 'todas' || c.company === e).length;

    const chip = (activo) => ({
        border: `1px solid ${activo ? t.color.primary : t.color.border}`,
        background: activo ? t.color.primarySoft : t.color.surface,
        color: activo ? t.color.primary : t.color.textMuted,
        borderRadius: t.radius.full, padding: '0 12px', height: isMobile ? 36 : 30,
        fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, fontFamily: t.font.family,
        cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, ...t.numericStyle,
    });

    const vacia = vista === 'productos' ? productos.length === 0 : cotizaciones.length === 0;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[4] }}>
            <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: t.space[3], flexWrap: 'wrap',
                padding: isMobile ? '0 12px' : undefined,
            }}>
                <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap' }}>
                    <button type="button" style={chip(vista === 'cotizaciones')} onClick={() => setVista('cotizaciones')}>
                        <Icon.Tag size={13} /> Por cotización · {cotizaciones.length}
                    </button>
                    <button type="button" style={chip(vista === 'productos')} onClick={() => setVista('productos')}>
                        <Icon.Package size={13} /> Por producto · {productos.length}
                    </button>
                </div>
                <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap' }}>
                    {[['todas', 'Todas'], ['neggo', 'Neggo'], ['preventas', 'Preventas']].map(([v, label]) => (
                        <button key={v} type="button" style={chip(empresa === v)} onClick={() => setEmpresa(v)}>
                            {label} {cuenta(v)}
                        </button>
                    ))}
                </div>
            </div>

            <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family, marginTop: -4, padding: isMobile ? '0 12px' : undefined }}>
                Cotizaciones de Odoo en borrador o enviadas con la etiqueta «{data.etiqueta}»: encargues de clientes y mercadería que faltó en un pedido. Hay que conseguirla para entregarla.
            </div>

            {loading ? (
                <Card><div style={{ padding: 40, textAlign: 'center', color: t.color.textMuted, fontFamily: t.font.family }}>Leyendo cotizaciones de Odoo…</div></Card>
            ) : vacia ? (
                <Card>
                    <div style={{ padding: isMobile ? 28 : 40, textAlign: 'center', fontFamily: t.font.family, maxWidth: 380, margin: '0 auto' }}>
                        <div style={{ width: 48, height: 48, borderRadius: '50%', background: t.color.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', color: t.color.textMuted }}>
                            <Icon.Check size={22} />
                        </div>
                        <div style={{ fontSize: 15, fontWeight: t.font.weight.medium, color: t.color.text }}>
                            No hay cotizaciones pendientes
                        </div>
                        <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 4 }}>
                            Cuando una cotización lleve la etiqueta «{data.etiqueta}» en Odoo, aparece acá. Tocá «Actualizar» para volver a leer.
                        </div>
                    </div>
                </Card>
            ) : vista === 'productos' ? (
                <VistaProductos productos={productos} isMobile={isMobile} t={t} />
            ) : (
                cotizaciones.map(c => (
                    <TarjetaCotizacion
                        key={c.odoo_order_id}
                        c={c}
                        abierta={abiertas.has(c.odoo_order_id)}
                        onToggle={() => toggle(c.odoo_order_id)}
                        trabajando={trabajando}
                        onReponer={reponer}
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
        </div>
    );
}
