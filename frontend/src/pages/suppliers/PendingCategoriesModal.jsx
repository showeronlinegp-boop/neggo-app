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
// Claude revisa tandas con scripts/categoriasClaude.js (nota 131): su propuesta llega precargada
// en los selectores; nada se guarda hasta tocar Asignar.
// Vista "Frenan Preventas" (nota 200): solo las categorías con productos para crear, activar o
// publicar en Sync Preventas que no tienen categoría de Preventas, con un pre-matching precargado.

const TONO_CONFIANZA = { alta: 'success', media: 'primary', baja: 'warn' };

const MODOS = {
    todas:     { url: '/suppliers/pending-categories', subtitulo: 'Sin regla, los productos de estas categorías no entran en el ingreso ni en los catálogos.' },
    preventas: { url: '/suppliers/pending-categories/preventas', subtitulo: 'Sin categoría de Preventas, Sync Preventas no crea, activa ni publica estos productos, ni completa la de los que ya están en Odoo.' },
};

// Pre-matching de la categoría de Preventas (solo en la vista "Frenan Preventas")
function preMatchDe(row) {
    if (!row.pre_categ_preventas) return null;
    const enOdoo = row.pre_origen === 'odoo';
    return {
        preventas: row.pre_categ_preventas,
        nombre: row.pre_nombre,
        // Confiable: la mitad o más de lo que ya está en Odoo de esa categoría tiene la misma
        confiable: enOdoo && row.pre_total > 0 && row.pre_votos / row.pre_total >= 0.5,
        texto: enOdoo
            ? `${row.pre_votos} de ${row.pre_total} ya en Odoo están en "${row.pre_nombre}"`
            : `Otros proveedores usan "${row.pre_nombre}" para esta categoría`,
    };
}

