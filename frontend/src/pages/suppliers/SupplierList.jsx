import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useTheme } from '../../theme/ThemeContext';
import DataTable from '../../components/common/DataTable';
import Drawer from '../../components/common/Drawer';
import Modal from '../../components/common/Modal';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Select from '../../components/common/Select';
import Toggle from '../../components/common/Toggle';
import Badge from '../../components/common/Badge';
import * as Icon from '../../components/common/icons';
import PendingCategoriesModal from './PendingCategoriesModal';

const PRICE_FORMAT_OPTIONS = [
    { value: 'ar',  label: 'Argentino — 1.234,56' },
    { value: 'inv', label: 'Inverso — 1,234.56' },
];

// Fuente interna: los productos salen de Neggo (Odoo), no de la web del proveedor
const NEGGO_SOURCE_KEY = 'neggo_scraper';

const SOURCE_TYPES = [
    { value: 'web',     label: 'Web del proveedor' },
    { value: 'interno', label: 'Interno (Neggo)' },
    { value: 'ninguna', label: 'Sin fuente' },
];

function sourceType(key) {
    if (!key) return 'ninguna';
    return key === NEGGO_SOURCE_KEY ? 'interno' : 'web';
}

function formatDate(iso) {
    if (!iso) return 'Nunca';
    try {
        return new Intl.DateTimeFormat('es-AR', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
        }).format(new Date(iso));
    } catch { return 'Inválido'; }
}

function pct(v) {
    return v != null && v !== '' ? `${Number(v)}%` : '—';
}

