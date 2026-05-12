import { useState, useEffect } from 'react';
import api from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR } from '../../theme/tokens';
import Tabs from '../../components/common/Tabs';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Select from '../../components/common/Select';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import ProductThumb from '../../components/common/ProductThumb';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import * as Icon from '../../components/common/icons';

const FILTER_OPTS = [
    { value: 'all',      label: 'Todos' },
    { value: 'mapped',   label: 'Con vínculo' },
    { value: 'unmapped', label: 'Sin vínculo' },
    { value: 'partial',  label: 'Parciales' },
];

const MATCH_TONE = {
    auto_ref:   'primary',
    auto_fuzzy: 'warn',
    manual:     'success',
};

export default function ProductMappings() {
    const { tokens: t } = useTheme();
    const { showToast } = useToast();

    const [activeTab, setActiveTab] = useState('vincular');
    const [suppliers, setSuppliers] = useState([]);
    const [selectedSupplier, setSelectedSupplier] = useState('');

    // Tab Vincular
    const [unmapped, setUnmapped] = useState([]);
    const [unmappedLoading, setUnmappedLoading] = useState(false);
    const [unmappedSearch, setUnmappedSearch] = useState('');
    const [selectedLeft, setSelectedLeft] = useState(null);
    const [odooProducts, setOdooProducts] = useState([]);
    const [odooLoading, setOdooLoading] = useState(false);
    const [odooSearch, setOdooSearch] = useState('');
    const [odooCompany, setOdooCompany] = useState('neggo');
    const [selectedRight, setSelectedRight] = useState(null);
    const [mappings, setMappings] = useState([]);
    const [mappingsLoading, setMappingsLoading] = useState(false);
    const [autoMatchLoading, setAutoMatchLoading] = useState(false);
    const [confirmUnlink, setConfirmUnlink] = useState(null);

    // Tab Comparación
    const [cmpData, setCmpData] = useState([]);
    const [cmpLoading, setCmpLoading] = useState(false);
    const [cmpSearch, setCmpSearch] = useState('');
    const [cmpFilter, setCmpFilter] = useState('all');
    const [cmpPage, setCmpPage] = useState(1);
    const [cmpTotal, setCmpTotal] = useState(0);
    const CMP_PAGE_SIZE = 50;

    useEffect(() => {
        api.get('/suppliers', { status: 'active' }).then(r => r.success && setSuppliers(r.data || []));
    }, []);

    useEffect(() => {
        if (selectedSupplier) { fetchUnmapped(); fetchMappings(); }
    }, [selectedSupplier, unmappedSearch]);

    useEffect(() => { fetchOdooProducts(); }, [odooSearch, odooCompany]);

    useEffect(() => {
        if (activeTab === 'comparacion' && selectedSupplier) fetchComparison();
    }, [activeTab, selectedSupplier, cmpSearch, cmpFilter, cmpPage]);

    async function fetchUnmapped() {
        setUnmappedLoading(true);
        const res = await api.get('/mappings', { supplierId: selectedSupplier, unmapped: true, search: unmappedSearch, limit: 50 });
        if (res.success) setUnmapped(res.data || []);
        setUnmappedLoading(false);
    }

    async function fetchOdooProducts() {
        if (!odooSearch && !odooCompany) return;
        setOdooLoading(true);
        const res = await api.get('/products/odoo', { company: odooCompany, search: odooSearch, limit: 50 });
        if (res.success) setOdooProducts(res.data || []);
        setOdooLoading(false);
    }

    async function fetchMappings() {
        setMappingsLoading(true);
        const res = await api.get('/mappings', { supplierId: selectedSupplier, status: 'active', limit: 100 });
        if (res.success) setMappings(res.data || []);
        setMappingsLoading(false);
    }

    async function fetchComparison() {
        setCmpLoading(true);
        const res = await api.get('/mappings/comparison', { supplierId: selectedSupplier, search: cmpSearch, filter: cmpFilter, limit: CMP_PAGE_SIZE, offset: (cmpPage - 1) * CMP_PAGE_SIZE });
        if (res.success) { setCmpData(res.data || []); setCmpTotal(res.pagination?.total ?? res.data?.length ?? 0); }
        else showToast(res.error || 'Error al cargar comparación', 'error');
        setCmpLoading(false);
    }

    async function handleLink() {
        if (!selectedLeft || !selectedRight) return;
        const res = await api.post('/mappings', { supplierProductId: selectedLeft.supplier_product_id || selectedLeft.id, odooProductId: selectedRight.odoo_id, odooCompany });
        if (res.success) { showToast('Vínculo creado', 'success'); setSelectedLeft(null); setSelectedRight(null); fetchUnmapped(); fetchMappings(); }
        else showToast(res.error || 'Error al crear vínculo', 'error');
    }

    async function handleUnlink(id) {
        const res = await api.del(`/mappings/${id}`);
        if (res.success) { showToast('Vínculo eliminado', 'success'); fetchUnmapped(); fetchMappings(); }
        else showToast(res.error || 'Error al desvincular', 'error');
        setConfirmUnlink(null);
    }

    async function handleAutoMatch() {
        if (!selectedSupplier) return showToast('Seleccioná un proveedor primero', 'warning');
        setAutoMatchLoading(true);
        const res = await api.post('/mappings/auto-match', { supplierId: parseInt(selectedSupplier) });
        setAutoMatchLoading(false);
        if (res.success) {
            const { matched = 0, autoLinked = 0, suggested = 0, noMatch = 0 } = res.data || {};
            showToast(`Auto-match: ${matched + autoLinked} vinculados, ${suggested} sugeridos, ${noMatch} sin match`, 'success');
            fetchUnmapped(); fetchMappings();
        } else showToast(res.error || 'Error en auto-match', 'error');
    }

    const supplierOptions = [
        { value: '', label: 'Seleccioná un proveedor' },
        ...suppliers.map(s => ({ value: String(s.id), label: s.name })),
    ];

    const tabs = [
        { value: 'vincular',    label: 'Vincular' },
        { value: 'comparacion', label: 'Comparación' },
    ];

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>

            {/* Selector de proveedor + auto-match */}
            <Card padding={false} style={{ padding: t.space[5] }}>
                <div style={{ display: 'flex', gap: t.space[3], alignItems: 'center', flexWrap: 'wrap' }}>
                    <Select
                        value={selectedSupplier}
                        onChange={v => { setSelectedSupplier(v); setSelectedLeft(null); setCmpPage(1); }}
                        options={supplierOptions}
                        style={{ width: 240 }}
                    />
                    <Button
                        variant="secondary"
                        leftIcon={<Icon.Bot size={15} />}
                        disabled={!selectedSupplier || autoMatchLoading}
                        onClick={handleAutoMatch}
                    >
                        {autoMatchLoading ? 'Procesando…' : 'Auto-match'}
                    </Button>
                </div>
            </Card>

            <Tabs tabs={tabs} value={activeTab} onChange={setActiveTab} />

            {/* ── TAB VINCULAR ─────────────────────────────────────────────────────── */}
            {activeTab === 'vincular' && (
                <>
                    {/* Split panel */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: t.space[5] }}>

                        {/* Izquierda: sin vincular */}
                        <Card padding={false} style={{ display: 'flex', flexDirection: 'column', minHeight: 420 }}>
                            <div style={{ padding: `14px 16px`, borderBottom: `1px solid ${t.color.border}` }}>
                                <div style={{ fontSize: 15, fontWeight: t.font.weight.semibold, color: t.color.text, marginBottom: t.space[3], fontFamily: t.font.family }}>
                                    Sin vincular
                                </div>
                                <Input
                                    value={unmappedSearch}
                                    onChange={e => setUnmappedSearch(e.target.value)}
                                    placeholder="Buscar producto…"
                                    leftIcon={<Icon.Search size={14} />}
                                />
                            </div>
                            <div style={{ flex: 1, overflowY: 'auto', maxHeight: 360, padding: t.space[2] }}>
                                {unmappedLoading ? (
                                    <Centered><LoadingSpinner size="sm" color={t.color.primary} /></Centered>
                                ) : unmapped.length === 0 ? (
                                    <EmptyPanel tokens={t} msg={selectedSupplier ? 'No hay productos sin vincular' : 'Seleccioná un proveedor'} />
                                ) : unmapped.map(p => (
                                    <ProductItem
                                        key={p.id || p.supplier_product_id}
                                        product={p}
                                        selected={selectedLeft?.id === p.id}
                                        onClick={() => setSelectedLeft(p)}
                                        tokens={t}
                                    />
                                ))}
                            </div>
                        </Card>

                        {/* Centro: botón vincular */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <button
                                type="button"
                                onClick={handleLink}
                                disabled={!selectedLeft || !selectedRight}
                                title={selectedLeft && selectedRight ? 'Vincular seleccionados' : 'Seleccioná un producto de cada panel'}
                                style={{
                                    width: 48, height: 48, borderRadius: t.radius.full,
                                    border: `2px solid ${selectedLeft && selectedRight ? t.color.primary : t.color.border}`,
                                    background: selectedLeft && selectedRight ? t.color.primarySoft : t.color.surface,
                                    color: selectedLeft && selectedRight ? t.color.primary : t.color.textFaint,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    cursor: selectedLeft && selectedRight ? 'pointer' : 'not-allowed',
                                    transition: 'all 160ms',
                                    opacity: selectedLeft && selectedRight ? 1 : 0.5,
                                }}
                            >
                                <Icon.Link size={18} />
                            </button>
                        </div>

                        {/* Derecha: productos Odoo */}
                        <Card padding={false} style={{ display: 'flex', flexDirection: 'column', minHeight: 420 }}>
                            <div style={{ padding: `14px 16px`, borderBottom: `1px solid ${t.color.border}` }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: t.space[3], marginBottom: t.space[3] }}>
                                    <span style={{ fontSize: 15, fontWeight: t.font.weight.semibold, color: t.color.text, flex: 1, fontFamily: t.font.family }}>
                                        Productos Odoo
                                    </span>
                                    <div style={{
                                        display: 'flex', background: t.color.surface2,
                                        borderRadius: t.radius.sm, padding: 2,
                                        border: `1px solid ${t.color.border}`,
                                    }}>
                                        {['neggo', 'preventas'].map(c => (
                                            <button key={c} type="button" onClick={() => { setOdooCompany(c); setSelectedRight(null); }} style={{
                                                padding: '0 10px', height: 26, borderRadius: t.radius.sm - 1,
                                                fontSize: t.font.size.xs, fontWeight: t.font.weight.medium,
                                                fontFamily: t.font.family, textTransform: 'capitalize',
                                                background: odooCompany === c ? t.color.surface : 'transparent',
                                                color: odooCompany === c ? t.color.text : t.color.textMuted,
                                                cursor: 'pointer',
                                            }}>{c}</button>
                                        ))}
                                    </div>
                                </div>
                                <Input
                                    value={odooSearch}
                                    onChange={e => setOdooSearch(e.target.value)}
                                    placeholder="Buscar en Odoo…"
                                    leftIcon={<Icon.Search size={14} />}
                                />
                            </div>
                            <div style={{ flex: 1, overflowY: 'auto', maxHeight: 360, padding: t.space[2] }}>
                                {odooLoading ? (
                                    <Centered><LoadingSpinner size="sm" color={t.color.primary} /></Centered>
                                ) : odooProducts.length === 0 ? (
                                    <EmptyPanel tokens={t} msg="Buscá un producto de Odoo" />
                                ) : odooProducts.map(p => (
                                    <OdooItem
                                        key={p.id}
                                        product={p}
                                        selected={selectedRight?.id === p.id}
                                        onClick={() => setSelectedRight(p)}
                                        tokens={t}
                                    />
                                ))}
                            </div>
                        </Card>
                    </div>

                    {/* Vínculos existentes */}
                    <Card padding={false}>
                        <div style={{ padding: `16px ${t.layout.cardPadX}px`, borderBottom: `1px solid ${t.color.border}` }}>
                            <span style={{ fontSize: 15, fontWeight: t.font.weight.semibold, color: t.color.text, fontFamily: t.font.family }}>
                                Vínculos existentes
                                {mappings.length > 0 && (
                                    <span style={{ marginLeft: 8, fontSize: t.font.size.sm, fontWeight: t.font.weight.regular, color: t.color.textMuted }}>
                                        · {mappings.length}
                                    </span>
                                )}
                            </span>
                        </div>
                        {mappingsLoading ? (
                            <Centered style={{ padding: 32 }}><LoadingSpinner size="sm" color={t.color.primary} /></Centered>
                        ) : mappings.length === 0 ? (
                            <div style={{ padding: '32px 24px', textAlign: 'center', fontSize: t.font.size.sm, color: t.color.textFaint, fontFamily: t.font.family }}>
                                No hay vínculos para este proveedor.
                            </div>
                        ) : (
                            <div style={{ overflowX: 'auto' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: t.font.size.sm }}>
                                    <thead>
                                        <tr style={{ background: t.color.surface2 }}>
                                            {['Producto proveedor', 'SKU', 'Producto Odoo', 'Ref. Odoo', 'Empresa', 'Match', 'Confianza', ''].map(h => (
                                                <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, color: t.color.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap', fontFamily: t.font.family }}>
                                                    {h}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {mappings.map(m => (
                                            <tr key={m.id} style={{ borderTop: `1px solid ${t.color.border}` }}>
                                                <td style={{ padding: '10px 14px', color: t.color.text, fontFamily: t.font.family }}>{m.supplier_product_name || m.product_name}</td>
                                                <td style={{ padding: '10px 14px' }}>
                                                    <span style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textFaint }}>{m.sku}</span>
                                                </td>
                                                <td style={{ padding: '10px 14px', color: t.color.text, fontFamily: t.font.family }}>{m.odoo_product_name}</td>
                                                <td style={{ padding: '10px 14px' }}>
                                                    <span style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textFaint }}>{m.odoo_internal_ref || '—'}</span>
                                                </td>
                                                <td style={{ padding: '10px 14px' }}>
                                                    <Badge tone={m.odoo_company === 'neggo' ? 'primary' : 'accent'}>{m.odoo_company}</Badge>
                                                </td>
                                                <td style={{ padding: '10px 14px' }}>
                                                    {m.match_type ? <Badge tone={MATCH_TONE[m.match_type] || 'muted'}>{m.match_type}</Badge> : '—'}
                                                </td>
                                                <td style={{ padding: '10px 14px', ...t.numericStyle, color: t.color.textMuted }}>
                                                    {m.confidence ? `${Math.round(m.confidence * 100)}%` : '—'}
                                                </td>
                                                <td style={{ padding: '10px 14px' }}>
                                                    <Button size="sm" variant="danger" onClick={() => setConfirmUnlink(m)}>
                                                        Desvincular
                                                    </Button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </Card>

                    <ConfirmDialog
                        isOpen={!!confirmUnlink}
                        onClose={() => setConfirmUnlink(null)}
                        onConfirm={() => handleUnlink(confirmUnlink.id)}
                        title="Desvincular producto"
                        message={`¿Desvinculás "${confirmUnlink?.supplier_product_name || confirmUnlink?.product_name}" de Odoo?`}
                        confirmLabel="Desvincular"
                        danger
                    />
                </>
            )}

            {/* ── TAB COMPARACIÓN ──────────────────────────────────────────────────── */}
            {activeTab === 'comparacion' && (
                <ComparisonTab
                    supplierId={selectedSupplier}
                    data={cmpData}
                    loading={cmpLoading}
                    search={cmpSearch}
                    onSearchChange={v => { setCmpSearch(v); setCmpPage(1); }}
                    filter={cmpFilter}
                    onFilterChange={v => { setCmpFilter(v); setCmpPage(1); }}
                    page={cmpPage}
                    total={cmpTotal}
                    pageSize={CMP_PAGE_SIZE}
                    onPageChange={setCmpPage}
                    onRefresh={fetchComparison}
                    tokens={t}
                />
            )}
        </div>
    );
}

// ─── Ítem de producto (panel izquierdo) ──────────────────────────────────────────
function ProductItem({ product: p, selected, onClick, tokens: t }) {
    const [hovered, setHovered] = useState(false);
    return (
        <div
            onClick={onClick}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
                display: 'flex', gap: 10, alignItems: 'flex-start',
                padding: 10, marginBottom: 4,
                border: `2px solid ${selected ? t.color.accent : hovered ? t.color.borderStrong : t.color.border}`,
                borderRadius: t.radius.sm,
                background: selected ? t.color.accentSoft : hovered ? t.color.surface2 : t.color.surface,
                cursor: 'pointer', transition: 'all 120ms',
            }}
        >
            <ProductThumb imageUrl={p.image_url} emoji={p.name?.[0]} size={36} />
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: t.font.family }}>
                    {p.name || p.product_name}
                </div>
                <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: 2, fontFamily: t.font.family }}>
                    <span style={{ fontFamily: t.font.mono }}>{p.sku}</span>
                    {p.raw_price != null && <> · {fmtAR(p.raw_price)}</>}
                </div>
                {p.source_category && (
                    <div style={{ fontSize: 11, color: t.color.textFaint, marginTop: 2, fontFamily: t.font.family }}>{p.source_category}</div>
                )}
            </div>
        </div>
    );
}

