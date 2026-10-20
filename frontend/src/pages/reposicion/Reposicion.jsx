import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR } from '../../theme/tokens';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Tabs from '../../components/common/Tabs';
import Modal from '../../components/common/Modal';
import ProductThumb from '../../components/common/ProductThumb';
import * as Icon from '../../components/common/icons';

// Cola de reposición de Neggo: archivados, bajo stock, recorrida y «queda poco».
// Agrupa por proveedor; el modal muestra ritmo de venta, ABC y genera OC borrador.

const ORIGEN = {
    archivado:  { label: 'Agotado',     tone: 'danger' },
    reponer:    { label: 'Queda poco',  tone: 'warn' },
    recorrida:  { label: 'Recorrida',   tone: 'warn' },
    bajo_stock: { label: 'Bajo stock',  tone: 'muted' }, // legacy; Neggo no lleva stock en Odoo
};
const ESTADO = {
    repuesto:   { label: 'Repuesto',   tone: 'success' },
    descartado: { label: 'Descartado', tone: 'muted' },
};
const RITMO = {
    reponer:   { label: 'Reponer',  tone: 'success' },
    estable:   { label: 'Estable',  tone: 'muted' },
    flojo:     { label: 'Flojo',    tone: 'warn' },
    sin_datos: { label: 'Sin ventas', tone: 'muted' },
};

const fmtFecha = (iso) => iso
    ? new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';

function agruparPorProveedor(items) {
    const grupos = new Map();
    for (const it of items) {
        if (!grupos.has(it.vendor_name)) grupos.set(it.vendor_name, []);
        grupos.get(it.vendor_name).push(it);
    }
    return [...grupos.entries()];
}

function BuscadorReponer({ onAgregado, onError }) {
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

    return (
        <Card padding={false} style={{ padding: t.space[5] }}>
            <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.text, marginBottom: t.space[2], fontFamily: t.font.family }}>
                Marcar «queda poco»
            </div>
            <Input
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder="Buscá por nombre, referencia o código de barras…"
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
                <div style={{ marginTop: t.space[3], border: `1px solid ${t.color.border}`, borderRadius: t.radius.sm, maxHeight: 300, overflowY: 'auto' }}>
                    {resultados.map(p => (
                        <div key={p.odoo_id} style={{ display: 'flex', alignItems: 'center', gap: t.space[3], padding: '8px 10px', borderTop: `1px solid ${t.color.border}` }}>
                            <ProductThumb imageUrl={p.image_url} size={36} />
                            <div style={{ flex: 1, minWidth: 0, fontFamily: t.font.family }}>
                                <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                                <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>
                                    <span style={{ fontFamily: t.font.mono }}>{p.internal_ref || p.barcode || '—'}</span> · {p.vendor_name}
                                </div>
                            </div>
                            {p.es_liquidar ? (
                                <Badge tone="muted">Liquidar</Badge>
                            ) : p.en_cola ? (
                                <Badge tone="success" dot>En la cola</Badge>
                            ) : (
                                <Button size="sm" variant="primary" leftIcon={<Icon.Plus size={13} />}
                                    disabled={agregando === p.odoo_id} onClick={() => agregar(p)}>
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

function ModalProveedor({ vendor, onClose, onChanged }) {
    const { tokens: t } = useTheme();
    const [detalle, setDetalle] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [qtys, setQtys] = useState({});
    const [selected, setSelected] = useState({});
    const [generando, setGenerando] = useState(false);
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
            sel[it.id] = it.ritmo !== 'flojo'; // por defecto no marcar los flojos
        }
        setQtys(q);
        setSelected(sel);
    }, [vendor]);

    useEffect(() => { cargar(); }, [cargar]);

    const toggle = (id) => setSelected(prev => ({ ...prev, [id]: !prev[id] }));

    const generarOc = async () => {
        const items = (detalle?.items || [])
            .filter(it => selected[it.id])
            .map(it => ({ id: it.id, qty_decidida: qtys[it.id] === '' ? undefined : Number(qtys[it.id]) }));
        if (!items.length) { setError('Seleccioná al menos un producto'); return; }
        setGenerando(true);
        setError(null);
        setAviso(null);
        const res = await api.post('/reposicion/generar-oc', {
            vendor_name: vendor,
            items,
        });
        setGenerando(false);
        if (!res.success) { setError(res.error || 'No se pudo generar la OC'); return; }
        setAviso(`Borrador de OC #${res.data.odoo_po_id} creado en Odoo (${res.data.lineas} líneas).`);
        onChanged?.();
        await cargar();
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
                        variant="primary"
                        leftIcon={<Icon.Truck size={14} />}
                        disabled={generando || loading || !(detalle?.items?.length)}
                        onClick={generarOc}
                    >
                        {generando ? 'Generando…' : 'Generar OC en Odoo'}
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
                                <th style={{ ...th, textAlign: 'right' }}>Pedir</th>
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
                        El ritmo y el Pareto ABC van por unidades vendidas (no por monto). La cantidad sugerida es ~2 semanas de ritmo de venta. Las ventas se refrescan al abrir este modal (y al prender la app); no hay cron diario. «Generar OC» crea un borrador en Odoo Neggo.
                    </div>
                </div>
            )}
        </Modal>
    );
}

