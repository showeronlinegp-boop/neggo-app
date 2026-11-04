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

function EstadoCola({ p, company, conSeparado = false }) {
    if (company !== 'neggo') return null;
    if (p.llego) return <Llego llego={p.llego} />;
    if (conSeparado && p.separado) return <Badge tone="success" dot>Separado</Badge>;
    // Por proveedor: una cotización llegó y otra está separada, no falta nada
    if (conSeparado && p.qty_falta === 0) return <Badge tone="success" dot>Está todo</Badge>;
    if (p.en_cache === false) return <Badge tone="muted">No está en Neggo</Badge>;
    if (p.es_liquidar) return <Badge tone="muted">Liquidar</Badge>;
    if (p.estado_cola === 'encargado') return <Badge tone="accent" dot>Encargado</Badge>;
    if (p.estado_cola === 'pendiente') return <Badge tone="warn" dot>En la cola</Badge>;
    return null;
}

function puedeReponer(p, company) {
    return company === 'neggo' && !!p.puede_reponer;
}

/** Lo que falta conseguir de un producto: sin lo que ya llegó o está separado (Preventas: todo). */
function qtyPedir(p) {
    return p.company === 'neggo' && p.qty_falta != null ? p.qty_falta : p.qty_total;
}

/** Se puede archivar en Odoo: de Neggo, conocido, activo y no Liquidar. */
function puedeArchivar(p, company) {
    return company === 'neggo' && p.en_cache !== false && p.active !== false && !p.es_liquidar;
}

/**
 * Botón que pide confirmar en el mismo lugar: el primer toque lo arma y el segundo hace la
 * acción. Si no se confirma en 4 segundos, vuelve solo.
 */
function BotonConfirmar({ texto, confirmar, icono, onConfirm, disabled, title, variant = 'ghost', style }) {
    const [armado, setArmado] = useState(false);
    useEffect(() => {
        if (!armado) return undefined;
        const id = setTimeout(() => setArmado(false), 4000);
        return () => clearTimeout(id);
    }, [armado]);
    return (
        <Button size="sm" variant={armado ? 'danger' : variant} leftIcon={icono} disabled={disabled} title={title}
            onClick={(e) => {
                e.stopPropagation();
                if (!armado) { setArmado(true); return; }
                setArmado(false);
                onConfirm();
            }}
            style={style}>
            {armado ? confirmar : texto}
        </Button>
    );
}

/** Cotización de Neggo con cada producto ya ingresado o separado para el cliente. */
function estaLista(c) {
    return c.company === 'neggo' && c.productos.length > 0 && (c.n_listos ?? c.n_llegados) === c.productos.length;
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

function FilaProducto({ p, company, busy, onReponer, onSeparar, onQuitar, onArchivar, onVerFoto, isMobile, t }) {
    const deNeggo = company === 'neggo';
    const listo = p.llego || p.separado;
    const btnMobile = isMobile ? { height: 40 } : undefined;
    return (
        <div style={{
            display: 'flex', alignItems: isMobile ? 'stretch' : 'center', gap: t.space[3],
            flexDirection: isMobile ? 'column' : 'row',
            padding: isMobile ? '10px 12px' : '8px 16px',
            borderTop: `1px solid ${t.color.border}`,
            background: listo ? t.color.successSoft : undefined,
            fontFamily: t.font.family,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: t.space[3], flex: 1, minWidth: 0 }}>
                {deNeggo && (
                    <label title="Ya está separado para el cliente: no se vuelve a pedir"
                        style={{
                            display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 2, flexShrink: 0,
                            cursor: busy ? 'default' : 'pointer', fontSize: 10, color: p.separado ? t.color.success : t.color.textMuted,
                            fontWeight: t.font.weight.medium, minWidth: 52,
                        }}>
                        <input type="checkbox" checked={!!p.separado} disabled={busy}
                            onChange={(e) => onSeparar(p, e.target.checked)}
                            aria-label={`Marcar ${p.name} como separado`}
                            style={{ width: isMobile ? 22 : 18, height: isMobile ? 22 : 18, margin: 0, cursor: 'inherit', accentColor: t.color.success }} />
                        Separado
                    </label>
                )}
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
                justifyContent: 'flex-end', minWidth: isMobile ? undefined : 180, flexWrap: 'wrap',
            }}>
                <EstadoCola p={p} company={company} />
                {deNeggo && !p.llego && p.qty_llegada > 0 && (
                    <Badge tone="success">Llegaron {fmtInt(p.qty_llegada)} de {fmtInt(p.qty)}</Badge>
                )}
                {deNeggo && p.active === false && !p.llego && <Badge tone="muted">Archivado</Badge>}
                {puedeReponer(p, company) && (
                    <Button size="sm" variant="primary" leftIcon={<Icon.Plus size={13} />} disabled={busy}
                        onClick={() => onReponer(p)} style={isMobile ? { flex: 1, height: 40 } : undefined}>
                        Reponer
                    </Button>
                )}
                {deNeggo && puedeArchivar(p, company) && (
                    <BotonConfirmar texto="Archivar" confirmar="¿Archivar en Odoo?" icono={<Icon.Archive size={13} />}
                        disabled={busy} onConfirm={() => onArchivar(p)} style={btnMobile}
                        title="Archiva el producto en Odoo (agotado) y lo mete en la cola de reposición" />
                )}
                {deNeggo && (
                    <BotonConfirmar texto="Quitar" confirmar="¿Quitar de la cotización?" icono={<Icon.Trash2 size={13} />}
                        disabled={busy} onConfirm={() => onQuitar(p)} style={btnMobile}
                        title="Borra este producto de la cotización en Odoo" />
                )}
            </div>
        </div>
    );
}

