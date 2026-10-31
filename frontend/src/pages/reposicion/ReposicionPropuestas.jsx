import { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR, fmtInt } from '../../theme/tokens';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Select from '../../components/common/Select';
import ProductThumb from '../../components/common/ProductThumb';
import * as Icon from '../../components/common/icons';
import { descargarPedidoPDF } from './pedidoPdf';

// Propuestas de compra (plan de reposición automática, punto 6): el motor arma un pedido por
// proveedor eligiendo por costo total (precio, flete, pack y pedido mínimo). Acá se revisa:
// se puede cambiar la cantidad o mover un renglón a otro proveedor, y al aprobar se guarda el
// pedido, se descarga el PDF y sus productos pasan a Encargados.

const MOTIVO = {
    habitual:         { label: 'De siempre',      tone: 'muted' },
    mas_barato:       { label: 'Más barato',      tone: 'success' },
    minimo:           { label: 'Por el mínimo',   tone: 'accent' },
    unico:            { label: 'Única opción',    tone: 'muted' },
    manual:           { label: 'Cambiado a mano', tone: 'primary' },
    esperando_minimo: { label: 'Esperando mínimo', tone: 'warn' },
};

const totalRenglon = (r) => {
    const o = r.opciones[r.elegido];
    return o ? o.costo_unit * r.qty : 0;
};

// Pedidos por proveedor a partir de lo elegido en pantalla (mismo cálculo que el backend)
function agrupar(renglones, condiciones) {
    const porCanasta = new Map();
    for (const r of renglones) {
        if (r.elegido < 0) continue;
        const canasta = r.opciones[r.elegido].canasta;
        if (!porCanasta.has(canasta)) {
            porCanasta.set(canasta, { proveedor: canasta, condiciones: condiciones[canasta] || {}, renglones: [], total: 0 });
        }
        const c = porCanasta.get(canasta);
        c.renglones.push(r);
        c.total += totalRenglon(r);
    }
    return [...porCanasta.values()]
        .map(c => {
            const minimo = Number(c.condiciones.pedido_minimo) || 0;
            return { ...c, minimo, falta: minimo > c.total ? minimo - c.total : 0 };
        })
        .sort((a, b) => b.total - a.total);
}