export default function SupplierList() {
    const { tokens: t } = useTheme();
    const { user } = useAuth();
    const { showToast } = useToast();
    const navigate = useNavigate();
    const isAdmin = user?.role === 'admin';

    const [suppliers, setSuppliers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [showInactive, setShowInactive] = useState(false);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [editingSupplier, setEditingSupplier] = useState(null);
    const [confirmDeactivate, setConfirmDeactivate] = useState(null);
    const [deletingSupplier, setDeletingSupplier] = useState(null);
    const [unmappedBySupplier, setUnmappedBySupplier] = useState({});
    const [pendingOpen, setPendingOpen] = useState(false);
    const [pendingSupplierId, setPendingSupplierId] = useState(null);

    const loadSuppliers = useCallback(async () => {
        setLoading(true);
        const res = await api.get('/suppliers');
        setLoading(false);
        if (res.success) setSuppliers(res.data);
        else showToast(res.error || 'Error al cargar proveedores', 'error');
    }, []);

    const loadUnmapped = useCallback(async () => {
        const res = await api.get('/suppliers/unmapped-summary');
        if (res.success && res.data?.bySupplier) {
            const map = {};
            res.data.bySupplier.forEach(r => { map[r.supplier_id] = parseInt(r.unmapped_count, 10); });
            setUnmappedBySupplier(map);
        }
    }, []);

    useEffect(() => { loadSuppliers(); loadUnmapped(); }, [loadSuppliers, loadUnmapped]);

    function openCreate() { setEditingSupplier(null); setDrawerOpen(true); }
    function openEdit(s) { if (isAdmin) { setEditingSupplier(s); setDrawerOpen(true); } }
    function openPending(supplierId = null) { setPendingSupplierId(supplierId); setPendingOpen(true); }

    function replaceSupplier(saved) {
        setSuppliers(prev => prev.map(s => s.id === saved.id ? { ...s, ...saved } : s));
    }

    function handleSave(saved, isNew) {
        if (isNew) {
            setSuppliers(prev => [...prev, saved].sort((a, b) => a.name.localeCompare(b.name)));
            showToast(`Proveedor "${saved.name}" creado`, 'success');
        } else {
            replaceSupplier(saved);
            showToast(`Proveedor "${saved.name}" actualizado`, 'success');
        }
        setDrawerOpen(false);
    }

    async function handleToggleScraping(supplier, enabled) {
        const res = await api.post(`/suppliers/${supplier.id}/scraping/toggle`, { enabled });
        if (res.success) {
            replaceSupplier(res.data);
            showToast(`Scraping de "${supplier.name}" ${res.data.scrape_enabled ? 'activado' : 'pausado'}`, 'success');
        } else {
            showToast(res.error || 'Error al cambiar el scraping', 'error');
        }
    }

    async function handleDeactivate(supplier) {
        const res = await api.del(`/suppliers/${supplier.id}`);
        setConfirmDeactivate(null);
        if (res.success) {
            replaceSupplier({ id: supplier.id, active: false, scrape_enabled: false, is_stale: false });
            setDrawerOpen(false);
            showToast(`Proveedor "${supplier.name}" desactivado`, 'success');
            loadUnmapped();
        } else {
            showToast(res.error || 'Error al desactivar', 'error');
        }
    }

    async function handleReactivate(supplier) {
        const res = await api.put(`/suppliers/${supplier.id}`, { active: true });
        if (res.success) {
            replaceSupplier(res.data);
            setDrawerOpen(false);
            showToast(`Proveedor "${supplier.name}" reactivado`, 'success');
        } else {
            showToast(res.error || 'Error al reactivar', 'error');
        }
    }

    function handleDeleted(result) {
        setDeletingSupplier(null);
        setDrawerOpen(false);
        setSuppliers(prev => prev.filter(s => s.id !== result.id));
        const odoo = result.replacement
            ? ` — ${result.odoo_reassigned + result.odoo_removed_duplicates} productos de Odoo pasaron a "${result.replacement.name}"`
            : '';
        showToast(`Proveedor "${result.name}" eliminado${odoo}`, 'success');
        loadUnmapped();
    }

    const inactiveCount = suppliers.filter(s => !s.active).length;
    const q = search.trim().toLowerCase();
    const visible = suppliers.filter(s =>
        (showInactive || s.active) &&
        (!q || s.name.toLowerCase().includes(q) || (s.prefix || '').toLowerCase().includes(q))
    );
    const staleSuppliers = suppliers.filter(s => s.is_stale);
    const totalPending = Object.values(unmappedBySupplier).reduce((a, b) => a + b, 0);

    function renderFuente(row) {
        if (!row.scraper_key) return <Badge tone="muted">Sin fuente</Badge>;
        if (!row.scraper_available) return <Badge tone="warn">Falta el scraper · {row.scraper_key}</Badge>;
        if (row.scraper_key === NEGGO_SOURCE_KEY) return <Badge tone="primary">Interno (Neggo)</Badge>;
        return <Badge tone="accent">Web · {row.scraper_key}</Badge>;
    }

    const cols = [
        {
            key: 'name',
            label: 'Proveedor',
            render: (v, row) => (
                <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: t.font.weight.medium, color: row.active ? t.color.text : t.color.textFaint, fontFamily: t.font.family }}>
                            {v}
                        </span>
                        {!row.active && <Badge tone="muted">Desactivado</Badge>}
                        {row.is_stale && <Badge tone="warn">Sin scraping +7d</Badge>}
                    </div>
                    <div style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textFaint, marginTop: 2 }}>
                        {row.prefix || '—'}
                    </div>
                </div>
            ),
        },
        { key: 'scraper_key', label: 'Fuente', render: (_, row) => renderFuente(row) },
        {
            key: 'scrape_enabled',
            label: 'Scraping',
            render: (v, row) => {
                // Se puede pausar siempre; activar solo si la fuente tiene scraper
                const canToggle = isAdmin && row.active && (v || row.scraper_available);
                return (
                    <div
                        style={{ display: 'flex', alignItems: 'center', gap: t.space[2] }}
                        onClick={e => e.stopPropagation()}
                        title={!row.scraper_available && !v ? 'Elegí una fuente con scraper para poder activarlo' : undefined}
                    >
                        <Toggle size="sm" checked={!!v} disabled={!canToggle} onChange={val => handleToggleScraping(row, val)} />
                        <span style={{ fontSize: t.font.size.sm, color: v ? t.color.text : t.color.textFaint, fontFamily: t.font.family }}>
                            {v ? 'Activo' : 'Pausado'}
                        </span>
                    </div>
                );
            },
        },
        {
            key: 'default_discount',
            label: 'Desc. · Markup N / P',
            render: (v, row) => (
                <span style={{ ...t.numericStyle, fontSize: t.font.size.sm, whiteSpace: 'nowrap' }}>
                    <span style={{ color: t.color.text }}>{pct(v)}</span>
                    <span style={{ color: t.color.textFaint, margin: '0 6px' }}>·</span>
                    <span style={{ color: t.color.primary }}>{pct(row.markup_neggo)}</span>
                    <span style={{ color: t.color.textFaint, margin: '0 4px' }}>/</span>
                    <span style={{ color: t.color.accent }}>{pct(row.markup_preventas)}</span>
                </span>
            ),
        },
        {
            key: 'last_scraped_at',
            label: 'Último scraping',
            render: (v, row) => (
                <span style={{
                    fontSize: t.font.size.sm, fontFamily: t.font.family, whiteSpace: 'nowrap',
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
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }} onClick={e => e.stopPropagation()}>
                    {unmappedBySupplier[row.id] > 0 && isAdmin && (
                        <Button size="sm" variant="ghost" onClick={() => openPending(row.id)} title="Categorías sin regla">
                            <Badge tone="warn" style={{ padding: '0 6px' }}>{unmappedBySupplier[row.id]} pend.</Badge>
                        </Button>
                    )}
                    <Button size="sm" variant="secondary" onClick={() => navigate(`/proveedores/${row.id}/reglas`)}>
                        Reglas
                    </Button>
                    {isAdmin && (
                        <Button size="sm" variant="ghost" leftIcon={<Icon.Edit2 size={13} />} onClick={() => openEdit(row)}>
                            Editar
                        </Button>
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
                <div style={{ display: 'flex', alignItems: 'center', gap: t.space[4], flexWrap: 'wrap' }}>
                    <Input
                        placeholder="Buscar por nombre o prefijo"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        leftIcon={<Icon.Search size={14} />}
                        style={{ width: 260 }}
                    />
                    <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family, ...t.numericStyle }}>
                        {visible.length} proveedores
                    </span>
                    {inactiveCount > 0 && (
                        <label style={{ display: 'flex', alignItems: 'center', gap: t.space[2], fontSize: t.font.size.sm, color: t.color.textMuted, cursor: 'pointer', fontFamily: t.font.family }}>
                            <Toggle size="sm" checked={showInactive} onChange={setShowInactive} />
                            Ver desactivados ({inactiveCount})
                        </label>
                    )}
                </div>
                {isAdmin && (
                    <div style={{ display: 'flex', gap: t.space[2] }}>
                        <Button
                            variant="secondary"
                            leftIcon={<Icon.Tag size={15} />}
                            onClick={() => openPending()}
                            rightIcon={totalPending > 0 ? <Badge tone="warn" style={{ padding: '0 6px' }}>{totalPending}</Badge> : undefined}
                        >
                            Categorías pendientes
                        </Button>
                        <Button variant="primary" leftIcon={<Icon.Truck size={15} />} onClick={openCreate}>
                            Nuevo proveedor
                        </Button>
                    </div>
                )}
            </div>

            <DataTable columns={cols} data={visible} loading={loading} onRowClick={isAdmin ? openEdit : undefined} />

            {/* Panel lateral crear/editar */}
            <Drawer
                isOpen={drawerOpen}
                onClose={() => setDrawerOpen(false)}
                title={editingSupplier ? editingSupplier.name : 'Nuevo proveedor'}
                subtitle={editingSupplier ? `Último scraping: ${formatDate(editingSupplier.last_scraped_at)}` : undefined}
                footer={
                    <>
                        {editingSupplier && (editingSupplier.active ? (
                            <Button variant="danger" size="sm" onClick={() => setConfirmDeactivate(editingSupplier)}>
                                Desactivar
                            </Button>
                        ) : (
                            <Button variant="success" size="sm" onClick={() => handleReactivate(editingSupplier)}>
                                Reactivar
                            </Button>
                        ))}
                        {editingSupplier && (
                            <Button variant="ghost" size="sm" leftIcon={<Icon.Trash2 size={13} />} onClick={() => setDeletingSupplier(editingSupplier)}>
                                Eliminar
                            </Button>
                        )}
                        <div style={{ flex: 1 }} />
                        <Button variant="ghost" onClick={() => setDrawerOpen(false)}>Cancelar</Button>
                        <Button type="submit" form="supplier-form" variant="primary">Guardar</Button>
                    </>
                }
            >
                {drawerOpen && (
                    <SupplierForm
                        key={editingSupplier?.id || 'nuevo'}
                        supplier={editingSupplier}
                        tokens={t}
                        onSave={handleSave}
                    />
                )}
            </Drawer>

            <PendingCategoriesModal
                isOpen={pendingOpen}
                onClose={() => setPendingOpen(false)}
                onChanged={loadUnmapped}
                initialSupplierId={pendingSupplierId}
            />

            {/* Confirm desactivar */}
            <ConfirmDialog
                isOpen={!!confirmDeactivate}
                onClose={() => setConfirmDeactivate(null)}
                onConfirm={() => handleDeactivate(confirmDeactivate)}
                title="Desactivar proveedor"
                message={`¿Desactivás a "${confirmDeactivate?.name}"? Se pausa el scraping y se borran sus productos scrapeados (las reglas quedan). Lo podés reactivar después.`}
                confirmLabel="Desactivar"
                danger
            />

            {/* Eliminar con reasignación en Odoo Neggo */}
            <Modal
                isOpen={!!deletingSupplier}
                onClose={() => setDeletingSupplier(null)}
                title="Eliminar proveedor"
                width={560}
            >
                {deletingSupplier && (
                    <DeleteSupplierForm
                        supplier={deletingSupplier}
                        suppliers={suppliers}
                        tokens={t}
                        onClose={() => setDeletingSupplier(null)}
                        onDeleted={handleDeleted}
                    />
                )}
            </Modal>
        </div>
    );
}

