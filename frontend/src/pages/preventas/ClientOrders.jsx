import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR } from '../../theme/tokens';
import DataTable from '../../components/common/DataTable';
import Modal from '../../components/common/Modal';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import ProductThumb from '../../components/common/ProductThumb';
import * as Icon from '../../components/common/icons';

const SOURCES = [
    { key: 'neggo',     label: 'Neggo',     desc: 'Productos en Odoo Neggo' },
    { key: 'preventas', label: 'Preventas', desc: 'Productos en Odoo Preventas' },
];

function orderStatusTone(s) {
    if (s === 'confirmado') return 'success';
    if (s === 'cancelado')  return 'danger';
    if (s === 'cotizacion') return 'primary';
    if (s === 'pendiente')  return 'warn';
    return 'muted';
}

function getProductPrice(p, source) {
    return source === 'supplier' ? (p.raw_price ?? p.precio_preventas) : p.list_price;
}

function applyPricelistToProduct(product, pricelist) {
    if (!pricelist) return null;
    // Backend ya calcula pricelist_price cuando se pasa pricelist_id al endpoint
    if (product.pricelist_price != null) return parseFloat(product.pricelist_price);
    return null;
}
function getProductSku(p, source) {
    return source === 'supplier' ? p.sku : p.internal_ref;
}

// ─── ProductCard ─────────────────────────────────────────────────────────────────
function ProductCard({ p, source, onAdd, adding, onSearchFocus, onArchive, pricelistPrice }) {
    const { tokens: t } = useTheme();
    const [qty, setQty] = useState('1');
    const defaultPrice = (pricelistPrice != null) ? pricelistPrice : getProductPrice(p, source);
    const [editPrice, setEditPrice] = useState(defaultPrice != null ? String(defaultPrice) : '');
    const sku = getProductSku(p, source);
    const [hovered, setHovered] = useState(false);
    const isNeggo = source === 'neggo';

    function handleAdd() {
        const q = Math.max(1, parseInt(qty) || 1);
        setQty('1');
        const customPrice = isNeggo ? (parseFloat(editPrice) || defaultPrice) : undefined;
        onAdd(p, q, customPrice);
        onSearchFocus?.();
    }

    return (
        <div
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
                display: 'flex', alignItems: 'center', gap: t.space[3],
                padding: '8px 10px', marginBottom: t.space[2],
                border: `1px solid ${hovered ? t.color.borderStrong : t.color.border}`,
                borderRadius: t.radius.sm, background: t.color.surface,
                transition: 'border-color 120ms',
            }}
        >
            <ProductThumb imageUrl={p.image_url} emoji={p.name?.[0]} size={40} />
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: t.font.family }}>
                    {p.name}
                </div>
                {sku && <div style={{ fontSize: t.font.size.xs, fontFamily: t.font.mono, color: t.color.textFaint, marginTop: 2 }}>{sku}</div>}
                {isNeggo ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: t.space[1], marginTop: 2 }}>
                        <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family }}>$</span>
                        <input
                            type="text"
                            value={editPrice}
                            onChange={e => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setEditPrice(v); }}
                            onFocus={e => e.target.select()}
                            title="Precio de venta para esta cotización"
                            style={{
                                width: 80, padding: '2px 4px',
                                border: `1px solid ${t.color.borderStrong}`, borderRadius: t.radius.sm,
                                fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold,
                                fontFamily: t.font.mono, color: t.color.accent,
                                background: t.color.surface, outline: 'none',
                            }}
                        />
                    </div>
                ) : (
                    <div style={{ fontSize: t.font.size.sm, color: t.color.accent, fontWeight: t.font.weight.semibold, marginTop: 2, ...t.numericStyle }}>
                        {defaultPrice != null ? fmtAR(defaultPrice) : '—'}
                    </div>
                )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: t.space[1], flexShrink: 0 }}>
                {isNeggo && (
                    <button
                        onClick={() => onArchive?.(p)}
                        title="Archivar: no aparece más en búsquedas"
                        style={{
                            width: 26, height: 26, borderRadius: t.radius.sm,
                            background: 'none', border: `1px solid ${t.color.border}`,
                            color: t.color.textFaint, cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            flexShrink: 0,
                        }}
                    >
                        <Icon.Archive size={13} />
                    </button>
                )}
                <input
                    type="text"
                    value={qty}
                    onChange={e => { const v = e.target.value; if (v === '' || /^\d+$/.test(v)) setQty(v); }}
                    onFocus={e => e.target.select()}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }}
                    disabled={adding}
                    style={{
                        width: 40, textAlign: 'center', padding: '4px',
                        border: `1px solid ${t.color.borderStrong}`, borderRadius: t.radius.sm,
                        fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold,
                        fontFamily: t.font.family, color: t.color.text, background: t.color.surface,
                    }}
                />
                <button
                    onClick={handleAdd}
                    disabled={adding}
                    style={{
                        width: 30, height: 30, borderRadius: t.radius.sm,
                        background: adding ? t.color.surface2 : t.color.primary,
                        color: adding ? t.color.textMuted : '#fff',
                        border: 'none', cursor: adding ? 'not-allowed' : 'pointer',
                        fontSize: 18, fontWeight: t.font.weight.bold, lineHeight: 1,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0,
                    }}
                >
                    {adding ? '…' : '+'}
                </button>
            </div>
        </div>
    );
}

