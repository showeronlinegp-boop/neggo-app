// Ofertas web de un producto en la tabla maestra (nota 107). Lo usan Reposición y Comparar compras.
import { useState } from 'react';
import { fmtAR } from '../../theme/tokens';
import Badge from '../common/Badge';
import * as Icon from '../common/icons';

// Ofertas web vinculadas al producto (tabla maestra): el más económico, si conviene otro
// proveedor y, desplegable, todas. Precio por unidad sin IVA, comparable con el costo de Odoo.
export default function OfertasProducto({ ofertas, t }) {
    const [abierto, setAbierto] = useState(false);
    if (!ofertas || !ofertas.ofertas?.length) return null;
    const me = ofertas.mas_economico;
    const conv = ofertas.conviene;
    const fmtPct = (n) => `${n > 0 ? '+' : ''}${String(n).replace('.', ',')} %`;
    return (
        <div style={{ marginTop: 6, fontSize: t.font.size.xs, fontFamily: t.font.family, color: t.color.textMuted }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                {me ? (
                    <span title="Oferta web disponible más barata, por unidad, sin IVA y con el descuento del proveedor">
                        Más económico: <strong style={{ color: t.color.text }}>{me.proveedor}</strong>
                        {' · '}<span style={t.numericStyle}>{fmtAR(me.precio)}</span>{me.pack > 1 ? ` c/u (pack ${me.pack})` : ' c/u'}
                        {ofertas.pct_vs_costo != null && ofertas.pct_vs_costo !== 0 && (
                            <span style={t.numericStyle}> · {fmtPct(ofertas.pct_vs_costo)} vs. costo</span>
                        )}
                    </span>
                ) : (
                    <span>Sin ofertas web disponibles</span>
                )}
                {me?.precio_viejo && <Badge tone="warn">Precio viejo</Badge>}
                {conv && (
                    <Badge tone="success">
                        Conviene {conv.proveedor} ({fmtPct(conv.pct)}{conv.contra === 'costo_actual' ? ' vs. costo' : ''})
                    </Badge>
                )}
                <button type="button" onClick={() => setAbierto(a => !a)}
                    style={{
                        border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: t.color.primary,
                        fontSize: t.font.size.xs, fontFamily: t.font.family, display: 'inline-flex', alignItems: 'center', gap: 2,
                    }}>
                    {abierto ? 'Ocultar' : `Ver ${ofertas.ofertas.length === 1 ? 'oferta' : `${ofertas.ofertas.length} ofertas`}`}
                    <span style={{ display: 'inline-flex', transform: abierto ? 'rotate(180deg)' : undefined }}><Icon.ChevronDown size={12} /></span>
                </button>
            </div>
            {abierto && (
                <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {ofertas.ofertas.map(o => (
                        <div key={o.supplier_product_id} style={{
                            display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
                            padding: '4px 8px', borderRadius: t.radius.sm, background: t.color.surface2,
                            opacity: o.disponible ? 1 : 0.6,
                        }}>
                            <span style={{ fontWeight: t.font.weight.semibold, color: t.color.text }}>{o.proveedor}</span>
                            {o.es_principal && <Badge tone="primary">Principal</Badge>}
                            <span style={{ flex: 1, minWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={o.nombre}>
                                {o.url
                                    ? <a href={o.url} target="_blank" rel="noreferrer" style={{ color: t.color.textMuted }}>{o.nombre}</a>
                                    : o.nombre}
                            </span>
                            <span style={{ ...t.numericStyle, color: t.color.text }}>{fmtAR(o.precio)}{o.pack > 1 ? ` (pack ${o.pack})` : ''}</span>
                            {!o.disponible && <Badge tone="muted">No disponible</Badge>}
                            {o.disponible && o.precio_viejo && <Badge tone="warn">Precio viejo</Badge>}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