// ─── Eliminar proveedor ──────────────────────────────────────────────────────────
function DeleteSupplierForm({ supplier, suppliers, tokens: t, onClose, onDeleted }) {
    const [preview, setPreview] = useState(null);
    const [error, setError] = useState(null);
    const [replacementId, setReplacementId] = useState('');
    const [deleting, setDeleting] = useState(false);

    useEffect(() => {
        api.get(`/suppliers/${supplier.id}/delete-preview`).then(res => {
            if (res.success) setPreview(res.data);
            else setError(res.error || 'No se pudo consultar el proveedor');
        });
    }, [supplier.id]);

    const options = suppliers
        .filter(s => s.id !== supplier.id)
        .map(s => ({ value: String(s.id), label: s.name }));

    const blocked = preview?.blocked_reasons?.length > 0;
    const needsReplacement = preview?.odoo_neggo_products > 0;
    const canDelete = preview && !blocked && (!needsReplacement || replacementId);
    const replacementName = options.find(o => o.value === replacementId)?.label;

    async function handleDelete() {
        setDeleting(true);
        const res = await api.post(`/suppliers/${supplier.id}/delete`, {
            replacement_supplier_id: replacementId ? Number(replacementId) : null,
        });
        setDeleting(false);
        if (res.success) onDeleted(res.data);
        else setError(res.error || 'No se pudo eliminar el proveedor');
    }

    const text = { fontSize: t.font.size.sm, color: t.color.text, fontFamily: t.font.family, lineHeight: 1.5 };
    const box = (tone) => ({
        ...text,
        background: tone === 'danger' ? t.color.dangerSoft : t.color.warnSoft,
        color: tone === 'danger' ? t.color.danger : t.color.warn,
        border: `1px solid ${tone === 'danger' ? t.color.danger : t.color.warn}33`,
        padding: '10px 14px', borderRadius: t.radius.sm,
    });
    const num = { ...t.numericStyle, fontWeight: t.font.weight.semibold };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>
            {error && <div style={box('danger')}>{error}</div>}

            {!preview && !error && (
                <div style={{ ...text, color: t.color.textMuted }}>Consultando a Odoo…</div>
            )}

            {preview && blocked && (
                <div style={box('danger')}>
                    <div style={{ fontWeight: t.font.weight.semibold, marginBottom: 4 }}>
                        No se puede eliminar "{supplier.name}":
                    </div>
                    {preview.blocked_reasons.map(r => <div key={r}>· {r}</div>)}
                </div>
            )}

            {preview && !blocked && (
                <>
                    <div style={text}>
                        Vas a eliminar a <b>{supplier.name}</b> de la app, con sus reglas y
                        sus <span style={num}>{preview.scraped_products}</span> productos scrapeados.
                        El historial de scraping y los ingresos se conservan, sin proveedor.
                    </div>

                    {needsReplacement ? (
                        <>
                            <div style={text}>
                                En Odoo Neggo hay <span style={num}>{preview.odoo_neggo_products}</span> productos
                                con este proveedor. Elegí a quién pasarlos (Precompras no se toca):
                            </div>
                            <Select
                                value={replacementId}
                                onChange={setReplacementId}
                                options={options}
                                placeholder="Elegí el proveedor de reemplazo..."
                            />
                        </>
                    ) : (
                        <div style={{ ...text, color: t.color.textMuted }}>
                            {preview.odoo_partner
                                ? 'No tiene productos en Odoo Neggo: no hace falta reasignar nada.'
                                : 'No figura como contacto en Odoo: no hay productos para reasignar.'}
                        </div>
                    )}

                    {canDelete && (
                        <div style={box('warn')}>
                            Esto no se puede deshacer.
                            {needsReplacement && ` Se escribe en Odoo: los productos pasan a "${replacementName}".`}
                        </div>
                    )}
                </>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: t.space[3] }}>
                <Button variant="ghost" onClick={onClose}>Cancelar</Button>
                {!blocked && (
                    <Button variant="danger" disabled={!canDelete || deleting} onClick={handleDelete}>
                        {deleting ? 'Eliminando…' : 'Eliminar'}
                    </Button>
                )}
            </div>
        </div>
    );
}

