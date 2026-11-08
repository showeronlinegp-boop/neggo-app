import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import api from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR } from '../../theme/tokens';
import DataTable from '../../components/common/DataTable';
import Modal from '../../components/common/Modal';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Select from '../../components/common/Select';
import Toggle from '../../components/common/Toggle';
import * as Icon from '../../components/common/icons';

const EMPTY_FORM = {
    sourceCategory: '',
    destCategNeggoId: '',
    destCategPreventasId: '',
    discountOverride: '',
    markupNeggoOverride: '',
    markupPreventasOverride: '',
};

const PRICE_FORMAT_OPTS = [
    { value: 'ar', label: 'Argentino — 1.234,56' },
    { value: 'inv', label: 'Inverso — 1,234.56' },
];

export default function SupplierRules() {
    const { tokens: t } = useTheme();
    const { id } = useParams();
    const { showToast } = useToast();

    const [supplier, setSupplier] = useState(null);
    const [rules, setRules] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showAll, setShowAll] = useState(false);
    const [modal, setModal] = useState(null);
    const [deleting, setDeleting] = useState(null);
    const [deletingAllProducts, setDeletingAllProducts] = useState(false);
    const [saving, setSaving] = useState(false);
    const [form, setForm] = useState(EMPTY_FORM);
    const [previewCost, setPreviewCost] = useState('');
    const [unmapped, setUnmapped] = useState([]);
    // Categorías sin regla tildadas para crearles la regla de una sola vez
    const [seleccion, setSeleccion] = useState([]);
    const [scrapingCategories, setScrapingCategories] = useState([]);
    const [odooCategsNeggo, setOdooCategsNeggo] = useState([]);
    const [odooCategsPreventas, setOdooCategsPreventas] = useState([]);
    const [loadingOdooCategs, setLoadingOdooCategs] = useState(false);

    const [editingConfig, setEditingConfig] = useState(false);
    const [savingConfig, setSavingConfig] = useState(false);
    const [cfgPrefix, setCfgPrefix] = useState('');
    const [cfgPriceFormat, setCfgPriceFormat] = useState('ar');
    const [cfgDiscount, setCfgDiscount] = useState('');
    const [cfgMarkupNeggo, setCfgMarkupNeggo] = useState('');
    const [cfgMarkupPreventas, setCfgMarkupPreventas] = useState('');

    useEffect(() => {
        api.get(`/suppliers/${id}`).then(r => {
            if (r.success) {
                setSupplier(r.data);
                setCfgPrefix(r.data.prefix || '');
                setCfgPriceFormat(r.data.price_format || 'ar');
                setCfgDiscount(r.data.default_discount !== null ? String(r.data.default_discount) : '0');
                setCfgMarkupNeggo(r.data.markup_neggo !== null ? String(r.data.markup_neggo) : '0');
                setCfgMarkupPreventas(r.data.markup_preventas !== null ? String(r.data.markup_preventas) : '0');
            }
        });
        fetchRules(); fetchUnmapped(); fetchScrapingCategories(); fetchOdooCategories();
    }, [id]);

    useEffect(() => { fetchRules(); }, [showAll]);

    async function fetchScrapingCategories() {
        const res = await api.get(`/suppliers/${id}/scraping-categories`);
        if (res.success) setScrapingCategories(res.data || []);
    }

    async function fetchOdooCategories() {
        setLoadingOdooCategs(true);
        try {
            const [neggo, preventas] = await Promise.all([
                api.get('/suppliers/odoo-categories?company=neggo'),
                api.get('/suppliers/odoo-categories?company=preventas'),
            ]);
            if (neggo.success) setOdooCategsNeggo(neggo.data || []);
            if (preventas.success) setOdooCategsPreventas(preventas.data || []);
        } catch (_) {}
        finally { setLoadingOdooCategs(false); }
    }

    async function fetchUnmapped() {
        const res = await api.get(`/suppliers/${id}/unmapped-categories`);
        if (res.success) {
            const lista = res.data || [];
            setUnmapped(lista);
            // Si alguna tildada ya tiene regla, se destilda sola
            setSeleccion(prev => prev.filter(c => lista.some(u => u.source_category === c)));
        }
    }

    function toggleSeleccion(cat) {
        setSeleccion(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]);
    }
    const todasTildadas = unmapped.length > 0 && seleccion.length === unmapped.length;
    function toggleTodas() {
        setSeleccion(todasTildadas ? [] : unmapped.map(u => u.source_category));
    }

    async function fetchRules() {
        setLoading(true);
        const res = await api.get(`/suppliers/${id}/rules`, { active: showAll ? 'false' : undefined });
        if (res.success) setRules(res.data || []);
        else showToast(res.error || 'Error al cargar reglas', 'error');
        setLoading(false);
    }

    function resetForm(partial = {}) { setForm({ ...EMPTY_FORM, ...partial }); setPreviewCost(''); }
    function openNew() { resetForm(); setModal('new'); }
    function openNewFromUnmapped(cat) { resetForm({ sourceCategory: cat }); setModal('new'); }
    function openBulk() { resetForm(); setModal('bulk'); }
    function openEdit(rule) {
        resetForm({
            sourceCategory:          rule.source_category || '',
            destCategNeggoId:        rule.odoo_categ_id_neggo ? String(rule.odoo_categ_id_neggo) : '',
            destCategPreventasId:    rule.odoo_categ_id_preventas ? String(rule.odoo_categ_id_preventas) : '',
            discountOverride:        rule.discount_override != null ? String(rule.discount_override) : '',
            markupNeggoOverride:     rule.markup_neggo_override != null ? String(rule.markup_neggo_override) : '',
            markupPreventasOverride: rule.markup_preventas_override != null ? String(rule.markup_preventas_override) : '',
        });
        setModal(rule);
    }

    function setField(field, value) { setForm(prev => ({ ...prev, [field]: value })); }

    function categName(categs, idStr) {
        if (!idStr) return null;
        const found = categs.find(c => String(c.id) === String(idStr));
        return found?.complete_name || found?.name || null;
    }

    async function handleSave() {
        const esLote = modal === 'bulk';
        if (esLote && seleccion.length === 0) return showToast('No hay categorías tildadas', 'warning');
        if (!esLote && !form.sourceCategory.trim()) return showToast('La categoría origen es obligatoria', 'warning');
        setSaving(true);
        const body = {
            source_category:           form.sourceCategory.trim(),
            dest_category_neggo:       categName(odooCategsNeggo, form.destCategNeggoId) || null,
            dest_category_preventas:   categName(odooCategsPreventas, form.destCategPreventasId) || null,
            odoo_categ_id_neggo:       form.destCategNeggoId ? parseInt(form.destCategNeggoId) : null,
            odoo_categ_id_preventas:   form.destCategPreventasId ? parseInt(form.destCategPreventasId) : null,
            discount_override:         form.discountOverride !== '' ? parseFloat(form.discountOverride) : null,
            markup_neggo_override:     form.markupNeggoOverride !== '' ? parseFloat(form.markupNeggoOverride) : null,
            markup_preventas_override: form.markupPreventasOverride !== '' ? parseFloat(form.markupPreventasOverride) : null,
        };
        if (esLote) return guardarLote(body);
        const res = modal === 'new'
            ? await api.post(`/suppliers/${id}/rules`, body)
            : await api.put(`/suppliers/${id}/rules/${modal.id}`, body);
        setSaving(false);
        if (res.success) { showToast(modal === 'new' ? 'Regla creada' : 'Regla actualizada', 'success'); setModal(null); fetchRules(); fetchUnmapped(); }
        else showToast(res.error || 'Error al guardar', 'error');
    }

    // Crea una regla por cada categoría tildada, con los mismos destinos y overrides
    async function guardarLote(body) {
        const fallidas = [];
        let creadas = 0;
        for (const cat of seleccion) {
            const res = await api.post(`/suppliers/${id}/rules`, { ...body, source_category: cat });
            if (res.success) creadas++;
            else fallidas.push(`${cat}: ${res.error || 'error'}`);
        }
        setSaving(false);
        if (fallidas.length === 0) {
            showToast(`${creadas} regla${creadas !== 1 ? 's' : ''} creada${creadas !== 1 ? 's' : ''}`, 'success');
            setModal(null);
        } else {
            showToast(`Se crearon ${creadas}; fallaron ${fallidas.length} — ${fallidas.join(' · ')}`, 'error');
            if (creadas > 0) setModal(null);
        }
        fetchRules(); fetchUnmapped();
    }

    async function handleSaveConfig() {
        setSavingConfig(true);
        const res = await api.put(`/suppliers/${id}`, {
            prefix: cfgPrefix.trim(), price_format: cfgPriceFormat,
            default_discount: parseFloat(cfgDiscount) || 0,
            markup_neggo: parseFloat(cfgMarkupNeggo) || 0,
            markup_preventas: parseFloat(cfgMarkupPreventas) || 0,
        });
        setSavingConfig(false);
        if (res.success) { showToast('Configuración actualizada', 'success'); setSupplier(res.data); setEditingConfig(false); }
        else showToast(res.error || 'Error al guardar', 'error');
    }

    async function handleDelete() {
        const res = await api.del(`/suppliers/${id}/rules/${deleting.id}`);
        setDeleting(null);
        if (res.success) { showToast('Regla eliminada', 'success'); fetchRules(); }
        else showToast(res.error || 'Error al eliminar', 'error');
    }

    async function handleDeleteAllProducts() {
        const res = await api.del(`/suppliers/${id}/products`);
        setDeletingAllProducts(false);
        if (res.success) showToast(`${res.data.deleted} productos eliminados`, 'success');
        else showToast(res.error || 'Error al eliminar productos', 'error');
    }

    // Cálculo de preview (solo frontend)
    const defDiscount = supplier?.default_discount ?? 0;
    const defMarkupN  = supplier?.markup_neggo ?? 0;
    const defMarkupP  = supplier?.markup_preventas ?? 0;
    const actDiscount = form.discountOverride !== '' ? parseFloat(form.discountOverride) : defDiscount;
    const actMarkupN  = form.markupNeggoOverride !== '' ? parseFloat(form.markupNeggoOverride) : defMarkupN;
    const actMarkupP  = form.markupPreventasOverride !== '' ? parseFloat(form.markupPreventasOverride) : defMarkupP;
    const lista = parseFloat(previewCost) || 0;
    const costo = lista * (1 - actDiscount / 100);
    const precioN = lista * (1 + actMarkupN / 100);
    const precioP = lista * (1 + actMarkupP / 100);

    function renderCategCell(row, company) {
        const idField = company === 'neggo' ? 'odoo_categ_id_neggo' : 'odoo_categ_id_preventas';
        const nameField = company === 'neggo' ? 'dest_category_neggo' : 'dest_category_preventas';
        const name = row[nameField];
        if (!name) return <span style={{ color: t.color.textFaint }}>—</span>;
        return (
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {row[idField] && <Badge tone="primary" style={{ fontSize: 10, padding: '0 5px' }}>Odoo</Badge>}
                <span style={{ fontSize: t.font.size.sm, color: t.color.text, fontFamily: t.font.family }}>{name}</span>
            </span>
        );
    }

    const scrapCatDatalistId = `scraping-cats-${id}`;

    const cols = [
        { key: 'source_category', label: 'Categoría origen' },
        { key: 'dest_category_neggo',     label: 'Destino Neggo',     render: (_, row) => renderCategCell(row, 'neggo') },
        { key: 'dest_category_preventas', label: 'Destino Preventas', render: (_, row) => renderCategCell(row, 'preventas') },
        { key: 'discount_override',         label: 'Descuento',      render: v => v != null ? <span style={t.numericStyle}>{v}%</span> : <span style={{ color: t.color.textFaint }}>Def. ({defDiscount}%)</span> },
        { key: 'markup_neggo_override',     label: 'Markup N',       render: v => v != null ? <span style={t.numericStyle}>{v}%</span> : <span style={{ color: t.color.textFaint }}>Def. ({defMarkupN}%)</span> },
        { key: 'markup_preventas_override', label: 'Markup P',       render: v => v != null ? <span style={t.numericStyle}>{v}%</span> : <span style={{ color: t.color.textFaint }}>Def. ({defMarkupP}%)</span> },
        { key: 'active', label: 'Activa', render: v => <Badge tone={v ? 'success' : 'muted'} dot>{v ? 'Sí' : 'No'}</Badge> },
        { key: 'id', label: '', render: (_, row) => (
            <div style={{ display: 'flex', gap: t.space[2] }}>
                <Button size="sm" variant="ghost" onClick={e => { e.stopPropagation(); openEdit(row); }}>Editar</Button>
                <Button size="sm" variant="danger" onClick={e => { e.stopPropagation(); setDeleting(row); }}>Eliminar</Button>
            </div>
        )},
    ];

    const labelStyle = { display: 'block', fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.textMuted, marginBottom: t.space[1], fontFamily: t.font.family };
    const nativeSelectStyle = { width: '100%', padding: '8px 12px', border: `1px solid ${t.color.borderStrong}`, borderRadius: t.radius.sm, fontSize: t.font.size.base, fontFamily: t.font.family, color: t.color.text, background: t.color.surface, boxSizing: 'border-box', height: t.layout.inputHeight };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>

            {/* Config del proveedor */}
            {supplier && (
                <Card padding={false} style={{ padding: `${t.space[5]}px ${t.layout.cardPadX}px` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: t.space[5] }}>
                        <div style={{ display: 'flex', gap: t.space[8], flexWrap: 'wrap' }}>
                            {[
                                ['Prefijo', supplier.prefix || '—'],
                                ['Formato precio', supplier.price_format === 'ar' ? 'Argentino' : 'Inverso'],
                                ['Descuento', `${defDiscount}%`],
                                ['Markup Neggo', `${defMarkupN}%`],
                                ['Markup Prev.', `${defMarkupP}%`],
                                ['Scraper', supplier.scraper_key || '—'],
                            ].map(([k, v]) => (
                                <div key={k}>
                                    <div style={{ fontSize: 11, color: t.color.textFaint, fontWeight: t.font.weight.semibold, marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.04em', fontFamily: t.font.family }}>{k}</div>
                                    <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.text, fontFamily: t.font.family }}>{v}</div>
                                </div>
                            ))}
                        </div>
                        <div style={{ display: 'flex', gap: t.space[2] }}>
                            <Button size="sm" variant="secondary" leftIcon={<Icon.Settings size={13} />} onClick={() => setEditingConfig(true)}>
                                Editar config
                            </Button>
                            <Button size="sm" variant="danger" onClick={() => setDeletingAllProducts(true)}>
                                Borrar productos
                            </Button>
                        </div>
                    </div>
                </Card>
            )}

            {/* Categorías sin mapear */}
            {unmapped.length > 0 && (
                <div style={{ background: t.color.warnSoft, border: `1px solid ${t.color.warn}44`, borderRadius: t.radius.md, padding: `14px ${t.space[6]}px` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: t.space[2], marginBottom: t.space[4], flexWrap: 'wrap' }}>
                        <Icon.Bell size={16} color={t.color.warn} />
                        <span style={{ fontWeight: t.font.weight.semibold, color: t.color.warn, fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                            {unmapped.length} categoría{unmapped.length > 1 ? 's' : ''} sin regla — los productos no aparecen en catálogos
                        </span>
                        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: t.space[3] }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: t.space[1], fontSize: t.font.size.sm, color: t.color.textMuted, cursor: 'pointer', fontFamily: t.font.family }}>
                                <input type="checkbox" checked={todasTildadas} onChange={toggleTodas} style={{ accentColor: t.color.accent, cursor: 'pointer' }} />
                                Tildar todas
                            </label>
                            <Button size="sm" variant="accent" disabled={seleccion.length === 0} onClick={openBulk}>
                                {seleccion.length > 0 ? `Crear regla para ${seleccion.length}` : 'Tildá para crear varias'}
                            </Button>
                        </div>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: t.space[2] }}>
                        {unmapped.map(u => {
                            const tildada = seleccion.includes(u.source_category);
                            return (
                            <div key={u.source_category} style={{
                                display: 'flex', alignItems: 'center', gap: t.space[2],
                                background: tildada ? t.color.accentSoft : t.color.surface,
                                border: `1px solid ${tildada ? t.color.accent : t.color.warn + '66'}`,
                                borderRadius: t.radius.sm, padding: `${t.space[1]}px ${t.space[3]}px`,
                            }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: t.space[2], cursor: 'pointer' }}>
                                    <input type="checkbox" checked={tildada} onChange={() => toggleSeleccion(u.source_category)} style={{ accentColor: t.color.accent, cursor: 'pointer' }} />
                                    <span style={{ fontSize: t.font.size.sm, color: t.color.text, fontFamily: t.font.family }}>{u.source_category}</span>
                                </label>
                                <Badge tone="warn">{u.product_count} prod.</Badge>
                                <Button size="sm" variant="accent" onClick={() => openNewFromUnmapped(u.source_category)}>
                                    + Regla
                                </Button>
                            </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Cabecera tabla de reglas */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: t.space[2], fontSize: t.font.size.sm, color: t.color.textMuted, cursor: 'pointer', fontFamily: t.font.family }}>
                    <Toggle checked={showAll} onChange={setShowAll} size="sm" />
                    Ver inactivas también
                </label>
                <Button variant="primary" leftIcon={<Icon.Link size={14} />} onClick={openNew}>
                    Nueva regla
                </Button>
            </div>

            <DataTable columns={cols} data={rules} loading={loading} />

            {/* Modal editar config */}
            <Modal
                isOpen={editingConfig}
                onClose={() => setEditingConfig(false)}
                title={`Configurar ${supplier?.name}`}
                size="lg"
                footer={
                    <>
                        <Button variant="ghost" onClick={() => setEditingConfig(false)}>Cancelar</Button>
                        <Button variant="primary" disabled={savingConfig} onClick={handleSaveConfig}>
                            {savingConfig ? 'Guardando…' : 'Guardar'}
                        </Button>
                    </>
                }
            >
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: t.space[6] }}>
                    <div>
                        <label style={labelStyle}>Prefijo de código</label>
                        <Input value={cfgPrefix} onChange={e => setCfgPrefix(e.target.value)} placeholder="Ej: CAST" />
                    </div>
                    <div>
                        <label style={labelStyle}>Formato de precio</label>
                        <Select value={cfgPriceFormat} onChange={setCfgPriceFormat} options={PRICE_FORMAT_OPTS} />
                    </div>
                    <div>
                        <label style={labelStyle}>Descuento default (%)</label>
                        <Input type="number" value={cfgDiscount} onChange={e => setCfgDiscount(e.target.value)} min="0" max="100" placeholder="0" />
                    </div>
                    <div>
                        <label style={labelStyle}>Markup Neggo (%)</label>
                        <Input type="number" value={cfgMarkupNeggo} onChange={e => setCfgMarkupNeggo(e.target.value)} min="0" placeholder="0" />
                    </div>
                    <div>
                        <label style={labelStyle}>Markup Preventas (%)</label>
                        <Input type="number" value={cfgMarkupPreventas} onChange={e => setCfgMarkupPreventas(e.target.value)} min="0" placeholder="0" />
                    </div>
                </div>
            </Modal>

            {/* Modal crear/editar regla */}
            <Modal
                isOpen={!!modal}
                onClose={() => setModal(null)}
                title={modal === 'bulk' ? `Nueva regla para ${seleccion.length} categorías` : modal === 'new' ? 'Nueva regla' : 'Editar regla'}
                size="lg"
                footer={
                    <>
                        <Button variant="ghost" onClick={() => setModal(null)}>Cancelar</Button>
                        <Button variant="primary" disabled={saving} onClick={handleSave}>
                            {saving ? 'Guardando…' : 'Guardar'}
                        </Button>
                    </>
                }
            >
                {/* datalist nativo para autocompletado de categorías del scraper */}
                <datalist id={scrapCatDatalistId}>
                    {scrapingCategories.map(c => (
                        <option key={c.source_category} value={c.source_category}>
                            {c.source_category} ({c.product_count} prod.)
                        </option>
                    ))}
                </datalist>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: t.space[6] }}>

                    {modal === 'bulk' ? (
                    <div style={{ gridColumn: '1 / -1' }}>
                        <label style={labelStyle}>Categorías origen ({seleccion.length})</label>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: t.space[2], maxHeight: 140, overflowY: 'auto' }}>
                            {seleccion.map(c => <Badge key={c} tone="muted">{c}</Badge>)}
                        </div>
                        <div style={{ marginTop: t.space[2], fontSize: t.font.size.xs, color: t.color.textFaint, fontFamily: t.font.family }}>
                            Se crea una regla por cada una, con las categorías de Odoo y los porcentajes que elijas abajo.
                        </div>
                    </div>
                    ) : (
                    <div style={{ gridColumn: '1 / -1' }}>
                        <label style={labelStyle}>
                            Categoría origen *
                            {scrapingCategories.length > 0 && (
                                <span style={{ fontWeight: t.font.weight.regular, marginLeft: t.space[2], fontSize: t.font.size.xs, color: t.color.textFaint }}>
                                    ({scrapingCategories.length} disponibles)
                                </span>
                            )}
                        </label>
                        <Input
                            value={form.sourceCategory}
                            onChange={e => setField('sourceCategory', e.target.value)}
                            list={scrapCatDatalistId}
                            placeholder="Seleccioná o escribí una categoría"
                        />
                    </div>
                    )}

                    <div>
                        <label style={labelStyle}>
                            Cat. Odoo — Neggo
                            {loadingOdooCategs && <span style={{ fontWeight: 400, marginLeft: 6, color: t.color.textFaint }}> cargando…</span>}
                        </label>
                        <select
                            value={form.destCategNeggoId}
                            onChange={e => setField('destCategNeggoId', e.target.value)}
                            style={nativeSelectStyle}
                        >
                            <option value="">— Sin categoría —</option>
                            {odooCategsNeggo.map(c => <option key={c.id} value={c.id}>{c.complete_name || c.name}</option>)}
                        </select>
                        {odooCategsNeggo.length === 0 && !loadingOdooCategs && (
                            <div style={{ marginTop: 4, fontSize: t.font.size.xs, color: t.color.textFaint, fontFamily: t.font.family }}>Odoo no disponible</div>
                        )}
                    </div>

                    <div>
                        <label style={labelStyle}>
                            Cat. Odoo — Preventas
                            {loadingOdooCategs && <span style={{ fontWeight: 400, marginLeft: 6, color: t.color.textFaint }}> cargando…</span>}
                        </label>
                        <select
                            value={form.destCategPreventasId}
                            onChange={e => setField('destCategPreventasId', e.target.value)}
                            style={nativeSelectStyle}
                        >
                            <option value="">— Sin categoría —</option>
                            {odooCategsPreventas.map(c => <option key={c.id} value={c.id}>{c.complete_name || c.name}</option>)}
                        </select>
                        {odooCategsPreventas.length === 0 && !loadingOdooCategs && (
                            <div style={{ marginTop: 4, fontSize: t.font.size.xs, color: t.color.textFaint, fontFamily: t.font.family }}>Odoo no disponible</div>
                        )}
                    </div>

                    <div>
                        <label style={labelStyle}>Descuento override (%)</label>
                        <Input type="number" value={form.discountOverride} onChange={e => setField('discountOverride', e.target.value)} placeholder={`Default: ${defDiscount}%`} min="-100" max="100" />
                    </div>
                    <div>
                        <label style={labelStyle}>Markup Neggo override (%)</label>
                        <Input type="number" value={form.markupNeggoOverride} onChange={e => setField('markupNeggoOverride', e.target.value)} placeholder={`Default: ${defMarkupN}%`} min="0" />
                    </div>
                    <div>
                        <label style={labelStyle}>Markup Preventas override (%)</label>
                        <Input type="number" value={form.markupPreventasOverride} onChange={e => setField('markupPreventasOverride', e.target.value)} placeholder={`Default: ${defMarkupP}%`} min="0" />
                    </div>
                </div>

                {/* Vista previa de precio */}
                <div style={{ background: t.color.primarySoft, border: `1px solid ${t.color.primary}22`, borderRadius: t.radius.sm, padding: t.space[5], marginTop: t.space[5] }}>
                    <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.primary, marginBottom: t.space[3], fontFamily: t.font.family }}>
                        Vista previa de precio
                    </div>
                    <div style={{ display: 'flex', gap: t.space[6], alignItems: 'center', flexWrap: 'wrap' }}>
                        <div>
                            <label style={{ ...labelStyle, marginBottom: t.space[1] }}>Precio lista</label>
                            <Input type="number" value={previewCost} onChange={e => setPreviewCost(e.target.value)} placeholder="Ej: 1000" style={{ width: 120 }} />
                        </div>
                        {lista > 0 && (
                            <div style={{ display: 'flex', gap: t.space[8], alignItems: 'center', flexWrap: 'wrap' }}>
                                <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                                    Costo (desc. {actDiscount}%) → <span style={{ fontWeight: t.font.weight.semibold, color: t.color.text }}>{fmtAR(costo)}</span>
                                </div>
                                <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.primary, fontFamily: t.font.family, ...t.numericStyle }}>
                                    Neggo: {fmtAR(precioN)}
                                </div>
                                <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.accent, fontFamily: t.font.family, ...t.numericStyle }}>
                                    Preventas: {fmtAR(precioP)}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </Modal>

            <ConfirmDialog isOpen={!!deleting} onClose={() => setDeleting(null)} onConfirm={handleDelete} title="Eliminar regla" message={`¿Eliminás la regla para "${deleting?.source_category}"? No se puede deshacer.`} confirmLabel="Eliminar" danger />
            <ConfirmDialog isOpen={deletingAllProducts} onClose={() => setDeletingAllProducts(false)} onConfirm={handleDeleteAllProducts} title="Borrar todos los productos" message={`¿Eliminás TODOS los productos scrapeados de "${supplier?.name}"? Esto borra historial de precios y vínculos con Odoo. No se puede deshacer.`} confirmLabel="Sí, borrar todo" danger />
        </div>
    );
}