// ─── PartnerSearch ────────────────────────────────────────────────────────────────
function PartnerSearch({ onSelect }) {
    const { tokens: t } = useTheme();
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const [searched, setSearched] = useState(false);
    const [open, setOpen] = useState(false);
    const [creating, setCreating] = useState(false);
    const [createPhone, setCreatePhone] = useState('');
    const [showCreate, setShowCreate] = useState(false);
    const wrapRef = useRef(null);

    useEffect(() => {
        setSearched(false); setShowCreate(false);
        const timer = setTimeout(async () => {
            if (!query.trim()) { setResults([]); return; }
            setLoading(true);
            const res = await api.get('/preventas/customers', { search: query, limit: 15 });
            if (res.success) setResults(res.data || []);
            setLoading(false); setSearched(true); setOpen(true);
        }, 300);
        return () => clearTimeout(timer);
    }, [query]);

    useEffect(() => {
        const handler = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) { setOpen(false); setShowCreate(false); } };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    function pick(partner) {
        onSelect(partner); setQuery(''); setResults([]); setOpen(false); setShowCreate(false);
    }

    async function handleCreate() {
        if (!query.trim()) return;
        setCreating(true);
        const res = await api.post('/preventas/customers', { name: query.trim(), phone: createPhone.trim() || undefined });
        setCreating(false);
        if (res.success) pick({ id: res.data.id, name: res.data.name, phone: createPhone.trim() || null });
    }

    return (
        <div ref={wrapRef} style={{ position: 'relative' }}>
            <Input
                value={query}
                onChange={e => { setQuery(e.target.value); setOpen(true); setShowCreate(false); }}
                onFocus={() => (results.length || searched) && setOpen(true)}
                placeholder="Buscar cliente en Odoo Preventas…"
                leftIcon={<Icon.Search size={14} />}
                autoComplete="off"
            />
            {open && (loading || results.length > 0 || (searched && query.trim())) && (
                <div style={{
                    position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
                    zIndex: 1000, background: t.color.surface,
                    border: `1px solid ${t.color.border}`, borderRadius: t.radius.sm,
                    boxShadow: t.shadow.pop, maxHeight: 240, overflowY: 'auto',
                }}>
                    {loading && (
                        <div style={{ padding: '10px 14px', color: t.color.textMuted, fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                            Buscando…
                        </div>
                    )}
                    {!loading && results.map(p => (
                        <div
                            key={p.id}
                            onMouseDown={() => pick(p)}
                            onMouseEnter={e => { e.currentTarget.style.background = t.color.surface2; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                            style={{ padding: '10px 14px', cursor: 'pointer', borderBottom: `1px solid ${t.color.border}` }}
                        >
                            <div style={{ fontWeight: t.font.weight.semibold, fontSize: t.font.size.sm, color: t.color.text, fontFamily: t.font.family }}>{p.name}</div>
                            {(p.phone || p.mobile || p.city) && (
                                <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family }}>
                                    {[p.phone || p.mobile, p.city].filter(Boolean).join(' · ')}
                                </div>
                            )}
                        </div>
                    ))}
                    {!loading && searched && results.length === 0 && (
                        <div style={{ padding: '10px 14px', color: t.color.textMuted, fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                            Sin resultados para "{query}"
                        </div>
                    )}
                    {!loading && searched && (
                        showCreate ? (
                            <div style={{ padding: '10px 14px', borderTop: `1px solid ${t.color.border}` }}>
                                <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.primary, marginBottom: t.space[2], fontFamily: t.font.family }}>
                                    Crear cliente: {query.trim()}
                                </div>
                                <Input
                                    value={createPhone}
                                    onChange={e => setCreatePhone(e.target.value)}
                                    placeholder="Teléfono (opcional)"
                                    style={{ marginBottom: t.space[2] }}
                                    autoFocus
                                />
                                <div style={{ display: 'flex', gap: t.space[2] }}>
                                    <Button size="sm" variant="primary" onMouseDown={handleCreate} disabled={creating} style={{ flex: 1 }}>
                                        {creating ? 'Creando…' : 'Crear en Odoo'}
                                    </Button>
                                    <Button size="sm" variant="ghost" onMouseDown={() => setShowCreate(false)}>
                                        Cancelar
                                    </Button>
                                </div>
                            </div>
                        ) : (
                            <div
                                onMouseDown={() => setShowCreate(true)}
                                onMouseEnter={e => { e.currentTarget.style.background = t.color.surface2; }}
                                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                style={{
                                    padding: '10px 14px', cursor: 'pointer',
                                    color: t.color.primary, fontWeight: t.font.weight.semibold,
                                    fontSize: t.font.size.sm, borderTop: `1px solid ${t.color.border}`,
                                    fontFamily: t.font.family,
                                }}
                            >
                                + Crear "{query.trim()}" como nuevo cliente
                            </div>
                        )
                    )}
                </div>
            )}
        </div>
    );
}

// ─── Componente principal ─────────────────────────────────────────────────────────
export default function ClientOrders() {
    const { tokens: t } = useTheme();
    const { showToast } = useToast();

    const [data, setData] = useState([]);
    const [loading, setLoading] = useState(true);
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);

    const [newModal, setNewModal] = useState(false);
    const [step, setStep] = useState(1);
    const [orderId, setOrderId] = useState(null);
    const [selectedPartner, setSelectedPartner] = useState(null);
    const [clientPhone, setClientPhone] = useState('');
    const [clientNotes, setClientNotes] = useState('');
    const [creating, setCreating] = useState(false);

    const [productSource, setProductSource] = useState('neggo');
    const [productSearch, setProductSearch] = useState('');
    const [productResults, setProductResults] = useState([]);
    const [searching, setSearching] = useState(false);
    const [addingProduct, setAddingProduct] = useState(null);
    const [orderItems, setOrderItems] = useState([]);

    const searchInputRef = useRef(null);

    const [detailModal, setDetailModal] = useState(null);
    const [sendingOdoo, setSendingOdoo] = useState(false);
    const [detailPartner, setDetailPartner] = useState(null);
    const [deletingOrder, setDeletingOrder] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [editingNotes, setEditingNotes] = useState(false);
    const [notesDraft, setNotesDraft] = useState('');
    const [savingNotes, setSavingNotes] = useState(false);
    const [updatingItem, setUpdatingItem] = useState(null);
    const [confirming, setConfirming] = useState(false);

    const [pricelists, setPricelists] = useState([]);
    const [selectedPricelist, setSelectedPricelist] = useState(null);
    const [loadingPricelist, setLoadingPricelist] = useState(false);

    useEffect(() => { fetchData(); }, [page]);

    useEffect(() => {
        api.get('/pricelists').then(res => {
            if (res.success) setPricelists(res.data || []);
        });
    }, []);

    async function fetchData() {
        setLoading(true);
        const res = await api.get('/preventas/client-orders', { limit: 20, offset: (page - 1) * 20 });
        if (res.success) { setData(res.data || []); setTotal(res.pagination?.total || res.data?.length || 0); }
        else showToast(res.error || 'Error al cargar pedidos', 'error');
        setLoading(false);
    }

    function openNew() {
        setStep(1); setOrderId(null);
        setSelectedPartner(null); setClientPhone(''); setClientNotes('');
        setSelectedPricelist(null);
        setOrderItems([]); setProductSearch(''); setProductResults([]);
        setProductSource('neggo');
        setNewModal(true);
    }

    async function createOrder() {
        if (!selectedPartner) return showToast('Seleccioná un cliente de Odoo', 'warning');
        setCreating(true);
        const res = await api.post('/preventas/client-orders', {
            client_name:     selectedPartner.name,
            client_phone:    clientPhone || selectedPartner.phone || selectedPartner.mobile || null,
            client_notes:    clientNotes || null,
            odoo_partner_id: selectedPartner.id,
            pricelist_id:    selectedPricelist?.id || null,
        });
        setCreating(false);
        if (res.success) { setOrderId(res.data.id); setStep(2); }
        else showToast(res.error || 'Error al crear pedido', 'error');
    }

    const runSearch = useCallback(async (search, source, pricelistId) => {
        setSearching(true);
        const params = { company: source, search: search || undefined, limit: 40 };
        if (pricelistId) params.pricelist_id = pricelistId;
        const res = await api.get('/products/odoo', params);
        if (res.success) setProductResults(res.data || []);
        else showToast(res.error || 'Error al buscar', 'error');
        setSearching(false);
    }, []);

    useEffect(() => {
        if (!newModal || step !== 2) return;
        const timer = setTimeout(() => runSearch(productSearch, productSource, selectedPricelist?.id), productSearch ? 300 : 0);
        return () => clearTimeout(timer);
    }, [productSearch, productSource, newModal, step, runSearch, selectedPricelist]);

    async function addItem(product, quantity = 1, customPrice) {
        const key = productSource === 'supplier' ? product.id : product.odoo_id;
        setAddingProduct(key);
        const body = productSource === 'supplier'
            ? { supplierProductId: product.id, quantity }
            : { odooProductId: product.odoo_id, odooCompany: productSource, quantity, ...(customPrice != null ? { unit_price: customPrice } : {}) };
        const res = await api.post(`/preventas/client-orders/${orderId}/items`, body);
        setAddingProduct(null);
        if (res.success) {
            const backendPrice = res.data.unit_price;
            const fallbackPrice = customPrice != null ? customPrice : getProductPrice(product, productSource);
            const price = backendPrice != null ? backendPrice : fallbackPrice;
            const sku = getProductSku(product, productSource);
            setOrderItems(prev => {
                const match = prev.find(i =>
                    productSource === 'supplier'
                        ? i.supplier_product_id === product.id
                        : i.odoo_product_id === product.odoo_id && i.odoo_company === productSource
                );
                if (match) return prev.map(i => i.id === match.id ? { ...i, quantity: res.data.quantity } : i);
                return [...prev, { ...res.data, product_name: product.name, image_url: product.image_url || null, unit_price: price, sku }];
            });
        } else showToast(res.error || 'Error al agregar', 'error');
    }

    async function archiveProduct(product) {
        const res = await api.patch(`/products/odoo/${product.odoo_id}/archive`, { company: 'neggo', archived: true });
        if (res.success) {
            setProductResults(prev => prev.filter(p => p.odoo_id !== product.odoo_id));
            showToast(`"${product.name}" archivado`, 'success');
        } else {
            showToast(res.error || 'Error al archivar', 'error');
        }
    }

    async function removeItem(item) {
        const res = await api.del(`/preventas/client-orders/${orderId}/items/${item.id}`);
        if (res.success) setOrderItems(prev => prev.filter(i => i.id !== item.id));
        else showToast(res.error || 'Error al quitar item', 'error');
    }

    async function openDetail(row) {
        setDetailPartner(null);
        const res = await api.get(`/preventas/client-orders/${row.id}`);
        if (res.success) setDetailModal(res.data);
        else showToast(res.error || 'Error al cargar detalle', 'error');
    }

    async function sendToOdoo() {
        if (!detailModal) return;
        const partnerId = detailModal.odoo_partner_id || detailPartner?.id;
        if (!partnerId) return showToast('Seleccioná un cliente de Odoo primero', 'warning');
        setSendingOdoo(true);
        const res = await api.post(`/preventas/client-orders/${detailModal.id}/send-to-odoo`, { partner_id: partnerId });
        setSendingOdoo(false);
        if (res.success) {
            const names = [res.data.preventas?.name, res.data.neggo?.name].filter(Boolean).join(' · ');
            showToast(`Pedido enviado a Odoo: ${names}`, 'success');
            setDetailModal(prev => ({
                ...prev,
                odoo_partner_id: partnerId,
                ...(res.data.preventas ? { odoo_sale_order_id: res.data.preventas.id, odoo_sale_order_name: res.data.preventas.name } : {}),
                ...(res.data.neggo ? { neggo_sale_order_id: res.data.neggo.id, neggo_sale_order_name: res.data.neggo.name } : {}),
                status: 'cotizacion',
            }));
            setDetailPartner(null); fetchData();
        } else showToast(res.error || 'Error al enviar a Odoo', 'error');
    }

    async function updateItemQty(item, delta) {
        const newQty = (item.quantity || 1) + delta;
        if (newQty < 1) return;
        setUpdatingItem(item.id);
        const res = await api.put(`/preventas/client-orders/${detailModal.id}/items/${item.id}`, { quantity: newQty });
        setUpdatingItem(null);
        if (res.success) setDetailModal(prev => ({ ...prev, items: prev.items.map(i => i.id === item.id ? { ...i, quantity: newQty } : i) }));
        else showToast(res.error || 'Error al actualizar cantidad', 'error');
    }

    async function removeDetailItem(item) {
        setUpdatingItem(item.id);
        const res = await api.del(`/preventas/client-orders/${detailModal.id}/items/${item.id}`);
        setUpdatingItem(null);
        if (res.success) setDetailModal(prev => ({ ...prev, items: prev.items.filter(i => i.id !== item.id) }));
        else showToast(res.error || 'Error al quitar ítem', 'error');
    }

    async function confirmOrder() {
        if (!detailModal) return;
        setConfirming(true);
        const res = await api.post(`/preventas/client-orders/${detailModal.id}/confirm`, {});
        setConfirming(false);
        if (res.success) { showToast('Pedido confirmado en Odoo', 'success'); setDetailModal(prev => ({ ...prev, status: 'confirmado' })); fetchData(); }
        else showToast(res.error || 'Error al confirmar', 'error');
    }

    async function deleteOrder() {
        setDeletingOrder(true);
        const res = await api.del(`/preventas/client-orders/${detailModal.id}`);
        setDeletingOrder(false); setConfirmDelete(false);
        if (res.success) { showToast('Pedido eliminado', 'success'); setDetailModal(null); fetchData(); }
        else showToast(res.error || 'Error al eliminar', 'error');
    }

    function printOrder() {
        if (!detailModal) return;
        const items = detailModal.items || [];
        const total = items.reduce((s, i) => s + (i.unit_price || 0) * i.quantity, 0);
        const fecha = new Date(detailModal.created_at).toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' });

        const rows = items.map(i => `
            <tr>
                <td>${i.product_name || '—'}</td>
                <td class="mono">${i.sku || '—'}</td>
                <td class="num">${i.quantity}</td>
                <td class="num">$ ${(i.unit_price || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
                <td class="num bold">$ ${((i.unit_price || 0) * i.quantity).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
            </tr>`).join('');

        const refs = [
            detailModal.odoo_sale_order_name && `Preventas: <strong>${detailModal.odoo_sale_order_name}</strong>`,
            detailModal.neggo_sale_order_name && `Neggo: <strong>${detailModal.neggo_sale_order_name}</strong>`,
        ].filter(Boolean).join(' &nbsp;·&nbsp; ');

        const html = `<!DOCTYPE html><html lang="es"><head>
<meta charset="utf-8">
<title>Pedido — ${detailModal.client_name}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 13px; color: #1c1c1a; background: #fff; padding: 32px 40px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; padding-bottom: 18px; border-bottom: 2px solid #1f3a68; }
  .brand { font-size: 22px; font-weight: 800; color: #1f3a68; letter-spacing: -0.5px; }
  .brand span { color: #e25a1c; }
  .meta-block { text-align: right; font-size: 12px; color: #6b6a64; line-height: 1.6; }
  .meta-block strong { color: #1c1c1a; font-size: 14px; display: block; margin-bottom: 2px; }
  .section { margin-bottom: 22px; }
  .section-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #9a988f; margin-bottom: 6px; }
  .client-name { font-size: 18px; font-weight: 700; color: #1c1c1a; }
  .client-sub { font-size: 12px; color: #6b6a64; margin-top: 3px; }
  .notes-box { background: #f5f3ee; border-left: 3px solid #e25a1c; padding: 8px 12px; font-size: 12px; color: #1c1c1a; border-radius: 2px; }
  table { width: 100%; border-collapse: collapse; }
  thead tr { background: #1f3a68; color: #fff; }
  thead th { padding: 8px 10px; text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  thead th.num { text-align: right; }
  tbody tr { border-bottom: 1px solid #e8e3d8; }
  tbody tr:last-child { border-bottom: none; }
  tbody td { padding: 7px 10px; font-size: 12px; vertical-align: middle; }
  .mono { font-family: 'Courier New', monospace; font-size: 11px; color: #9a988f; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .bold { font-weight: 700; }
  .total-row { background: #f5f3ee; }
  .total-row td { padding: 10px; font-size: 14px; font-weight: 700; color: #1f3a68; }
  .refs { margin-top: 10px; font-size: 11px; color: #9a988f; }
  .refs strong { color: #1c1c1a; }
  .footer { margin-top: 32px; padding-top: 14px; border-top: 1px solid #e8e3d8; font-size: 11px; color: #9a988f; text-align: center; }
  @media print { body { padding: 0; } @page { margin: 18mm 16mm; } }
</style></head><body>
<div class="header">
  <div class="brand">Neggo<span>.</span></div>
  <div class="meta-block">
    <strong>Presupuesto</strong>
    ${fecha}
    ${refs ? `<br>${refs}` : ''}
  </div>
</div>

<div class="section">
  <div class="section-title">Cliente</div>
  <div class="client-name">${detailModal.client_name}</div>
  ${detailModal.client_phone ? `<div class="client-sub">${detailModal.client_phone}</div>` : ''}
</div>

${detailModal.notes ? `<div class="section"><div class="notes-box">${detailModal.notes}</div></div>` : ''}

<div class="section">
  <table>
    <thead>
      <tr>
        <th>Producto</th>
        <th>SKU</th>
        <th class="num">Cant.</th>
        <th class="num">Precio unit.</th>
        <th class="num">Subtotal</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
      <tr class="total-row">
        <td colspan="4" style="text-align:right;">Total estimado</td>
        <td class="num bold">$ ${total.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</td>
      </tr>
    </tbody>
  </table>
  ${refs ? `<div class="refs">Referencia Odoo: ${refs}</div>` : ''}
</div>

<div class="footer">Neggo Mayorista — Pergamino, Buenos Aires</div>
</body></html>`;

        const w = window.open('', '_blank', 'width=800,height=900');
        w.document.write(html);
        w.document.close();
        w.focus();
        setTimeout(() => { w.print(); }, 400);
    }

    async function saveNotes() {
        setSavingNotes(true);
        const res = await api.put(`/preventas/client-orders/${detailModal.id}`, { client_notes: notesDraft });
        setSavingNotes(false);
        if (res.success) { setDetailModal(prev => ({ ...prev, notes: notesDraft })); setEditingNotes(false); showToast('Notas actualizadas', 'success'); }
        else showToast(res.error || 'Error al guardar notas', 'error');
    }

    function openAddProducts() {
        setOrderId(detailModal.id);
        setSelectedPartner({ name: detailModal.client_name, id: detailModal.odoo_partner_id });
        setOrderItems((detailModal.items || []).map(i => ({ ...i })));
        setProductSearch(''); setProductResults([]); setProductSource('neggo');
        setEditingNotes(false); setStep(2); setDetailModal(null); setNewModal(true);
    }

    const total_items  = orderItems.reduce((s, i) => s + (i.quantity || 1), 0);
    const total_amount = orderItems.reduce((s, i) => s + ((i.unit_price || 0) * (i.quantity || 1)), 0);
    const isClosed = (status) => ['confirmado', 'cancelado'].includes(status);

    const cols = [
        { key: 'client_name',    label: 'Cliente' },
        { key: 'client_phone',   label: 'Teléfono', render: v => v || '—' },
        { key: 'created_at',     label: 'Fecha',    render: v => new Date(v).toLocaleDateString('es-AR') },
        { key: 'item_count',     label: 'Ítems',    render: v => <span style={t.numericStyle}>{v ?? '—'}</span> },
        { key: 'total_estimated',label: 'Total est.',render: v => v ? <span style={t.numericStyle}>{fmtAR(v)}</span> : '—' },
        { key: 'odoo_sale_order_name', label: 'Odoo', render: (_, row) => {
            const tags = [];
            if (row.odoo_sale_order_name) tags.push(<Badge key="p" tone="accent" style={{ marginRight: 4 }}>{row.odoo_sale_order_name}</Badge>);
            if (row.neggo_sale_order_name) tags.push(<Badge key="n" tone="primary">{row.neggo_sale_order_name}</Badge>);
            return tags.length ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{tags}</div> : <span style={{ color: t.color.textFaint }}>—</span>;
        }},
        { key: 'status', label: 'Estado', render: v => <Badge tone={orderStatusTone(v)} dot>{v || '—'}</Badge> },
    ];

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button variant="primary" leftIcon={<Icon.ShoppingCart size={15} />} onClick={openNew}>
                    Nuevo pedido
                </Button>
            </div>

            <DataTable columns={cols} data={data} loading={loading} onRowClick={openDetail} pagination={{ page, pageSize: 20, total }} onPageChange={setPage} />

            {/* ── Modal nuevo pedido ── */}
            <Modal
                isOpen={newModal}
                onClose={() => { setNewModal(false); fetchData(); }}
                title={step === 1 ? 'Nuevo pedido' : `Agregar productos — ${selectedPartner?.name}`}
                size="xl"
            >
                {step === 1 ? (
                    <div style={{ maxWidth: 480 }}>
                        <div style={{ marginBottom: t.space[5] }}>
                            <label style={{ display: 'block', fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.textMuted, marginBottom: t.space[2], fontFamily: t.font.family }}>
                                Cliente de Odoo Preventas *
                            </label>
                            {selectedPartner ? (
                                <PartnerCard partner={selectedPartner} onClear={() => setSelectedPartner(null)} tokens={t} />
                            ) : (
                                <PartnerSearch onSelect={p => { setSelectedPartner(p); setClientPhone(p.phone || p.mobile || ''); }} />
                            )}
                        </div>
                        <div style={{ marginBottom: t.space[5] }}>
                            <label style={{ display: 'block', fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.textMuted, marginBottom: t.space[2], fontFamily: t.font.family }}>
                                Teléfono (opcional)
                            </label>
                            <Input value={clientPhone} onChange={e => setClientPhone(e.target.value)} placeholder="Ej: 11 2345-6789" />
                        </div>
                        <div style={{ marginBottom: t.space[5] }}>
                            <label style={{ display: 'block', fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.textMuted, marginBottom: t.space[2], fontFamily: t.font.family }}>
                                Lista de precios{' '}
                                <span style={{ fontWeight: t.font.weight.regular, color: t.color.textFaint }}>(opcional)</span>
                            </label>
                            <select
                                value={selectedPricelist?.id || ''}
                                onChange={async e => {
                                    const id = parseInt(e.target.value);
                                    if (!id) { setSelectedPricelist(null); return; }
                                    setLoadingPricelist(true);
                                    const r = await api.get(`/pricelists/${id}`);
                                    setLoadingPricelist(false);
                                    if (r.success) setSelectedPricelist(r.data);
                                }}
                                disabled={loadingPricelist}
                                style={{
                                    width: '100%', padding: '8px 12px',
                                    border: `1px solid ${t.color.borderStrong}`,
                                    borderRadius: t.radius.sm, fontSize: t.font.size.base,
                                    fontFamily: t.font.family, color: t.color.text,
                                    background: t.color.surface, outline: 'none',
                                }}
                            >
                                <option value="">— Precio estándar —</option>
                                {pricelists.map(pl => (
                                    <option key={pl.id} value={pl.id}>{pl.name}</option>
                                ))}
                            </select>
                            {selectedPricelist && (
                                <div style={{ marginTop: t.space[2], fontSize: t.font.size.xs, color: t.color.accent, fontFamily: t.font.family }}>
                                    Descuento base {selectedPricelist.default_descuento}% sobre precio de lista del proveedor
                                    {selectedPricelist.rules?.length > 0 && ` · ${selectedPricelist.rules.length} regla${selectedPricelist.rules.length > 1 ? 's' : ''} específica${selectedPricelist.rules.length > 1 ? 's' : ''}`}
                                </div>
                            )}
                        </div>
                        <div style={{ marginBottom: t.space[5] }}>
                            <label style={{ display: 'block', fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.textMuted, marginBottom: t.space[2], fontFamily: t.font.family }}>
                                Notas
                            </label>
                            <textarea
                                value={clientNotes}
                                onChange={e => setClientNotes(e.target.value)}
                                rows={3}
                                style={{ width: '100%', padding: '8px 12px', border: `1px solid ${t.color.borderStrong}`, borderRadius: t.radius.sm, fontSize: t.font.size.base, fontFamily: t.font.family, color: t.color.text, background: t.color.surface, resize: 'vertical', boxSizing: 'border-box', outline: 'none' }}
                            />
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                            <Button variant="primary" disabled={creating || !selectedPartner} onClick={createOrder} rightIcon={<Icon.ArrowRight size={15} />}>
                                {creating ? 'Creando…' : 'Crear y agregar productos'}
                            </Button>
                        </div>
                    </div>
                ) : (
                    <div style={{ display: 'flex', gap: 0, height: 'calc(72vh - 80px)', minHeight: 420 }}>
                        {/* Panel izquierdo: buscador */}
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: t.space[3], minWidth: 0, paddingRight: t.space[6] }}>
                            {/* Tabs de fuente */}
                            <div style={{ display: 'flex', background: t.color.surface2, borderRadius: t.radius.sm, padding: 3, border: `1px solid ${t.color.border}` }}>
                                {SOURCES.map(src => (
                                    <button
                                        key={src.key}
                                        type="button"
                                        onClick={() => { setProductSource(src.key); setProductSearch(''); setProductResults([]); }}
                                        title={src.desc}
                                        style={{
                                            flex: 1, padding: '6px 10px', fontSize: t.font.size.sm,
                                            fontWeight: t.font.weight.medium, fontFamily: t.font.family,
                                            borderRadius: t.radius.sm - 1, cursor: 'pointer',
                                            background: productSource === src.key ? t.color.surface : 'transparent',
                                            color: productSource === src.key ? t.color.text : t.color.textMuted,
                                            boxShadow: productSource === src.key ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                                        }}
                                    >
                                        {src.label}
                                    </button>
                                ))}
                            </div>

                            <Input
                                ref={searchInputRef}
                                value={productSearch}
                                onChange={e => setProductSearch(e.target.value)}
                                placeholder={productSource === 'supplier' ? 'Buscar por nombre o SKU…' : 'Buscar por nombre o código…'}
                                leftIcon={<Icon.Search size={14} />}
                            />

                            <div style={{ flex: 1, overflowY: 'auto' }}>
                                {searching && <div style={{ color: t.color.textMuted, fontSize: t.font.size.sm, textAlign: 'center', padding: '24px 0', fontFamily: t.font.family }}>Buscando…</div>}
                                {!searching && productResults.length === 0 && (
                                    <div style={{ color: t.color.textFaint, fontSize: t.font.size.sm, textAlign: 'center', padding: '24px 0', fontFamily: t.font.family }}>
                                        {productSearch ? 'Sin resultados.' : 'Escribí algo para buscar.'}
                                    </div>
                                )}
                                {!searching && productResults.map(p => {
                                    const key = p.odoo_id;
                                    const pricelistPrice = selectedPricelist
                                        ? applyPricelistToProduct(p, selectedPricelist)
                                        : null;
                                    return (
                                        <ProductCard
                                            key={key}
                                            p={p}
                                            source={productSource}
                                            onAdd={addItem}
                                            adding={addingProduct === key}
                                            onSearchFocus={() => searchInputRef.current?.focus()}
                                            onArchive={productSource === 'neggo' ? archiveProduct : undefined}
                                            pricelistPrice={pricelistPrice}
                                        />
                                    );
                                })}
                            </div>
                        </div>

                        {/* Panel derecho: carrito */}
                        <div style={{ width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column', borderLeft: `1px solid ${t.color.border}`, paddingLeft: t.space[6] }}>
                            <div style={{ fontSize: 15, fontWeight: t.font.weight.semibold, color: t.color.text, marginBottom: t.space[1], flexShrink: 0, fontFamily: t.font.family }}>
                                Pedido{' '}
                                <span style={{ color: t.color.textMuted, fontWeight: t.font.weight.regular, ...t.numericStyle }}>
                                    ({total_items} ítems)
                                </span>
                            </div>
                            {selectedPricelist && (
                                <div style={{ marginBottom: t.space[3], display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: t.radius.sm, background: t.color.accent + '1a', border: `1px solid ${t.color.accent}33`, fontSize: t.font.size.xs, color: t.color.accent, fontFamily: t.font.family }}>
                                    <Icon.Tag size={10} />
                                    {selectedPricelist.name}
                                </div>
                            )}

                            <div style={{ flex: 1, overflowY: 'auto' }}>
                                {orderItems.length === 0 ? (
                                    <p style={{ color: t.color.textMuted, fontSize: t.font.size.sm, margin: 0, fontFamily: t.font.family }}>
                                        Todavía no agregaste productos.
                                    </p>
                                ) : orderItems.map(item => (
                                    <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: t.space[2], padding: `${t.space[2]}px 0`, borderBottom: `1px solid ${t.color.border}` }}>
                                        <ProductThumb imageUrl={item.image_url} emoji={item.product_name?.[0]} size={32} />
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: t.color.text, fontFamily: t.font.family }}>
                                                {item.product_name}
                                            </div>
                                            {item.sku && <div style={{ fontSize: t.font.size.xs, fontFamily: t.font.mono, color: t.color.textFaint }}>{item.sku}</div>}
                                            <div style={{ fontSize: t.font.size.xs, color: t.color.accent, ...t.numericStyle }}>
                                                {fmtAR(item.unit_price || 0)} c/u
                                            </div>
                                        </div>
                                        <span style={{ fontWeight: t.font.weight.semibold, fontSize: t.font.size.sm, minWidth: 24, textAlign: 'center', color: t.color.text, ...t.numericStyle }}>
                                            ×{item.quantity || 1}
                                        </span>
                                        <button
                                            onClick={() => removeItem(item)}
                                            style={{ background: 'none', border: 'none', color: t.color.textFaint, cursor: 'pointer', padding: '2px 4px', fontSize: 14, lineHeight: 1 }}
                                        >
                                            ✕
                                        </button>
                                    </div>
                                ))}
                            </div>

                            <div style={{ flexShrink: 0, paddingTop: t.space[3] }}>
                                {total_amount > 0 && (
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: `1px solid ${t.color.border}`, paddingTop: t.space[3], marginBottom: t.space[3] }}>
                                        <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>Total estimado</span>
                                        <span style={{ fontWeight: t.font.weight.semibold, fontSize: t.font.size.lg, color: t.color.text, ...t.numericStyle }}>
                                            {fmtAR(total_amount)}
                                        </span>
                                    </div>
                                )}
                                <Button
                                    variant="primary"
                                    leftIcon={<Icon.Check size={15} />}
                                    style={{ width: '100%' }}
                                    onClick={() => { setNewModal(false); fetchData(); }}
                                >
                                    Finalizar pedido{orderItems.length > 0 && ` (${total_items} ítems)`}
                                </Button>
                            </div>
                        </div>
                    </div>
                )}
            </Modal>

            {/* ── Modal detalle ── */}
            <Modal
                isOpen={!!detailModal}
                onClose={() => setDetailModal(null)}
                title={`Pedido — ${detailModal?.client_name}`}
                subtitle={detailModal ? new Date(detailModal.created_at).toLocaleString('es-AR') : ''}
                size="lg"
            >
                {detailModal && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[6] }}>
                        {/* Acciones */}
                        <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap' }}>
                            {!isClosed(detailModal.status) && (
                                <Button size="sm" variant="secondary" leftIcon={<Icon.Package size={13} />} onClick={openAddProducts}>
                                    Agregar productos
                                </Button>
                            )}
                            {detailModal.status === 'cotizacion' && (
                                <Button size="sm" variant="primary" leftIcon={<Icon.Check size={13} />} disabled={confirming} onClick={confirmOrder}>
                                    {confirming ? 'Confirmando…' : 'Confirmar en Odoo'}
                                </Button>
                            )}
                            {(detailModal.items?.length > 0) && (
                                <Button size="sm" variant="ghost" leftIcon={<Icon.FileText size={13} />} onClick={printOrder}>
                                    Exportar PDF
                                </Button>
                            )}
                            <Button size="sm" variant="danger" style={{ marginLeft: 'auto' }} disabled={deletingOrder} onClick={() => setConfirmDelete(true)}>
                                Eliminar pedido
                            </Button>
                        </div>

                        {/* Meta del pedido */}
                        <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: `${t.space[2]}px ${t.space[5]}px`, alignItems: 'start' }}>
                            <span style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.textMuted, fontFamily: t.font.family }}>Estado</span>
                            <Badge tone={orderStatusTone(detailModal.status)} dot>{detailModal.status}</Badge>

                            <span style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.textMuted, fontFamily: t.font.family }}>Teléfono</span>
                            <span style={{ fontSize: t.font.size.sm, color: t.color.text, fontFamily: t.font.family }}>{detailModal.client_phone || '—'}</span>

                            <span style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.textMuted, fontFamily: t.font.family, paddingTop: 2 }}>Notas</span>
                            <div>
                                {editingNotes ? (
                                    <div style={{ display: 'flex', gap: t.space[2], alignItems: 'flex-start' }}>
                                        <textarea
                                            value={notesDraft}
                                            onChange={e => setNotesDraft(e.target.value)}
                                            rows={2} autoFocus
                                            style={{ flex: 1, padding: '6px 10px', border: `1px solid ${t.color.borderStrong}`, borderRadius: t.radius.sm, fontSize: t.font.size.sm, fontFamily: t.font.family, color: t.color.text, background: t.color.surface, resize: 'vertical', outline: 'none' }}
                                        />
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[1] }}>
                                            <Button size="sm" variant="primary" disabled={savingNotes} onClick={saveNotes}>{savingNotes ? '…' : 'Guardar'}</Button>
                                            <Button size="sm" variant="ghost" onClick={() => setEditingNotes(false)}>Cancelar</Button>
                                        </div>
                                    </div>
                                ) : (
                                    <span
                                        onClick={() => { setNotesDraft(detailModal.notes || ''); setEditingNotes(true); }}
                                        style={{ fontSize: t.font.size.sm, cursor: 'pointer', color: detailModal.notes ? t.color.text : t.color.textFaint, borderBottom: `1px dashed ${t.color.border}`, paddingBottom: 1, fontFamily: t.font.family }}
                                        title="Clic para editar"
                                    >
                                        {detailModal.notes || 'Sin notas — clic para agregar'}
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* Tabla de ítems */}
                        {detailModal.items?.length > 0 && (
                            <div style={{ border: `1px solid ${t.color.border}`, borderRadius: t.radius.sm, overflow: 'hidden' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: t.font.size.sm }}>
                                    <thead>
                                        <tr style={{ background: t.color.surface2 }}>
                                            {['', 'Producto', 'SKU', 'Origen', 'Cant.', 'Precio unit.', 'Subtotal', ...(isClosed(detailModal.status) ? [] : [''])].map((h, i) => (
                                                <th key={i} style={{ padding: '8px 12px', textAlign: i >= 4 ? 'right' : 'left', fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, color: t.color.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em', fontFamily: t.font.family }}>
                                                    {h}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {detailModal.items.map(item => (
                                            <tr key={item.id} style={{ borderTop: `1px solid ${t.color.border}` }}>
                                                <td style={{ padding: '8px 12px', width: 36 }}>
                                                    <ProductThumb imageUrl={item.image_url} emoji={item.product_name?.[0]} size={32} />
                                                </td>
                                                <td style={{ padding: '8px 12px', color: t.color.text, fontFamily: t.font.family }}>{item.product_name}</td>
                                                <td style={{ padding: '8px 12px' }}>
                                                    <span style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textFaint }}>{item.sku || '—'}</span>
                                                </td>
                                                <td style={{ padding: '8px 12px' }}>
                                                    <Badge tone="muted">{item.supplier_name || '—'}</Badge>
                                                </td>
                                                <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                                                    {!isClosed(detailModal.status) ? (
                                                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: t.space[1] }}>
                                                            <QtyBtn onClick={() => updateItemQty(item, -1)} disabled={updatingItem === item.id || item.quantity <= 1} tokens={t}>−</QtyBtn>
                                                            <span style={{ minWidth: 20, textAlign: 'center', fontWeight: t.font.weight.semibold, ...t.numericStyle }}>{item.quantity}</span>
                                                            <QtyBtn onClick={() => updateItemQty(item, 1)} disabled={updatingItem === item.id} tokens={t}>+</QtyBtn>
                                                        </div>
                                                    ) : <span style={t.numericStyle}>{item.quantity}</span>}
                                                </td>
                                                <td style={{ padding: '8px 12px', textAlign: 'right', ...t.numericStyle, color: t.color.textMuted }}>{fmtAR(item.unit_price || 0)}</td>
                                                <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: t.font.weight.semibold, ...t.numericStyle, color: t.color.text }}>
                                                    {fmtAR((item.unit_price || 0) * item.quantity)}
                                                </td>
                                                {!isClosed(detailModal.status) && (
                                                    <td style={{ padding: '8px 12px', width: 36 }}>
                                                        <button onClick={() => removeDetailItem(item)} disabled={updatingItem === item.id} style={{ background: 'none', border: 'none', color: t.color.textFaint, cursor: 'pointer', fontSize: 13 }}>✕</button>
                                                    </td>
                                                )}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}

                        {/* Bloque Odoo */}
                        <OdooBlock detailModal={detailModal} detailPartner={detailPartner} setDetailPartner={setDetailPartner} sendToOdoo={sendToOdoo} sendingOdoo={sendingOdoo} tokens={t} />
                    </div>
                )}
            </Modal>

            {/* Confirm eliminar pedido */}
            <ConfirmDialog
                isOpen={confirmDelete}
                onClose={() => setConfirmDelete(false)}
                onConfirm={deleteOrder}
                title="Eliminar pedido"
                message={`¿Eliminás el pedido de "${detailModal?.client_name}"? Se cancelarán las órdenes en Odoo si ya fueron enviadas.`}
                confirmLabel={deletingOrder ? 'Eliminando…' : 'Eliminar'}
                danger
            />
        </div>
    );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────────