// ─── Formulario del panel ───────────────────────────────────────────────────────
function SupplierForm({ supplier, tokens: t, onSave }) {
    const [form, setForm] = useState({
        name:             supplier?.name || '',
        prefix:           supplier?.prefix || '',
        website_url:      supplier?.website_url || '',
        scraper_key:      supplier?.scraper_key || '',
        price_format:     supplier?.price_format || 'ar',
        default_discount: supplier?.default_discount ?? '',
        markup_neggo:     supplier?.markup_neggo ?? '',
        markup_preventas: supplier?.markup_preventas ?? '',
        scrape_enabled:   supplier ? !!supplier.scrape_enabled : true,
        odoo_partner_id:  supplier?.scrape_config?.odoo_partner_id || null,
    });
    const [type, setType] = useState(sourceType(supplier?.scraper_key));
    const [errors, setErrors] = useState({});
    const [saving, setSaving] = useState(false);
    const [scraperKeys, setScraperKeys] = useState([]);

    useEffect(() => {
        api.get('/suppliers/scraper-keys').then(res => { if (res.success) setScraperKeys(res.data); });
    }, []);

    // Scrapers web registrados; se conserva la clave guardada aunque no tenga scraper
    const webKeys = [...new Set([
        ...scraperKeys.filter(k => k !== NEGGO_SOURCE_KEY),
        ...(sourceType(supplier?.scraper_key) === 'web' ? [supplier.scraper_key] : []),
    ])].sort();
    const webOptions = webKeys.map(k => ({
        value: k,
        label: scraperKeys.includes(k) ? k : `${k} (falta el scraper)`,
    }));

    const scraperAvailable = !!form.scraper_key && scraperKeys.includes(form.scraper_key);

    function changeType(next) {
        setType(next);
        setErrors(prev => ({ ...prev, scraper_key: undefined, odoo_partner_id: undefined }));
        setForm(p => {
            const key = next === 'interno' ? NEGGO_SOURCE_KEY
                : next === 'web' ? (sourceType(p.scraper_key) === 'web' ? p.scraper_key : '')
                : '';
            return { ...p, scraper_key: key, scrape_enabled: next === 'ninguna' ? false : p.scrape_enabled };
        });
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

    function validate() {
        const errs = {};
        if (!form.name.trim()) errs.name = 'El nombre es obligatorio';
        if (!form.prefix.trim()) errs.prefix = 'El prefijo es obligatorio';
        if (type === 'web' && !form.scraper_key) errs.scraper_key = 'Elegí qué scraper usa';
        if (type === 'interno' && !form.odoo_partner_id) errs.odoo_partner_id = 'Elegí el proveedor de Odoo';
        for (const k of ['default_discount', 'markup_neggo', 'markup_preventas']) {
            if (form[k] !== '' && isNaN(Number(form[k]))) errs[k] = 'Debe ser un número';
        }
        return errs;
    }

    async function handleSubmit(e) {
        e.preventDefault();
        if (saving) return;
        const errs = validate();
        if (Object.keys(errs).length) { setErrors(errs); return; }
        setSaving(true);
        const num = v => (v !== '' && v != null ? Number(v) : null);
        const body = {
            name:             form.name,
            prefix:           form.prefix,
            website_url:      form.website_url,
            scraper_key:      form.scraper_key,
            price_format:     form.price_format,
            default_discount: num(form.default_discount),
            markup_neggo:     num(form.markup_neggo),
            markup_preventas: num(form.markup_preventas),
            scrape_enabled:   form.scrape_enabled && scraperAvailable,
        };
        // El partner de Odoo solo se toca con fuente interna (los web también lo tienen guardado)
        if (type === 'interno') body.odoo_partner_id = form.odoo_partner_id;
        // Al editar, un scraper que todavía no existe no se manda: el backend lo rechazaría
        if (supplier && !scraperAvailable && form.scraper_key === supplier.scraper_key) {
            delete body.scraper_key;
            delete body.scrape_enabled;
        }
        const res = supplier
            ? await api.put(`/suppliers/${supplier.id}`, body)
            : await api.post('/suppliers', body);
        setSaving(false);
        if (res.success) onSave(res.data, !supplier);
        else setErrors({ _global: res.error || 'Ocurrió un error al guardar' });
    }

    const sectionTitle = {
        fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, color: t.color.textFaint,
        textTransform: 'uppercase', letterSpacing: '0.05em', fontFamily: t.font.family,
        margin: `${t.space[6]}px 0 ${t.space[3]}px`,
    };
    const hint = { fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family };

    return (
        <form id="supplier-form" onSubmit={handleSubmit} noValidate>
            {errors._global && (
                <div style={{
                    background: t.color.dangerSoft, color: t.color.danger,
                    border: `1px solid ${t.color.danger}33`,
                    padding: '10px 14px', borderRadius: t.radius.sm,
                    fontSize: t.font.size.sm, marginBottom: t.space[5],
                    fontFamily: t.font.family,
                }}>
                    {errors._global}
                </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: t.space[4] }}>
                <FormField label="Nombre *" error={errors.name} tokens={t}>
                    <Input placeholder="Ej: Proveedor ABC" {...field('name')} style={errors.name ? { borderColor: t.color.danger } : {}} />
                </FormField>
                <FormField label="Prefijo *" error={errors.prefix} tokens={t}>
                    <Input placeholder="Ej: ABC" {...field('prefix')} style={{ fontFamily: t.font.mono, ...(errors.prefix ? { borderColor: t.color.danger } : {}) }} />
                </FormField>
            </div>

            {/* Fuente de datos */}
            <div style={sectionTitle}>De dónde salen los productos</div>
            <Segmented options={SOURCE_TYPES} value={type} onChange={changeType} tokens={t} />

            <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[4], marginTop: t.space[4] }}>
                {type === 'web' && (
                    <>
                        <FormField label="Scraper" error={errors.scraper_key} tokens={t}>
                            <Select
                                value={form.scraper_key}
                                onChange={v => { setForm(p => ({ ...p, scraper_key: v })); setErrors(p => ({ ...p, scraper_key: undefined })); }}
                                options={webOptions}
                                placeholder="Elegí el scraper"
                            />
                            {form.scraper_key && !scraperAvailable && (
                                <span style={{ ...hint, color: t.color.warn }}>
                                    Este proveedor todavía no tiene scraper: no se puede ejecutar hasta que se programe.
                                </span>
                            )}
                        </FormField>
                        <FormField label="URL del sitio" tokens={t}>
                            <Input type="url" placeholder="https://proveedor.com" {...field('website_url')} />
                        </FormField>
                        <FormField label="Formato de precio en la web" tokens={t}>
                            <Select value={form.price_format} onChange={v => setForm(p => ({ ...p, price_format: v }))} options={PRICE_FORMAT_OPTIONS} />
                        </FormField>
                    </>
                )}

                {type === 'interno' && (
                    <FormField label="Proveedor en Odoo" error={errors.odoo_partner_id} tokens={t}>
                        <OdooPartnerPicker
                            value={form.odoo_partner_id}
                            initialQuery={form.name}
                            onChange={id => { setForm(p => ({ ...p, odoo_partner_id: id })); setErrors(p => ({ ...p, odoo_partner_id: undefined })); }}
                            tokens={t}
                        />
                        <span style={hint}>Se toman los productos de Neggo que tienen cargado a este proveedor.</span>
                    </FormField>
                )}

                {type === 'ninguna' && (
                    <span style={hint}>Sin fuente no se scrapea: los productos se cargan solo por ingreso.</span>
                )}

                {type !== 'ninguna' && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: t.space[3], cursor: scraperAvailable ? 'pointer' : 'default' }}>
                        <Toggle
                            checked={form.scrape_enabled && scraperAvailable}
                            disabled={!scraperAvailable}
                            onChange={v => setForm(p => ({ ...p, scrape_enabled: v }))}
                        />
                        <div>
                            <div style={{ fontSize: t.font.size.sm, color: scraperAvailable ? t.color.text : t.color.textFaint, fontFamily: t.font.family }}>
                                Scraping activo
                            </div>
                            <div style={hint}>Si está pausado, no aparece en Scraping.</div>
                        </div>
                    </label>
                )}
            </div>

            {/* Precios */}
            <div style={sectionTitle}>Precios</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: t.space[4] }}>
                <FormField label="Descuento (%)" error={errors.default_discount} tokens={t}>
                    <Input type="number" min="0" max="100" step="0.01" placeholder="0" {...field('default_discount')} style={{ ...t.numericStyle, ...(errors.default_discount ? { borderColor: t.color.danger } : {}) }} />
                </FormField>
                <FormField label="Markup Neggo (%)" error={errors.markup_neggo} tokens={t}>
                    <Input type="number" min="0" step="0.01" placeholder="0" {...field('markup_neggo')} style={{ ...t.numericStyle, ...(errors.markup_neggo ? { borderColor: t.color.danger } : {}) }} />
                </FormField>
                <FormField label="Markup Preventas (%)" error={errors.markup_preventas} tokens={t}>
                    <Input type="number" min="0" step="0.01" placeholder="0" {...field('markup_preventas')} style={{ ...t.numericStyle, ...(errors.markup_preventas ? { borderColor: t.color.danger } : {}) }} />
                </FormField>
            </div>
            {type === 'interno' && (
                <div style={{ ...hint, marginTop: t.space[2] }}>
                    Con fuente interna el descuento se usa solo en el ingreso a Neggo. En Precompras no se aplica: el costo de Neggo ya lo incluye.
                </div>
            )}
            <div style={{ ...hint, marginTop: t.space[2] }}>
                Cada categoría puede pisar estos valores desde Reglas.
            </div>

            {saving && <div style={{ ...hint, marginTop: t.space[4] }}>Guardando…</div>}
        </form>
    );
}

