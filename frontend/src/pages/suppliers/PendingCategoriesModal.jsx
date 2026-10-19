import { useState, useEffect } from 'react';
import api from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { useTheme } from '../../theme/ThemeContext';
import Modal from '../../components/common/Modal';
import Button from '../../components/common/Button';
import Badge from '../../components/common/Badge';
import Select from '../../components/common/Select';
import LoadingSpinner from '../../components/common/LoadingSpinner';

// Categorías de los proveedores que todavía no tienen regla.
// Se asigna la categoría de Odoo de cada empresa (o se ignora) sin salir de Proveedores.
export default function PendingCategoriesModal({ isOpen, onClose, onChanged, initialSupplierId }) {
    const { tokens: t } = useTheme();
    const { showToast } = useToast();

    const [pending, setPending] = useState([]);
    const [loading, setLoading] = useState(false);
    const [supplierFilter, setSupplierFilter] = useState('');
    const [categsNeggo, setCategsNeggo] = useState([]);
    const [categsPreventas, setCategsPreventas] = useState([]);
    const [loadingCategs, setLoadingCategs] = useState(false);
    // Elección por fila: { [clave]: { neggo: id, preventas: id } }
    const [choices, setChoices] = useState({});
    const [savingKey, setSavingKey] = useState(null);

    useEffect(() => {
        if (!isOpen) return;
        setSupplierFilter(initialSupplierId ? String(initialSupplierId) : '');
        setChoices({});
        loadPending();
        if (categsNeggo.length === 0) loadOdooCategories();
    }, [isOpen, initialSupplierId]);

    async function loadPending() {
        setLoading(true);
        const res = await api.get('/suppliers/pending-categories');
        setLoading(false);
        if (res.success) setPending(res.data || []);
        else showToast(res.error || 'Error al cargar categorías pendientes', 'error');
    }

    async function loadOdooCategories() {
        setLoadingCategs(true);
        const [neggo, preventas] = await Promise.all([
            api.get('/suppliers/odoo-categories', { company: 'neggo' }),
            api.get('/suppliers/odoo-categories', { company: 'preventas' }),
        ]);
        setLoadingCategs(false);
        if (neggo.success) setCategsNeggo(neggo.data || []);
        if (preventas.success) setCategsPreventas(preventas.data || []);
    }

    const keyOf = row => `${row.supplier_id}::${row.source_category}`;

    function setChoice(row, company, value) {
        const k = keyOf(row);
        setChoices(prev => ({ ...prev, [k]: { ...prev[k], [company]: value } }));
    }

    function categName(categs, id) {
        const found = categs.find(c => String(c.id) === String(id));
        return found?.complete_name || found?.name || null;
    }

    async function resolve(row, ignored) {
        const k = keyOf(row);
        const choice = choices[k] || {};
        const body = ignored
            ? { source_category: row.source_category, ignored: true }
            : {
                source_category:         row.source_category,
                dest_category_neggo:     categName(categsNeggo, choice.neggo),
                dest_category_preventas: categName(categsPreventas, choice.preventas),
                odoo_categ_id_neggo:     choice.neggo ? parseInt(choice.neggo, 10) : null,
                odoo_categ_id_preventas: choice.preventas ? parseInt(choice.preventas, 10) : null,
            };
        setSavingKey(k);
        const res = await api.post(`/suppliers/${row.supplier_id}/rules`, body);
        setSavingKey(null);
        if (!res.success) return showToast(res.error || 'Error al guardar la regla', 'error');
        setPending(prev => prev.filter(r => keyOf(r) !== k));
        showToast(ignored ? `"${row.source_category}" ignorada` : `Regla creada para "${row.source_category}"`, 'success');
        onChanged?.();
    }

    // Proveedores con pendientes, para el filtro
    const suppliers = [...new Map(pending.map(r => [r.supplier_id, r.supplier_name])).entries()];
    const supplierOptions = [
        { value: '', label: `Todos los proveedores (${pending.length})` },
        ...suppliers.map(([id, name]) => ({
            value: String(id),
            label: `${name} (${pending.filter(r => r.supplier_id === id).length})`,
        })),
    ];
    const visible = supplierFilter ? pending.filter(r => String(r.supplier_id) === supplierFilter) : pending;

    // Agrupar por proveedor manteniendo el orden del backend
    const groups = [];
    for (const row of visible) {
        const last = groups[groups.length - 1];
        if (last && last.supplierId === row.supplier_id) last.rows.push(row);
        else groups.push({ supplierId: row.supplier_id, supplierName: row.supplier_name, rows: [row] });
    }

    const nativeSelectStyle = {
        width: '100%', padding: '0 10px', height: t.layout.inputHeight,
        border: `1px solid ${t.color.borderStrong}`, borderRadius: t.radius.sm,
        fontSize: t.font.size.sm, fontFamily: t.font.family,
        color: t.color.text, background: t.color.surface, boxSizing: 'border-box',
    };
    const colLabel = {
        fontSize: t.font.size.xs, color: t.color.textFaint, fontWeight: t.font.weight.semibold,
        textTransform: 'uppercase', letterSpacing: '0.04em', fontFamily: t.font.family,
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title="Categorías pendientes"
            subtitle="Sin regla, los productos de estas categorías no entran en el ingreso ni en los catálogos."
            size="xl"
        >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: t.space[3], marginBottom: t.space[5], flexWrap: 'wrap' }}>
                <Select value={supplierFilter} onChange={setSupplierFilter} options={supplierOptions} style={{ minWidth: 260 }} />
                {loadingCategs && (
                    <span style={{ fontSize: t.font.size.sm, color: t.color.textFaint, fontFamily: t.font.family }}>
                        Cargando categorías de Odoo…
                    </span>
                )}
            </div>

            {loading && <div style={{ padding: t.space[8], display: 'flex', justifyContent: 'center' }}><LoadingSpinner /></div>}

            {!loading && visible.length === 0 && (
                <div style={{ padding: `${t.space[8]}px 0`, textAlign: 'center', color: t.color.textMuted, fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                    No hay categorías pendientes. Todo tiene regla.
                </div>
            )}

            {!loading && groups.map(g => (
                <div key={g.supplierId} style={{ marginBottom: t.space[6] }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: t.space[2], marginBottom: t.space[2] }}>
                        <span style={{ fontWeight: t.font.weight.semibold, color: t.color.text, fontFamily: t.font.family }}>{g.supplierName}</span>
                        <Badge tone="warn">{g.rows.length}</Badge>
                    </div>

                    <div style={{ border: `1px solid ${t.color.border}`, borderRadius: t.radius.md, overflow: 'hidden' }}>
                        <div style={{
                            display: 'grid', gridTemplateColumns: 'minmax(180px, 1.3fr) 1fr 1fr auto',
                            gap: t.space[3], padding: `8px ${t.space[4]}px`, background: t.color.surface2,
                        }}>
                            <span style={colLabel}>Categoría del proveedor</span>
                            <span style={colLabel}>Categoría Odoo Neggo</span>
                            <span style={colLabel}>Categoría Odoo Preventas</span>
                            <span style={{ ...colLabel, minWidth: 150 }} />
                        </div>

                        {g.rows.map(row => {
                            const k = keyOf(row);
                            const choice = choices[k] || {};
                            const saving = savingKey === k;
                            return (
                                <div key={k} style={{
                                    display: 'grid', gridTemplateColumns: 'minmax(180px, 1.3fr) 1fr 1fr auto',
                                    gap: t.space[3], alignItems: 'center',
                                    padding: `10px ${t.space[4]}px`, borderTop: `1px solid ${t.color.border}`,
                                }}>
                                    <div style={{ minWidth: 0 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: t.space[2] }}>
                                            <span style={{ fontWeight: t.font.weight.medium, color: t.color.text, fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                                                {row.source_category}
                                            </span>
                                            <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, ...t.numericStyle }}>
                                                {row.product_count} prod.
                                            </span>
                                        </div>
                                        {row.sample_products?.length > 0 && (
                                            <div
                                                title={row.sample_products.join('\n')}
                                                style={{
                                                    fontSize: t.font.size.xs, color: t.color.textFaint, marginTop: 2, fontFamily: t.font.family,
                                                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                                }}
                                            >
                                                Ej: {row.sample_products.join(' · ')}
                                            </div>
                                        )}
                                    </div>

                                    <select value={choice.neggo || ''} onChange={e => setChoice(row, 'neggo', e.target.value)} style={nativeSelectStyle}>
                                        <option value="">— Sin categoría —</option>
                                        {categsNeggo.map(c => <option key={c.id} value={c.id}>{c.complete_name || c.name}</option>)}
                                    </select>

                                    <select value={choice.preventas || ''} onChange={e => setChoice(row, 'preventas', e.target.value)} style={nativeSelectStyle}>
                                        <option value="">— Sin categoría —</option>
                                        {categsPreventas.map(c => <option key={c.id} value={c.id}>{c.complete_name || c.name}</option>)}
                                    </select>

                                    <div style={{ display: 'flex', gap: t.space[2], minWidth: 150, justifyContent: 'flex-end' }}>
                                        <Button size="sm" variant="ghost" disabled={saving} onClick={() => resolve(row, true)}>
                                            Ignorar
                                        </Button>
                                        <Button
                                            size="sm" variant="primary"
                                            disabled={saving || (!choice.neggo && !choice.preventas)}
                                            onClick={() => resolve(row, false)}
                                        >
                                            {saving ? 'Guardando…' : 'Asignar'}
                                        </Button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}
        </Modal>
    );
}
