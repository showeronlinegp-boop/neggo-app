import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR, fmtInt } from '../../theme/tokens';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import ProductThumb from '../../components/common/ProductThumb';
import FotoAmpliada from '../../components/common/FotoAmpliada';
import * as Icon from '../../components/common/icons';
import { descargarPedidoPDF } from './pedidoPdf';

// Pestaña «Cotizaciones» de Reposición: cotizaciones de Odoo con la etiqueta «Pendiente»
// (encargues de clientes y mercadería que faltó en un pedido), de Neggo y de Preventas.
// Se ven por cotización o por proveedor. Lo de Neggo que no está en la cola se manda a
// reponer desde acá (de a uno o en lote, con la cantidad del cliente) y lo que ya llegó
// en un ingreso queda marcado para avisarle al cliente (nota 149). Preventas solo se ve.

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

function Llego({ llego }) {
    if (!llego) return null;
    return (
        <Link to={`/ingreso/${llego.ingreso_id}`} title="Ver el ingreso" onClick={e => e.stopPropagation()}
            style={{ textDecoration: 'none', display: 'inline-flex' }}>
            <Badge tone="success" dot>Llegó · {llego.comprobante || `ingreso #${llego.ingreso_id}`}</Badge>
        </Link>
    );
}

function EstadoCola({ p, company }) {
    if (company !== 'neggo') return null;
    if (p.llego) return <Llego llego={p.llego} />;
    if (p.en_cache === false) return <Badge tone="muted">No está en Neggo</Badge>;
    if (p.es_liquidar) return <Badge tone="muted">Liquidar</Badge>;
    if (p.estado_cola === 'encargado') return <Badge tone="accent" dot>Encargado</Badge>;
    if (p.estado_cola === 'pendiente') return <Badge tone="warn" dot>En la cola</Badge>;
    return null;
}

function puedeReponer(p, company) {
    return company === 'neggo' && !!p.puede_reponer;
}

/** Cotización de Neggo con todo lo que faltaba ya ingresado. */
function estaLista(c) {
    return c.company === 'neggo' && c.productos.length > 0 && c.n_llegados === c.productos.length;
}

function Thumb({ p, onVerFoto, isMobile }) {
    if (!p.image_url) return <ProductThumb imageUrl={p.image_url} size={isMobile ? 44 : 36} />;
    return (
        <button type="button" onClick={() => onVerFoto(p)} aria-label={`Ver foto de ${p.name}`} title="Ver foto en grande"
            style={{ padding: 0, border: 'none', background: 'none', cursor: 'zoom-in', lineHeight: 0, flexShrink: 0 }}>
            <ProductThumb imageUrl={p.image_url} size={isMobile ? 44 : 36} />
        </button>
    );
}

function FilaProducto({ p, company, busy, onReponer, onVerFoto, isMobile, t }) {
    return (
        <div style={{
            display: 'flex', alignItems: isMobile ? 'stretch' : 'center', gap: t.space[3],
            flexDirection: isMobile ? 'column' : 'row',
            padding: isMobile ? '10px 12px' : '8px 16px',
            borderTop: `1px solid ${t.color.border}`,
            background: p.llego ? t.color.successSoft : undefined,
            fontFamily: t.font.family,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: t.space[3], flex: 1, minWidth: 0 }}>
                <Thumb p={p} onVerFoto={onVerFoto} isMobile={isMobile} />
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
    const lista = estaLista(c);
    return (
        <Card padding={false} style={{ overflow: 'hidden', borderLeft: lista ? `3px solid ${t.color.success}` : undefined }}>
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
                        {lista ? (
                            <Badge tone="success" dot>Llegó todo · avisale al cliente</Badge>
                        ) : c.n_llegados > 0 ? (
                            <Badge tone="success">Llegaron {fmtInt(c.n_llegados)} de {fmtInt(c.productos.length)}</Badge>
                        ) : null}
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
                    busy={trabajando}
                    onReponer={onReponer}
                    onVerFoto={onVerFoto}
                    isMobile={isMobile}
                    t={t}
                />
            ))}
        </Card>
    );
}

