import { useState, useEffect, useRef } from 'react';
import api from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { useScrapingContext } from '../../context/ScrapingContext';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR } from '../../theme/tokens';
import DataTable from '../../components/common/DataTable';
import Modal from '../../components/common/Modal';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Select from '../../components/common/Select';
import Toggle from '../../components/common/Toggle';
import ProductThumb from '../../components/common/ProductThumb';
import * as Icon from '../../components/common/icons';

const fmt = v => v != null && v !== '' ? fmtAR(v) : '—';

export default function SupplierProducts() {
    const { tokens: t } = useTheme();
    const { showToast } = useToast();
    const { activeRuns } = useScrapingContext();

    const [data, setData] = useState([]);
    const [loading, setLoading] = useState(true);
    const [suppliers, setSuppliers] = useState([]);
    const [supplierId, setSupplierId] = useState('');
    const [search, setSearch] = useState('');
    const [onlyAvailable, setOnlyAvailable] = useState(false);
    const [company, setCompany] = useState('neggo');
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [detail, setDetail] = useState(null);
    const [history, setHistory] = useState([]);
    const [mappings, setMappings] = useState([]);
    const autoRefreshRef = useRef(null);

    const activeSupplierIds = Object.keys(activeRuns).map(Number);
    const selectedId = supplierId ? parseInt(supplierId, 10) : null;
    const isScrapingActive = selectedId ? !!activeRuns[selectedId] : activeSupplierIds.length > 0;
    const scrapingSupplier = !selectedId && activeSupplierIds.length === 1 ? String(activeSupplierIds[0]) : null;
    const effectiveSupplierId = supplierId || scrapingSupplier || '';

    useEffect(() => { api.get('/suppliers').then(r => r.success && setSuppliers(r.data || [])); }, []);
    useEffect(() => { setPage(1); }, [effectiveSupplierId, search, onlyAvailable]);
    useEffect(() => { fetchData(); }, [effectiveSupplierId, search, onlyAvailable, page]);

    useEffect(() => {
        if (autoRefreshRef.current) { clearInterval(autoRefreshRef.current); autoRefreshRef.current = null; }
        if (isScrapingActive) autoRefreshRef.current = setInterval(fetchData, 3000);
        return () => { if (autoRefreshRef.current) clearInterval(autoRefreshRef.current); };
    }, [activeRuns, effectiveSupplierId]);

    async function fetchData() {
        setLoading(true);
        const res = await api.get('/products/supplier', {
            supplierId: effectiveSupplierId || undefined,
            search: search || undefined,
            available: onlyAvailable || undefined,
            sort: isScrapingActive ? 'new' : 'name',
            limit: 20,
            offset: (page - 1) * 20,
        });
        if (res.success) { setData(res.data || []); setTotal(res.pagination?.total || res.data?.length || 0); }
        else showToast(res.error || 'Error al cargar productos', 'error');
        setLoading(false);
    }

    async function openDetail(row) {
        setDetail(row);
        setHistory([]); setMappings([]);
        const [hRes, mRes] = await Promise.all([
            api.get(`/products/supplier/${row.id}/price-history`),
            api.get('/mappings', { supplierId: row.supplier_id, search: row.sku }),
        ]);
        if (hRes.success) setHistory(hRes.data || []);
        if (mRes.success) setMappings(mRes.data || []);
    }

    const supplierOptions = [
        { value: '', label: 'Todos los proveedores' },
        ...suppliers.map(s => ({ value: String(s.id), label: s.name })),
    ];

    const cols = [
        {
            key: 'name',
            label: 'Producto',
            render: (v, row) => (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <ProductThumb imageUrl={row.image_url} emoji={v?.[0]} size={36} />
                    <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: t.font.weight.medium, color: t.color.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280, fontFamily: t.font.family }}>
                            {v || '—'}
                        </div>
                        <div style={{ fontSize: t.font.size.xs, color: t.color.textFaint, marginTop: 2, fontFamily: t.font.mono }}>
                            {row.sku || ''}
                        </div>
                    </div>
                </div>
            ),
        },
        { key: 'supplier_name', label: 'Proveedor' },
        {
            key: 'raw_price',
            label: 'Precio prov.',
            render: v => (
                <span style={{ textAlign: 'right', display: 'block', color: t.color.textMuted, ...t.numericStyle }}>
                    {fmt(v)}
                </span>
            ),
        },
        {
            key: 'costo',
            label: 'Costo',
            render: v => (
                <span style={{ textAlign: 'right', display: 'block', color: t.color.textMuted, ...t.numericStyle }}>
                    {fmt(v)}
                </span>
            ),
        },
        {
            key: company === 'neggo' ? 'precio_neggo' : 'precio_preventas',
            label: company === 'neggo' ? 'Venta Neggo' : 'Venta Preventas',
            render: v => (
                <span style={{
                    textAlign: 'right', display: 'block',
                    fontWeight: t.font.weight.semibold,
                    color: company === 'neggo' ? t.color.primary : t.color.accent,
                    ...t.numericStyle,
                }}>
                    {fmt(v)}
                </span>
            ),
        },
        {
            key: 'available',
            label: 'Stock',
            render: v => v
                ? <Badge tone="success" dot>stock</Badge>
                : <Badge tone="danger" dot>sin stock</Badge>,
        },
    ];

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>

            {/* Filtros */}
            <Card padding={false} style={{ padding: t.space[5] }}>
                <div style={{ display: 'flex', gap: t.space[3], flexWrap: 'wrap', alignItems: 'center' }}>
                    <Input
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Buscar por nombre o SKU…"
                        leftIcon={<Icon.Search size={15} />}
                        style={{ flex: '1 1 260px', minWidth: 180 }}
                    />
                    <Select
                        value={effectiveSupplierId}
                        onChange={v => setSupplierId(v)}
                        options={supplierOptions}
                        placeholder="Todos los proveedores"
                        style={{ width: 200 }}
                    />

                    {/* Selector empresa */}
                    <div style={{
                        display: 'flex',
                        background: t.color.surface2,
                        borderRadius: t.radius.sm,
                        padding: 3,
                        border: `1px solid ${t.color.border}`,
                        flexShrink: 0,
                    }}>
                        {['neggo', 'preventas'].map(c => (
                            <button
                                key={c}
                                type="button"
                                onClick={() => setCompany(c)}
                                style={{
                                    padding: '0 14px',
                                    height: 32,
                                    borderRadius: t.radius.sm - 1,
                                    fontSize: t.font.size.sm,
                                    fontWeight: t.font.weight.medium,
                                    fontFamily: t.font.family,
                                    background: company === c ? t.color.surface : 'transparent',
                                    color: company === c ? t.color.text : t.color.textMuted,
                                    boxShadow: company === c ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                                    textTransform: 'capitalize',
                                    cursor: 'pointer',
                                }}
                            >
                                {c}
                            </button>
                        ))}
                    </div>

                    <label style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        fontSize: t.font.size.sm, color: t.color.textMuted,
                        fontFamily: t.font.family, cursor: 'pointer',
                        flexShrink: 0,
                    }}>
                        <Toggle checked={onlyAvailable} onChange={setOnlyAvailable} size="sm" />
                        Solo con stock
                    </label>
                </div>
            </Card>

            {/* Cabecera de resultados */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 4px' }}>
                <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                    <span style={{ color: t.color.text, fontWeight: t.font.weight.semibold, ...t.numericStyle }}>
                        {total.toLocaleString('es-AR')}
                    </span>
                    {' '}productos · precio:{' '}
                    <span style={{ color: t.color.text, fontWeight: t.font.weight.medium, textTransform: 'capitalize' }}>
                        {company}
                    </span>
                    {isScrapingActive && (
                        <Badge tone="primary" style={{ marginLeft: 10 }}>⏳ Actualizando…</Badge>
                    )}
                </div>
                <Button size="sm" variant="ghost" onClick={fetchData} leftIcon={<Icon.Refresh size={13} />}>
                    Actualizar
                </Button>
            </div>

            {/* Tabla */}
            <DataTable
                columns={cols}
                data={data}
                loading={loading}
                onRowClick={openDetail}
                pagination={{ page, pageSize: 20, total }}
                onPageChange={setPage}
            />

            {/* Modal detalle */}
            <Modal
                isOpen={!!detail}
                onClose={() => setDetail(null)}
                title={detail?.name || 'Detalle del producto'}
                subtitle={detail ? `${detail.supplier_name} · ${detail.sku}` : ''}
                size="lg"
            >
                {detail && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[8] }}>

                        {/* Header */}
                        <div style={{ display: 'flex', gap: t.space[6], alignItems: 'center' }}>
                            <ProductThumb imageUrl={detail.image_url} emoji={detail.name?.[0]} size={64} />
                            <div style={{ flex: 1 }}>
                                <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                                    {detail.source_category || 'Sin categoría'}
                                </div>
                                <div style={{ fontSize: t.font.size.base, fontWeight: t.font.weight.medium, marginBottom: t.space[2], fontFamily: t.font.family, color: t.color.text }}>
                                    {detail.supplier_name}
                                </div>
                                <Badge tone={detail.available ? 'success' : 'danger'} dot>
                                    {detail.available ? 'En stock' : 'Sin stock'}
                                </Badge>
                            </div>
                        </div>

                        {/* Cálculo de precios */}
                        <div>
                            <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, marginBottom: t.space[3], color: t.color.text, fontFamily: t.font.family }}>
                                Cálculo de precio
                            </div>
                            <div style={{
                                background: t.color.surface2,
                                borderRadius: t.radius.sm,
                                border: `1px solid ${t.color.border}`,
                                padding: t.space[5],
                            }}>
                                <PriceRow label="Precio proveedor" value={fmt(detail.raw_price)} tokens={t} />
                                {detail.offer_price && <PriceRow label="Precio oferta" value={fmt(detail.offer_price)} tokens={t} muted />}
                                <PriceRow label="Costo final" value={fmt(detail.costo)} tokens={t} />
                                <div style={{ borderTop: `1px solid ${t.color.border}`, margin: `${t.space[2]}px 0` }} />
                                <PriceRow label="Precio venta Neggo" value={fmt(detail.precio_neggo)} tokens={t} bold />
                                <div style={{ borderTop: `1px solid ${t.color.border}`, margin: `${t.space[2]}px 0` }} />
                                <PriceRow label="Precio venta Preventas" value={fmt(detail.precio_preventas)} tokens={t} bold />
                            </div>
                        </div>

                        {/* Historial de precios */}
                        {history.length > 0 && (
                            <div>
                                <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, marginBottom: t.space[3], color: t.color.text, fontFamily: t.font.family }}>
                                    Historial de precios
                                </div>
                                <div style={{ border: `1px solid ${t.color.border}`, borderRadius: t.radius.sm, overflow: 'hidden' }}>
                                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                        <thead>
                                            <tr style={{ background: t.color.surface2 }}>
                                                {['Fecha', 'Precio', 'Oferta'].map(h => (
                                                    <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: t.font.size.xs, color: t.color.textMuted, fontWeight: t.font.weight.semibold, textTransform: 'uppercase', letterSpacing: '0.04em', fontFamily: t.font.family }}>
                                                        {h}
                                                    </th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {history.slice(0, 10).map((h, i) => (
                                                <tr key={h.id} style={{ borderTop: `1px solid ${t.color.border}` }}>
                                                    <td style={{ padding: '8px 12px', fontSize: t.font.size.sm, fontFamily: t.font.mono, color: t.color.textMuted }}>
                                                        {new Date(h.scraped_at).toLocaleDateString('es-AR')}
                                                    </td>
                                                    <td style={{ padding: '8px 12px', fontSize: t.font.size.sm, ...t.numericStyle, color: t.color.text }}>
                                                        {fmt(h.price)}
                                                    </td>
                                                    <td style={{ padding: '8px 12px', fontSize: t.font.size.sm, ...t.numericStyle, color: t.color.textMuted }}>
                                                        {h.offer_price ? fmt(h.offer_price) : '—'}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}

                        {/* Vinculados a Odoo */}
                        {mappings.length > 0 && (
                            <div>
                                <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, marginBottom: t.space[3], color: t.color.text, fontFamily: t.font.family }}>
                                    Vinculados a Odoo · {mappings.length}
                                </div>
                                <div style={{ background: t.color.surface2, borderRadius: t.radius.sm, border: `1px solid ${t.color.border}`, overflow: 'hidden' }}>
                                    {mappings.map((m, i) => (
                                        <div key={m.id} style={{
                                            display: 'flex', alignItems: 'center', gap: t.space[3],
                                            padding: `${t.space[3]}px ${t.space[5]}px`,
                                            borderTop: i > 0 ? `1px solid ${t.color.border}` : 'none',
                                        }}>
                                            <Badge tone={m.odoo_company === 'neggo' ? 'primary' : 'accent'} style={{ minWidth: 74, justifyContent: 'center' }}>
                                                {m.odoo_company || '—'}
                                            </Badge>
                                            <span style={{ flex: 1, fontSize: t.font.size.sm, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: t.color.text, fontFamily: t.font.family }}>
                                                {m.odoo_product_name}
                                            </span>
                                            {m.odoo_internal_ref && (
                                                <span style={{ fontSize: t.font.size.xs, fontFamily: t.font.mono, color: t.color.textFaint }}>
                                                    {m.odoo_internal_ref}
                                                </span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </Modal>
        </div>
    );
}

function PriceRow({ label, value, tokens: t, muted, bold }) {
    return (
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: `4px 0`, fontSize: t.font.size.sm, fontFamily: t.font.family }}>
            <span style={{ color: muted ? t.color.textMuted : t.color.text }}>{label}</span>
            <span style={{ fontWeight: bold ? t.font.weight.semibold : t.font.weight.medium, color: muted ? t.color.textMuted : t.color.text, ...t.numericStyle }}>
                {value}
            </span>
        </div>
    );
}
