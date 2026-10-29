// Comparar compras (nota 107, punto 6): solo lectura sobre la tabla maestra de Neggo.
// "Comparar": productos con ofertas web confirmadas (más económico y si conviene otro proveedor).
// "Se vende y no tiene oferta": lo vendido sin oferta web disponible, con el motivo.
// No cambia el habitual ni escribe en Odoo.
import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR, fmtInt } from '../../theme/tokens';
import Tabs from '../../components/common/Tabs';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Input from '../../components/common/Input';
import ProductThumb from '../../components/common/ProductThumb';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import * as Icon from '../../components/common/icons';
import OfertasProducto from '../../components/tablaMaestra/OfertasProducto';

// Filas que se muestran de entrada en "Se vende y no tiene oferta" (son más de mil)
const FILAS_POR_TANDA = 200;

const MOTIVOS = {
    no_disponible:     { label: 'Oferta no disponible',     tone: 'warn',    ayuda: 'Tiene oferta vinculada, pero sin stock en la web del proveedor.' },
    sugerido:          { label: 'Para confirmar',           tone: 'primary', ayuda: 'Hay ofertas sugeridas esperando en Vincular.' },
    no_encontrada:     { label: 'No está vinculada',        tone: 'accent',  ayuda: 'Su proveedor tiene web, pero no hay oferta vinculada (puede no estar publicada).' },
    proveedor_sin_web: { label: 'Proveedor sin web',        tone: 'muted',   ayuda: 'Su proveedor principal no tiene web scrapeada (o no publica precios).' },
    sin_proveedor:     { label: 'Sin proveedor en Odoo',    tone: 'muted',   ayuda: 'El producto no tiene proveedor principal cargado en Odoo.' },
};

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const coincide = (p, q) => !q || `${p.name || ''} ${p.internal_ref || ''}`.toLowerCase().includes(q);

export default function CompararCompras() {
    const { tokens: t } = useTheme();
    const { showToast } = useToast();
    const [tab, setTab] = useState('comparar');
    const [datos, setDatos] = useState(null);
    const [sinOferta, setSinOferta] = useState(null);

    useEffect(() => {
        api.get('/mappings/comparar').then(res => {
            if (res.success) setDatos(res.data);
            else showToast(res.error || 'Error al cargar la comparación', 'error');
        });
        api.get('/mappings/comparar/sin-oferta').then(res => {
            if (res.success) setSinOferta(res.data || []);
            else showToast(res.error || 'Error al cargar lo que se vende sin oferta', 'error');
        });
    }, [showToast]);

    const m = datos?.metrica;
    const conCantidad = (label, n) => (n != null ? `${label} · ${fmtInt(n)}` : label);
    const tabs = [
        { value: 'comparar',   label: conCantidad('Comparar', datos?.productos?.length) },
        { value: 'sin_oferta', label: conCantidad('Se vende y no tiene oferta', sinOferta?.length) },
    ];

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>
            <Card padding={false} style={{ padding: t.space[5] }}>
                <div style={{ display: 'flex', gap: t.space[6], flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <Metrica tokens={t} titulo={`Top que hace el ${m ? Math.round(m.parte_top * 100) : 80} % de la venta`}
                        valor={m ? `${fmtInt(m.top_con_oferta)} de ${fmtInt(m.top)}` : '—'}
                        detalle={m ? `${pct(m.top_con_oferta, m.top)} % con oferta web disponible` : null} />
                    <Metrica tokens={t} titulo={`Todo lo vendido (${m?.semanas || 6} semanas)`}
                        valor={m ? `${fmtInt(m.vendidos_con_oferta)} de ${fmtInt(m.vendidos)}` : '—'}
                        detalle={m ? `${pct(m.vendidos_con_oferta, m.vendidos)} % con oferta web disponible` : null} />
                    <span style={{ flex: 1, minWidth: 220, fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family, lineHeight: 1.5 }}>
                        Solo para mirar: compara las ofertas web confirmadas en la tabla maestra (por unidad, sin IVA y con
                        el descuento del proveedor). Para sumar ofertas, confirmalas en <Link to="/productos/vinculos" style={{ color: t.color.primary }}>Vínculos Odoo</Link>.
                    </span>
                </div>
            </Card>

            <Tabs tabs={tabs} value={tab} onChange={setTab} style={{ overflowX: 'auto' }} />

            {tab === 'comparar' && (datos ? <Comparar tokens={t} productos={datos.productos} /> : <Cargando tokens={t} />)}
            {tab === 'sin_oferta' && (sinOferta ? <SinOferta tokens={t} filas={sinOferta} /> : <Cargando tokens={t} />)}
        </div>
    );
}

// ─── Comparar ────────────────────────────────────────────────────────────────────
function Comparar({ tokens: t, productos }) {
    const [buscar, setBuscar] = useState('');
    const [filtro, setFiltro] = useState('todos');

    const nVendidos = productos.filter(p => Number(p.venta) > 0).length;
    const nConviene = productos.filter(p => p.ofertas?.conviene).length;
    const q = buscar.trim().toLowerCase();
    const visibles = productos.filter(p =>
        coincide(p, q)
        && (filtro !== 'vendidos' || Number(p.venta) > 0)
        && (filtro !== 'conviene' || p.ofertas?.conviene));

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[4] }}>
            <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap', alignItems: 'center' }}>
                <Input value={buscar} onChange={e => setBuscar(e.target.value)} placeholder="Buscar por nombre o código"
                    leftIcon={<Icon.Search size={15} />} style={{ width: 260, maxWidth: '100%' }} />
                <Chip tokens={t} activo={filtro === 'todos'} onClick={() => setFiltro('todos')}>Todos · {fmtInt(productos.length)}</Chip>
                <Chip tokens={t} activo={filtro === 'vendidos'} onClick={() => setFiltro('vendidos')}>Se venden · {fmtInt(nVendidos)}</Chip>
                <Chip tokens={t} activo={filtro === 'conviene'} onClick={() => setFiltro('conviene')}>Conviene otro proveedor · {fmtInt(nConviene)}</Chip>
            </div>
            {!visibles.length ? <Vacio tokens={t} msg="No hay productos con ese filtro." /> : (
                <Card padding={false} style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: t.font.size.sm }}>
                        <thead>
                            <tr style={{ background: t.color.surface2 }}>
                                <Th tokens={t}>Producto de Neggo y ofertas</Th>
                                <Th tokens={t}>Principal en Odoo</Th>
                                <Th tokens={t} right>Venta 6 sem.</Th>
                                <Th tokens={t} right>Costo actual (Odoo)</Th>
                            </tr>
                        </thead>
                        <tbody>
                            {visibles.map(p => (
                                <tr key={p.odoo_id} style={{ borderTop: `1px solid ${t.color.border}` }}>
                                    <Td tokens={t}>
                                        <Producto tokens={t} p={p} />
                                        <div style={{ paddingLeft: 52 }}><OfertasProducto ofertas={p.ofertas} t={t} /></div>
                                    </Td>
                                    <Td tokens={t}><Principal tokens={t} nombre={p.vendor_name} /></Td>
                                    <Td tokens={t} right><Venta tokens={t} p={p} /></Td>
                                    <Td tokens={t} right><span style={{ ...t.numericStyle, color: t.color.textMuted }}>{Number(p.standard_price) ? fmtAR(p.standard_price) : '—'}</span></Td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </Card>
            )}
        </div>
    );
}

