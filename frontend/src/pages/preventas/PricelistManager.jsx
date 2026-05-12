import { useState, useEffect } from 'react';
import api from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR } from '../../theme/tokens';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Modal from '../../components/common/Modal';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import * as Icon from '../../components/common/icons';

export default function PricelistManager() {
    const { tokens: t } = useTheme();
    const { showToast } = useToast();

    const [pricelists, setPricelists] = useState([]);
    const [suppliers, setSuppliers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [expandedId, setExpandedId] = useState(null);

    // Modal nueva lista
    const [newModal, setNewModal] = useState(false);
    const [newName, setNewName] = useState('');
    const [newDesc, setNewDesc] = useState('');
    const [newDescuento, setNewDescuento] = useState('0');
    const [saving, setSaving] = useState(false);

    // Modal editar lista
    const [editModal, setEditModal] = useState(null);
    const [editDescuento, setEditDescuento] = useState('');
    const [editName, setEditName] = useState('');

    // Reglas
    const [rulesData, setRulesData] = useState({});
    const [newRulePricelist, setNewRulePricelist] = useState(null);
    const [newRuleSupplier, setNewRuleSupplier] = useState('');
    const [newRuleDescuento, setNewRuleDescuento] = useState('0');
    const [savingRule, setSavingRule] = useState(false);

    // Preview
    const [previewData, setPreviewData] = useState(null);
    const [previewLoading, setPreviewLoading] = useState(false);

    // Confirmar borrado
    const [confirmDelete, setConfirmDelete] = useState(null);
    const [confirmRuleDelete, setConfirmRuleDelete] = useState(null);

    useEffect(() => {
        loadData();
        api.get('/suppliers').then(res => {
            if (res.success) setSuppliers((res.data || []).filter(s => s.status === 'active'));
        });
    }, []);

    async function loadData() {
        setLoading(true);
        const res = await api.get('/pricelists');
        if (res.success) setPricelists(res.data || []);
        else showToast(res.error || 'Error al cargar', 'error');
        setLoading(false);
    }

    async function loadRules(id) {
        if (rulesData[id]) return;
        const res = await api.get(`/pricelists/${id}`);
        if (res.success) setRulesData(prev => ({ ...prev, [id]: res.data.rules || [] }));
    }

    function toggleExpand(id) {
        const next = expandedId === id ? null : id;
        setExpandedId(next);
        if (next) loadRules(next);
    }

    async function createPricelist() {
        if (!newName.trim()) return showToast('El nombre es requerido', 'warning');
        setSaving(true);
        const res = await api.post('/pricelists', {
            name: newName.trim(),
            description: newDesc.trim() || null,
            default_descuento: parseFloat(newDescuento) || 0,
        });
        setSaving(false);
        if (res.success) {
            showToast(`Lista "${newName}" creada`, 'success');
            setNewModal(false); setNewName(''); setNewDesc(''); setNewDescuento('0');
            loadData();
        } else showToast(res.error || 'Error al crear', 'error');
    }

    async function updatePricelist() {
        if (!editModal) return;
        setSaving(true);
        const res = await api.put(`/pricelists/${editModal.id}`, {
            name: editName.trim(),
            default_descuento: parseFloat(editDescuento) || 0,
        });
        setSaving(false);
        if (res.success) {
            showToast('Lista actualizada', 'success');
            setEditModal(null);
            setPricelists(prev => prev.map(pl => pl.id === editModal.id ? { ...pl, name: editName.trim(), default_descuento: parseFloat(editDescuento) || 0 } : pl));
        } else showToast(res.error || 'Error al actualizar', 'error');
    }

    async function deletePricelist(id) {
        const res = await api.del(`/pricelists/${id}`);
        if (res.success) { showToast('Lista eliminada', 'success'); loadData(); }
        else showToast(res.error || 'Error al eliminar', 'error');
        setConfirmDelete(null);
    }

    async function addRule(pricelistId) {
        if (!newRuleSupplier) return showToast('Seleccioná un proveedor', 'warning');
        setSavingRule(true);
        const res = await api.post(`/pricelists/${pricelistId}/rules`, {
            supplier_id: parseInt(newRuleSupplier),
            descuento_pct: parseFloat(newRuleDescuento) || 0,
        });
        setSavingRule(false);
        if (res.success) {
            showToast('Regla agregada', 'success');
            setNewRulePricelist(null); setNewRuleSupplier(''); setNewRuleDescuento('0');
            const supplierName = suppliers.find(s => s.id === parseInt(newRuleSupplier))?.name || '';
            setRulesData(prev => ({
                ...prev,
                [pricelistId]: [...(prev[pricelistId] || []).filter(r => r.supplier_id !== parseInt(newRuleSupplier)),
                    { ...res.data, supplier_name: supplierName }]
            }));
        } else showToast(res.error || 'Error al agregar regla', 'error');
    }

    async function deleteRule(pricelistId, ruleId) {
        const res = await api.del(`/pricelists/${pricelistId}/rules/${ruleId}`);
        if (res.success) {
            showToast('Regla eliminada', 'success');
            setRulesData(prev => ({ ...prev, [pricelistId]: (prev[pricelistId] || []).filter(r => r.id !== ruleId) }));
        } else showToast(res.error || 'Error al eliminar regla', 'error');
        setConfirmRuleDelete(null);
    }

    async function showPreview(id, supplierId) {
        setPreviewLoading(true);
        const params = supplierId ? { supplier_id: supplierId, limit: 8 } : { limit: 8 };
        const res = await api.get(`/pricelists/${id}/preview`, params);
        setPreviewLoading(false);
        if (res.success) setPreviewData({ pricelistId: id, items: res.data });
        else showToast(res.error || 'Error al cargar preview', 'error');
    }

    const cardStyle = {
        background: t.color.surface, border: `1px solid ${t.color.border}`,
        borderRadius: t.radius.md, marginBottom: t.space[4],
        overflow: 'hidden',
    };

    const labelStyle = {
        display: 'block', fontSize: t.font.size.sm,
        fontWeight: t.font.weight.medium, color: t.color.textMuted,
        marginBottom: t.space[2], fontFamily: t.font.family,
    };

    const inputGroupStyle = { marginBottom: t.space[4] };

    return (
        <div style={{ maxWidth: 820 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: t.space[6] }}>
                <div>
                    <h1 style={{ fontSize: 22, fontWeight: t.font.weight.bold, color: t.color.text, margin: 0, fontFamily: t.font.family }}>
                        Listas de precios especiales
                    </h1>
                    <p style={{ fontSize: t.font.size.sm, color: t.color.textMuted, margin: `${t.space[1]}px 0 0`, fontFamily: t.font.family }}>
                        Precio = raw_price × (1 − descuento%)
                    </p>
                </div>
                <Button variant="primary" leftIcon={<Icon.Plus size={14} />} onClick={() => setNewModal(true)}>
                    Nueva lista
                </Button>
            </div>

            {loading ? (
                <p style={{ color: t.color.textMuted, fontFamily: t.font.family }}>Cargando…</p>
            ) : pricelists.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '48px 24px', color: t.color.textFaint, fontFamily: t.font.family }}>
                    <Icon.Tag size={36} style={{ marginBottom: 12, opacity: 0.4 }} />
                    <p style={{ margin: 0 }}>No hay listas de precios todavía.</p>
                </div>
            ) : pricelists.map(pl => (
                <div key={pl.id} style={cardStyle}>
                    {/* Cabecera de la lista */}
                    <div
                        onClick={() => toggleExpand(pl.id)}
                        style={{
                            display: 'flex', alignItems: 'center', gap: t.space[3],
                            padding: `${t.space[4]}px ${t.space[5]}px`,
                            cursor: 'pointer', userSelect: 'none',
                            borderBottom: expandedId === pl.id ? `1px solid ${t.color.border}` : 'none',
                        }}
                    >
                        <Icon.ChevronDown
                            size={16}
                            style={{ color: t.color.textMuted, transform: expandedId === pl.id ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 150ms', flexShrink: 0 }}
                        />
                        <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: t.font.weight.semibold, color: t.color.text, fontFamily: t.font.family }}>
                                {pl.name}
                            </div>
                            {pl.description && (
                                <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family, marginTop: 2 }}>
                                    {pl.description}
                                </div>
                            )}
                        </div>
                        <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family, textAlign: 'right', flexShrink: 0 }}>
                            <span style={{ fontWeight: t.font.weight.semibold, color: t.color.text }}>
                                {pl.default_descuento}%
                            </span>{' '}desc. base
                            {parseInt(pl.rules_count) > 0 && (
                                <span style={{ marginLeft: 8, color: t.color.textFaint }}>
                                    · {pl.rules_count} regla{parseInt(pl.rules_count) !== 1 ? 's' : ''}
                                </span>
                            )}
                        </div>
                        <div style={{ display: 'flex', gap: t.space[2], flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                            <button
                                onClick={() => { setEditModal(pl); setEditName(pl.name); setEditDescuento(String(pl.default_descuento)); }}
                                style={{ background: 'none', border: `1px solid ${t.color.border}`, borderRadius: t.radius.sm, padding: '4px 8px', cursor: 'pointer', color: t.color.textMuted, fontSize: 12, fontFamily: t.font.family, display: 'flex', alignItems: 'center', gap: 4 }}
                            >
                                <Icon.Edit2 size={12} /> Editar
                            </button>
                            <button
                                onClick={() => setConfirmDelete(pl)}
                                style={{ background: 'none', border: `1px solid ${t.color.border}`, borderRadius: t.radius.sm, padding: '4px 8px', cursor: 'pointer', color: t.color.danger || '#c0392b', fontSize: 12, fontFamily: t.font.family, display: 'flex', alignItems: 'center', gap: 4 }}
                            >
                                <Icon.Trash2 size={12} />
                            </button>
                        </div>
                    </div>

                    {/* Reglas expandidas */}
                    {expandedId === pl.id && (
                        <div style={{ padding: t.space[5] }}>
                            <div style={{ marginBottom: t.space[4] }}>
                                <div style={{ fontWeight: t.font.weight.medium, fontSize: t.font.size.sm, color: t.color.textMuted, marginBottom: t.space[3], fontFamily: t.font.family }}>
                                    Reglas por proveedor
                                </div>
                                {(rulesData[pl.id] || []).length === 0 ? (
                                    <p style={{ fontSize: t.font.size.sm, color: t.color.textFaint, margin: 0, fontFamily: t.font.family }}>
                                        Sin reglas específicas. Se usa el descuento base ({pl.default_descuento}%) para todos los proveedores.
                                    </p>
                                ) : (rulesData[pl.id] || []).map(rule => (
                                    <div key={rule.id} style={{ display: 'flex', alignItems: 'center', gap: t.space[3], padding: '8px 12px', background: t.color.surface2, borderRadius: t.radius.sm, marginBottom: t.space[2] }}>
                                        <div style={{ flex: 1, fontFamily: t.font.family }}>
                                            <span style={{ fontWeight: t.font.weight.medium, color: t.color.text, fontSize: t.font.size.sm }}>{rule.supplier_name}</span>
                                        </div>
                                        <div style={{ fontSize: t.font.size.sm, fontFamily: t.font.family, color: t.color.accent, fontWeight: t.font.weight.semibold, ...t.numericStyle }}>
                                            {rule.descuento_pct}% desc.
                                        </div>
                                        <button
                                            onClick={() => setConfirmRuleDelete({ pricelistId: pl.id, rule })}
                                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: t.color.textFaint, padding: '2px 4px', lineHeight: 1 }}
                                        >
                                            <Icon.X size={14} />
                                        </button>
                                    </div>
                                ))}
                            </div>

                            {/* Agregar regla */}
                            {newRulePricelist === pl.id ? (
                                <div style={{ display: 'flex', gap: t.space[3], alignItems: 'flex-end', padding: '12px', background: t.color.surface2, borderRadius: t.radius.sm }}>
                                    <div style={{ flex: 1 }}>
                                        <label style={{ ...labelStyle, marginBottom: 4 }}>Proveedor</label>
                                        <select
                                            value={newRuleSupplier}
                                            onChange={e => setNewRuleSupplier(e.target.value)}
                                            style={{ width: '100%', padding: '6px 10px', border: `1px solid ${t.color.borderStrong}`, borderRadius: t.radius.sm, fontSize: t.font.size.sm, fontFamily: t.font.family, background: t.color.surface, color: t.color.text }}
                                        >
                                            <option value="">— Seleccioná —</option>
                                            {suppliers
                                                .filter(s => !(rulesData[pl.id] || []).some(r => r.supplier_id === s.id))
                                                .map(s => <option key={s.id} value={s.id}>{s.name}</option>)
                                            }
                                        </select>
                                    </div>
                                    <div style={{ width: 120 }}>
                                        <label style={{ ...labelStyle, marginBottom: 4 }}>Descuento %</label>
                                        <input
                                            type="number" min="0" max="100" step="0.5"
                                            value={newRuleDescuento}
                                            onChange={e => setNewRuleDescuento(e.target.value)}
                                            style={{ width: '100%', padding: '6px 10px', border: `1px solid ${t.color.borderStrong}`, borderRadius: t.radius.sm, fontSize: t.font.size.sm, fontFamily: t.font.family, background: t.color.surface, color: t.color.text, boxSizing: 'border-box' }}
                                        />
                                    </div>
                                    <div style={{ display: 'flex', gap: t.space[2], flexShrink: 0 }}>
                                        <Button variant="primary" size="sm" disabled={savingRule} onClick={() => addRule(pl.id)}>
                                            {savingRule ? '…' : 'Agregar'}
                                        </Button>
                                        <Button variant="ghost" size="sm" onClick={() => { setNewRulePricelist(null); setNewRuleSupplier(''); setNewRuleDescuento('0'); }}>
                                            Cancelar
                                        </Button>
                                    </div>
                                </div>
                            ) : (
                                <div style={{ display: 'flex', gap: t.space[3] }}>
                                    <Button variant="ghost" size="sm" leftIcon={<Icon.Plus size={13} />} onClick={() => { setNewRulePricelist(pl.id); setNewRuleSupplier(''); setNewRuleDescuento('0'); }}>
                                        Agregar regla de proveedor
                                    </Button>
                                    <Button variant="ghost" size="sm" leftIcon={<Icon.Eye size={13} />} onClick={() => showPreview(pl.id, null)}>
                                        Ver preview de precios
                                    </Button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            ))}

            {/* Modal nueva lista */}
            <Modal isOpen={newModal} onClose={() => setNewModal(false)} title="Nueva lista de precios" size="sm">
                <div style={inputGroupStyle}>
                    <label style={labelStyle}>Nombre *</label>
                    <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Ej: Precio de Lista" autoFocus />
                </div>
                <div style={inputGroupStyle}>
                    <label style={labelStyle}>Descripción (opcional)</label>
                    <Input value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder="Para clientes mayoristas…" />
                </div>
                <div style={inputGroupStyle}>
                    <label style={labelStyle}>
                        Descuento base sobre precio de lista del proveedor (%)
                    </label>
                    <input
                        type="number" min="0" max="100" step="0.5"
                        value={newDescuento}
                        onChange={e => setNewDescuento(e.target.value)}
                        style={{ width: '100%', padding: '8px 12px', border: `1px solid ${t.color.borderStrong}`, borderRadius: t.radius.sm, fontSize: t.font.size.base, fontFamily: t.font.family, background: t.color.surface, color: t.color.text, boxSizing: 'border-box' }}
                    />
                    <div style={{ fontSize: t.font.size.xs, color: t.color.textFaint, marginTop: 4, fontFamily: t.font.family }}>
                        0% = vendés al precio de lista exacto · 5% = precio de lista × 0.95
                    </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: t.space[3] }}>
                    <Button variant="ghost" onClick={() => setNewModal(false)}>Cancelar</Button>
                    <Button variant="primary" disabled={saving || !newName.trim()} onClick={createPricelist}>
                        {saving ? 'Guardando…' : 'Crear lista'}
                    </Button>
                </div>
            </Modal>

            {/* Modal editar lista */}
            <Modal isOpen={!!editModal} onClose={() => setEditModal(null)} title="Editar lista de precios" size="sm">
                <div style={inputGroupStyle}>
                    <label style={labelStyle}>Nombre</label>
                    <Input value={editName} onChange={e => setEditName(e.target.value)} />
                </div>
                <div style={inputGroupStyle}>
                    <label style={labelStyle}>Descuento base (%)</label>
                    <input
                        type="number" min="0" max="100" step="0.5"
                        value={editDescuento}
                        onChange={e => setEditDescuento(e.target.value)}
                        style={{ width: '100%', padding: '8px 12px', border: `1px solid ${t.color.borderStrong}`, borderRadius: t.radius.sm, fontSize: t.font.size.base, fontFamily: t.font.family, background: t.color.surface, color: t.color.text, boxSizing: 'border-box' }}
                    />
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: t.space[3] }}>
                    <Button variant="ghost" onClick={() => setEditModal(null)}>Cancelar</Button>
                    <Button variant="primary" disabled={saving} onClick={updatePricelist}>
                        {saving ? 'Guardando…' : 'Guardar cambios'}
                    </Button>
                </div>
            </Modal>

            {/* Preview de precios */}
            <Modal isOpen={!!previewData} onClose={() => setPreviewData(null)} title="Preview de precios" size="md">
                {previewLoading ? (
                    <p style={{ color: t.color.textMuted, fontFamily: t.font.family }}>Calculando…</p>
                ) : previewData?.items?.length === 0 ? (
                    <p style={{ color: t.color.textFaint, fontFamily: t.font.family }}>Sin productos disponibles para previsualizar.</p>
                ) : (
                    <div>
                        <div style={{ marginBottom: t.space[3], fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                            Muestra de productos con precio calculado por esta lista:
                        </div>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                            <thead>
                                <tr style={{ background: t.color.surface2 }}>
                                    <th style={{ textAlign: 'left', padding: '8px 10px', color: t.color.textMuted, fontWeight: t.font.weight.medium }}>Producto</th>
                                    <th style={{ textAlign: 'right', padding: '8px 10px', color: t.color.textMuted, fontWeight: t.font.weight.medium }}>Raw price</th>
                                    <th style={{ textAlign: 'center', padding: '8px 10px', color: t.color.textMuted, fontWeight: t.font.weight.medium }}>Desc.</th>
                                    <th style={{ textAlign: 'right', padding: '8px 10px', color: t.color.textMuted, fontWeight: t.font.weight.medium }}>Precio lista</th>
                                </tr>
                            </thead>
                            <tbody>
                                {previewData.items.map(item => (
                                    <tr key={item.id} style={{ borderBottom: `1px solid ${t.color.border}` }}>
                                        <td style={{ padding: '8px 10px', color: t.color.text }}>
                                            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280 }}>{item.name}</div>
                                            <div style={{ fontSize: t.font.size.xs, color: t.color.textFaint, fontFamily: t.font.mono }}>{item.supplier_name}</div>
                                        </td>
                                        <td style={{ padding: '8px 10px', textAlign: 'right', color: t.color.textMuted, ...t.numericStyle }}>{fmtAR(item.raw_price)}</td>
                                        <td style={{ padding: '8px 10px', textAlign: 'center', color: t.color.textMuted }}>{item.descuento_aplicado}%</td>
                                        <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: t.font.weight.semibold, color: t.color.accent, ...t.numericStyle }}>{fmtAR(item.precio_lista)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Modal>

            {/* Confirm delete lista */}
            <ConfirmDialog
                isOpen={!!confirmDelete}
                title="Eliminar lista"
                message={`¿Eliminás la lista "${confirmDelete?.name}"? Los pedidos existentes no se verán afectados.`}
                confirmLabel="Eliminar"
                onConfirm={() => deletePricelist(confirmDelete.id)}
                onCancel={() => setConfirmDelete(null)}
                variant="danger"
            />

            {/* Confirm delete regla */}
            <ConfirmDialog
                isOpen={!!confirmRuleDelete}
                title="Eliminar regla"
                message={`¿Eliminás la regla para "${confirmRuleDelete?.rule?.supplier_name}"?`}
                confirmLabel="Eliminar"
                onConfirm={() => deleteRule(confirmRuleDelete.pricelistId, confirmRuleDelete.rule.id)}
                onCancel={() => setConfirmRuleDelete(null)}
                variant="danger"
            />
        </div>
    );
}