export default function Reposicion() {
    const { tokens: t } = useTheme();
    const [tab, setTab] = useState('pendiente');
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [aviso, setAviso] = useState(null);
    const [trabajando, setTrabajando] = useState(null);
    const [modalVendor, setModalVendor] = useState(null);

    const cargar = useCallback(async () => {
        setLoading(true);
        setError(null);
        const res = await api.get('/reposicion', { estado: tab === 'pendiente' ? 'pendiente' : 'resueltos' });
        if (res.success) setItems(res.data || []);
        else setError(res.error || 'No se pudo cargar la cola');
        setLoading(false);
    }, [tab]);

    useEffect(() => { cargar(); }, [cargar]);

    const mostrarError = useCallback((msg) => setError(msg), []);

    const cambiarEstado = async (item, estado) => {
        setTrabajando(item.id);
        setError(null);
        const res = await api.patch(`/reposicion/${item.id}`, { estado });
        setTrabajando(null);
        if (!res.success) { setError(res.error || 'No se pudo actualizar'); return; }
        setItems(prev => prev.filter(i => i.id !== item.id));
        const texto = estado === 'pendiente' ? 'volvió a la cola' : estado === 'repuesto' ? 'quedó como repuesto' : 'quedó descartado';
        setAviso(`«${item.name || item.odoo_id}» ${texto}.`);
    };

    const alAgregar = (item) => {
        setAviso(`«${item.name}» entró a la cola como «queda poco».`);
        if (tab === 'pendiente') cargar();
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

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: t.space[3] }}>
                <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family, ...t.numericStyle }}>
                    {pendiente ? (
                        <>
                            <span style={{ fontWeight: t.font.weight.semibold, color: t.color.text }}>{items.length}</span> productos para evaluar
                            {' '}en <span style={{ fontWeight: t.font.weight.semibold, color: t.color.text }}>{grupos.length}</span> proveedores
                        </>
                    ) : 'Últimos 200 resueltos'}
                </div>
                <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap' }}>
                    <Link to="/reposicion/recorrida" style={{ textDecoration: 'none' }}>
                        <Button size="sm" variant="secondary" leftIcon={<Icon.ScanBarcode size={13} />}>
                            Recorrida
                        </Button>
                    </Link>
                    <Button size="sm" variant="ghost" leftIcon={<Icon.Refresh size={13} />} onClick={cargar}>Actualizar</Button>
                </div>
            </div>

            <Tabs
                tabs={[{ value: 'pendiente', label: 'Pendientes' }, { value: 'resueltos', label: 'Resueltos' }]}
                value={tab}
                onChange={(v) => { setTab(v); setAviso(null); }}
            />

            {pendiente && <BuscadorReponer onAgregado={alAgregar} onError={mostrarError} />}

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

            {loading ? (
                <Card><div style={{ padding: 40, textAlign: 'center', color: t.color.textMuted, fontFamily: t.font.family }}>Cargando…</div></Card>
            ) : items.length === 0 ? (
                <Card>
                    <div style={{ padding: 40, textAlign: 'center', fontFamily: t.font.family, maxWidth: 420, margin: '0 auto' }}>
                        <div style={{ width: 48, height: 48, borderRadius: '50%', background: t.color.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', color: t.color.textMuted }}>
                            <Icon.Check size={22} />
                        </div>
                        <div style={{ fontSize: 15, fontWeight: t.font.weight.medium, color: t.color.text }}>
                            {pendiente ? 'No hay nada para reponer' : 'Todavía no resolviste nada'}
                        </div>
                        <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 4 }}>
                            {pendiente
                                ? 'Cuando archives un producto (baja) aparece acá. También podés marcar «queda poco» o hacer la recorrida con el escáner.'
                                : 'Los productos que marques como repuestos o descartados van a aparecer acá.'}
                        </div>
                    </div>
                </Card>
            ) : (
                grupos.map(([proveedor, lista]) => (
                    <Card key={proveedor} padding={false} style={{ overflow: 'hidden' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: t.space[3], padding: '12px 16px', flexWrap: 'wrap' }}>
                            <Icon.Truck size={16} />
                            <span style={{ fontWeight: t.font.weight.semibold, fontSize: t.font.size.base, color: t.color.text, fontFamily: t.font.family }}>{proveedor}</span>
                            <Badge tone="muted">{lista.length}</Badge>
                            {pendiente && lista.some(i => i.origen === 'archivado') && (
                                <Badge tone="danger" dot>{lista.filter(i => i.origen === 'archivado').length} agotados</Badge>
                            )}
                            {pendiente && (
                                <Button size="sm" variant="ghost" style={{ marginLeft: 'auto' }}
                                    onClick={() => setModalVendor(proveedor)}>
                                    Decidir / OC
                                </Button>
                            )}
                        </div>
                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 700 }}>
                                <thead>
                                    <tr>
                                        <th style={thStyle}>Producto</th>
                                        <th style={thStyle}>{pendiente ? 'Motivo' : 'Resultado'}</th>
                                        <th style={thStyle}>{pendiente ? 'Desde' : 'Resuelto'}</th>
                                        <th style={{ ...thStyle, textAlign: 'right' }}>Costo</th>
                                        <th style={{ ...thStyle, textAlign: 'right' }}>Venta</th>
                                        <th style={{ ...thStyle, textAlign: 'right' }}></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {lista.map(it => (
                                        <tr key={it.id}>
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
                                                {it.nota && <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: 4 }}>{it.nota}</div>}
                                                {!pendiente && it.odoo_po_id && (
                                                    <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: 4 }}>OC #{it.odoo_po_id}</div>
                                                )}
                                            </td>
                                            <td style={{ ...tdStyle, fontSize: t.font.size.xs, color: t.color.textMuted, whiteSpace: 'nowrap', ...t.numericStyle }}>
                                                {fmtFecha(pendiente ? it.created_at : it.resolved_at)}
                                                {(pendiente ? it.created_by_name : it.resolved_by_name) && (
                                                    <div>{pendiente ? it.created_by_name : it.resolved_by_name}</div>
                                                )}
                                            </td>
                                            <td style={{ ...tdStyle, textAlign: 'right', color: t.color.textMuted, ...t.numericStyle }}>{fmtAR(it.standard_price)}</td>
                                            <td style={{ ...tdStyle, textAlign: 'right', fontWeight: t.font.weight.semibold, color: t.color.primary, ...t.numericStyle }}>{fmtAR(it.list_price)}</td>
                                            <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                                                {pendiente ? (
                                                    <div style={{ display: 'inline-flex', gap: t.space[2] }}>
                                                        <Button size="sm" variant="success" leftIcon={<Icon.Check size={13} />}
                                                            disabled={trabajando === it.id} onClick={() => cambiarEstado(it, 'repuesto')}>
                                                            Repuesto
                                                        </Button>
                                                        <Button size="sm" variant="ghost" leftIcon={<Icon.X size={13} />}
                                                            disabled={trabajando === it.id} onClick={() => cambiarEstado(it, 'descartado')}>
                                                            Descartar
                                                        </Button>
                                                    </div>
                                                ) : (
                                                    <Button size="sm" variant="ghost" leftIcon={<Icon.Refresh size={13} />}
                                                        disabled={trabajando === it.id} onClick={() => cambiarEstado(it, 'pendiente')}>
                                                        Volver a la cola
                                                    </Button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </Card>
                ))
            )}

            {modalVendor && (
                <ModalProveedor
                    vendor={modalVendor}
                    onClose={() => setModalVendor(null)}
                    onChanged={cargar}
                />
            )}
        </div>
    );
}