// ─── Se vende y no tiene oferta ──────────────────────────────────────────────────
function SinOferta({ tokens: t, filas }) {
    const [buscar, setBuscar] = useState('');
    const [soloTop, setSoloTop] = useState(true);
    const [motivo, setMotivo] = useState('');
    const [mostrar, setMostrar] = useState(FILAS_POR_TANDA);

    const base = soloTop ? filas.filter(f => f.en_top) : filas;
    const porMotivo = useMemo(() => {
        const cuenta = {};
        base.forEach(f => { cuenta[f.motivo] = (cuenta[f.motivo] || 0) + 1; });
        return cuenta;
    }, [base]);
    const q = buscar.trim().toLowerCase();
    const visibles = base.filter(f => coincide(f, q) && (!motivo || f.motivo === motivo));

    useEffect(() => { setMostrar(FILAS_POR_TANDA); }, [buscar, soloTop, motivo]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[4] }}>
            <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap', alignItems: 'center' }}>
                <Input value={buscar} onChange={e => setBuscar(e.target.value)} placeholder="Buscar por nombre o código"
                    leftIcon={<Icon.Search size={15} />} style={{ width: 260, maxWidth: '100%' }} />
                <Chip tokens={t} activo={soloTop} onClick={() => setSoloTop(true)}>Top 80 % de la venta</Chip>
                <Chip tokens={t} activo={!soloTop} onClick={() => setSoloTop(false)}>Todo lo vendido</Chip>
            </div>
            <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap' }}>
                <Chip tokens={t} activo={!motivo} onClick={() => setMotivo('')}>Todos · {fmtInt(base.length)}</Chip>
                {Object.entries(MOTIVOS).filter(([k]) => porMotivo[k]).map(([k, mo]) => (
                    <Chip key={k} tokens={t} activo={motivo === k} onClick={() => setMotivo(motivo === k ? '' : k)} title={mo.ayuda}>
                        {mo.label} · {fmtInt(porMotivo[k])}
                    </Chip>
                ))}
            </div>
            {motivo && (
                <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                    {MOTIVOS[motivo].ayuda}
                    {motivo === 'sugerido' && <> Confirmalas en <Link to="/productos/vinculos" style={{ color: t.color.primary }}>Vínculos Odoo</Link>.</>}
                </div>
            )}
            {!visibles.length ? <Vacio tokens={t} msg="No hay productos con ese filtro." /> : (
                <Card padding={false} style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: t.font.size.sm }}>
                        <thead>
                            <tr style={{ background: t.color.surface2 }}>
                                <Th tokens={t}>Producto de Neggo</Th>
                                <Th tokens={t}>Principal en Odoo</Th>
                                <Th tokens={t}>Por qué no tiene oferta</Th>
                                <Th tokens={t} right>Venta 6 sem.</Th>
                            </tr>
                        </thead>
                        <tbody>
                            {visibles.slice(0, mostrar).map(f => (
                                <tr key={f.odoo_id} style={{ borderTop: `1px solid ${t.color.border}` }}>
                                    <Td tokens={t}><Producto tokens={t} p={f} /></Td>
                                    <Td tokens={t}><Principal tokens={t} nombre={f.vendor_name} /></Td>
                                    <Td tokens={t}>
                                        <span title={MOTIVOS[f.motivo]?.ayuda}>
                                            <Badge tone={MOTIVOS[f.motivo]?.tone}>{MOTIVOS[f.motivo]?.label || f.motivo}</Badge>
                                        </span>
                                        {f.motivo === 'sugerido' && (
                                            <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: 4 }}>
                                                {f.sugeridos === 1 ? '1 sugerida' : `${fmtInt(f.sugeridos)} sugeridas`}
                                            </div>
                                        )}
                                    </Td>
                                    <Td tokens={t} right><Venta tokens={t} p={f} /></Td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {visibles.length > mostrar && (
                        <div style={{ padding: t.space[4], textAlign: 'center', borderTop: `1px solid ${t.color.border}` }}>
                            <button type="button" onClick={() => setMostrar(n => n + FILAS_POR_TANDA)} style={{
                                border: 'none', background: 'none', cursor: 'pointer', color: t.color.primary,
                                fontSize: t.font.size.sm, fontFamily: t.font.family,
                            }}>
                                Mostrar más ({fmtInt(visibles.length - mostrar)} restantes)
                            </button>
                        </div>
                    )}
                </Card>
            )}
        </div>
    );
}