function TarjetaCotizacion({ c, abierta, onToggle, trabajando, onReponer, onSeparar, onQuitar, onArchivar, onCancelar, onVerFoto, isMobile, t }) {
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
                            <Badge tone="success" dot>Está todo · avisale al cliente</Badge>
                        ) : (
                            <>
                                {c.n_llegados > 0 && (
                                    <Badge tone="success">Llegaron {fmtInt(c.n_llegados)} de {fmtInt(c.productos.length)}</Badge>
                                )}
                                {c.n_separados > 0 && (
                                    <Badge tone="success">Separados {fmtInt(c.n_separados)} de {fmtInt(c.productos.length)}</Badge>
                                )}
                            </>
                        )}
                    </span>
                    {/* En el celular el cliente va en su propia línea: es lo que se busca con la vista */}
                    {isMobile && c.partner_name && (
                        <span style={{ display: 'block', fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.text, marginTop: 4 }}>
                            {c.partner_name}
                        </span>
                    )}
                    <span style={{ display: 'block', fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: 2, ...t.numericStyle }}>
                        {fmtFecha(c.date_order)}
                        {!isMobile && c.partner_name ? ` · ${c.partner_name}` : ''}
                        {c.origen ? ` · de ${c.origen}` : ''}
                        {isMobile ? ` · ${c.productos.length} prod. · ${fmtAR(c.amount_total)}` : ''}
                    </span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: t.space[2], flexShrink: 0 }}>
                    {!isMobile && <Badge tone="muted">{c.productos.length} prod.</Badge>}
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
                    onSeparar={(p, valor) => onSeparar(c, p, valor)}
                    onQuitar={(p) => onQuitar(c, p)}
                    onArchivar={onArchivar}
                    onVerFoto={onVerFoto}
                    isMobile={isMobile}
                    t={t}
                />
            ))}
            {abierta && c.company === 'neggo' && (
                <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: t.space[2], flexWrap: 'wrap',
                    padding: isMobile ? '10px 12px' : '8px 16px', borderTop: `1px solid ${t.color.border}`,
                    background: t.color.surface2, fontFamily: t.font.family,
                }}>
                    <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>
                        Tildá lo que ya separaste: deja de pedirse. «Quitar» y «Cancelar» cambian la cotización en Odoo.
                    </span>
                    <BotonConfirmar texto="Cancelar cotización" confirmar={`Sí, cancelar ${c.name} en Odoo`}
                        icono={<Icon.X size={13} />} variant="danger" disabled={trabajando}
                        onConfirm={() => onCancelar(c)} style={isMobile ? { height: 40, flex: 1 } : undefined}
                        title="Pasa la cotización a «Cancelado» en Odoo" />
                </div>
            )}
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

    // En el celular los botones ocupan todo el ancho, debajo del nombre del proveedor
    const btnMobile = isMobile ? { height: 40, flex: '1 1 auto' } : undefined;
    const tilde = { width: isMobile ? 22 : 16, height: isMobile ? 22 : 16, margin: 0, flexShrink: 0 };
    return (
        <Card padding={false} style={{ overflow: 'hidden' }}>
            <div style={{
                padding: isMobile ? '10px 12px' : '10px 16px', background: t.color.surface2,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: t.space[2], flexWrap: 'wrap',
                fontFamily: t.font.family, ...t.numericStyle,
            }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: t.space[2], minWidth: 0, flexWrap: 'wrap', width: isMobile ? '100%' : undefined }}>
                    {reponibles.length > 0 && (
                        <input type="checkbox" checked={todos} onChange={alternarTodos} style={tilde}
                            aria-label={`Tildar todo lo de ${vendor} sin pedir`} title="Tildar todo lo sin pedir" />
                    )}
                    <span style={{ fontWeight: t.font.weight.semibold, color: t.color.text, fontSize: t.font.size.sm }}>{vendor}</span>
                    <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>
                        {items.length} producto{items.length === 1 ? '' : 's'}
                        {reponibles.length > 0 ? ` · ${reponibles.length} sin pedir` : ''}
                    </span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: t.space[2], flexWrap: 'wrap', width: isMobile ? '100%' : undefined }}>
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
                        display: 'flex', alignItems: 'center', gap: isMobile ? `${t.space[2]}px ${t.space[3]}px` : t.space[3],
                        flexWrap: isMobile ? 'wrap' : 'nowrap',
                        padding: isMobile ? '10px 12px' : '8px 16px', borderTop: `1px solid ${t.color.border}`,
                        background: p.llego || p.separado || p.qty_falta === 0 ? t.color.successSoft : tildados.has(p.odoo_id) && reponible ? t.color.primarySoft : undefined,
                        fontFamily: t.font.family,
                    }}>
                        <span style={{ width: isMobile ? 22 : 16, flexShrink: 0, display: 'inline-flex' }}>
                            {reponible && (
                                <input type="checkbox" checked={tildados.has(p.odoo_id)} onChange={() => alternar(p.odoo_id)}
                                    style={tilde} aria-label={`Tildar ${p.name}`} />
                            )}
                        </span>
                        <Thumb p={p} onVerFoto={onVerFoto} isMobile={isMobile} />
                        <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.text, overflowWrap: 'anywhere' }}>
                                {p.name || `Producto ${p.odoo_id}`}
                            </div>
                            <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, display: 'flex', flexWrap: 'wrap', gap: '0 8px', ...t.numericStyle }}>
                                <span style={{ fontFamily: t.font.mono }}>{p.internal_ref || '—'}</span>
                                <span>{p.cotizaciones.map(c => `${c.name}${c.partner_name ? ` (${c.partner_name})` : ''} × ${fmtInt(c.qty)}${c.separado ? ' (separado)' : ''}`).join(' · ')}</span>
                            </div>
                        </div>
                        {/* En el celular los estados y la cantidad bajan a otra línea para no apretar el nombre */}
                        <div style={{
                            display: 'flex', alignItems: 'center', gap: t.space[2], flexShrink: 0, flexWrap: 'wrap',
                            justifyContent: isMobile ? 'flex-start' : 'flex-end',
                            ...(isMobile ? { flexBasis: '100%', paddingLeft: 22 + 44 + t.space[3] * 2 } : null),
                        }}>
                            <Badge tone={empresa.tone}>{empresa.label}</Badge>
                            <EstadoCola p={p} company={p.company} conSeparado />
                            <span style={{
                                fontWeight: t.font.weight.semibold, color: t.color.text, fontSize: t.font.size.sm, minWidth: 48, textAlign: 'right',
                                marginLeft: isMobile ? 'auto' : undefined, ...t.numericStyle,
                            }}
                                title={qtyPedir(p) !== p.qty_total ? `Faltan ${fmtInt(qtyPedir(p))} de ${fmtInt(p.qty_total)}: el resto ya llegó o está separado` : undefined}>
                                × {fmtInt(qtyPedir(p))}
                                {qtyPedir(p) !== p.qty_total && (
                                    <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontWeight: t.font.weight.regular }}> de {fmtInt(p.qty_total)}</span>
                                )}
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

    // Nota 150: separado (solo en la app), quitar producto / cancelar cotización / archivar (Odoo)
    const accion = async (fn, mensajeError) => {
        setTrabajando(true);
        const res = await fn();
        setTrabajando(false);
        if (!res.success) { onError(res.error || mensajeError); return null; }
        return res.data || {};
    };

    const separar = async (c, p, separado) => {
        // Se ve tildado al instante; si falla, la recarga lo deja como estaba
        setData(prev => ({
            ...prev,
            cotizaciones: prev.cotizaciones.map(x => x.odoo_order_id !== c.odoo_order_id ? x : {
                ...x,
                productos: x.productos.map(y => y.odoo_id === p.odoo_id ? { ...y, separado: separado ? { at: new Date().toISOString() } : null } : y),
            }),
        }));
        const res = await api.post('/reposicion/cotizaciones/separado', {
            odoo_order_id: c.odoo_order_id, odoo_id: p.odoo_id, separado,
        });
        if (!res.success) onError(res.error || 'No se pudo marcar como separado');
        await cargar(false, true);
    };

    const quitar = async (c, p) => {
        const ok = await accion(
            () => api.post('/reposicion/cotizaciones/quitar', { odoo_order_id: c.odoo_order_id, odoo_id: p.odoo_id }),
            'No se pudo quitar el producto de la cotización'
        );
        if (!ok) return;
        onAviso(`«${p.name}» se quitó de ${c.name} en Odoo.`);
        await cargar(false, true);
    };

    const cancelar = async (c) => {
        const ok = await accion(
            () => api.post('/reposicion/cotizaciones/cancelar', { odoo_order_id: c.odoo_order_id }),
            'No se pudo cancelar la cotización'
        );
        if (!ok) return;
        onAviso(`${c.name} quedó cancelada en Odoo.`);
        await cargar(false, true);
    };

    const archivar = async (p) => {
        const ok = await accion(
            () => api.post('/reposicion/archivar', { odoo_id: p.odoo_id }),
            'No se pudo archivar el producto'
        );
        if (!ok) return;
        onAviso(`«${p.name}» quedó archivado en Odoo y entró a la cola de reposición.`);
        onCambioCola();
        await cargar(false, true);
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
            // Lo que ya llegó o está separado no se le pide al proveedor
            const aPedir = items.map(p => ({ ...p, qty: qtyPedir(p) })).filter(p => p.qty > 0);
            if (!aPedir.length) {
                onAviso(`No hay nada para pedirle a ${vendor}: ya llegó o está separado.`);
                return;
            }
            await descargarPedidoPDF(vendor, aPedir, { prefijo: 'cotizaciones' });
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
            flexShrink: 0, whiteSpace: 'nowrap',
        };
    };

    const vacia = vista === 'productos' ? productos.length === 0 : cotizaciones.length === 0;

    // En el celular los filtros van en una sola fila que se desliza de costado
    const filaChips = isMobile
        ? { display: 'flex', gap: t.space[2], flexWrap: 'nowrap', flexShrink: 0 }
        : { display: 'flex', gap: t.space[2], flexWrap: 'wrap' };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: isMobile ? t.space[3] : t.space[4] }}>
            <div style={{
                display: 'flex', justifyContent: isMobile ? 'flex-start' : 'space-between', alignItems: 'center', gap: t.space[3],
                flexWrap: isMobile ? 'nowrap' : 'wrap',
                padding: isMobile ? '0 12px 2px' : undefined,
                ...(isMobile ? { overflowX: 'auto', scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' } : null),
            }}>
                <div style={filaChips}>
                    <button type="button" style={chip(vista === 'cotizaciones')} onClick={() => setVista('cotizaciones')}>
                        <Icon.Tag size={13} /> Por cotización · {cotizaciones.length}
                    </button>
                    <button type="button" style={chip(vista === 'productos')} onClick={() => { setVista('productos'); setSoloListas(false); }}>
                        <Icon.Truck size={13} /> Por proveedor · {productos.length}
                    </button>
                    {vista === 'cotizaciones' && nListas > 0 && (
                        <button type="button" style={chip(soloListas, 'success')} onClick={() => setSoloListas(v => !v)}
                            title="Cotizaciones de Neggo con todo ya ingresado o separado">
                            <Icon.PackageDown size={13} /> Está todo · {nListas}
                        </button>
                    )}
                </div>
                {isMobile && <span style={{ width: 1, alignSelf: 'stretch', background: t.color.border, flexShrink: 0 }} />}
                <div style={filaChips}>
                    {[['todas', 'Todas'], ['neggo', 'Neggo'], ['preventas', 'Preventas']].map(([v, label]) => (
                        <button key={v} type="button" style={chip(empresa === v)} onClick={() => setEmpresa(v)}>
                            {label} {cuenta(v)}
                        </button>
                    ))}
                </div>
            </div>

            <div style={{
                fontSize: isMobile ? t.font.size.xs : t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family,
                marginTop: -4, padding: isMobile ? '0 12px' : undefined,
            }}>
                {soloListas
                    ? 'Cotizaciones de Neggo con todo ya ingresado o separado: avisale al cliente y confirmá la cotización en Odoo.'
                    : isMobile
                        ? `Encargues de clientes con la etiqueta «${data.etiqueta}». Lo de Neggo se manda a reponer; Preventas solo se ve.`
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
                                ? 'Cuando todo lo de una cotización entre en un ingreso o esté separado, aparece acá.'
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
                        onSeparar={separar}
                        onQuitar={quitar}
                        onArchivar={archivar}
                        onCancelar={cancelar}
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