export default function ReposicionPropuestas({ isMobile, recargar, onAviso, onError, onCambioCola }) {
    const { tokens: t } = useTheme();
    const [data, setData] = useState(null);
    const [renglones, setRenglones] = useState([]);
    const [loading, setLoading] = useState(true);
    const [aprobando, setAprobando] = useState(null);
    const [verNoReponer, setVerNoReponer] = useState(false);

    const cargar = useCallback(async () => {
        setLoading(true);
        const res = await api.get('/reposicion/propuestas');
        setLoading(false);
        if (!res.success) { onError?.(res.error || 'No se pudieron armar las propuestas'); return; }
        setData(res.data);
        setRenglones(res.data.renglones.map(r => ({
            ...r,
            qty: r.elegido >= 0 ? r.opciones[r.elegido].qty : r.qty_total,
        })));
    }, [onError]);

    useEffect(() => { cargar(); }, [cargar, recargar]);

    const condiciones = data?.condiciones || {};
    const pedidos = useMemo(() => agrupar(renglones, condiciones), [renglones, condiciones]);
    const esperando = renglones.filter(r => r.elegido < 0);

    const cambiar = (odooId, cambios) => setRenglones(prev => prev.map(r => (r.odoo_id === odooId ? { ...r, ...cambios } : r)));
    const moverA = (r, j) => {
        const o = r.opciones[j];
        // La cantidad se ajusta al pack del nuevo proveedor
        cambiar(r.odoo_id, { elegido: j, motivo: 'manual', qty: Math.ceil(Math.max(r.qty, 1) / o.pack) * o.pack });
    };

    const aprobar = async (pedido) => {
        setAprobando(pedido.proveedor);
        const filas = pedido.renglones.map(r => {
            const o = r.opciones[r.elegido];
            return {
                odoo_id: r.odoo_id, reposicion_item_id: r.reposicion_item_id, supplier_product_id: o.supplier_product_id,
                nombre: r.nombre, qty: r.qty, pack: o.pack, precio: o.precio, costo_unit: o.costo_unit,
                motivo: r.motivo, alternativa: r.alternativa,
            };
        });
        const res = await api.post('/reposicion/propuestas/aprobar', { proveedor: pedido.proveedor, solver: data.solver, renglones: filas });
        if (!res.success) { setAprobando(null); onError?.(res.error || 'No se pudo aprobar el pedido'); return; }
        try {
            await descargarPedidoPDF(pedido.proveedor, pedido.renglones.map(r => ({
                name: r.nombre, internal_ref: r.ref, standard_price: r.opciones[r.elegido].precio,
                qty: r.qty, image_url: r.image_url, cotizaciones: r.cotizaciones,
            })), { prefijo: 'propuesta' });
        } catch (err) {
            onError?.(`El pedido quedó aprobado pero no se pudo generar el PDF: ${err.message}`);
        }
        setAprobando(null);
        const ids = new Set(pedido.renglones.map(r => r.odoo_id));
        setRenglones(prev => prev.filter(r => !ids.has(r.odoo_id)));
        onAviso?.(`Pedido a ${pedido.proveedor} aprobado: ${fmtInt(res.data.renglones)} renglones, ${fmtInt(res.data.encargados)} pasaron a Encargados.`);
        onCambioCola?.();
    };

    if (loading && !data) {
        return <Card><div style={{ padding: 40, textAlign: 'center', color: t.color.textMuted, fontFamily: t.font.family }}>Armando los pedidos…</div></Card>;
    }
    if (!data) return null;

    const th = {
        padding: '8px 12px', textAlign: 'left', fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold,
        color: t.color.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em',
        background: t.color.surface2, fontFamily: t.font.family, whiteSpace: 'nowrap',
    };
    const td = {
        padding: '10px 12px', fontSize: t.font.size.sm, color: t.color.text, borderTop: `1px solid ${t.color.border}`,
        verticalAlign: 'middle', fontFamily: t.font.family,
    };
    const hint = { fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family };
    const r = data.resumen;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[4], padding: isMobile ? '0 12px' : undefined }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: t.space[3], flexWrap: 'wrap' }}>
                <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family, ...t.numericStyle }}>
                    <b style={{ color: t.color.text }}>{fmtInt(pedidos.length)}</b> pedidos ·{' '}
                    <b style={{ color: t.color.text }}>{fmtInt(renglones.length - esperando.length)}</b> productos ·{' '}
                    <b style={{ color: t.color.text }}>{fmtAR(pedidos.reduce((s, p) => s + p.total, 0))}</b> con flete
                    {r.cambian_de_proveedor > 0 && <> · {fmtInt(r.cambian_de_proveedor)} cambian de proveedor</>}
                </div>
                <Button size="sm" variant="ghost" leftIcon={<Icon.Refresh size={13} />} onClick={cargar} disabled={loading}>
                    {loading ? 'Calculando…' : 'Recalcular'}
                </Button>
            </div>

            <div style={hint}>
                Cada producto va al proveedor con menor costo total (precio con flete, redondeado al pack). Solo se cambia
                al de siempre si el otro es {data.parametros.umbral_cambio_pct} % más barato. Si un pedido no llega al mínimo del
                proveedor, sus productos pasan a otro cuando conviene o quedan esperando.
            </div>

            {(r.precios_viejos > 0 || data.solver !== 'highs' || data.avisos.length > 0) && (
                <div style={{ background: t.color.warnSoft, borderRadius: t.radius.sm, padding: '10px 14px', fontSize: t.font.size.sm, color: t.color.text, fontFamily: t.font.family, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {r.precios_viejos > 0 && (
                        <div>{fmtInt(r.precios_viejos)} ofertas de otros proveedores no se usaron porque el precio tiene más de 7 días. Actualizá los precios en Pendientes y recalculá.</div>
                    )}
                    {data.solver !== 'highs' && <div>El optimizador no respondió: los pedidos mínimos no se tuvieron en cuenta.</div>}
                    {data.avisos.map(a => <div key={a}>{a}</div>)}
                </div>
            )}

            {pedidos.length === 0 && esperando.length === 0 && (
                <Card><div style={{ padding: 32, textAlign: 'center', color: t.color.textMuted, fontFamily: t.font.family }}>No hay nada para pedir.</div></Card>
            )}

            {pedidos.map(p => (
                <Card key={p.proveedor} padding={false} style={{ overflow: 'hidden' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: t.space[3], flexWrap: 'wrap', padding: '14px 16px' }}>
                        <div>
                            <div style={{ fontSize: 15, fontWeight: t.font.weight.semibold, color: t.color.text, fontFamily: t.font.family }}>{p.proveedor}</div>
                            <div style={{ ...hint, marginTop: 2, ...t.numericStyle }}>
                                {fmtInt(p.renglones.length)} productos · {fmtAR(p.total)}
                                {p.condiciones.demora_dias != null && ` · llega en ${p.condiciones.demora_dias} días`}
                                {p.condiciones.nota && ` · ${p.condiciones.nota}`}
                            </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: t.space[2], flexWrap: 'wrap' }}>
                            {p.minimo > 0 && (p.falta > 0
                                ? <Badge tone="warn" dot>Faltan {fmtAR(p.falta)} para el mínimo</Badge>
                                : <Badge tone="success" dot>Llega al mínimo</Badge>)}
                            {!p.minimo && <Badge tone="muted">Sin mínimo cargado</Badge>}
                            <Button size="sm" variant="primary" leftIcon={<Icon.Download size={13} />}
                                disabled={aprobando != null} onClick={() => aprobar(p)}>
                                {aprobando === p.proveedor ? 'Aprobando…' : 'Aprobar y bajar PDF'}
                            </Button>
                        </div>
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
                            <thead>
                                <tr>
                                    <th style={th}>Producto</th>
                                    <th style={{ ...th, textAlign: 'right' }}>Cantidad</th>
                                    <th style={th}>Proveedor</th>
                                    <th style={{ ...th, textAlign: 'right' }}>C/u con flete</th>
                                    <th style={{ ...th, textAlign: 'right' }}>Total</th>
                                    <th style={th}>Por qué</th>
                                </tr>
                            </thead>
                            <tbody>
                                {p.renglones.map(x => <Renglon key={x.odoo_id} r={x} t={t} td={td} hint={hint} onQty={q => cambiar(x.odoo_id, { qty: q })} onMover={j => moverA(x, j)} />)}
                            </tbody>
                        </table>
                    </div>
                </Card>
            ))}

            {esperando.length > 0 && (
                <Card padding={false} style={{ overflow: 'hidden' }}>
                    <div style={{ padding: '14px 16px' }}>
                        <div style={{ fontSize: 15, fontWeight: t.font.weight.semibold, color: t.color.text, fontFamily: t.font.family }}>Esperando el mínimo</div>
                        <div style={{ ...hint, marginTop: 2 }}>Su proveedor no llega al pedido mínimo y no conviene pasarlos a otro. Elegí uno para pedirlos igual.</div>
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
                            <tbody>
                                {esperando.map(x => <Renglon key={x.odoo_id} r={x} t={t} td={td} hint={hint} onQty={q => cambiar(x.odoo_id, { qty: q })} onMover={j => moverA(x, j)} />)}
                            </tbody>
                        </table>
                    </div>
                </Card>
            )}

            {data.sin_precio.length > 0 && (
                <ListaSimple t={t} hint={hint} titulo={`Sin precio (${fmtInt(data.sin_precio.length)})`}
                    texto="No tienen costo en Odoo ni oferta con precio: hay que pedir precio o cargar el costo."
                    items={data.sin_precio} />
            )}

            {data.no_reponer.length > 0 && (
                <div>
                    <Button size="sm" variant="ghost" leftIcon={verNoReponer ? <Icon.ChevronDown size={13} /> : <Icon.ChevronRight size={13} />}
                        onClick={() => setVerNoReponer(v => !v)}>
                        Sugeridos para no reponer ({fmtInt(data.no_reponer.length)})
                    </Button>
                    {verNoReponer && (
                        <ListaSimple t={t} hint={hint} titulo="Sugeridos para no reponer"
                            texto="Se venden poco y nadie los encargó. Si querés pedirlos, cargá la cantidad en Pendientes y recalculá."
                            items={data.no_reponer} conMotivo />
                    )}
                </div>
            )}
        </div>
    );
}

