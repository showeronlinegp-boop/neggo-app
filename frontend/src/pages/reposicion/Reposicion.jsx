import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR, fmtInt } from '../../theme/tokens';
import useIsMobile from '../../hooks/useIsMobile';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Tabs from '../../components/common/Tabs';
import Modal from '../../components/common/Modal';
import ProductThumb from '../../components/common/ProductThumb';
import * as Icon from '../../components/common/icons';
import ReposicionProveedorModal from './ReposicionProveedorModal';
import ReposicionOrdenes from './ReposicionOrdenes';

// Cola de reposición de Neggo: archivados, recorrida y «queda poco».
// Lista de proveedores + catálogo; de pendientes se pueden encargar (se pidió).
// Un ingreso con el producto activo para Neggo se destaca para sacarlo de la cola.

const ORIGEN = {
    archivado:  { label: 'Agotado',    tone: 'danger' },
    reponer:    { label: 'Queda poco', tone: 'warn' },
    recorrida:  { label: 'Recorrida',  tone: 'warn' },
    bajo_stock: { label: 'Bajo stock', tone: 'muted' },
};
const RITMO = {
    reponer:   { label: 'Reponer',    tone: 'success' },
    estable:   { label: 'Estable',    tone: 'muted' },
    flojo:     { label: 'Flojo',      tone: 'warn' },
    sin_datos: { label: 'Sin ventas', tone: 'muted' },
};
const ESTADO = {
    encargado:  { label: 'Encargado',  tone: 'accent' },
    repuesto:   { label: 'Repuesto',   tone: 'success' },
    descartado: { label: 'Descartado', tone: 'muted' },
};

const fmtFecha = (iso) => iso
    ? new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';

