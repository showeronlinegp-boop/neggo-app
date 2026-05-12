import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useTheme } from '../../theme/ThemeContext';
import DataTable from '../../components/common/DataTable';
import Modal from '../../components/common/Modal';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Select from '../../components/common/Select';
import Toggle from '../../components/common/Toggle';
import Badge from '../../components/common/Badge';
import * as Icon from '../../components/common/icons';

const PRICE_FORMAT_OPTIONS = [
    { value: 'ar',  label: 'AR (con puntos de miles)' },
    { value: 'inv', label: 'INV (punto decimal)' },
];

const EMPTY_FORM = {
    name: '', prefix: '', website_url: '', scraper_key: '',
    price_format: 'ar', is_published: false,
    default_discount: '', markup_neggo: '', markup_preventas: '', scrape_schedule: '',
};

function formatDate(iso) {
    if (!iso) return 'Nunca';
    try {
        return new Intl.DateTimeFormat('es-AR', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
        }).format(new Date(iso));
    } catch { return 'Inválido'; }
}

export default function SupplierList() {
    const { tokens: t } = useTheme();
    const { user } = useAuth();
    const { showToast } = useToast();
    const navigate = useNavigate();
    const isAdmin = user?.role === 'admin';

    const [suppliers, setSuppliers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [modalOpen, setModalOpen] = useState(false);
    const [editingSupplier, setEditingSupplier] = useState(null);
    const [confirmDeactivate, setConfirmDeactivate] = useState(null);
    const [unmappedBySupplier, setUnmappedBySupplier] = useState({});

    const loadSuppliers = useCallback(async () => {
        setLoading(true);
        const res = await api.get('/suppliers');
        setLoading(false);
        if (res.success) setSuppliers(res.data);
        else showToast(res.error || 'Error al cargar proveedores', 'error');
    }, []);

    useEffect(() => { loadSuppliers(); }, [loadSuppliers]);

    useEffect(() => {
        api.get('/suppliers/unmapped-summary').then(res => {
            if (res.success && res.data?.bySupplier) {
                const map = {};
                res.data.bySupplier.forEach(r => { map[r.supplier_id] = parseInt(r.unmapped_count); });
                setUnmappedBySupplier(map);
            }
        });
    }, []);

    function openCreate() { setEditingSupplier(null); setModalOpen(true); }
    function openEdit(s) { setEditingSupplier(s); setModalOpen(true); }

    function handleSave(saved, isNew) {
        if (isNew) {
            setSuppliers(prev => [saved, ...prev]);
            showToast(`Proveedor "${saved.name}" creado`, 'success');
        } else {
            setSuppliers(prev => prev.map(s => s.id === saved.id ? saved : s));
            showToast(`Proveedor "${saved.name}" actualizado`, 'success');
        }
        setModalOpen(false);
    }

    async function handleDeactivate(supplier) {
        const res = await api.del(`/suppliers/${supplier.id}`);
        setConfirmDeactivate(null);
        if (res.success) {
            setSuppliers(prev => prev.map(s => s.id === supplier.id ? { ...s, active: false } : s));
            showToast(`Proveedor "${supplier.name}" desactivado`, 'success');
        } else {
            showToast(res.error || 'Error al desactivar', 'error');
        }
    }

    const staleSuppliers = suppliers.filter(s => s.is_stale);

    const cols = [
        {
            key: 'name',
            label: 'Proveedor',
            render: (v, row) => (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: t.font.weight.medium, color: t.color.text, fontFamily: t.font.family }}>
                            {v}
                        </div>
                        <div style={{ display: 'flex', gap: 6, marginTop: 3, flexWrap: 'wrap' }}>
                            <Badge tone={row.active ? 'success' : 'muted'} dot>
                                {row.active ? 'Activo' : 'Inactivo'}
                            </Badge>
                            {row.is_stale && <Badge tone="warn">Sin scraping +7d</Badge>}
                            {!row.is_published && <Badge tone="muted">No publicado</Badge>}
                        </div>
                    </div>
                </div>
            ),
        },
        {
            key: 'prefix',
            label: 'Prefijo',
            render: v => (
                <span style={{ fontFamily: t.font.mono, fontSize: t.font.size.sm, color: t.color.textMuted }}>
                    {v || '—'}
                </span>
            ),
        },
        { key: 'scraper_key', label: 'Scraper', render: v => v || <span style={{ color: t.color.textFaint }}>—</span> },
        {
            key: 'default_discount',
            label: 'Descuento',
            render: v => (
                <span style={{ textAlign: 'right', display: 'block', ...t.numericStyle }}>
                    {v != null ? `${v}%` : <span style={{ color: t.color.textFaint }}>—</span>}
                </span>
            ),
        },
        {
            key: 'markup_neggo',
            label: 'Markup N / P',
            render: (v, row) => (
                <span style={{ display: 'block', textAlign: 'right', ...t.numericStyle, fontSize: t.font.size.sm }}>
                    <span style={{ color: t.color.primary }}>{v != null ? `${v}%` : '—'}</span>
                    <span style={{ color: t.color.textFaint, margin: '0 4px' }}>/</span>
                    <span style={{ color: t.color.accent }}>{row.markup_preventas != null ? `${row.markup_preventas}%` : '—'}</span>
                </span>
            ),
        },
        {
            key: 'last_scraped_at',
            label: 'Último scraping',
            render: (v, row) => (
                <span style={{
                    fontSize: t.font.size.sm,
                    fontFamily: t.font.family,
                    color: row.is_stale ? t.color.warn : v ? t.color.textMuted : t.color.textFaint,
                }}>
                    {formatDate(v)}
                </span>
            ),
        },
        {
            key: 'id',
            label: '',
            render: (_, row) => (
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <Button
                        size="sm" variant="secondary"
                        onClick={e => { e.stopPropagation(); navigate(`/proveedores/${row.id}/reglas`); }}
                        rightIcon={unmappedBySupplier[row.id] > 0
                            ? <Badge tone="warn" style={{ padding: '0 5px', fontSize: 10 }}>{unmappedBySupplier[row.id]}</Badge>
                            : undefined
                        }
                    >
                        Reglas
                    </Button>
                    {isAdmin && (
                        <>
                            <Button size="sm" variant="ghost" onClick={e => { e.stopPropagation(); openEdit(row); }}>
                                Editar
                            </Button>
                            {row.active && (
                                <Button size="sm" variant="danger" onClick={e => { e.stopPropagation(); setConfirmDeactivate(row); }}>
                                    Desactivar
                                </Button>
                            )}
                        </>
                    )}
                </div>
            ),
        },
    ];

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>

            {/* Banner stale */}
            {staleSuppliers.length > 0 && (
                <div style={{
                    background: t.color.warnSoft,
                    border: `1px solid ${t.color.warn}44`,
                    borderRadius: t.radius.md,
                    padding: `12px 18px`,
                    display: 'flex', alignItems: 'center', gap: 10,
                }}>
                    <Icon.Bell size={16} color={t.color.warn} />
                    <div style={{ fontSize: t.font.size.sm, color: t.color.warn, fontFamily: t.font.family }}>
                        <span style={{ fontWeight: t.font.weight.semibold }}>
                            {staleSuppliers.length} proveedor{staleSuppliers.length > 1 ? 'es' : ''} sin scraping en más de 7 días:
                        </span>
                        <span style={{ marginLeft: 8 }}>{staleSuppliers.map(s => s.name).join(', ')}</span>
                    </div>
                </div>
            )}

            {/* Cabecera */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family, ...t.numericStyle }}>
                    {suppliers.length} proveedores
                </span>
                {isAdmin && (
                    <Button variant="primary" leftIcon={<Icon.Truck size={15} />} onClick={openCreate}>
                        Nuevo proveedor
                    </Button>
                )}
            </div>

            <DataTable columns={cols} data={suppliers} loading={loading} />

            {/* Modal crear/editar */}
            <Modal
                isOpen={modalOpen}
                onClose={() => setModalOpen(false)}
                title={editingSupplier ? 'Editar proveedor' : 'Nuevo proveedor'}
                width={640}
            >
                {modalOpen && (
                    <SupplierForm
                        supplier={editingSupplier}
                        tokens={t}
                        onClose={() => setModalOpen(false)}
                        onSave={handleSave}
                    />
                )}
            </Modal>

            {/* Confirm desactivar */}
            <ConfirmDialog
                isOpen={!!confirmDeactivate}
                onClose={() => setConfirmDeactivate(null)}
                onConfirm={() => handleDeactivate(confirmDeactivate)}
                title="Desactivar proveedor"
                message={`¿Confirmás que querés desactivar a "${confirmDeactivate?.name}"? Esta acción se puede revertir.`}
                confirmLabel="Desactivar"
                danger
            />
        </div>
    );
}

