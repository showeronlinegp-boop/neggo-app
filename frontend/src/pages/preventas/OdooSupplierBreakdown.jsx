import { useState, useEffect } from 'react';
import api from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR } from '../../theme/tokens';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Stat from '../../components/common/Stat';
import ProductThumb from '../../components/common/ProductThumb';
import * as Icon from '../../components/common/icons';

const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';

async function downloadPDF(supplier) {
    const token = localStorage.getItem('neggo_token');
    const res = await fetch('/api/preventas/odoo-quotations/pdf', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            supplier_name: supplier.supplier_name,
            products:      supplier.products,
            total_cost:    supplier.total_cost,
            total_qty:     supplier.total_qty,
        }),
    });
    if (!res.ok) {
        let message = 'No se pudo generar el PDF';
        try {
            const body = await res.json();
            if (body?.error) message = body.error;
        } catch { /* el cuerpo no es JSON */ }
        throw new Error(message);
    }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const safe = supplier.supplier_name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    a.href = url;
    a.download = `pedido-${safe}-${new Date().toISOString().slice(0, 10)}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
}

function downloadCSV(data, supplierNameFilter = null) {
    const rows = [['Proveedor', 'Producto', 'SKU', 'Costo unit.', 'Cantidad Total', 'Total Costo', 'Cotizaciones', 'URL Foto']];
    const origin = window.location.origin;
    const suppliers = supplierNameFilter ? data.filter(s => s.supplier_name === supplierNameFilter) : data;
    for (const supplier of suppliers) {
        for (const product of supplier.products) {
            const quotationsStr = product.quotations.map(q => `${q.quotation_name}(${q.qty})`).join('; ');
            const totalCost = product.unit_cost != null ? (product.unit_cost * product.total_qty).toFixed(2) : '';
            rows.push([supplier.supplier_name, product.product_name, product.external_id || '', product.unit_cost != null ? Number(product.unit_cost).toFixed(2) : '', product.total_qty, totalCost, quotationsStr, product.image_url ? `${origin}${product.image_url}` : '']);
        }
    }
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeName = (supplierNameFilter || 'todos').replace(/[^a-zA-Z0-9_\-]/g, '_');
    a.download = `pedidos_${safeName}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.href = url; a.click(); URL.revokeObjectURL(url);
}

