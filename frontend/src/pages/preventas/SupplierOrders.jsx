import { useState, useEffect } from 'react';
import api from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR } from '../../theme/tokens';
import DataTable from '../../components/common/DataTable';
import Modal from '../../components/common/Modal';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import * as Icon from '../../components/common/icons';

function orderStatusTone(s) {
    if (s === 'confirmado' || s === 'done') return 'success';
    if (s === 'cancelado') return 'danger';
    if (s === 'borrador')  return 'muted';
    if (s === 'enviado')   return 'primary';
    return 'muted';
}

export default function SupplierOrders() {
    const { tokens: t } = useTheme();
    const { showToast } = useToast();

    const [data, setData] = useState([]);
    const [loading, setLoading] = useState(true);
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [generateModal, setGenerateModal] = useState(false);
    const [pendingOrders, setPendingOrders] = useState([]);
    const [selectedOrders, setSelectedOrders] = useState([]);
    const [generating, setGenerating] = useState(false);
    const [sendingId, setSendingId] = useState(null);
    const [downloadingId, setDownloadingId] = useState(null);

    useEffect(() => { fetchData(); }, [page]);

    async function fetchData() {
        setLoading(true);
        const res = await api.get('/preventas/supplier-orders', { limit: 20, offset: (page - 1) * 20 });
        if (res.success) { setData(res.data || []); setTotal(res.pagination?.total || res.data?.length || 0); }
        else showToast(res.error || 'Error al cargar órdenes', 'error');
        setLoading(false);
    }

    async function openGenerate() {
        const res = await api.get('/preventas/client-orders', { status: 'pendiente', limit: 50 });
        if (res.success) setPendingOrders(res.data || []);
        setSelectedOrders([]);
        setGenerateModal(true);
    }

    function toggleOrder(id) {
        setSelectedOrders(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
    }

    function toggleAll() {
        setSelectedOrders(prev =>
            prev.length === pendingOrders.length ? [] : pendingOrders.map(o => o.id)
        );
    }

    async function handleGenerate() {
        if (!selectedOrders.length) return showToast('Seleccioná al menos un pedido', 'warning');
        setGenerating(true);
        const res = await api.post('/preventas/generate-supplier-orders', { clientOrderIds: selectedOrders });
        setGenerating(false);
        if (res.success) {
            const orders = res.data || [];
            showToast(`${orders.length} órdenes generadas para ${orders.length} proveedores`, 'success');
            setGenerateModal(false);
            fetchData();
        } else showToast(res.error || 'Error al generar órdenes', 'error');
    }

    async function handleDownloadPdf(order) {
        setDownloadingId(order.id);
        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`/api/preventas/supplier-orders/${order.id}/pdf`, {
                headers: { 'Authorization': `Bearer ${token}` },
            });
            if (!res.ok) { showToast('Error al generar el PDF', 'error'); return; }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const safeName = order.supplier_name.toLowerCase().replace(/[^a-z0-9]/g, '-');
            a.href = url;
            a.download = `orden-${safeName}-${order.id}.pdf`;
            a.click();
            URL.revokeObjectURL(url);
        } catch {
            showToast('Error al descargar el PDF', 'error');
        } finally {
            setDownloadingId(null);
        }
    }

    async function handleSendToOdoo(order) {
        setSendingId(order.id);
        const res = await api.post(`/preventas/supplier-orders/${order.id}/send-to-odoo`);
        setSendingId(null);
        if (res.success) {
            showToast(`OC creada en Odoo: ${res.data?.odooPurchaseOrderName || 'OK'}`, 'success');
            fetchData();
        } else showToast(res.error || 'Error al enviar a Odoo', 'error');
    }

    const cols = [
        { key: 'supplier_name', label: 'Proveedor' },
        {
            key: 'item_count',
            label: 'Ítems',
            render: v => <span style={t.numericStyle}>{v ?? '—'}</span>,
        },
        {
            key: 'total_amount',
            label: 'Total',
            render: v => v
                ? <span style={{ ...t.numericStyle, fontWeight: t.font.weight.semibold }}>{fmtAR(v)}</span>
                : '—',
        },
        {
            key: 'status',
            label: 'Estado',
            render: v => <Badge tone={orderStatusTone(v)} dot>{v || '—'}</Badge>,
        },
        {
            key: 'odoo_purchase_order_name',
            label: 'OC Odoo',
            render: v => v
                ? <span style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textMuted }}>{v}</span>
                : <span style={{ color: t.color.textFaint }}>—</span>,
        },
        {
            key: 'id',
            label: '',
            render: (_, row) => (
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <Button
                        size="sm"
                        variant="ghost"
                        leftIcon={<Icon.FileText size={13} />}
                        disabled={downloadingId === row.id}
                        onClick={e => { e.stopPropagation(); handleDownloadPdf(row); }}
                        title="Descargar PDF para el proveedor"
                    >
                        {downloadingId === row.id ? 'Generando…' : 'PDF'}
                    </Button>
                    {!row.odoo_purchase_order_id && row.status === 'borrador' && (
                        <Button
                            size="sm"
                            variant="primary"
                            leftIcon={<Icon.ArrowRight size={13} />}
                            disabled={sendingId === row.id}
                            onClick={e => { e.stopPropagation(); handleSendToOdoo(row); }}
                        >
                            {sendingId === row.id ? 'Enviando…' : 'Enviar a Odoo'}
                        </Button>
                    )}
                </div>
            ),
        },
    ];

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button
                    variant="primary"
                    leftIcon={<Icon.Activity size={15} />}
                    onClick={openGenerate}
                >
                    Generar órdenes
                </Button>
            </div>

            <DataTable
                columns={cols}
                data={data}
                loading={loading}
                pagination={{ page, pageSize: 20, total }}
                onPageChange={setPage}
            />

            <Modal
                isOpen={generateModal}
                onClose={() => setGenerateModal(false)}
                title="Generar órdenes a proveedores"
                subtitle="Seleccioná los pedidos a agrupar por proveedor"
                footer={
                    <>
                        <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family, marginRight: 'auto', ...t.numericStyle }}>
                            {selectedOrders.length} seleccionados
                        </span>
                        <Button variant="ghost" onClick={() => setGenerateModal(false)}>Cancelar</Button>
                        <Button
                            variant="primary"
                            disabled={generating || !selectedOrders.length}
                            onClick={handleGenerate}
                        >
                            {generating ? 'Generando…' : 'Generar'}
                        </Button>
                    </>
                }
            >
                {pendingOrders.length === 0 ? (
                    <p style={{ color: t.color.textMuted, fontSize: t.font.size.sm, margin: 0, fontFamily: t.font.family }}>
                        No hay pedidos pendientes.
                    </p>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                        {/* Seleccionar todos */}
                        <SelectRow
                            checked={selectedOrders.length === pendingOrders.length}
                            onChange={toggleAll}
                            tokens={t}
                            style={{ borderBottom: `2px solid ${t.color.border}`, marginBottom: t.space[1] }}
                        >
                            <span style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.textMuted, fontFamily: t.font.family }}>
                                Todos ({pendingOrders.length})
                            </span>
                        </SelectRow>

                        <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                            {pendingOrders.map(o => (
                                <SelectRow
                                    key={o.id}
                                    checked={selectedOrders.includes(o.id)}
                                    onChange={() => toggleOrder(o.id)}
                                    tokens={t}
                                >
                                    <div style={{ flex: 1 }}>
                                        <span style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.text, fontFamily: t.font.family }}>
                                            {o.client_name}
                                        </span>
                                        <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginLeft: t.space[3], fontFamily: t.font.family, ...t.numericStyle }}>
                                            {o.item_count} ítems · {new Date(o.created_at).toLocaleDateString('es-AR')}
                                        </span>
                                    </div>
                                </SelectRow>
                            ))}
                        </div>
                    </div>
                )}
            </Modal>
        </div>
    );
}

function SelectRow({ checked, onChange, children, tokens: t, style }) {
    const [hovered, setHovered] = useState(false);
    return (
        <div
            onClick={onChange}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
                display: 'flex', alignItems: 'center', gap: t.space[3],
                padding: `${t.space[2]}px ${t.space[1]}px`,
                borderBottom: `1px solid ${t.color.border}`,
                cursor: 'pointer',
                background: hovered ? t.color.surface2 : 'transparent',
                borderRadius: t.radius.sm,
                transition: 'background 100ms',
                ...style,
            }}
        >
            {/* Checkbox custom */}
            <div style={{
                width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                border: `2px solid ${checked ? t.color.primary : t.color.borderStrong}`,
                background: checked ? t.color.primary : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 120ms',
            }}>
                {checked && (
                    <svg width="9" height="7" viewBox="0 0 9 7" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M1 3.5L3.5 6 8 1" />
                    </svg>
                )}
            </div>
            {children}
        </div>
    );
}