// ─── Formulario del modal ────────────────────────────────────────────────────────
function SupplierForm({ supplier, tokens: t, onClose, onSave }) {
    const [form, setForm] = useState(supplier ? {
        name:              supplier.name || '',
        prefix:            supplier.prefix || '',
        website_url:       supplier.website_url || '',
        scraper_key:       supplier.scraper_key || '',
        price_format:      supplier.price_format || 'ar',
        is_published:      supplier.is_published ?? false,
        default_discount:  supplier.default_discount ?? '',
        markup_neggo:      supplier.markup_neggo ?? '',
        markup_preventas:  supplier.markup_preventas ?? '',
        scrape_schedule:   supplier.scrape_schedule || '',
    } : { ...EMPTY_FORM });

    const [errors, setErrors] = useState({});
    const [saving, setSaving] = useState(false);

    function validate() {
        const errs = {};
        if (!form.name.trim()) errs.name = 'El nombre es obligatorio';
        if (!form.prefix.trim()) errs.prefix = 'El prefijo es obligatorio';
        if (form.default_discount !== '' && isNaN(Number(form.default_discount))) errs.default_discount = 'Debe ser un número';
        if (form.markup_neggo !== '' && isNaN(Number(form.markup_neggo))) errs.markup_neggo = 'Debe ser un número';
        if (form.markup_preventas !== '' && isNaN(Number(form.markup_preventas))) errs.markup_preventas = 'Debe ser un número';
        return errs;
    }

    function field(name) {
        return {
            value: form[name],
            onChange: e => {
                setForm(prev => ({ ...prev, [name]: e.target.value }));
                if (errors[name]) setErrors(prev => ({ ...prev, [name]: undefined }));
            },
        };
    }

    async function handleSubmit(e) {
        e.preventDefault();
        const errs = validate();
        if (Object.keys(errs).length) { setErrors(errs); return; }
        setSaving(true);
        const body = {
            ...form,
            default_discount: form.default_discount !== '' ? Number(form.default_discount) : null,
            markup_neggo:     form.markup_neggo !== '' ? Number(form.markup_neggo) : null,
            markup_preventas: form.markup_preventas !== '' ? Number(form.markup_preventas) : null,
        };
        const res = supplier
            ? await api.put(`/suppliers/${supplier.id}`, body)
            : await api.post('/suppliers', body);
        setSaving(false);
        if (res.success) onSave(res.data, !supplier);
        else setErrors({ _global: res.error || 'Ocurrió un error al guardar' });
    }

    const labelStyle = {
        display: 'block', fontSize: t.font.size.sm,
        fontWeight: t.font.weight.medium, color: t.color.textMuted,
        marginBottom: t.space[1], fontFamily: t.font.family,
    };

    return (
        <form onSubmit={handleSubmit} noValidate>
            {errors._global && (
                <div style={{
                    background: t.color.dangerSoft, color: t.color.danger,
                    border: `1px solid ${t.color.danger}33`,
                    padding: '10px 14px', borderRadius: t.radius.sm,
                    fontSize: t.font.size.sm, marginBottom: t.space[6],
                    fontFamily: t.font.family,
                }}>
                    {errors._global}
                </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: t.space[6] }}>

                <FormField label="Nombre *" error={errors.name} tokens={t}>
                    <Input placeholder="Ej: Proveedor ABC" {...field('name')} style={errors.name ? { borderColor: t.color.danger } : {}} />
                </FormField>

                <FormField label="Prefijo *" error={errors.prefix} tokens={t}>
                    <Input placeholder="Ej: ABC" {...field('prefix')} style={errors.prefix ? { borderColor: t.color.danger } : {}} />
                </FormField>

                <FormField label="URL del sitio" tokens={t} style={{ gridColumn: '1 / -1' }}>
                    <Input type="url" placeholder="https://proveedor.com" {...field('website_url')} />
                </FormField>

                <FormField label="Clave scraper" tokens={t}>
                    <Input placeholder="Ej: abc_scraper" {...field('scraper_key')} />
                </FormField>

                <FormField label="Formato de precio" tokens={t}>
                    <Select
                        value={form.price_format}
                        onChange={v => setForm(p => ({ ...p, price_format: v }))}
                        options={PRICE_FORMAT_OPTIONS}
                    />
                </FormField>

                <FormField label="Descuento default (%)" error={errors.default_discount} tokens={t}>
                    <Input type="number" min="0" max="100" step="0.01" placeholder="Ej: 20" {...field('default_discount')} style={errors.default_discount ? { borderColor: t.color.danger } : {}} />
                </FormField>

                <FormField label="Markup Neggo (%)" error={errors.markup_neggo} tokens={t}>
                    <Input type="number" min="0" step="0.01" placeholder="Ej: 25" {...field('markup_neggo')} style={errors.markup_neggo ? { borderColor: t.color.danger } : {}} />
                </FormField>

                <FormField label="Markup Preventas (%)" error={errors.markup_preventas} tokens={t}>
                    <Input type="number" min="0" step="0.01" placeholder="Ej: 20" {...field('markup_preventas')} style={errors.markup_preventas ? { borderColor: t.color.danger } : {}} />
                </FormField>

                <FormField label="Schedule (cron)" tokens={t}>
                    <Input placeholder="Ej: 0 6 * * *" {...field('scrape_schedule')} />
                </FormField>

                <div style={{ display: 'flex', alignItems: 'center', gap: t.space[3], paddingTop: t.space[8] }}>
                    <Toggle
                        checked={form.is_published}
                        onChange={v => setForm(p => ({ ...p, is_published: v }))}
                    />
                    <span style={{ fontSize: t.font.size.sm, color: t.color.text, fontFamily: t.font.family }}>
                        Publicado
                    </span>
                </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: t.space[3], marginTop: t.space[8] }}>
                <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
                <Button type="submit" variant="primary" disabled={saving}>
                    {saving ? 'Guardando…' : 'Guardar'}
                </Button>
            </div>
        </form>
    );
}

function FormField({ label, error, children, tokens: t, style }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[1], ...style }}>
            <label style={{
                fontSize: t.font.size.sm, fontWeight: t.font.weight.medium,
                color: t.color.textMuted, fontFamily: t.font.family,
            }}>
                {label}
            </label>
            {children}
            {error && (
                <span style={{ fontSize: t.font.size.xs, color: t.color.danger, fontFamily: t.font.family }}>
                    {error}
                </span>
            )}
        </div>
    );
}