// Total por producto, agrupado por proveedor: lo que hay que conseguir.
// Lo de Neggo sin pedir se tilda y se manda a la cola en lote, o se arma el pedido directo.
// Cada proveedor baja su pedido en PDF con el total de cada producto.
function GrupoProveedor({ vendor, items, generando, trabajando, onPdf, onReponerLote, onArmar, onVerFoto, isMobile, t }) {
    const [tildados, setTildados] = useState(() => new Set());
    const reponibles = items.filter(p => puedeReponer(p, p.company));
    const elegidos = reponibles.filter(p => tildados.has(p.odoo_id));
    const aMandar = elegidos.length ? elegidos : reponibles;
    const hayNeggo = items.some(p => p.company === 'neggo' && (p.puede_reponer || p.estado_cola === 'pendiente'));
    const todos = reponibles.length > 0 && elegidos.length === reponibles.length;

    const alternar = (id) => setTildados(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });
    const alternarTodos = () => setTildados(todos ? new Set() : new Set(reponibles.map(p => p.odoo_id)));

    const mandar = async () => {
        const ok = await onReponerLote(aMandar.map(p => p.odoo_id), vendor);
        if (ok) setTildados(new Set());
    };

    const btnMobile = isMobile ? { height: 36 } : undefined;
    return (
        <Card padding={false} style={{ overflow: 'hidden' }}>
            <div style={{
                padding: isMobile ? '10px 12px' : '10px 16px', background: t.color.surface2,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: t.space[2], flexWrap: 'wrap',
                fontFamily: t.font.family, ...t.numericStyle,
            }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: t.space[2], minWidth: 0 }}>
                    {reponibles.length > 0 && (
                        <input type="checkbox" checked={todos} onChange={alternarTodos}
                            aria-label={`Tildar todo lo de ${vendor} sin pedir`} title="Tildar todo lo sin pedir" />
                    )}
                    <span style={{ fontWeight: t.font.weight.semibold, color: t.color.text, fontSize: t.font.size.sm }}>{vendor}</span>
                    <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>
                        {items.length} producto{items.length === 1 ? '' : 's'}
                        {reponibles.length > 0 ? ` · ${reponibles.length} sin pedir` : ''}
                    </span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: t.space[2], flexWrap: 'wrap' }}>
                    {reponibles.length > 0 && (
                        <Button size="sm" variant="primary" leftIcon={<Icon.Plus size={13} />} disabled={trabajando}
                            title="Mete a la cola de reposición lo de Neggo sin pedir, con la cantidad que esperan los clientes"
                            onClick={mandar} style={btnMobile}>
                            Mandar a reponer ({aMandar.length})
                        </Button>
                    )}
                    {hayNeggo && (
                        <Button size="sm" variant="secondary" leftIcon={<Icon.ShoppingCart size={13} />} disabled={trabajando}
                            title="Manda a la cola lo sin pedir de este proveedor y abre Armar pedido"
                            onClick={() => onArmar(vendor, reponibles.map(p => p.odoo_id))} style={btnMobile}>
                            Armar pedido
                        </Button>
                    )}
                    <Button size="sm" variant="ghost" leftIcon={<Icon.FileText size={13} />}
                        disabled={generando === vendor}
                        title="Descargar el pedido en PDF para encargarle al proveedor, con el total de cada producto"
                        onClick={() => onPdf(vendor, items)}
                        style={btnMobile}>
                        {generando === vendor ? 'Generando…' : 'PDF'}
                    </Button>
                </span>
            </div>
            {items.map(p => {
                const empresa = EMPRESA[p.company] || EMPRESA.neggo;
                const reponible = puedeReponer(p, p.company);
                return (
                    <div key={`${p.company}|${p.odoo_id}`} style={{
                        display: 'flex', alignItems: 'center', gap: t.space[3],
                        padding: isMobile ? '10px 12px' : '8px 16px', borderTop: `1px solid ${t.color.border}`,
                        background: p.llego ? t.color.successSoft : tildados.has(p.odoo_id) && reponible ? t.color.primarySoft : undefined,
                        fontFamily: t.font.family,
                    }}>
                        <span style={{ width: 16, flexShrink: 0, display: 'inline-flex' }}>
                            {reponible && (
                                <input type="checkbox" checked={tildados.has(p.odoo_id)} onChange={() => alternar(p.odoo_id)}
                                    aria-label={`Tildar ${p.name}`} />
                            )}
                        </span>
                        <Thumb p={p} onVerFoto={onVerFoto} isMobile={isMobile} />
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
                            <EstadoCola p={p} company={p.company} />
                            <span style={{ fontWeight: t.font.weight.semibold, color: t.color.text, fontSize: t.font.size.sm, minWidth: 48, textAlign: 'right', ...t.numericStyle }}>
                                × {fmtInt(p.qty_total)}
                            </span>
                        </div>
                    </div>
                );
            })}
        </Card>
    );
}

