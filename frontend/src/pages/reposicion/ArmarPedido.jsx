import { useEffect, useMemo, useState } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR, fmtInt } from '../../theme/tokens';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import ProductThumb from '../../components/common/ProductThumb';
import * as Icon from '../../components/common/icons';
import { descargarPedidoPDF } from './pedidoPdf';
import {
    accesoDe,
    destinoDe,
    estaVinculado,
    filtrarSolapa,
    ofertaElegida,
    ofertaMasBarata,
    proveedorPrincipal,
    proveedoresDelPedido,
    recomendarDePedidos,
} from './pedidoDestino';

const ETIQUETA_ACCESO = {
    abierta: 'Catálogo web',
    clave: 'Web con clave',
    pdf: 'Solo PDF',
};

function qtyInicial(it) {
    const n = Number(it.qty_decidida ?? it.qty_sugerida);
    return Number.isInteger(n) && n > 0 ? n : 1;
}

function Thumb({ it, onVerFoto, size }) {
    if (!it.image_url) return <ProductThumb imageUrl={null} size={size} />;
    return (
        <button
            type="button"
            onClick={() => onVerFoto(it)}
            aria-label={`Ver foto de ${it.name || 'producto'}`}
            title="Ver foto en grande"
            style={{ padding: 0, border: 'none', background: 'none', cursor: 'zoom-in', lineHeight: 0, flexShrink: 0 }}
        >
            <ProductThumb imageUrl={it.image_url} size={size} />
        </button>
    );
}