// ─── Ítem de producto Odoo (panel derecho) ────────────────────────────────────────
function OdooItem({ product: p, selected, onClick, tokens: t }) {
    const [hovered, setHovered] = useState(false);
    return (
        <div
            onClick={onClick}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
                padding: 10, marginBottom: 4,
                border: `2px solid ${selected ? t.color.primary : hovered ? t.color.borderStrong : t.color.border}`,
                borderRadius: t.radius.sm,
                background: selected ? t.color.primarySoft : hovered ? t.color.surface2 : t.color.surface,
                cursor: 'pointer', transition: 'all 120ms',
            }}
        >
            <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: t.font.family }}>
                {p.name}
            </div>
            <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: 2, fontFamily: t.font.family }}>
                Ref: <span style={{ fontFamily: t.font.mono }}>{p.internal_ref || '—'}</span>
                {p.list_price != null && <> · {fmtAR(p.list_price)}</>}
            </div>
            {p.categ_name && (
                <div style={{ fontSize: 11, color: t.color.textFaint, marginTop: 2, fontFamily: t.font.family }}>{p.categ_name}</div>
            )}
        </div>
    );
}

// ─── Tab Comparación ─────────────────────────────────────────────────────────────
function ComparisonTab({ supplierId, data, loading, search, onSearchChange, filter, onFilterChange, page, total, pageSize, onPageChange, onRefresh, tokens: t }) {
    if (!supplierId) {
        return (
            <div style={{ padding: '48px 24px', textAlign: 'center', fontSize: t.font.size.sm, color: t.color.textFaint, fontFamily: t.font.family }}>
                Seleccioná un proveedor para ver la comparación.
            </div>
        );
    }

    const totalPages = Math.ceil(total / pageSize);
    const divColor = t.color.borderStrong;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>
            {/* Filtros */}
            <Card padding={false} style={{ padding: t.space[5] }}>
                <div style={{ display: 'flex', gap: t.space[3], flexWrap: 'wrap', alignItems: 'center' }}>
                    <Input
                        value={search}
                        onChange={e => onSearchChange(e.target.value)}
                        placeholder="Buscar producto o SKU…"
                        leftIcon={<Icon.Search size={14} />}
                        style={{ flex: '1 1 240px', minWidth: 180 }}
                    />
                    <Select value={filter} onChange={onFilterChange} options={FILTER_OPTS} style={{ width: 160 }} />
                    <Button size="sm" variant="ghost" leftIcon={<Icon.Refresh size={13} />} onClick={onRefresh} disabled={loading}>
                        Actualizar
                    </Button>
                    <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family, ...t.numericStyle }}>
                        {total} productos
                    </span>
                </div>
            </Card>

            {/* Tabla */}
            {loading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
                    <LoadingSpinner size="md" color={t.color.primary} />
                </div>
            ) : data.length === 0 ? (
                <div style={{ padding: '32px 24px', textAlign: 'center', fontSize: t.font.size.sm, color: t.color.textFaint, fontFamily: t.font.family }}>
                    No hay productos para mostrar.
                </div>
            ) : (
                <Card padding={false} style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: t.font.size.sm }}>
                        <thead>
                            <tr style={{ background: t.color.surface2 }}>
                                <Th tokens={t}>Producto proveedor</Th>
                                <Th tokens={t}>SKU</Th>
                                <Th tokens={t} right>Precio prov.</Th>
                                <Th tokens={t} divLeft={divColor}>Neggo — Odoo</Th>
                                <Th tokens={t} right>Lista Neggo</Th>
                                <Th tokens={t}>Match N</Th>
                                <Th tokens={t} divLeft={divColor}>Preventas — Odoo</Th>
                                <Th tokens={t} right>Lista Prev.</Th>
                                <Th tokens={t}>Match P</Th>
                                <Th tokens={t}>Estado</Th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.map(row => {
                                const hasBoth = !!row.neggo_mapping_id && !!row.prev_mapping_id;
                                const hasNone = !row.neggo_mapping_id && !row.prev_mapping_id;
                                const statusTone = hasBoth ? 'success' : hasNone ? 'danger' : 'warn';
                                const statusLabel = hasBoth ? 'Ambas' : hasNone ? 'Sin vínculo' : 'Parcial';

                                return (
                                    <tr key={row.id} style={{ borderTop: `1px solid ${t.color.border}`, background: hasNone ? `${t.color.dangerSoft}66` : 'transparent' }}>
                                        <Td tokens={t}>
                                            <div style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: t.font.weight.medium }}>
                                                {row.product_name}
                                            </div>
                                            {row.source_category && <div style={{ fontSize: 11, color: t.color.textFaint }}>{row.source_category}</div>}
                                        </Td>
                                        <Td tokens={t}><span style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textFaint }}>{row.sku || '—'}</span></Td>
                                        <Td tokens={t} right><span style={{ fontWeight: t.font.weight.medium, ...t.numericStyle }}>{row.raw_price ? fmtAR(row.raw_price) : '—'}</span></Td>

                                        <Td tokens={t} divLeft={divColor}>
                                            {row.neggo_odoo_name
                                                ? <OdooCell name={row.neggo_odoo_name} ref={row.neggo_ref} tokens={t} />
                                                : <span style={{ color: t.color.textFaint }}>—</span>}
                                        </Td>
                                        <Td tokens={t} right><span style={{ ...t.numericStyle }}>{row.neggo_list_price ? fmtAR(row.neggo_list_price) : '—'}</span></Td>
                                        <Td tokens={t}>{row.neggo_match_type ? <Badge tone={MATCH_TONE[row.neggo_match_type] || 'muted'}>{row.neggo_match_type}</Badge> : '—'}</Td>

                                        <Td tokens={t} divLeft={divColor}>
                                            {row.prev_odoo_name
                                                ? <OdooCell name={row.prev_odoo_name} ref={row.prev_ref} tokens={t} />
                                                : <span style={{ color: t.color.textFaint }}>—</span>}
                                        </Td>
                                        <Td tokens={t} right><span style={{ ...t.numericStyle }}>{row.prev_list_price ? fmtAR(row.prev_list_price) : '—'}</span></Td>
                                        <Td tokens={t}>{row.prev_match_type ? <Badge tone={MATCH_TONE[row.prev_match_type] || 'muted'}>{row.prev_match_type}</Badge> : '—'}</Td>

                                        <Td tokens={t}><Badge tone={statusTone} dot>{statusLabel}</Badge></Td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </Card>
            )}

            {/* Paginación */}
            {totalPages > 1 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                        Página {page} de {totalPages}
                    </span>
                    <div style={{ display: 'flex', gap: t.space[2] }}>
                        <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>← Anterior</Button>
                        <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>Siguiente →</Button>
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── Helpers de tabla ─────────────────────────────────────────────────────────────
function Th({ children, tokens: t, right, divLeft }) {
    return (
        <th style={{
            padding: '10px 14px', textAlign: right ? 'right' : 'left',
            fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold,
            color: t.color.textMuted, textTransform: 'uppercase',
            letterSpacing: '0.04em', whiteSpace: 'nowrap',
            fontFamily: t.font.family,
            borderLeft: divLeft ? `2px solid ${divLeft}` : 'none',
        }}>
            {children}
        </th>
    );
}

function Td({ children, tokens: t, right, divLeft }) {
    return (
        <td style={{
            padding: '10px 14px', color: t.color.text, fontFamily: t.font.family,
            textAlign: right ? 'right' : 'left',
            borderLeft: divLeft ? `2px solid ${t.color.borderStrong}` : 'none',
        }}>
            {children}
        </td>
    );
}

function OdooCell({ name, ref: refVal, tokens: t }) {
    return (
        <div style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={name}>
            {name}
            {refVal && <span style={{ fontSize: 11, color: t.color.textMuted, marginLeft: 4, fontFamily: t.font.mono }}>({refVal})</span>}
        </div>
    );
}

function Centered({ children, style }) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: '20px 0', ...style }}>{children}</div>;
}

function EmptyPanel({ tokens: t, msg }) {
    return <p style={{ color: t.color.textFaint, fontSize: t.font.size.sm, textAlign: 'center', padding: '24px 0', fontFamily: t.font.family }}>{msg}</p>;
}