function Renglon({ r, t, td, hint, onQty, onMover }) {
    const o = r.elegido >= 0 ? r.opciones[r.elegido] : null;
    const m = MOTIVO[r.motivo] || MOTIVO.unico;
    const fueraDePack = o && o.pack > 1 && r.qty % o.pack !== 0;
    return (
        <tr>
            <td style={td}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <ProductThumb imageUrl={r.image_url} size={36} />
                    <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: t.font.weight.medium }}>{r.nombre}</div>
                        <div style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textFaint }}>{r.ref || '—'}</div>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                            {r.abc && <Badge tone={r.abc === 'A' ? 'success' : 'muted'}>{r.abc}</Badge>}
                            {r.qty_encargue > 0 && <Badge tone="accent">Encargue: {fmtInt(r.qty_encargue)}</Badge>}
                            {r.encargue_viejo && <Badge tone="warn">Encargue de más de 7 días: decidí a mano</Badge>}
                        </div>
                    </div>
                </div>
            </td>
            <td style={{ ...td, textAlign: 'right' }}>
                <input
                    type="number" min="1" step={o?.pack || 1} value={r.qty}
                    onChange={e => { const v = parseInt(e.target.value, 10); onQty(Number.isInteger(v) && v > 0 ? v : 1); }}
                    style={{
                        width: 72, padding: '6px 8px', textAlign: 'right', borderRadius: t.radius.sm,
                        border: `1px solid ${fueraDePack ? t.color.warn : t.color.borderStrong}`,
                        background: t.color.surface, color: t.color.text, fontFamily: t.font.family, ...t.numericStyle,
                    }}
                />
                <div style={{ ...hint, marginTop: 2 }}>
                    {o?.pack > 1 ? `pack x${o.pack}` : `sugerido ${fmtInt(r.qty_total)}`}
                </div>
            </td>
            <td style={{ ...td, minWidth: 200 }}>
                {r.opciones.length > 1 || !o ? (
                    <Select
                        value={o ? String(r.elegido) : ''}
                        placeholder="Elegí proveedor"
                        onChange={v => onMover(Number(v))}
                        options={r.opciones.map((x, j) => ({ value: String(j), label: `${x.canasta} · ${fmtAR(x.costo_unit)}${x.habitual ? ' (de siempre)' : ''}` }))}
                    />
                ) : (
                    <span>{o.canasta}</span>
                )}
                {o && (
                    <div style={{ ...hint, marginTop: 2 }}>
                        {o.origen === 'costo_odoo' ? 'costo de Odoo' : o.proveedor !== o.canasta ? `oferta de ${o.proveedor}` : 'oferta web'}
                    </div>
                )}
            </td>
            <td style={{ ...td, textAlign: 'right', ...t.numericStyle }}>{o ? fmtAR(o.costo_unit) : '—'}</td>
            <td style={{ ...td, textAlign: 'right', fontWeight: t.font.weight.semibold, ...t.numericStyle }}>{o ? fmtAR(o.costo_unit * r.qty) : '—'}</td>
            <td style={td}>
                <Badge tone={m.tone}>{m.label}</Badge>
                {r.alternativa && (
                    <div style={{ ...hint, marginTop: 4, ...t.numericStyle }}>
                        Otra: {r.alternativa.proveedor} {fmtAR(r.alternativa.total)}
                        {r.alternativa.diferencia_pct != null && ` (${r.alternativa.diferencia_pct > 0 ? '+' : ''}${r.alternativa.diferencia_pct} %)`}
                    </div>
                )}
            </td>
        </tr>
    );
}

function ListaSimple({ t, hint, titulo, texto, items, conMotivo }) {
    return (
        <Card>
            <div style={{ fontSize: 15, fontWeight: t.font.weight.semibold, color: t.color.text, fontFamily: t.font.family }}>{titulo}</div>
            <div style={{ ...hint, marginTop: 2, marginBottom: t.space[3] }}>{texto}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {items.map(x => (
                    <div key={x.odoo_id} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <ProductThumb imageUrl={x.image_url} size={32} />
                        <div style={{ minWidth: 0, fontFamily: t.font.family }}>
                            <div style={{ fontSize: t.font.size.sm, color: t.color.text }}>{x.nombre}</div>
                            <div style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textFaint }}>
                                {x.ref || '—'} · {x.vendor_name}{conMotivo && x.no_reponer ? ` · ${x.no_reponer}` : ''}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </Card>
    );
}