export default function OdooSupplierBreakdown() {
    const { tokens: t } = useTheme();
    const { showToast } = useToast();
    const [data, setData] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [expanded, setExpanded] = useState({});
    const [search, setSearch] = useState('');
    const [pdfLoading, setPdfLoading] = useState(null);

    const load = async () => {
        setLoading(true); setError(null);
        try {
            const res = await api.get('/preventas/odoo-quotations/by-supplier');
            if (res.success) {
                setData(res.data || []);
                if (res.data?.length > 0) setExpanded({ [res.data[0].supplier_name]: true });
            } else setError(res.error || 'Error al cargar datos');
        } catch (err) { setError(err.message); }
        finally { setLoading(false); }
    };

    useEffect(() => { load(); }, []);

    const filtered = data.filter(s => {
        if (!search) return true;
        const q = search.toLowerCase();
        return s.supplier_name.toLowerCase().includes(q) || s.products.some(p => p.product_name.toLowerCase().includes(q) || (p.external_id || '').toLowerCase().includes(q));
    });

    const totalProducts = filtered.reduce((s, r) => s + r.total_products, 0);
    const totalQty      = filtered.reduce((s, r) => s + r.total_qty, 0);

    const thStyle = {
        padding: '8px 12px', textAlign: 'left',
        fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold,
        color: t.color.textMuted, background: t.color.surface2,
        borderBottom: `1px solid ${t.color.border}`,
        whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.04em', fontFamily: t.font.family,
    };
    const tdStyle = { padding: '8px 12px', fontSize: t.font.size.sm, borderBottom: `1px solid ${t.color.border}`, verticalAlign: 'top', color: t.color.text, fontFamily: t.font.family };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>

            {/* Cabecera */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: t.space[2] }}>
                <Button size="sm" variant="success" leftIcon={<Icon.ArrowRight size={13} />} disabled={loading || filtered.length === 0} onClick={() => downloadCSV(filtered)}>
                    Descargar CSV
                </Button>
                <Button size="sm" variant="ghost" leftIcon={<Icon.Refresh size={13} />} disabled={loading} onClick={load}>
                    {loading ? 'Cargando…' : 'Actualizar'}
                </Button>
            </div>

            {error && (
                <div style={{ background: t.color.dangerSoft, color: t.color.danger, padding: '12px 16px', borderRadius: t.radius.sm, fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                    {error}
                </div>
            )}

            {/* Stats */}
            {!loading && data.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: t.space[3] }}>
                    <Card><Stat label="Proveedores" value={filtered.length} icon={<Icon.Truck size={14} color={t.color.textMuted} />} /></Card>
                    <Card><Stat label="Productos únicos" value={totalProducts} icon={<Icon.Package size={14} color={t.color.textMuted} />} /></Card>
                    <Card><Stat label="Unidades totales" value={totalQty.toLocaleString('es-AR')} icon={<Icon.Activity size={14} color={t.color.textMuted} />} /></Card>
                </div>
            )}

            {/* Búsqueda */}
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por proveedor, producto o SKU…" leftIcon={<Icon.Search size={14} />} style={{ maxWidth: 440 }} />

            {loading ? (
                <div style={{ textAlign: 'center', padding: 60, color: t.color.textMuted, fontFamily: t.font.family }}>Conectando con Odoo Preventas…</div>
            ) : filtered.length === 0 ? (
                <Card style={{ padding: '60px 24px', textAlign: 'center' }}>
                    <div style={{ fontSize: 48, marginBottom: 12 }}>🛍️</div>
                    <div style={{ fontWeight: t.font.weight.medium, color: t.color.text, marginBottom: 6, fontFamily: t.font.family }}>
                        {search ? 'Sin coincidencias' : 'No hay cotizaciones abiertas en Odoo Preventas'}
                    </div>
                </Card>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[3] }}>
                    {filtered.map(supplier => {
                        const key        = supplier.supplier_name;
                        const isOpen     = !!expanded[key];
                        const isUnmapped = supplier.supplier_name === 'Sin proveedor asignado';
                        return (
                            <Card key={key} padding={false} style={{ border: isUnmapped ? `1px solid ${t.color.warn}66` : undefined }}>
                                {/* Cabecera del proveedor */}
                                <div
                                    onClick={() => setExpanded(prev => ({ ...prev, [key]: !prev[key] }))}
                                    onMouseEnter={e => { if (!isUnmapped) e.currentTarget.style.background = t.color.surface2; }}
                                    onMouseLeave={e => { e.currentTarget.style.background = isUnmapped ? t.color.warnSoft : 'transparent'; }}
                                    style={{ padding: '14px 18px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: t.space[5], flexWrap: 'wrap', userSelect: 'none', transition: 'background 100ms', background: isUnmapped ? t.color.warnSoft : 'transparent' }}
                                >
                                    <Icon.ChevronRight size={14} color={t.color.textFaint} style={{ transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 150ms', flexShrink: 0 }} />
                                    <span style={{ fontWeight: t.font.weight.semibold, fontSize: 15, color: isUnmapped ? t.color.warn : t.color.text, flex: 1, fontFamily: t.font.family }}>{supplier.supplier_name}</span>
                                    <Badge tone="muted">{supplier.total_products} producto{supplier.total_products !== 1 ? 's' : ''}</Badge>
                                    <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family, ...t.numericStyle }}>{supplier.total_qty.toLocaleString('es-AR')} unid.</span>
                                    {supplier.total_cost != null && <span style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.success, ...t.numericStyle }}>{fmtAR(supplier.total_cost)}</span>}
                                    {!isUnmapped && (
                                        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                leftIcon={<Icon.FileText size={13} />}
                                                disabled={pdfLoading === key}
                                                onClick={async () => {
                                                    setPdfLoading(key);
                                                    try {
                                                        await downloadPDF(supplier);
                                                    } catch (err) {
                                                        showToast(err.message || 'No se pudo generar el PDF', 'error');
                                                    } finally {
                                                        setPdfLoading(null);
                                                    }
                                                }}
                                            >
                                                {pdfLoading === key ? 'Generando…' : 'PDF'}
                                            </Button>
                                            <Button size="sm" variant="success" onClick={() => downloadCSV(data, supplier.supplier_name)}>
                                                CSV
                                            </Button>
                                        </div>
                                    )}
                                </div>

                                {/* Tabla de productos */}
                                {isOpen && (
                                    <div style={{ borderTop: `1px solid ${t.color.border}` }}>
                                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                            <thead>
                                                <tr>
                                                    <th style={{ ...thStyle, width: 52 }}></th>
                                                    <th style={thStyle}>Producto</th>
                                                    <th style={{ ...thStyle, width: 120 }}>SKU</th>
                                                    <th style={{ ...thStyle, textAlign: 'right', width: 110 }}>Costo unit.</th>
                                                    <th style={{ ...thStyle, textAlign: 'right', width: 90 }}>Cant.</th>
                                                    <th style={{ ...thStyle, textAlign: 'right', width: 120 }}>Total costo</th>
                                                    <th style={{ ...thStyle, minWidth: 200 }}>Cotizaciones</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {supplier.products.map((product, idx) => {
                                                    const totalCost = product.unit_cost != null ? product.unit_cost * product.total_qty : null;
                                                    return (
                                                        <tr key={idx} style={{ background: idx % 2 === 0 ? t.color.surface : t.color.surface2 }}>
                                                            <td style={{ ...tdStyle, textAlign: 'center', padding: '6px 8px' }}>
                                                                <ProductThumb imageUrl={product.image_url} emoji={product.product_name?.[0]} size={40} />
                                                            </td>
                                                            <td style={{ ...tdStyle, fontWeight: t.font.weight.medium }}>{product.product_name}</td>
                                                            <td style={{ ...tdStyle, fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textMuted }}>{product.external_id || '—'}</td>
                                                            <td style={{ ...tdStyle, textAlign: 'right', fontFamily: t.font.mono, color: t.color.textMuted, ...t.numericStyle }}>{fmtAR(product.unit_cost)}</td>
                                                            <td style={{ ...tdStyle, textAlign: 'right', fontWeight: t.font.weight.semibold, fontSize: 15, color: t.color.primary, ...t.numericStyle }}>{product.total_qty.toLocaleString('es-AR')}</td>
                                                            <td style={{ ...tdStyle, textAlign: 'right', fontFamily: t.font.mono, fontWeight: t.font.weight.semibold, color: totalCost ? t.color.success : t.color.textMuted, ...t.numericStyle }}>{fmtAR(totalCost)}</td>
                                                            <td style={tdStyle}>
                                                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                                                    {product.quotations.map((q, qi) => (
                                                                        <Badge key={qi} tone="primary" title={`${q.client || 'Sin cliente'} — ${fmtDate(q.date)}`}>
                                                                            {q.quotation_name} × {q.qty}
                                                                        </Badge>
                                                                    ))}
                                                                </div>
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </Card>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