// Propuesta de Claude de una fila, o null si todavía no la revisó
function propuestaDe(row) {
    if (!row.sug_revisada) return null;
    if (!row.sug_categ_neggo && !row.sug_categ_preventas) return { sinPropuesta: true, motivo: row.sug_motivo };
    return {
        neggo: row.sug_categ_neggo, preventas: row.sug_categ_preventas,
        confianza: row.sug_confianza, motivo: row.sug_motivo,
    };
}

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
    const [asignandoLote, setAsignandoLote] = useState(null); // { hechas, total } mientras asigna en lote
    const [modo, setModo] = useState('todas');
    const enPreventas = modo === 'preventas';

    useEffect(() => {
        if (!isOpen) return;
        setSupplierFilter(initialSupplierId ? String(initialSupplierId) : '');
        setChoices({});
        loadPending(modo);
        if (categsNeggo.length === 0) loadOdooCategories();
    }, [isOpen, initialSupplierId]);

    function cambiarModo(nuevo) {
        if (nuevo === modo) return;
        setModo(nuevo);
        setPending([]);
        loadPending(nuevo);
    }

    async function loadPending(modoActual = modo) {
        setLoading(true);
        const res = await api.get(MODOS[modoActual].url);
        setLoading(false);
        if (!res.success) return showToast(res.error || 'Error al cargar categorías pendientes', 'error');
        const rows = res.data || [];
        setPending(rows);
        // Precargar los selectores con la propuesta de Claude; en "Frenan Preventas" también con la
        // categoría de Neggo que ya tiene la regla y, si Claude no propuso, el pre-matching
        const iniciales = {};
        for (const row of rows) {
            const p = propuestaDe(row);
            const conClaude = p && !p.sinPropuesta;
            const pre = modoActual === 'preventas' ? preMatchDe(row) : null;
            const neggo = row.regla_categ_neggo || (conClaude ? p.neggo : null);
            const preventas = (conClaude ? p.preventas : null) || pre?.preventas;
            if (neggo || preventas) {
                iniciales[keyOf(row)] = {
                    neggo: neggo ? String(neggo) : '',
                    preventas: preventas ? String(preventas) : '',
                };
            }
        }
        setChoices(iniciales);
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

    // Asigna de una las filas visibles con propuesta alta o media de Claude (con lo que haya en los selectores)
    async function asignarSugeridas() {
        const filas = filasParaLote;
        setAsignandoLote({ hechas: 0, total: filas.length });
        let ok = 0;
        for (const row of filas) {
            if (await resolve(row, false, true)) ok++;
            setAsignandoLote(prev => ({ ...prev, hechas: prev.hechas + 1 }));
        }
        setAsignandoLote(null);
        showToast(`Asigné ${ok} de ${filas.length} categorías`, ok === filas.length ? 'success' : 'warning');
    }

    async function resolve(row, ignored, silencioso = false) {
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
        // La categoría ya tenía regla (sin la de Preventas, o ignorada): se completa esa regla
        const res = row.regla_id
            ? await api.put(`/suppliers/${row.supplier_id}/rules/${row.regla_id}`, { ...body, ignored: !!ignored })
            : await api.post(`/suppliers/${row.supplier_id}/rules`, body);
        setSavingKey(null);
        if (!res.success) {
            showToast(`${row.source_category}: ${res.error || 'Error al guardar la regla'}`, 'error');
            return false;
        }
        setPending(prev => prev.filter(r => keyOf(r) !== k));
        if (!silencioso) showToast(ignored ? `"${row.source_category}" ignorada` : `Regla creada para "${row.source_category}"`, 'success');
        onChanged?.();
        return true;
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
    const revisadas = visible.filter(r => r.sug_revisada).length;
    // Para el lote: propuesta alta/media (o, en "Frenan Preventas", un pre-matching confiable) y
    // selectores con algo elegido
    const filasParaLote = visible.filter(r => {
        const p = propuestaDe(r);
        const c = choices[keyOf(r)] || {};
        if (enPreventas) {
            const claudeOk = p && !p.sinPropuesta && p.confianza !== 'baja';
            return !!c.preventas && (claudeOk || !!preMatchDe(r)?.confiable);
        }
        return p && !p.sinPropuesta && p.confianza !== 'baja' && (c.neggo || c.preventas);
    });
    const ocupado = !!asignandoLote;

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
            subtitle={MODOS[modo].subtitulo}
            size="xl"
        >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: t.space[3], marginBottom: t.space[5], flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: t.space[3], flexWrap: 'wrap' }}>
                    <div role="tablist" style={{ display: 'inline-flex', border: `1px solid ${t.color.border}`, borderRadius: t.radius.sm, overflow: 'hidden' }}>
                        {[['todas', 'Todas sin regla'], ['preventas', 'Frenan Preventas']].map(([k, label]) => (
                            <button
                                key={k} type="button" role="tab" aria-selected={modo === k}
                                disabled={loading || ocupado}
                                onClick={() => cambiarModo(k)}
                                style={{
                                    border: 'none', padding: '6px 12px', cursor: 'pointer',
                                    fontSize: t.font.size.sm, fontFamily: t.font.family,
                                    fontWeight: modo === k ? t.font.weight.semibold : t.font.weight.regular,
                                    background: modo === k ? t.color.primarySoft : t.color.surface,
                                    color: modo === k ? t.color.primary : t.color.textMuted,
                                }}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    <Select value={supplierFilter} onChange={setSupplierFilter} options={supplierOptions} style={{ minWidth: 260 }} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: t.space[2], flexWrap: 'wrap' }}>
                    {loadingCategs && (
                        <span style={{ fontSize: t.font.size.sm, color: t.color.textFaint, fontFamily: t.font.family }}>
                            Cargando categorías de Odoo…
                        </span>
                    )}
                    {!loading && visible.length > 0 && (
                        <span
                            title="Para que Claude revise más, pedile en la terminal una tanda de categorías (skill categorias-claude)"
                            style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family, ...t.numericStyle }}
                        >
                            Claude revisó {revisadas} de {visible.length}
                        </span>
                    )}
                    <Button
                        size="sm" variant="primary"
                        disabled={ocupado || filasParaLote.length === 0}
                        onClick={asignarSugeridas}
                        title={enPreventas
                            ? 'Asigna las de Claude con confianza alta o media y las del pre-matching confiable, tal como están en los selectores'
                            : 'Asigna las propuestas de confianza alta y media tal como están en los selectores'}
                    >
                        {asignandoLote
                            ? `Asignando ${asignandoLote.hechas}/${asignandoLote.total}…`
                            : `Asignar sugeridas (${filasParaLote.length})`}
                    </Button>
                </div>
            </div>

            {loading && <div style={{ padding: t.space[8], display: 'flex', justifyContent: 'center' }}><LoadingSpinner /></div>}

            {!loading && visible.length === 0 && (
                <div style={{ padding: `${t.space[8]}px 0`, textAlign: 'center', color: t.color.textMuted, fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                    {enPreventas ? 'Nada frenado: todo lo que hay para subir a Preventas tiene categoría.' : 'No hay categorías pendientes. Todo tiene regla.'}
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
                            const propuesta = propuestaDe(row);
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
                                                {enPreventas
                                                    ? [row.para_crear > 0 && `${row.para_crear} para crear`, row.para_publicar > 0 && `${row.para_publicar} en Odoo sin categoría`].filter(Boolean).join(' · ')
                                                    : `${row.product_count} prod.`}
                                            </span>
                                            {row.regla_ignorada && <Badge tone="muted">Ignorada</Badge>}
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
                                        {enPreventas && preMatchDe(row) && (
                                            <div style={{ display: 'flex', alignItems: 'center', gap: t.space[2], marginTop: 4, minWidth: 0 }}>
                                                <Badge tone={preMatchDe(row).confiable ? 'success' : 'primary'}>Pre-matching</Badge>
                                                <span title={preMatchDe(row).texto} style={{
                                                    fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family,
                                                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...t.numericStyle,
                                                }}>
                                                    {preMatchDe(row).texto}
                                                </span>
                                            </div>
                                        )}
                                        {propuesta && (
                                            <div style={{ display: 'flex', alignItems: 'center', gap: t.space[2], marginTop: 4, minWidth: 0 }}>
                                                <Badge tone={propuesta.sinPropuesta ? 'muted' : TONO_CONFIANZA[propuesta.confianza]}>
                                                    {propuesta.sinPropuesta ? 'Claude: sin categoría' : `Claude · ${propuesta.confianza}`}
                                                </Badge>
                                                {propuesta.motivo && (
                                                    <span title={propuesta.motivo} style={{
                                                        fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family,
                                                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                                    }}>
                                                        {propuesta.motivo}
                                                    </span>
                                                )}
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
                                        {/* Ignorar no destraba nada en Preventas: ahí solo se asigna */}
                                        {!enPreventas && (
                                            <Button size="sm" variant="ghost" disabled={saving} onClick={() => resolve(row, true)}>
                                                Ignorar
                                            </Button>
                                        )}
                                        <Button
                                            size="sm" variant="primary"
                                            disabled={saving || (enPreventas ? !choice.preventas : (!choice.neggo && !choice.preventas))}
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