// Pedido al proveedor en PDF, con el mismo generador que Preventas (Chrome headless en el backend).
// items: [{ name, internal_ref, barcode, image_url, standard_price, qty }]
async function descargarPedidoPDF(vendor, items) {
    const products = items.map(it => ({
        product_name: it.name,
        external_id:  it.internal_ref || it.barcode || null,
        unit_cost:    Number(it.standard_price) > 0 ? Number(it.standard_price) : null,
        total_qty:    it.qty,
        image_url:    it.image_url,
    }));
    const hasCost = products.some(p => p.unit_cost != null);
    const totalCost = products.reduce((s, p) => p.unit_cost != null ? s + p.unit_cost * p.total_qty : s, 0);
    const token = localStorage.getItem('neggo_token');
    const res = await fetch('/api/preventas/odoo-quotations/pdf', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            supplier_name: vendor,
            products,
            total_cost: hasCost ? Math.round(totalCost * 100) / 100 : null,
            total_qty:  products.reduce((s, p) => s + p.total_qty, 0),
        }),
    });
    if (!res.ok) {
        let message = 'No se pudo generar el PDF';
        try {
            const body = await res.json();
            if (body?.error) message = body.error;
        } catch { /* la respuesta no era JSON */ }
        throw new Error(message);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safe = vendor.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    a.href = url;
    a.download = `reposicion-${safe}-${new Date().toISOString().slice(0, 10)}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
}

function agruparPorProveedor(items) {
    const grupos = new Map();
    for (const it of items) {
        if (!grupos.has(it.vendor_name)) grupos.set(it.vendor_name, []);
        grupos.get(it.vendor_name).push(it);
    }
    return [...grupos.entries()];
}

const BTN_MOVIL = {
    flex: 1,
    minWidth: 0,
    height: 52,
    flexDirection: 'column',
    gap: 3,
    padding: '6px 4px',
    fontSize: 11,
};

function ChipIcono({ icon, n, color, bg, label, t }) {
    if (!n) return null;
    return (
        <span title={label} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            background: bg, color, padding: '4px 8px',
            borderRadius: t.radius.full, fontSize: 11, fontWeight: t.font.weight.semibold,
            fontFamily: t.font.family, lineHeight: 1, ...t.numericStyle,
        }}>
            {icon}
            {n}
        </span>
    );
}

function AccionesCola({ it, tab, trabajando, onCambiar, compact, t }) {
    const pendiente = tab === 'pendiente';
    const encargado = tab === 'encargado';
    const busy = trabajando === it.id;
    const estilo = compact ? BTN_MOVIL : undefined;
    const icon = compact ? 18 : 13;
    const wrap = compact
        ? { display: 'flex', gap: t.space[2], width: '100%' }
        : { display: 'inline-flex', gap: t.space[2] };

    if (pendiente) {
        return (
            <div style={wrap}>
                {it.llego_ingreso ? (
                    <Button size="sm" variant="success" leftIcon={<Icon.Check size={icon} />}
                        disabled={busy} onClick={() => onCambiar(it, 'repuesto')} style={estilo}>
                        Ya llegó
                    </Button>
                ) : (
                    <Button size="sm" variant="accent" leftIcon={<Icon.ShoppingCart size={icon} />}
                        disabled={busy} onClick={() => onCambiar(it, 'encargado')} style={estilo}>
                        Se pidió
                    </Button>
                )}
                {!it.llego_ingreso && (
                    <Button size="sm" variant="success" leftIcon={<Icon.Check size={icon} />}
                        disabled={busy} onClick={() => onCambiar(it, 'repuesto')} style={estilo}>
                        Repuesto
                    </Button>
                )}
                <Button size="sm" variant="ghost" leftIcon={<Icon.X size={icon} />}
                    disabled={busy} onClick={() => onCambiar(it, 'descartado')} style={estilo}>
                    Descartar
                </Button>
            </div>
        );
    }
    if (encargado) {
        return (
            <div style={wrap}>
                <Button size="sm" variant="success" leftIcon={<Icon.Check size={icon} />}
                    disabled={busy} onClick={() => onCambiar(it, 'repuesto')} style={estilo}>
                    {it.llego_ingreso ? 'Ya llegó' : 'Repuesto'}
                </Button>
                <Button size="sm" variant="ghost" leftIcon={<Icon.Refresh size={icon} />}
                    disabled={busy} onClick={() => onCambiar(it, 'pendiente')} style={estilo}>
                    {compact ? 'Pendiente' : 'Volver a pendientes'}
                </Button>
                <Button size="sm" variant="ghost" leftIcon={<Icon.X size={icon} />}
                    disabled={busy} onClick={() => onCambiar(it, 'descartado')} style={estilo}>
                    Descartar
                </Button>
            </div>
        );
    }
    return (
        <Button size="sm" variant="ghost" leftIcon={<Icon.Refresh size={icon} />}
            disabled={busy} onClick={() => onCambiar(it, 'pendiente')}
            style={compact ? { ...BTN_MOVIL, width: '100%' } : undefined}>
            {compact ? 'Pendiente' : 'Volver a pendientes'}
        </Button>
    );
}

function BuscadorReponer({ onAgregado, onQuitado, onError, isMobile }) {
    const { tokens: t } = useTheme();
    const [q, setQ] = useState('');
    const [resultados, setResultados] = useState([]);
    const [buscando, setBuscando] = useState(false);
    const [agregando, setAgregando] = useState(null);
    const pedido = useRef(0);

    useEffect(() => {
        const term = q.trim();
        if (term.length < 2) { setResultados([]); return; }
        const id = ++pedido.current;
        const timer = setTimeout(async () => {
            setBuscando(true);
            const res = await api.get('/reposicion/buscar', { q: term });
            if (id !== pedido.current) return;
            setBuscando(false);
            if (res.success) setResultados(res.data || []);
            else onError(res.error || 'No se pudo buscar');
        }, 300);
        return () => clearTimeout(timer);
    }, [q, onError]);

    const agregar = async (p) => {
        setAgregando(p.odoo_id);
        const res = await api.post('/reposicion', { odoo_id: p.odoo_id });
        setAgregando(null);
        if (!res.success) { onError(res.error || 'No se pudo agregar'); return; }
        setResultados(prev => prev.map(r => (r.odoo_id === p.odoo_id ? { ...r, en_cola: true } : r)));
        onAgregado(res.data);
    };

    // Deshace un «Reponer» marcado por error
    const quitar = async (p) => {
        setAgregando(p.odoo_id);
        const res = await api.del(`/reposicion/producto/${p.odoo_id}`);
        setAgregando(null);
        if (!res.success) { onError(res.error || 'No se pudo sacar de la cola'); return; }
        setResultados(prev => prev.map(r => (r.odoo_id === p.odoo_id ? { ...r, en_cola: false, estado_cola: null } : r)));
        onQuitado(res.data);
    };

    return (
        <Card padding={false} style={{ padding: isMobile ? t.space[4] : t.space[5] }}>
            <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.text, marginBottom: t.space[2], fontFamily: t.font.family, display: 'flex', alignItems: 'center', gap: t.space[2] }}>
                <Icon.Search size={15} />
                Marcar «queda poco»
            </div>
            <Input
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder="Nombre, referencia o código…"
                leftIcon={<Icon.Search size={14} />}
            />
            {buscando && (
                <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: t.space[2], fontFamily: t.font.family }}>Buscando…</div>
            )}
            {!buscando && q.trim().length >= 2 && resultados.length === 0 && (
                <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: t.space[2], fontFamily: t.font.family }}>
                    No hay productos activos de Neggo que coincidan.
                </div>
            )}
            {resultados.length > 0 && (
                <div style={{ marginTop: t.space[3], border: `1px solid ${t.color.border}`, borderRadius: t.radius.sm, maxHeight: isMobile ? 360 : 300, overflowY: 'auto' }}>
                    {resultados.map(p => (
                        <div key={p.odoo_id} style={{
                            display: 'flex', flexDirection: isMobile ? 'column' : 'row',
                            alignItems: isMobile ? 'stretch' : 'center', gap: t.space[3],
                            padding: isMobile ? '10px 10px 12px' : '8px 10px',
                            borderTop: `1px solid ${t.color.border}`,
                        }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: t.space[3], minWidth: 0 }}>
                                <ProductThumb imageUrl={p.image_url} size={isMobile ? 44 : 36} />
                                <div style={{ flex: 1, minWidth: 0, fontFamily: t.font.family }}>
                                    <div style={{
                                        fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.text,
                                        overflow: 'hidden', textOverflow: 'ellipsis',
                                        whiteSpace: isMobile ? 'normal' : 'nowrap',
                                        display: isMobile ? '-webkit-box' : undefined,
                                        WebkitLineClamp: isMobile ? 2 : undefined,
                                        WebkitBoxOrient: isMobile ? 'vertical' : undefined,
                                    }}>{p.name}</div>
                                    <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>
                                        <span style={{ fontFamily: t.font.mono }}>{p.internal_ref || p.barcode || '—'}</span> · {p.vendor_name}
                                    </div>
                                </div>
                            </div>
                            {p.es_liquidar ? (
                                <Badge tone="muted">Liquidar</Badge>
                            ) : p.estado_cola === 'encargado' ? (
                                <Badge tone="accent" dot>Encargado</Badge>
                            ) : p.en_cola ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: t.space[2], flexShrink: 0 }}>
                                    <Badge tone="success" dot>En la cola</Badge>
                                    <Button size="sm" variant="ghost" leftIcon={<Icon.X size={isMobile ? 16 : 13} />}
                                        disabled={agregando === p.odoo_id} onClick={() => quitar(p)}
                                        title="Sacarlo de la cola de reposición"
                                        style={isMobile ? { flex: 1, height: 44 } : undefined}>
                                        Quitar
                                    </Button>
                                </div>
                            ) : (
                                <Button size="sm" variant="primary" leftIcon={<Icon.Plus size={isMobile ? 16 : 13} />}
                                    disabled={agregando === p.odoo_id} onClick={() => agregar(p)}
                                    style={isMobile ? { width: '100%', height: 44 } : undefined}>
                                    Reponer
                                </Button>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </Card>
    );
}

function ModalDecidirProveedor({ vendor, onClose, onChanged }) {
    const { tokens: t } = useTheme();
    const [detalle, setDetalle] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [qtys, setQtys] = useState({});
    const [selected, setSelected] = useState({});
    const [guardando, setGuardando] = useState(false);
    const [generandoPdf, setGenerandoPdf] = useState(false);
    const [aviso, setAviso] = useState(null);

    const cargar = useCallback(async () => {
        setLoading(true);
        setError(null);
        const res = await api.get('/reposicion/proveedor', { nombre: vendor });
        setLoading(false);
        if (!res.success) { setError(res.error || 'No se pudo cargar el proveedor'); return; }
        setDetalle(res.data);
        const q = {};
        const sel = {};
        for (const it of res.data.items || []) {
            q[it.id] = it.qty_decidida ?? it.qty_sugerida_calc ?? '';
            sel[it.id] = it.ritmo !== 'flojo';
        }
        setQtys(q);
        setSelected(sel);
    }, [vendor]);

    useEffect(() => { cargar(); }, [cargar]);

    const toggle = (id) => setSelected(prev => ({ ...prev, [id]: !prev[id] }));

    // La cantidad queda guardada al salir del casillero, aunque no se resuelva el ítem:
    // así la usa el PDF del encabezado del proveedor.
    const guardarQty = async (it) => {
        const raw = qtys[it.id];
        if (raw === '' || raw == null) return;
        const qty = Number(raw);
        if (!Number.isInteger(qty) || qty < 0 || qty === it.qty_decidida) return;
        const res = await api.patch(`/reposicion/${it.id}`, { estado: it.estado, qty_decidida: qty });
        if (!res.success) { setError(res.error || 'No se pudo guardar la cantidad'); return; }
        setDetalle(prev => prev && ({
            ...prev,
            items: prev.items.map(x => x.id === it.id ? { ...x, qty_decidida: qty } : x),
        }));
        onChanged?.();
    };

    const itemsSeleccionados = () => (detalle?.items || [])
        .filter(it => selected[it.id])
        .map(it => ({ id: it.id, qty_decidida: qtys[it.id] === '' ? undefined : Number(qtys[it.id]) }));

    const resolver = async (estado) => {
        const items = itemsSeleccionados();
        if (!items.length) { setError('Seleccioná al menos un producto'); return; }
        setGuardando(true);
        setError(null);
        setAviso(null);
        const res = await api.post('/reposicion/resolver', { items, estado });
        setGuardando(false);
        if (!res.success) { setError(res.error || 'No se pudo guardar la decisión'); return; }
        const label = estado === 'repuesto' ? 'repuestos' : 'descartados';
        setAviso(`${res.data.resueltos} producto(s) marcados como ${label}.`);
        onChanged?.();
        await cargar();
    };

    // Sale en el PDF lo tildado con cantidad mayor a cero.
    const pdf = async () => {
        const items = (detalle?.items || [])
            .filter(it => selected[it.id] && Number(qtys[it.id]) > 0)
            .map(it => ({ ...it, qty: Math.round(Number(qtys[it.id])) }));
        if (!items.length) { setError('Tildá al menos un producto con cantidad para armar el PDF'); return; }
        setGenerandoPdf(true);
        setError(null);
        try {
            await descargarPedidoPDF(vendor, items);
        } catch (err) {
            setError(err.message || 'No se pudo generar el PDF');
        } finally {
            setGenerandoPdf(false);
        }
    };

    const th = {
        padding: '8px 10px', textAlign: 'left', fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold,
        color: t.color.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em',
        background: t.color.surface2, fontFamily: t.font.family, whiteSpace: 'nowrap',
    };
    const td = {
        padding: '8px 10px', fontSize: t.font.size.sm, color: t.color.text,
        borderTop: `1px solid ${t.color.border}`, verticalAlign: 'middle', fontFamily: t.font.family,
    };

    return (
        <Modal
            isOpen
            onClose={onClose}
            title={vendor}
            subtitle={detalle ? `${detalle.resumen.pendientes} pendientes · ${detalle.resumen.reponer} para reponer · ${detalle.resumen.flojo} flojos` : 'Cargando…'}
            size="xl"
            footer={(
                <div style={{ display: 'flex', gap: t.space[2], justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    <Button variant="ghost" onClick={onClose}>Cerrar</Button>
                    <Button
                        variant="ghost"
                        leftIcon={<Icon.FileText size={14} />}
                        disabled={generandoPdf || loading || !(detalle?.items?.length)}
                        title="Descargar el pedido al proveedor con lo tildado y sus cantidades"
                        onClick={pdf}
                    >
                        {generandoPdf ? 'Generando…' : 'PDF'}
                    </Button>
                    <Button
                        variant="ghost"
                        leftIcon={<Icon.X size={14} />}
                        disabled={guardando || loading || !(detalle?.items?.length)}
                        onClick={() => resolver('descartado')}
                    >
                        Descartar
                    </Button>
                    <Button
                        variant="success"
                        leftIcon={<Icon.Check size={14} />}
                        disabled={guardando || loading || !(detalle?.items?.length)}
                        onClick={() => resolver('repuesto')}
                    >
                        {guardando ? 'Guardando…' : 'Marcar repuestos'}
                    </Button>
                </div>
            )}
        >
            {loading && <div style={{ padding: 24, textAlign: 'center', color: t.color.textMuted, fontFamily: t.font.family }}>Cargando métricas…</div>}
            {error && (
                <div style={{ background: t.color.dangerSoft, color: t.color.danger, padding: '10px 14px', borderRadius: t.radius.sm, fontSize: t.font.size.sm, marginBottom: t.space[3], fontFamily: t.font.family }}>
                    {error}
                </div>
            )}
            {aviso && (
                <div style={{ background: t.color.successSoft, color: t.color.success, padding: '10px 14px', borderRadius: t.radius.sm, fontSize: t.font.size.sm, marginBottom: t.space[3], fontFamily: t.font.family }}>
                    {aviso}
                </div>
            )}
            {!loading && detalle && (
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
                        <thead>
                            <tr>
                                <th style={th}></th>
                                <th style={th}>Producto</th>
                                <th style={th}>Motivo</th>
                                <th style={th}>Ritmo</th>
                                <th style={th}>ABC</th>
                                <th style={{ ...th, textAlign: 'right' }}>7d</th>
                                <th style={{ ...th, textAlign: 'right' }}>30d u.</th>
                                <th style={{ ...th, textAlign: 'right' }}>Prom/sem</th>
                                <th style={{ ...th, textAlign: 'right' }}>Cant.</th>
                            </tr>
                        </thead>
                        <tbody>
                            {detalle.items.map(it => (
                                <tr key={it.id}>
                                    <td style={td}>
                                        <input
                                            type="checkbox"
                                            checked={!!selected[it.id]}
                                            onChange={() => toggle(it.id)}
                                            aria-label={`Incluir ${it.name}`}
                                        />
                                    </td>
                                    <td style={td}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: t.space[2] }}>
                                            <ProductThumb imageUrl={it.image_url} size={32} />
                                            <div style={{ minWidth: 0 }}>
                                                <div style={{ fontWeight: t.font.weight.medium, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={it.name}>
                                                    {it.name}
                                                </div>
                                                <div style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textMuted }}>
                                                    {it.internal_ref || it.barcode || '—'}
                                                </div>
                                            </div>
                                        </div>
                                    </td>
                                    <td style={td}><Badge tone={ORIGEN[it.origen]?.tone} dot>{ORIGEN[it.origen]?.label}</Badge></td>
                                    <td style={td}><Badge tone={RITMO[it.ritmo]?.tone} dot>{RITMO[it.ritmo]?.label}</Badge></td>
                                    <td style={td}><Badge tone={it.abc === 'A' ? 'success' : it.abc === 'B' ? 'warn' : 'muted'}>{it.abc}</Badge></td>
                                    <td style={{ ...td, textAlign: 'right', ...t.numericStyle }}>{Number(it.qty_7d || 0).toLocaleString('es-AR')}</td>
                                    <td style={{ ...td, textAlign: 'right', ...t.numericStyle }}>{Number(it.qty_30d || 0).toLocaleString('es-AR')}</td>
                                    <td style={{ ...td, textAlign: 'right', ...t.numericStyle }}>{Number(it.avg_weekly || 0).toLocaleString('es-AR')}</td>
                                    <td style={{ ...td, textAlign: 'right', width: 88 }}>
                                        <input
                                            type="number"
                                            min={0}
                                            step={1}
                                            value={qtys[it.id] ?? ''}
                                            onChange={e => setQtys(prev => ({ ...prev, [it.id]: e.target.value }))}
                                            onBlur={() => guardarQty(it)}
                                            style={{
                                                width: 72, padding: '4px 6px', border: `1px solid ${t.color.border}`,
                                                borderRadius: t.radius.sm, fontFamily: t.font.family, fontSize: t.font.size.sm,
                                                textAlign: 'right', background: t.color.surface,
                                            }}
                                        />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {detalle.items.length === 0 && (
                        <div style={{ padding: 24, textAlign: 'center', color: t.color.textMuted, fontFamily: t.font.family }}>
                            Este proveedor ya no tiene pendientes.
                        </div>
                    )}
                    <div style={{ marginTop: t.space[3], fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family }}>
                        El ritmo y el Pareto ABC van por unidades vendidas (no por monto). La cantidad sugerida es ~2 semanas de ritmo de venta. Las ventas se refrescan al abrir este modal; no hay cron diario. No se genera OC en Odoo: la decisión queda en la cola. El PDF lleva lo tildado con su cantidad y el costo de Odoo.
                    </div>
                </div>
            )}
        </Modal>
    );
}

function ListaProveedores({ proveedores, loading, filtro, onFiltro, onAbrir, isMobile, t }) {
    const q = filtro.trim().toLowerCase();
    const lista = q
        ? proveedores.filter(p => p.vendor_name.toLowerCase().includes(q))
        : proveedores;

    return (
        <Card padding={false} style={{ overflow: 'hidden' }}>
            <div style={{ padding: isMobile ? '12px 12px 10px' : '12px 16px', display: 'flex', flexDirection: 'column', gap: t.space[3] }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: t.space[2] }}>
                    <span style={{
                        width: 28, height: 28, borderRadius: t.radius.sm, background: t.color.primarySoft,
                        color: t.color.primary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    }}>
                        <Icon.Truck size={15} />
                    </span>
                    <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.text, fontFamily: t.font.family }}>
                        Proveedores
                    </div>
                    <span style={{ marginLeft: 'auto', fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family, ...t.numericStyle }}>
                        {proveedores.length}
                    </span>
                </div>
                <Input
                    value={filtro}
                    onChange={e => onFiltro(e.target.value)}
                    placeholder="Buscá un proveedor…"
                    leftIcon={<Icon.Search size={14} />}
                />
            </div>
            {loading ? (
                <div style={{ padding: '20px 16px', color: t.color.textMuted, fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                    Cargando proveedores…
                </div>
            ) : lista.length === 0 ? (
                <div style={{ padding: '20px 16px', color: t.color.textMuted, fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                    {proveedores.length === 0
                        ? 'Todavía no hay productos de Neggo en el cache.'
                        : 'Ningún proveedor coincide con esa búsqueda.'}
                </div>
            ) : (
                <div style={{
                    maxHeight: isMobile ? '42vh' : 360,
                    overflowY: 'auto',
                    WebkitOverflowScrolling: 'touch',
                    borderTop: `1px solid ${t.color.border}`,
                }}>
                    {lista.map(p => (
                        <button
                            key={p.vendor_name}
                            type="button"
                            onClick={() => onAbrir(p.vendor_name)}
                            style={{
                                display: 'flex', alignItems: isMobile ? 'flex-start' : 'center',
                                gap: t.space[3], width: '100%',
                                padding: isMobile ? '12px 12px' : '10px 16px',
                                border: 'none', borderTop: `1px solid ${t.color.border}`,
                                background: 'transparent', cursor: 'pointer', textAlign: 'left',
                                fontFamily: t.font.family, minHeight: isMobile ? 56 : undefined,
                            }}
                            onMouseEnter={e => { e.currentTarget.style.background = t.color.surface2; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                        >
                            <span style={{
                                width: isMobile ? 40 : 28, height: isMobile ? 40 : 28, borderRadius: t.radius.md,
                                background: t.color.surface2, color: t.color.textMuted,
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                            }}>
                                <Icon.Truck size={isMobile ? 18 : 14} />
                            </span>
                            <span style={{ flex: 1, minWidth: 0 }}>
                                <span style={{
                                    display: 'block', fontWeight: t.font.weight.semibold,
                                    fontSize: isMobile ? t.font.size.base : t.font.size.sm,
                                    color: t.color.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                }}>
                                    {p.vendor_name}
                                </span>
                                <span style={{
                                    display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, alignItems: 'center',
                                }}>
                                    <ChipIcono t={t} n={p.n_pendientes} label="En cola" icon={<Icon.Package size={12} />}
                                        color={t.color.warn} bg={t.color.warnSoft} />
                                    <ChipIcono t={t} n={p.n_encargados} label="Encargados" icon={<Icon.ShoppingCart size={12} />}
                                        color={t.color.accent} bg={t.color.accentSoft} />
                                    <ChipIcono t={t} n={p.n_agotados} label="Agotados" icon={<Icon.Archive size={12} />}
                                        color={t.color.danger} bg={t.color.dangerSoft} />
                                    <span style={{ fontSize: 11, color: t.color.textMuted, ...t.numericStyle }}>
                                        {p.n_activos} act. · {p.n_archivados} arch.
                                    </span>
                                </span>
                            </span>
                            <Icon.ChevronRight size={16} />
                        </button>
                    ))}
                </div>
            )}
        </Card>
    );
}

function CardProductoCola({ it, tab, trabajando, onCambiar, etiquetaIngreso, t }) {
    const pendiente = tab === 'pendiente';
    const encargado = tab === 'encargado';
    const fecha = fmtFecha(pendiente ? it.created_at : encargado ? (it.encargado_at || it.created_at) : it.resolved_at);
    const quien = pendiente ? it.created_by_name : encargado ? (it.encargado_by_name || it.created_by_name) : it.resolved_by_name;

    return (
        <div style={{
            padding: '12px 12px 14px',
            borderTop: `1px solid ${t.color.border}`,
            background: it.llego_ingreso ? t.color.successSoft : undefined,
            display: 'flex', flexDirection: 'column', gap: 10,
        }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <ProductThumb imageUrl={it.image_url} size={52} />
                <div style={{ flex: 1, minWidth: 0, fontFamily: t.font.family }}>
                    <div style={{
                        fontWeight: t.font.weight.semibold, fontSize: t.font.size.base, color: t.color.text,
                        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                    }} title={it.name}>
                        {it.name || `Producto ${it.odoo_id}`}
                    </div>
                    <div style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: 2 }}>
                        {it.internal_ref || it.barcode || '—'}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, alignItems: 'center' }}>
                        {pendiente
                            ? <Badge tone={ORIGEN[it.origen]?.tone} dot>{ORIGEN[it.origen]?.label}</Badge>
                            : <Badge tone={ESTADO[it.estado]?.tone} dot>{ESTADO[it.estado]?.label}</Badge>}
                        {encargado && ORIGEN[it.origen] && (
                            <Badge tone={ORIGEN[it.origen].tone}>{ORIGEN[it.origen].label}</Badge>
                        )}
                    </div>
                    {etiquetaIngreso(it)}
                    {it.nota && <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: 4 }}>{it.nota}</div>}
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0, fontFamily: t.font.family }}>
                    <div style={{ fontWeight: t.font.weight.semibold, color: t.color.primary, fontSize: t.font.size.sm, ...t.numericStyle }}>
                        {fmtAR(it.list_price)}
                    </div>
                    <div style={{ fontSize: 11, color: t.color.textMuted, ...t.numericStyle }}>{fmtAR(it.standard_price)}</div>
                    {it.qty_decidida != null && (
                        <div style={{ fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, color: t.color.text, marginTop: 2, ...t.numericStyle }}>
                            × {fmtInt(it.qty_decidida)}
                        </div>
                    )}
                </div>
            </div>
            <div style={{ fontSize: 11, color: t.color.textFaint, fontFamily: t.font.family, ...t.numericStyle }}>
                {fecha}{quien ? ` · ${quien}` : ''}
            </div>
            <AccionesCola it={it} tab={tab} trabajando={trabajando} onCambiar={onCambiar} compact t={t} />
        </div>
    );
}

export default function Reposicion() {
    const { tokens: t } = useTheme();
    const isMobile = useIsMobile();
    const [tab, setTab] = useState('pendiente');
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [aviso, setAviso] = useState(null);
    const [trabajando, setTrabajando] = useState(null);
    const [proveedores, setProveedores] = useState([]);
    const [loadingProv, setLoadingProv] = useState(true);
    const [filtroProv, setFiltroProv] = useState('');
    const [proveedorAbierto, setProveedorAbierto] = useState(null);
    const [proveedorDecidir, setProveedorDecidir] = useState(null);
    const [recargarOrdenes, setRecargarOrdenes] = useState(0);
    const ordenes = tab === 'ordenes';

    const cargarCola = useCallback(async () => {
        // La pestaña Órdenes carga lo suyo (ReposicionOrdenes)
        if (tab === 'ordenes') { setLoading(false); return; }
        setLoading(true);
        setError(null);
        const estado = tab === 'resueltos' || tab === 'encargado' ? tab : 'pendiente';
        const res = await api.get('/reposicion', { estado });
        if (res.success) setItems(res.data || []);
        else setError(res.error || 'No se pudo cargar la cola');
        setLoading(false);
    }, [tab]);

    const cargarProveedores = useCallback(async () => {
        setLoadingProv(true);
        const res = await api.get('/reposicion/proveedores');
        if (res.success) setProveedores(res.data || []);
        else setError(res.error || 'No se pudo cargar los proveedores');
        setLoadingProv(false);
    }, []);

    const cargar = useCallback(async () => {
        if (tab === 'ordenes') setRecargarOrdenes(n => n + 1);
        await Promise.all([cargarCola(), cargarProveedores()]);
    }, [tab, cargarCola, cargarProveedores]);

    useEffect(() => { cargarCola(); }, [cargarCola]);
    useEffect(() => { cargarProveedores(); }, [cargarProveedores]);

    const mostrarError = useCallback((msg) => setError(msg), []);

    // PDF rápido desde el encabezado del proveedor: todo lo de la lista, con la cantidad
    // cargada en «Decidir» (una unidad si no se cargó ninguna).
    const [pdfProveedor, setPdfProveedor] = useState(null);
    const pdfEncabezado = async (proveedor, lista) => {
        setPdfProveedor(proveedor);
        setError(null);
        try {
            await descargarPedidoPDF(proveedor, lista.map(it => ({ ...it, qty: Number(it.qty_decidida) > 0 ? Number(it.qty_decidida) : 1 })));
        } catch (err) {
            mostrarError(err.message || 'No se pudo generar el PDF');
        } finally {
            setPdfProveedor(null);
        }
    };

    const cambiarEstado = async (item, estado) => {
        setTrabajando(item.id);
        setError(null);
        const res = await api.patch(`/reposicion/${item.id}`, { estado });
        setTrabajando(null);
        if (!res.success) { setError(res.error || 'No se pudo actualizar'); return; }
        const texto = estado === 'pendiente' ? 'volvió a pendientes'
            : estado === 'encargado' ? 'pasó a Encargados'
            : estado === 'repuesto' ? 'quedó como repuesto'
            : 'quedó descartado';
        setAviso(`«${item.name || item.odoo_id}» ${texto}.`);
        cargarProveedores();
        // El producto sale de la lista; el usuario se queda en la pestaña donde estaba
        setItems(prev => prev.filter(i => i.id !== item.id));
    };

    const alAgregar = (item) => {
        const como = item.origen === 'archivado' ? 'agotado'
            : item.origen === 'recorrida' ? 'recorrida'
            : 'queda poco';
        setAviso(`«${item.name}» entró a la cola como «${como}».`);
        if (tab === 'pendiente' || tab === 'encargado') cargarCola();
        cargarProveedores();
    };

    const alQuitar = (item) => {
        const archivado = item.origen === 'archivado' ? ' En Odoo sigue archivado.' : '';
        setAviso(`«${item.name}» salió de la cola.${archivado}`);
        if (tab === 'pendiente') setItems(prev => prev.filter(i => i.odoo_id !== item.odoo_id));
        cargarProveedores();
    };

    const etiquetaIngreso = (it) => {
        if (!it.llego_ingreso) return null;
        const nro = it.ingreso_comprobante || `#${it.ingreso_id}`;
        return (
            <Link
                to={`/ingreso/${it.ingreso_id}`}
                onClick={e => e.stopPropagation()}
                style={{ fontSize: t.font.size.xs, color: t.color.success, fontWeight: t.font.weight.medium, display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 4 }}
            >
                <Icon.PackageDown size={12} />
                Llegó en ingreso {nro}
            </Link>
        );
    };

    const thStyle = {
        padding: '8px 12px', textAlign: 'left', fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold,
        color: t.color.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em',
        background: t.color.surface2, fontFamily: t.font.family, whiteSpace: 'nowrap',
    };
    const tdStyle = {
        padding: '10px 12px', fontSize: t.font.size.sm, color: t.color.text, borderTop: `1px solid ${t.color.border}`,
        verticalAlign: 'middle', fontFamily: t.font.family,
    };

    const grupos = agruparPorProveedor(items);
    const pendiente = tab === 'pendiente';
    const encargado = tab === 'encargado';
    const nPend = proveedores.reduce((s, p) => s + (p.n_pendientes || 0), 0);
    const nEnc = proveedores.reduce((s, p) => s + (p.n_encargados || 0), 0);

    return (
        <div style={{
            display: 'flex', flexDirection: 'column',
            gap: isMobile ? t.space[4] : t.space[5],
            margin: isMobile ? '-8px -10px 0' : undefined,
        }}>
            <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                flexWrap: 'wrap', gap: t.space[3],
                padding: isMobile ? '0 12px' : undefined,
            }}>
                <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family, ...t.numericStyle }}>
                    {pendiente ? (
                        <>
                            <span style={{ fontWeight: t.font.weight.semibold, color: t.color.text }}>{items.length}</span> para evaluar
                            {' · '}
                            <span style={{ fontWeight: t.font.weight.semibold, color: t.color.text }}>{proveedores.length}</span> proveedores
                        </>
                    ) : encargado ? (
                        <>
                            <span style={{ fontWeight: t.font.weight.semibold, color: t.color.text }}>{items.length}</span> encargados
                        </>
                    ) : ordenes ? 'Ventas y POS de la última semana' : 'Últimos 200 resueltos'}
                </div>
                <div style={{ display: 'flex', gap: t.space[2] }}>
                    <Link to="/reposicion/recorrida" style={{ textDecoration: 'none' }}>
                        <Button size="sm" variant="secondary" leftIcon={<Icon.ScanBarcode size={13} />}
                            style={isMobile ? { minWidth: 44, padding: '0 10px' } : undefined}>
                            {isMobile ? null : 'Recorrida'}
                        </Button>
                    </Link>
                    <Button size="sm" variant="ghost" leftIcon={<Icon.Refresh size={13} />} onClick={cargar}
                        aria-label="Actualizar"
                        style={isMobile ? { minWidth: 44, padding: '0 10px' } : undefined}>
                        {isMobile ? null : 'Actualizar'}
                    </Button>
                </div>
            </div>

            <ListaProveedores
                proveedores={proveedores}
                loading={loadingProv}
                filtro={filtroProv}
                onFiltro={setFiltroProv}
                onAbrir={setProveedorAbierto}
                isMobile={isMobile}
                t={t}
            />

            <Tabs
                fullWidth={isMobile}
                tabs={[
                    { value: 'pendiente', label: isMobile ? 'Pend.' : 'Pendientes', count: nPend, icon: <Icon.Package size={14} /> },
                    { value: 'encargado', label: isMobile ? 'Encarg.' : 'Encargados', count: nEnc, icon: <Icon.ShoppingCart size={14} /> },
                    { value: 'resueltos', label: isMobile ? 'Resuel.' : 'Resueltos', icon: <Icon.Check size={14} /> },
                    { value: 'ordenes', label: 'Órdenes', icon: <Icon.ClipboardList size={14} /> },
                ]}
                value={tab}
                onChange={(v) => { setTab(v); setAviso(null); }}
            />

            {encargado && (
                <div style={{
                    fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family,
                    marginTop: -4, padding: isMobile ? '0 12px' : undefined,
                }}>
                    Pedidos que hiciste y todavía no cerraste. Si un ingreso lo trae activo para Neggo, aparece en verde: tocá «Ya llegó». Si no llega, volvelo a pendientes.
                </div>
            )}

            {pendiente && <BuscadorReponer onAgregado={alAgregar} onQuitado={alQuitar} onError={mostrarError} isMobile={isMobile} />}

            {error && (
                <div style={{ background: t.color.dangerSoft, color: t.color.danger, padding: '12px 16px', borderRadius: t.radius.sm, fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                    {error}
                </div>
            )}
            {aviso && !error && (
                <div style={{ background: t.color.successSoft, color: t.color.success, padding: '10px 16px', borderRadius: t.radius.sm, fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                    {aviso}
                </div>
            )}

            {ordenes ? (
                <ReposicionOrdenes
                    recargar={recargarOrdenes}
                    onCambioCola={cargarProveedores}
                    onAviso={(msg) => { setError(null); setAviso(msg); }}
                    onError={mostrarError}
                    isMobile={isMobile}
                />
            ) : loading ? (
                <Card><div style={{ padding: 40, textAlign: 'center', color: t.color.textMuted, fontFamily: t.font.family }}>Cargando…</div></Card>
            ) : items.length === 0 ? (
                <Card>
                    <div style={{ padding: isMobile ? 28 : 40, textAlign: 'center', fontFamily: t.font.family, maxWidth: 380, margin: '0 auto' }}>
                        <div style={{ width: 48, height: 48, borderRadius: '50%', background: t.color.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', color: t.color.textMuted }}>
                            <Icon.Check size={22} />
                        </div>
                        <div style={{ fontSize: 15, fontWeight: t.font.weight.medium, color: t.color.text }}>
                            {pendiente ? 'No hay nada para reponer' : encargado ? 'No hay nada encargado' : 'Todavía no resolviste nada'}
                        </div>
                        <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 4 }}>
                            {pendiente
                                ? 'Cuando archives un producto en Odoo (se agotó) aparece acá. También podés marcar «queda poco» o hacer la recorrida con el escáner.'
                                : encargado
                                    ? 'Cuando marques «Se pidió» en un pendiente, queda acá hasta que llegue o lo vuelvas a pendientes.'
                                    : 'Los productos que marques como repuestos o descartados van a aparecer acá.'}
                        </div>
                    </div>
                </Card>
            ) : (
                grupos.map(([proveedor, lista]) => (
                    <Card key={proveedor} padding={false} style={{ overflow: 'hidden' }}>
                        <button
                            type="button"
                            onClick={() => setProveedorAbierto(proveedor)}
                            title="Ver activos y archivados"
                            style={{
                                display: 'flex', alignItems: 'center', gap: t.space[3],
                                padding: isMobile ? '12px' : '12px 16px',
                                flexWrap: 'wrap', width: '100%', border: 'none', background: 'transparent',
                                cursor: 'pointer', textAlign: 'left', fontFamily: t.font.family,
                                minHeight: isMobile ? 52 : undefined,
                            }}
                            onMouseEnter={e => { e.currentTarget.style.background = t.color.surface2; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                        >
                            <span style={{
                                width: isMobile ? 36 : 28, height: isMobile ? 36 : 28, borderRadius: t.radius.md,
                                background: t.color.primarySoft, color: t.color.primary,
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                            }}>
                                <Icon.Truck size={isMobile ? 18 : 14} />
                            </span>
                            <span style={{ fontWeight: t.font.weight.semibold, fontSize: t.font.size.base, color: t.color.text, flex: 1, minWidth: 0 }}>
                                {proveedor}
                            </span>
                            <Badge tone="muted">{lista.length}</Badge>
                            {pendiente && lista.some(i => i.origen === 'archivado') && (
                                <ChipIcono t={t} n={lista.filter(i => i.origen === 'archivado').length} label="Agotados"
                                    icon={<Icon.Archive size={12} />} color={t.color.danger} bg={t.color.dangerSoft} />
                            )}
                            {lista.some(i => i.llego_ingreso) && (
                                <ChipIcono t={t} n={lista.filter(i => i.llego_ingreso).length} label="En un ingreso"
                                    icon={<Icon.PackageDown size={12} />} color={t.color.success} bg={t.color.successSoft} />
                            )}
                            {pendiente && (
                                <Button size="sm" variant="ghost"
                                    onClick={(e) => { e.stopPropagation(); setProveedorDecidir(proveedor); }}>
                                    Decidir
                                </Button>
                            )}
                            {(pendiente || encargado || lista.some(i => i.estado === 'repuesto')) && (
                                <Button size="sm" variant="ghost"
                                    leftIcon={<Icon.FileText size={13} />}
                                    disabled={pdfProveedor === proveedor}
                                    title={pendiente || encargado
                                        ? 'Descargar el pedido en PDF con las cantidades cargadas en «Decidir» (una unidad si no tiene)'
                                        : 'Descargar en PDF los repuestos de este proveedor con sus cantidades'}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        // En resueltos van solo los repuestos: lo descartado no se pide
                                        pdfEncabezado(proveedor, pendiente || encargado ? lista : lista.filter(i => i.estado === 'repuesto'));
                                    }}>
                                    {pdfProveedor === proveedor ? 'Generando…' : 'PDF'}
                                </Button>
                            )}
                            {!isMobile && <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>Ver catálogo</span>}
                            <Icon.ChevronRight size={16} />
                        </button>
                        {isMobile ? (
                            lista.map(it => (
                                <CardProductoCola
                                    key={it.id}
                                    it={it}
                                    tab={tab}
                                    trabajando={trabajando}
                                    onCambiar={cambiarEstado}
                                    etiquetaIngreso={etiquetaIngreso}
                                    t={t}
                                />
                            ))
                        ) : (
                            <div style={{ overflowX: 'auto' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                                    <thead>
                                        <tr>
                                            <th style={thStyle}>Producto</th>
                                            <th style={thStyle}>{pendiente ? 'Motivo' : encargado ? 'Estado' : 'Resultado'}</th>
                                            <th style={thStyle}>{pendiente ? 'Desde' : encargado ? 'Pedido' : 'Resuelto'}</th>
                                            <th style={{ ...thStyle, textAlign: 'right' }}>Cant.</th>
                                            <th style={{ ...thStyle, textAlign: 'right' }}>Costo</th>
                                            <th style={{ ...thStyle, textAlign: 'right' }}>Venta</th>
                                            <th style={{ ...thStyle, textAlign: 'right' }}></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {lista.map(it => (
                                            <tr key={it.id} style={it.llego_ingreso ? { background: t.color.successSoft } : undefined}>
                                                <td style={tdStyle}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: t.space[3] }}>
                                                        <ProductThumb imageUrl={it.image_url} size={36} />
                                                        <div style={{ minWidth: 0 }}>
                                                            <div style={{ fontWeight: t.font.weight.medium, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={it.name}>
                                                                {it.name || `Producto ${it.odoo_id}`}
                                                            </div>
                                                            <div style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textMuted }}>
                                                                {it.internal_ref || it.barcode || '—'}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </td>
                                                <td style={tdStyle}>
                                                    {pendiente
                                                        ? <Badge tone={ORIGEN[it.origen]?.tone} dot>{ORIGEN[it.origen]?.label}</Badge>
                                                        : <Badge tone={ESTADO[it.estado]?.tone} dot>{ESTADO[it.estado]?.label}</Badge>}
                                                    {encargado && ORIGEN[it.origen] && (
                                                        <div style={{ marginTop: 4 }}>
                                                            <Badge tone={ORIGEN[it.origen].tone}>{ORIGEN[it.origen].label}</Badge>
                                                        </div>
                                                    )}
                                                    {etiquetaIngreso(it)}
                                                    {it.nota && <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: 4 }}>{it.nota}</div>}
                                                </td>
                                                <td style={{ ...tdStyle, fontSize: t.font.size.xs, color: t.color.textMuted, whiteSpace: 'nowrap', ...t.numericStyle }}>
                                                    {fmtFecha(pendiente ? it.created_at : encargado ? (it.encargado_at || it.created_at) : it.resolved_at)}
                                                    {(pendiente ? it.created_by_name : encargado ? (it.encargado_by_name || it.created_by_name) : it.resolved_by_name) && (
                                                        <div>{pendiente ? it.created_by_name : encargado ? (it.encargado_by_name || it.created_by_name) : it.resolved_by_name}</div>
                                                    )}
                                                </td>
                                                <td style={{ ...tdStyle, textAlign: 'right', fontWeight: t.font.weight.semibold, ...t.numericStyle }}>
                                                    {it.qty_decidida != null ? fmtInt(it.qty_decidida) : '—'}
                                                </td>
                                                <td style={{ ...tdStyle, textAlign: 'right', color: t.color.textMuted, ...t.numericStyle }}>{fmtAR(it.standard_price)}</td>
                                                <td style={{ ...tdStyle, textAlign: 'right', fontWeight: t.font.weight.semibold, color: t.color.primary, ...t.numericStyle }}>{fmtAR(it.list_price)}</td>
                                                <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                                                    <AccionesCola it={it} tab={tab} trabajando={trabajando} onCambiar={cambiarEstado} t={t} />
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </Card>
                ))
            )}

            <ReposicionProveedorModal
                vendorName={proveedorAbierto}
                onClose={() => setProveedorAbierto(null)}
                onAgregado={alAgregar}
                onQuitado={alQuitar}
                onActivado={(prod) => {
                    const extra = prod?.cola_cerrada ? ' Salió de la lista de reposición.' : '';
                    setAviso(`«${prod.name}» volvió a estar activo en Odoo y en el Punto de Venta.${extra}`);
                    if (tab === 'pendiente' || tab === 'encargado') cargarCola();
                    cargarProveedores();
                }}
                onError={mostrarError}
            />
            {proveedorDecidir && (
                <ModalDecidirProveedor
                    vendor={proveedorDecidir}
                    onClose={() => setProveedorDecidir(null)}
                    onChanged={cargar}
                />
            )}
        </div>
    );
}