function VistaProductos({ productos, ...resto }) {
    const grupos = [];
    for (const p of productos) {
        const ultimo = grupos[grupos.length - 1];
        if (ultimo && ultimo.vendor === p.vendor_name) ultimo.items.push(p);
        else grupos.push({ vendor: p.vendor_name, items: [p] });
    }
    return grupos.map(g => <GrupoProveedor key={g.vendor} vendor={g.vendor} items={g.items} {...resto} />);
}

export default function ReposicionCotizaciones({ recargar, filtroInicial = null, onArmarPedido, onCambioCola, onAviso, onError, isMobile }) {
    const { tokens: t } = useTheme();
    const [data, setData] = useState({ cotizaciones: [], productos: [], etiqueta: 'Pendiente' });
    const [loading, setLoading] = useState(true);
    const [vista, setVista] = useState('cotizaciones');
    const [empresa, setEmpresa] = useState(filtroInicial === 'listas' ? 'neggo' : 'todas');
    const [soloListas, setSoloListas] = useState(filtroInicial === 'listas');
    const [abiertas, setAbiertas] = useState(() => new Set());
    const [trabajando, setTrabajando] = useState(false);
    const [foto, setFoto] = useState(null);
    const cerrarFoto = useCallback(() => setFoto(null), []);

    // Desde el bloque de Pendientes: «avisale al cliente» abre las que ya tienen todo
    useEffect(() => {
        if (filtroInicial !== 'listas') return;
        setVista('cotizaciones');
        setEmpresa('neggo');
        setSoloListas(true);
    }, [filtroInicial]);

    const cargar = useCallback(async (refrescar = false, silencioso = false) => {
        if (!silencioso) setLoading(true);
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

    // Manda a la cola con la cantidad que esperan los clientes. Devuelve true si salió bien.
    const reponerLote = async (odooIds, vendor = null) => {
        if (!odooIds.length) return true;
        setTrabajando(true);
        const res = await api.post('/reposicion/cotizaciones/reponer', { odoo_ids: odooIds });
        setTrabajando(false);
        if (!res.success) { onError(res.error || 'No se pudo mandar a la cola'); return false; }
        const { agregados = [], errores = [] } = res.data || {};
        const de = vendor ? ` de ${vendor}` : '';
        const texto = agregados.length === 1
            ? `«${agregados[0].name}» entró a la cola con ${fmtInt(agregados[0].qty)} u.`
            : `${fmtInt(agregados.length)} productos${de} entraron a la cola con la cantidad que esperan los clientes.`;
        onAviso(errores.length ? `${texto} ${errores.length} no se pudo: ${errores[0].error}` : texto);
        onCambioCola();
        await cargar(false, true);
        return true;
    };

    const armar = async (vendor, odooIds) => {
        const ok = await reponerLote(odooIds, vendor);
        if (ok && onArmarPedido) onArmarPedido(vendor);
    };

    // Pedido al proveedor: total pendiente de cada producto y de qué cotizaciones sale
    const [generandoPdf, setGenerandoPdf] = useState(null);
    const pdfProveedor = async (vendor, items) => {
        setGenerandoPdf(vendor);
        try {
            await descargarPedidoPDF(vendor, items.map(p => ({ ...p, qty: p.qty_total })), { prefijo: 'cotizaciones' });
        } catch (err) {
            onError(err.message || 'No se pudo generar el PDF');
        } finally {
            setGenerandoPdf(null);
        }
    };

    const deEmpresa = (company) => empresa === 'todas' || company === empresa;
    const cotizaciones = data.cotizaciones.filter(c => deEmpresa(c.company) && (!soloListas || estaLista(c)));
    const productos = data.productos.filter(p => deEmpresa(p.company));
    const cuenta = (e) => data.cotizaciones.filter(c => e === 'todas' || c.company === e).length;
    const nListas = data.cotizaciones.filter(estaLista).length;

    const chip = (activo, tono = 'primary') => {
        const color = tono === 'success' ? t.color.success : t.color.primary;
        const soft = tono === 'success' ? t.color.successSoft : t.color.primarySoft;
        return {
            border: `1px solid ${activo ? color : t.color.border}`,
            background: activo ? soft : t.color.surface,
            color: activo ? color : t.color.textMuted,
            borderRadius: t.radius.full, padding: '0 12px', height: isMobile ? 36 : 30,
            fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, fontFamily: t.font.family,
            cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, ...t.numericStyle,
        };
    };

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
                    <button type="button" style={chip(vista === 'productos')} onClick={() => { setVista('productos'); setSoloListas(false); }}>
                        <Icon.Truck size={13} /> Por proveedor · {productos.length}
                    </button>
                    {vista === 'cotizaciones' && nListas > 0 && (
                        <button type="button" style={chip(soloListas, 'success')} onClick={() => setSoloListas(v => !v)}
                            title="Cotizaciones de Neggo con todo lo que faltaba ya ingresado">
                            <Icon.PackageDown size={13} /> Llegó todo · {nListas}
                        </button>
                    )}
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
                {soloListas
                    ? 'Cotizaciones de Neggo con todo lo que faltaba ya ingresado: avisale al cliente y confirmá la cotización en Odoo.'
                    : `Cotizaciones de Odoo en borrador o enviadas con la etiqueta «${data.etiqueta}»: encargues de clientes y mercadería que faltó en un pedido. Lo de Neggo se manda a reponer con la cantidad del cliente; Preventas solo se ve.`}
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
                            {soloListas ? 'Ninguna cotización tiene todo todavía' : 'No hay cotizaciones pendientes'}
                        </div>
                        <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 4 }}>
                            {soloListas
                                ? 'Cuando entre en un ingreso todo lo que falta de una cotización, aparece acá.'
                                : `Cuando una cotización lleve la etiqueta «${data.etiqueta}» en Odoo, aparece acá. Tocá «Actualizar» para volver a leer.`}
                        </div>
                    </div>
                </Card>
            ) : vista === 'productos' ? (
                <VistaProductos productos={productos} generando={generandoPdf} trabajando={trabajando}
                    onPdf={pdfProveedor} onReponerLote={reponerLote} onArmar={armar}
                    onVerFoto={setFoto} isMobile={isMobile} t={t} />
            ) : (
                cotizaciones.map(c => (
                    <TarjetaCotizacion
                        key={c.odoo_order_id}
                        c={c}
                        abierta={abiertas.has(c.odoo_order_id)}
                        onToggle={() => toggle(c.odoo_order_id)}
                        trabajando={trabajando}
                        onReponer={(p) => reponerLote([p.odoo_id])}
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