export default function ArmarPedido({ items, isMobile, onVerFoto, onVincular, onError, onAviso, onChanged }) {
    const { tokens: t } = useTheme();
    const [proveedor, setProveedor] = useState(null);
    const [lados, setLados] = useState({});
    const [solapa, setSolapa] = useState('todos');
    const [elegidos, setElegidos] = useState({});
    const [qtys, setQtys] = useState({});
    const [accesos, setAccesos] = useState([]);
    const [ordenes, setOrdenes] = useState(null);
    const [ordenesError, setOrdenesError] = useState(null);
    const [trabajando, setTrabajando] = useState(false);
    const [generandoPdf, setGenerandoPdf] = useState(false);
    const [reponiendo, setReponiendo] = useState(null);

    useEffect(() => {
        let vivo = true;
        api.get('/reposicion/accesos').then(res => {
            if (vivo && res.success) setAccesos(res.data || []);
        });
        api.get('/reposicion/ordenes', { dias: 7 }).then(res => {
            if (!vivo) return;
            if (res.success) setOrdenes(res.data?.pendientes || []);
            else setOrdenesError(res.error || 'No se pudieron leer los pedidos');
        });
        return () => { vivo = false; };
    }, []);

    useEffect(() => {
        setQtys(prev => {
            const next = { ...prev };
            for (const it of items) {
                if (next[it.id] == null) next[it.id] = qtyInicial(it);
            }
            return next;
        });
    }, [items]);

    const grupos = useMemo(() => proveedoresDelPedido(items, lados), [items, lados]);

    useEffect(() => {
        if (!grupos.length) return;
        if (!grupos.some(g => g.nombre === proveedor)) {
            setProveedor(grupos.find(g => g.n > 0)?.nombre || grupos[0].nombre);
        }
    }, [grupos, proveedor]);

    const acceso = accesoDe(proveedor, accesos);
    const delProveedor = items.filter(it => destinoDe(it, lados[it.id]) === proveedor);
    const visibles = filtrarSolapa(delProveedor, solapa)
        .slice()
        .sort((a, b) => Number(estaVinculado(a)) - Number(estaVinculado(b)) || String(a.name).localeCompare(String(b.name), 'es'));
    const sinAsignar = delProveedor.filter(it => !estaVinculado(it)).length;
    const vinculados = delProveedor.length - sinAsignar;
    const tildados = delProveedor.filter(it => elegidos[it.id]);
    const recomendaciones = useMemo(
        () => recomendarDePedidos(ordenes, proveedor, items.map(it => it.odoo_id)),
        [ordenes, proveedor, items]
    );

    const marcar = (id) => setElegidos(prev => ({ ...prev, [id]: !prev[id] }));

    const mover = (it) => {
        const actual = lados[it.id] === 'principal' ? 'principal' : 'economico';
        const siguiente = actual === 'principal' ? 'economico' : 'principal';
        setLados(prev => ({ ...prev, [it.id]: siguiente }));
        setProveedor(destinoDe(it, siguiente));
    };

    const guardarQty = async (it) => {
        const qty = Number(qtys[it.id]);
        if (!Number.isInteger(qty) || qty < 0 || qty === Number(it.qty_decidida)) return;
        const res = await api.patch(`/reposicion/${it.id}`, { estado: 'pendiente', qty_decidida: qty });
        if (!res.success) onError(res.error || 'No se pudo guardar la cantidad');
    };

    const pasarAEncargados = async () => {
        if (!tildados.length) { onError('Tildá al menos un producto'); return; }
        setTrabajando(true);
        onError(null);
        let ok = 0;
        for (const it of tildados) {
            const qty = Number(qtys[it.id]);
            const res = await api.patch(`/reposicion/${it.id}`, {
                estado: 'encargado',
                qty_decidida: Number.isInteger(qty) && qty >= 0 ? qty : undefined,
            });
            if (!res.success) {
                setTrabajando(false);
                onError(res.error || 'No se pudo pasar a encargados');
                if (ok) onChanged();
                return;
            }
            ok += 1;
        }
        setElegidos({});
        setTrabajando(false);
        onAviso(`${ok} producto${ok === 1 ? '' : 's'} de ${proveedor} pasó a encargados.`);
        onChanged();
    };

    const pdf = async () => {
        const lista = tildados
            .map(it => ({ ...it, qty: Number(qtys[it.id]) }))
            .filter(it => it.qty > 0);
        if (!lista.length) { onError('Tildá al menos un producto con cantidad'); return; }
        setGenerandoPdf(true);
        onError(null);
        try {
            await descargarPedidoPDF(proveedor, lista);
        } catch (err) {
            onError(err.message || 'No se pudo generar el PDF');
        } finally {
            setGenerandoPdf(false);
        }
    };

    const reponer = async (p) => {
        setReponiendo(p.odoo_id);
        onError(null);
        const res = await api.post('/reposicion', { odoo_id: p.odoo_id });
        setReponiendo(null);
        if (!res.success) { onError(res.error || 'No se pudo agregar'); return; }
        setQtys(prev => ({ ...prev, [res.data.id]: p.qty > 0 ? Math.round(p.qty) : 1 }));
        onAviso(`«${p.name}» entró a la cola desde un pedido.`);
        onChanged();
    };

    const linkDe = (it) => {
        const of = ofertaElegida(it, lados[it.id]);
        return of?.url || acceso.sitio || null;
    };

    const borde = `1px solid ${t.color.border}`;
    const solapas = [
        ['todos', `Todos · ${delProveedor.length}`],
        ['sin', `Sin asignar · ${sinAsignar}`],
        ['vinculados', `Vinculados · ${vinculados}`],
    ];

    return (
        <div style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr' : '240px 1fr',
            border: borde,
            borderRadius: t.radius.lg,
            overflow: 'hidden',
            background: t.color.surface,
            minHeight: 420,
        }}>
            <div style={{
                borderRight: isMobile ? 'none' : borde,
                borderBottom: isMobile ? borde : 'none',
                background: t.color.surface2,
                display: 'flex',
                flexDirection: isMobile ? 'row' : 'column',
                overflowX: isMobile ? 'auto' : 'hidden',
                overflowY: isMobile ? 'hidden' : 'auto',
                position: isMobile ? undefined : 'sticky',
                top: 12,
                alignSelf: 'start',
                maxHeight: isMobile ? undefined : 'calc(100vh - 120px)',
            }}>
                {!isMobile && (
                    <div style={{ padding: '12px 14px', borderBottom: borde }}>
                        <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.text, fontFamily: t.font.family }}>A quién se le pide</div>
                        <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family }}>Más barato, o el principal</div>
                    </div>
                )}
                {grupos.map(g => {
                    const activo = g.nombre === proveedor;
                    const acc = accesoDe(g.nombre, accesos);
                    return (
                        <button
                            key={g.nombre}
                            type="button"
                            onClick={() => { setProveedor(g.nombre); setSolapa('todos'); }}
                            style={{
                                display: 'block',
                                textAlign: 'left',
                                padding: '10px 14px',
                                border: 'none',
                                borderBottom: isMobile ? 'none' : borde,
                                borderRight: isMobile ? borde : 'none',
                                background: activo ? t.color.surface : 'transparent',
                                cursor: 'pointer',
                                flexShrink: 0,
                                minWidth: isMobile ? 140 : undefined,
                                fontFamily: t.font.family,
                            }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ fontWeight: activo ? t.font.weight.semibold : t.font.weight.medium, color: t.color.text, fontSize: t.font.size.sm }}>{g.nombre}</span>
                                <Badge tone="muted">{g.n}</Badge>
                            </div>
                            <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: 2 }}>
                                {ETIQUETA_ACCESO[acc.tipo]}{g.sin > 0 ? ` · ${g.sin} sin asignar` : ''}
                            </div>
                        </button>
                    );
                })}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <div style={{ padding: '12px 16px', borderBottom: borde, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: t.font.weight.semibold, fontSize: t.font.size.lg, color: t.color.text, fontFamily: t.font.family }}>{proveedor}</span>
                    <Badge tone={acceso.tipo === 'clave' ? 'warn' : acceso.tipo === 'pdf' ? 'muted' : 'primary'}>{ETIQUETA_ACCESO[acceso.tipo]}</Badge>
                    <span style={{ marginLeft: 'auto', fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family }}>
                        {acceso.tipo === 'clave' && 'Hay que ingresar. La clave no se muestra.'}
                        {acceso.tipo === 'pdf' && 'Sin ficha web: lo tildado arma el PDF.'}
                        {acceso.tipo === 'abierta' && acceso.sitio}
                    </span>
                </div>

                <div style={{ padding: '8px 16px', borderBottom: borde, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {solapas.map(([id, label]) => (
                        <button
                            key={id}
                            type="button"
                            onClick={() => setSolapa(id)}
                            style={{
                                border: borde,
                                borderRadius: t.radius.full,
                                padding: '4px 10px',
                                background: solapa === id ? t.color.surface2 : 'transparent',
                                color: t.color.text,
                                cursor: 'pointer',
                                fontSize: t.font.size.xs,
                                fontFamily: t.font.family,
                            }}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                <div>
                    {visibles.length === 0 && (
                        <div style={{ padding: 16, fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                            {solapa === 'sin' && 'Este proveedor no tiene productos sin vincular.'}
                            {solapa === 'vinculados' && 'Este proveedor no tiene productos vinculados.'}
                            {solapa === 'todos' && 'Nada asignado a este proveedor.'}
                        </div>
                    )}
                    {visibles.map(it => {
                        const asignado = estaVinculado(it);
                        const barata = ofertaMasBarata(it);
                        const enPrincipal = !barata || lados[it.id] === 'principal';
                        const of = ofertaElegida(it, lados[it.id]);
                        const precio = of?.precio ?? it.standard_price;
                        const precioPrincipal = (it.ofertas?.ofertas || []).find(o => o.es_principal && Number(o.precio) > 0)?.precio ?? it.standard_price;
                        const href = asignado ? linkDe(it) : null;
                        const elegido = !!elegidos[it.id];
                        return (
                            <div key={it.id} style={{
                                display: 'flex', alignItems: 'center', gap: 12,
                                padding: '10px 16px', borderBottom: borde,
                                background: elegido ? t.color.primarySoft : 'transparent',
                                flexWrap: isMobile ? 'wrap' : 'nowrap',
                            }}>
                                <input
                                    type="checkbox"
                                    checked={elegido}
                                    onChange={() => marcar(it.id)}
                                    aria-label={elegido ? 'Sacar del pedido' : 'Sumar al pedido'}
                                />
                                <Thumb it={it} onVerFoto={onVerFoto} size={isMobile ? 44 : 40} />
                                <div style={{ flex: 1, minWidth: 160 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                        <span style={{ fontWeight: t.font.weight.medium, color: t.color.text, fontSize: t.font.size.sm, fontFamily: t.font.family }}>{it.name}</span>
                                        <Badge tone={asignado ? 'success' : 'warn'}>{asignado ? 'Asignado' : 'Sin asignar'}</Badge>
                                    </div>
                                    <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family, marginTop: 2 }}>
                                        <span style={{ fontFamily: t.font.mono }}>{it.internal_ref || it.barcode || '—'}</span>
                                        {' · '}
                                        {enPrincipal ? (barata ? 'principal' : 'principal, sin más barato') : 'más económico'}
                                        {precio != null && <> · {fmtAR(precio)}</>}
                                    </div>
                                    {barata && (
                                        <button type="button" onClick={() => mover(it)} style={{
                                            border: 'none', background: 'none', padding: 0, cursor: 'pointer',
                                            color: t.color.primary, fontSize: t.font.size.xs, fontFamily: t.font.family, textAlign: 'left',
                                        }}>
                                            {enPrincipal
                                                ? `Volver al más económico · ${barata.proveedor_odoo || barata.proveedor} · ${fmtAR(barata.precio)}`
                                                : `Enviar al principal · ${proveedorPrincipal(it)} · ${fmtAR(precioPrincipal)}`}
                                        </button>
                                    )}
                                </div>
                                {asignado && href && (
                                    <a href={href} target="_blank" rel="noreferrer" style={{ fontSize: t.font.size.xs, color: t.color.primary, fontFamily: t.font.family, whiteSpace: 'nowrap' }}>
                                        {acceso.tipo === 'clave' ? 'Abrir (pide clave)' : acceso.tipo === 'pdf' ? 'Abrir ficha' : 'Ver en el catálogo'}
                                    </a>
                                )}
                                {asignado && !href && acceso.tipo === 'pdf' && (
                                    <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family }}>Entra al PDF</span>
                                )}
                                {!asignado && (
                                    <Button size="sm" variant="secondary" leftIcon={<Icon.Link size={12} />} onClick={() => onVincular(it)}>
                                        Vincular
                                    </Button>
                                )}
                                <input
                                    type="number"
                                    min={0}
                                    step={1}
                                    value={qtys[it.id] ?? ''}
                                    aria-label={`Cantidad de ${it.name}`}
                                    onChange={e => setQtys(prev => ({ ...prev, [it.id]: e.target.value }))}
                                    onBlur={() => guardarQty(it)}
                                    style={{
                                        width: 64, padding: '4px 6px', border: borde, borderRadius: t.radius.sm,
                                        textAlign: 'right', fontFamily: t.font.family, fontSize: t.font.size.sm,
                                        background: t.color.surface, color: t.color.text,
                                    }}
                                />
                            </div>
                        );
                    })}
                </div>

                <div style={{ padding: '12px 16px', borderTop: borde, background: t.color.surface2, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 180 }}>
                        <div style={{ fontWeight: t.font.weight.semibold, fontSize: t.font.size.sm, color: t.color.text, fontFamily: t.font.family }}>
                            Pedido de {proveedor}
                            {tildados.length > 0 && ` · ${tildados.length}`}
                        </div>
                        <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family }}>
                            {tildados.length === 0
                                ? 'Todavía no tildaste nada de este proveedor.'
                                : tildados.map(it => `${qtys[it.id] || 0} × ${it.name}`).join(' · ')}
                        </div>
                    </div>
                    <Button size="sm" variant="secondary" leftIcon={<Icon.FileText size={13} />} disabled={generandoPdf} onClick={pdf}>
                        {generandoPdf ? 'Generando…' : 'PDF'}
                    </Button>
                    <Button size="sm" variant="primary" leftIcon={<Icon.ShoppingCart size={13} />} disabled={trabajando} onClick={pasarAEncargados}>
                        {trabajando ? 'Pasando…' : 'Pasar a encargados'}
                    </Button>
                </div>

                <div style={{ borderTop: borde, padding: '12px 16px 16px' }}>
                    <div style={{ fontWeight: t.font.weight.semibold, fontSize: t.font.size.sm, color: t.color.text, fontFamily: t.font.family }}>
                        Pendientes en pedidos
                    </div>
                    <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family, margin: '2px 0 8px' }}>
                        Vendidos en órdenes de la última semana que todavía no revisaste y no están en la cola.
                    </div>
                    {ordenes == null && !ordenesError && (
                        <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>Buscando pedidos…</div>
                    )}
                    {ordenesError && (
                        <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>{ordenesError}</div>
                    )}
                    {ordenes != null && recomendaciones.length === 0 && !ordenesError && (
                        <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                            No hay ventas pendientes de {proveedor} fuera de la cola.
                        </div>
                    )}
                    {recomendaciones.map(p => (
                        <div key={p.odoo_id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: borde }}>
                            <Thumb it={p} onVerFoto={onVerFoto} size={36} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.text, fontFamily: t.font.family }}>{p.name}</div>
                                <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family }}>
                                    <span style={{ fontFamily: t.font.mono }}>{p.internal_ref || '—'}</span>
                                    {' · '}{fmtInt(p.qty)} en {p.pedidos.join(', ')}
                                </div>
                            </div>
                            <Button size="sm" variant="primary" leftIcon={<Icon.Plus size={13} />} disabled={reponiendo === p.odoo_id} onClick={() => reponer(p)}>
                                Reponer
                            </Button>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