function PartnerCard({ partner, onClear, tokens: t }) {
    return (
        <div style={{
            display: 'flex', alignItems: 'center', gap: t.space[4],
            padding: '12px 14px', background: t.color.primarySoft,
            border: `2px solid ${t.color.primary}`, borderRadius: t.radius.sm,
        }}>
            <div style={{ flex: 1 }}>
                <div style={{ fontWeight: t.font.weight.semibold, fontSize: t.font.size.base, color: t.color.text, fontFamily: t.font.family }}>{partner.name}</div>
                {(partner.phone || partner.mobile) && (
                    <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 2, fontFamily: t.font.family }}>
                        {partner.phone || partner.mobile}
                    </div>
                )}
            </div>
            <Button size="sm" variant="ghost" onClick={onClear}>Cambiar</Button>
        </div>
    );
}

function QtyBtn({ children, onClick, disabled, tokens: t }) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            style={{
                width: 22, height: 22, borderRadius: t.radius.sm,
                border: `1px solid ${t.color.border}`, background: t.color.surface,
                color: disabled ? t.color.textFaint : t.color.primary,
                cursor: disabled ? 'not-allowed' : 'pointer',
                fontWeight: t.font.weight.bold, fontSize: 14, lineHeight: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
        >
            {children}
        </button>
    );
}