// ─── Piezas chicas ───────────────────────────────────────────────────────────────
function Producto({ tokens: t, p }) {
    return (
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', minWidth: 240 }}>
            <ProductThumb imageUrl={p.image_url} emoji={p.name} size={40} />
            <div style={{ minWidth: 0 }}>
                <div style={{ color: t.color.text, fontWeight: t.font.weight.medium, fontFamily: t.font.family }}>{p.name || '—'}</div>
                <div style={{ fontSize: t.font.size.xs, color: t.color.textFaint, marginTop: 2, fontFamily: t.font.mono }}>
                    {(p.internal_ref || '').trim() || '—'}
                </div>
                {p.active === false && <Badge tone="muted" style={{ marginTop: 4 }}>Archivado</Badge>}
            </div>
        </div>
    );
}

function Principal({ tokens: t, nombre }) {
    return nombre
        ? <span style={{ whiteSpace: 'nowrap' }}>{nombre}</span>
        : <span style={{ color: t.color.textFaint }}>sin principal</span>;
}

function Venta({ tokens: t, p }) {
    if (!Number(p.venta)) return <span style={{ color: t.color.textFaint }}>—</span>;
    return (
        <div style={t.numericStyle}>
            <div style={{ color: t.color.text }}>{fmtAR(p.venta)}</div>
            <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>{fmtInt(p.unidades)} u.</div>
        </div>
    );
}

function Metrica({ tokens: t, titulo, valor, detalle }) {
    return (
        <div style={{ minWidth: 180, fontFamily: t.font.family }}>
            <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>{titulo}</div>
            <div style={{ fontSize: t.font.size.xl, color: t.color.text, fontWeight: t.font.weight.semibold, marginTop: 2, ...t.numericStyle }}>{valor}</div>
            {detalle && <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: 2 }}>{detalle}</div>}
        </div>
    );
}

function Chip({ tokens: t, activo, onClick, title, children }) {
    return (
        <button type="button" onClick={onClick} title={title} style={{
            padding: '0 12px', height: 28, borderRadius: t.radius.full,
            border: `1px solid ${activo ? t.color.primary : t.color.border}`,
            background: activo ? t.color.primarySoft : t.color.surface,
            color: activo ? t.color.primary : t.color.textMuted,
            fontSize: t.font.size.xs, fontWeight: t.font.weight.medium, fontFamily: t.font.family,
            cursor: 'pointer', whiteSpace: 'nowrap', ...t.numericStyle,
        }}>
            {children}
        </button>
    );
}

function Th({ children, tokens: t, right }) {
    return (
        <th style={{
            padding: '10px 14px', textAlign: right ? 'right' : 'left',
            fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, color: t.color.textMuted,
            textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap', fontFamily: t.font.family,
        }}>
            {children}
        </th>
    );
}

function Td({ children, tokens: t, right }) {
    return (
        <td style={{ padding: '10px 14px', color: t.color.text, fontFamily: t.font.family, textAlign: right ? 'right' : 'left', verticalAlign: 'top' }}>
            {children}
        </td>
    );
}

function Cargando({ tokens: t }) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><LoadingSpinner size="md" color={t.color.primary} /></div>;
}

function Vacio({ tokens: t, msg }) {
    return (
        <div style={{ padding: '40px 24px', textAlign: 'center', fontSize: t.font.size.sm, color: t.color.textFaint, fontFamily: t.font.family }}>
            {msg}
        </div>
    );
}