// Selector en línea de pocas opciones (web / interno / sin fuente)
function Segmented({ options, value, onChange, tokens: t }) {
    return (
        <div style={{ display: 'flex', background: t.color.surface2, borderRadius: t.radius.sm, padding: 3, gap: 3 }}>
            {options.map(o => {
                const active = o.value === value;
                return (
                    <button
                        key={o.value}
                        type="button"
                        onClick={() => onChange(o.value)}
                        style={{
                            flex: 1, padding: '7px 10px', border: 'none', cursor: 'pointer',
                            borderRadius: t.radius.sm, fontFamily: t.font.family, fontSize: t.font.size.sm,
                            fontWeight: active ? t.font.weight.semibold : t.font.weight.medium,
                            background: active ? t.color.surface : 'transparent',
                            color: active ? t.color.text : t.color.textMuted,
                            boxShadow: active ? t.shadow.card : 'none',
                        }}
                    >
                        {o.label}
                    </button>
                );
            })}
        </div>
    );
}

// Busca el proveedor en Odoo (solo lectura) y guarda su ID
function OdooPartnerPicker({ value, initialQuery, onChange, tokens: t }) {
    const [selectedName, setSelectedName] = useState(null);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [searching, setSearching] = useState(false);
    const [editing, setEditing] = useState(!value);

    useEffect(() => {
        if (!value) { setSelectedName(null); return; }
        api.get(`/suppliers/odoo-partners/${value}`).then(res => {
            setSelectedName(res.success ? res.data.name : `ID ${value}`);
        });
    }, [value]);

    useEffect(() => {
        if (editing && !query && initialQuery) setQuery(initialQuery);
    }, [editing]);

    useEffect(() => {
        if (!editing || query.trim().length < 2) { setResults([]); return; }
        const timer = setTimeout(async () => {
            setSearching(true);
            const res = await api.get('/suppliers/odoo-partners', { q: query.trim() });
            setSearching(false);
            if (res.success) setResults(res.data || []);
        }, 300);
        return () => clearTimeout(timer);
    }, [query, editing]);

    if (value && !editing) {
        return (
            <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: t.space[3],
                border: `1px solid ${t.color.borderStrong}`, borderRadius: t.radius.sm,
                padding: '0 6px 0 12px', height: t.layout.inputHeight,
            }}>
                <span style={{ fontSize: t.font.size.sm, color: t.color.text, fontFamily: t.font.family }}>
                    {selectedName || 'Cargando…'}
                    <span style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textFaint, marginLeft: 8 }}>#{value}</span>
                </span>
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}>Cambiar</Button>
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[2] }}>
            <Input
                autoFocus
                placeholder="Buscá el proveedor en Odoo"
                value={query}
                onChange={e => setQuery(e.target.value)}
                leftIcon={<Icon.Search size={14} />}
            />
            {(searching || results.length > 0) && (
                <div style={{ border: `1px solid ${t.color.border}`, borderRadius: t.radius.sm, maxHeight: 200, overflowY: 'auto' }}>
                    {searching && <div style={{ padding: '8px 12px', fontSize: t.font.size.sm, color: t.color.textFaint, fontFamily: t.font.family }}>Buscando…</div>}
                    {!searching && results.map(p => (
                        <button
                            key={p.id}
                            type="button"
                            onClick={() => { onChange(p.id); setSelectedName(p.name); setEditing(false); }}
                            onMouseEnter={e => { e.currentTarget.style.background = t.color.surface2; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                            style={{
                                display: 'flex', justifyContent: 'space-between', width: '100%', textAlign: 'left',
                                padding: '8px 12px', border: 'none', background: 'transparent', cursor: 'pointer',
                                fontSize: t.font.size.sm, color: t.color.text, fontFamily: t.font.family,
                            }}
                        >
                            <span>{p.name}</span>
                            <span style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textFaint }}>#{p.id}</span>
                        </button>
                    ))}
                </div>
            )}
            {value && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)} style={{ alignSelf: 'flex-start' }}>
                    Dejar el actual
                </Button>
            )}
        </div>
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