function OdooBlock({ detailModal, detailPartner, setDetailPartner, sendToOdoo, sendingOdoo, tokens: t }) {
    const hasNeggoItems     = detailModal.items?.some(i => i.odoo_company === 'neggo');
    const hasPreventasItems = detailModal.items?.some(i => i.odoo_company === 'preventas' || !i.odoo_company);
    const allSent = (!hasNeggoItems || !!detailModal.neggo_sale_order_id) && (!hasPreventasItems || !!detailModal.odoo_sale_order_id);
    const noPartner = !detailModal.odoo_partner_id && !detailPartner;

    return (
        <div style={{ paddingTop: t.space[5], borderTop: `1px solid ${t.color.border}`, display: 'flex', flexDirection: 'column', gap: t.space[3] }}>
            {detailModal.odoo_sale_order_name && (
                <OdooConfirmedRow label="Odoo Preventas" name={detailModal.odoo_sale_order_name} tone="accent" tokens={t} />
            )}
            {detailModal.neggo_sale_order_name && (
                <OdooConfirmedRow label="Odoo Neggo" name={detailModal.neggo_sale_order_name} tone="primary" tokens={t} />
            )}

            {!allSent && (
                <>
                    {!detailModal.odoo_partner_id && (
                        detailPartner ? (
                            <PartnerCard partner={detailPartner} onClear={() => setDetailPartner(null)} tokens={t} />
                        ) : (
                            <div>
                                <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginBottom: t.space[2], fontFamily: t.font.family }}>
                                    Seleccioná el cliente de Odoo para enviar:
                                </div>
                                <PartnerSearch onSelect={p => setDetailPartner(p)} />
                            </div>
                        )
                    )}
                    <Button
                        variant="primary"
                        leftIcon={<Icon.ArrowRight size={15} />}
                        disabled={sendingOdoo || noPartner}
                        onClick={sendToOdoo}
                    >
                        {sendingOdoo ? 'Enviando…' : 'Enviar a Odoo'}
                    </Button>
                </>
            )}
        </div>
    );
}

function OdooConfirmedRow({ label, name, tone, tokens: t }) {
    return (
        <div style={{
            display: 'flex', alignItems: 'center', gap: t.space[3],
            padding: '10px 14px', background: t.color.surface2,
            borderRadius: t.radius.sm, border: `1px solid ${t.color.border}`,
        }}>
            <Icon.Check size={16} color={t.color.success} />
            <div style={{ flex: 1 }}>
                <div style={{ fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, color: t.color.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em', fontFamily: t.font.family }}>
                    {label}
                </div>
                <div style={{ fontSize: t.font.size.sm, color: t.color.text, fontFamily: t.font.family }}>{name}</div>
            </div>
            <Badge tone={tone}>{name}</Badge>
        </div>
    );
}
