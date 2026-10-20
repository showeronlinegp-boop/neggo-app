import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { useTheme } from '../../theme/ThemeContext';
import DataTable from '../../components/common/DataTable';
import Modal from '../../components/common/Modal';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Select from '../../components/common/Select';
import ProductThumb from '../../components/common/ProductThumb';
import * as Icon from '../../components/common/icons';

// ─── Colores semánticos del sync (NO del sistema de diseño) ────────────────────
// Estos colores representan estados de la operación de sync y se mantienen
// independientes del tema para garantizar consistencia visual en la herramienta.
const ESTADOS = [
    { key: 'todos',         label: 'Todos',           color: '#666',    bg: '#f5f5f5' },
    { key: 'activar',       label: 'Activar',         color: '#0c5460', bg: '#d1ecf1' },
    { key: 'precio_sube',   label: 'Precio sube',     color: '#856404', bg: '#fff3cd' },
    { key: 'precio_baja',   label: 'Precio baja',     color: '#004085', bg: '#cce5ff' },
    { key: 'inactivar',     label: 'Inactivar',       color: '#856404', bg: '#fff3cd' },
    { key: 'solo_scraper',  label: 'Crear en Odoo',   color: '#155724', bg: '#d4edda' },
    { key: 'solo_odoo',     label: 'Solo en Odoo',    color: '#721c24', bg: '#f8d7da' },
    { key: 'sin_cambios',   label: 'Sin cambios',     color: '#999',    bg: '#eee'    },
    { key: 'sin_fuente',    label: 'Sin fuente',      color: '#555',    bg: '#eee'    },
];

const BADGE = Object.fromEntries(ESTADOS.filter(e => e.key !== 'todos').map(e => [e.key, e]));

const MATCH_TYPES = [
    { key: 'todos',        label: 'Todos los matches', color: '#555',    bg: '#f0f0f0' },
    { key: 'exact_sku',    label: 'SKU exacto',        color: '#004085', bg: '#cce5ff' },
    { key: 'barcode',      label: 'Código de barras',  color: '#155724', bg: '#d4edda' },
    { key: 'internal_ref', label: 'Ref. interna',      color: '#6f42c1', bg: '#e8d5ff' },
    { key: 'bracket_code', label: 'Código en nombre',  color: '#0d6efd', bg: '#dce9ff' },
    { key: 'name_key',     label: 'Nombre norm.',      color: '#856404', bg: '#fff3cd' },
    { key: 'fuzzy_name',   label: 'Fuzzy',             color: '#721c24', bg: '#f8d7da' },
    { key: 'sin_match',    label: 'Sin match',         color: '#666',    bg: '#eee'    },
];

const MATCH_BADGE = Object.fromEntries(
    MATCH_TYPES.filter(m => m.key !== 'todos').map(m => [m.key, { label: m.label.split(' ')[0], color: m.color, bg: m.bg }])
);

const ACCION_LABEL = {
    solo_scraper: 'Crear', activar: 'Activar', inactivar: 'Inactivar',
    precio_sube: 'Actualizar precio', precio_baja: 'Actualizar precio',
    solo_odoo: 'Inactivar en Odoo', sin_cambios: null,
};

const fmt = v => v != null ? `$${Number(v).toLocaleString('es-AR', { maximumFractionDigits: 2 })}` : '—';
const diffPct = (a, b) => {
    if (a == null || b == null || Number(b) === 0) return null;
    return (((Number(a) - Number(b)) / Number(b)) * 100).toFixed(1);
};
const timeAgo = ts => {
    if (!ts) return null;
    const mins = Math.floor((Date.now() - new Date(ts)) / 60000);
    if (mins < 1)  return 'hace unos segundos';
    if (mins < 60) return `hace ${mins} min`;
    const hrs = Math.floor(mins / 60);
    return `hace ${hrs}h`;
};

const PAGE_SIZE = 100;

// Texto del resultado de un apply: ok, errores y omitidos por las protecciones
const resumenApply = r => [
    `${r.ok} ok`,
    r.error > 0 ? `${r.error} errores` : null,
    r.omitidos > 0 ? `${r.omitidos} omitidos (revisalos uno por uno)` : null,
].filter(Boolean).join(', ');

// ─── Bloque de comparación ─────────────────────────────────────────────────────
function ComparisonBlock({ resumen, grupo, sinVendor, onFilter, onFilterVendor, tokens: t }) {
    const fmtN = n => (n || 0).toLocaleString('es-AR');

    const row = (label, value, filterGrupo, colorScheme = 'normal') => {
        const isClickable = !!filterGrupo;
        const isActive = isClickable && grupo === filterGrupo;
        const colors = {
            normal:  { lc: t.color.text,    vc: t.color.primary },
            warning: { lc: '#856404', vc: '#856404' },
            danger:  { lc: '#721c24', vc: '#721c24' },
            success: { lc: '#155724', vc: '#155724' },
        };
        const { lc, vc } = colors[colorScheme];
        return (
            <div key={label} onClick={isClickable ? () => onFilter(filterGrupo) : undefined} title={isClickable ? `Filtrar por: ${label}` : undefined} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '5px 8px', borderRadius: t.radius.sm,
                cursor: isClickable ? 'pointer' : 'default',
                background: isActive ? t.color.primarySoft : 'transparent',
                marginBottom: 2,
            }}>
                <span style={{ fontSize: 13, color: lc, display: 'flex', alignItems: 'center', gap: 4, fontFamily: t.font.family }}>
                    {label}
                    {isClickable && <Icon.ChevronRight size={10} color={t.color.textFaint} />}
                </span>
                <span style={{ fontSize: 14, fontWeight: 700, color: vc, ...t.numericStyle }}>{fmtN(value)}</span>
            </div>
        );
    };

    const divider = () => <div style={{ borderTop: `1px solid ${t.color.border}`, margin: '8px 0' }} />;
    const sectionLabel = label => (
        <div style={{ fontSize: 10, fontWeight: t.font.weight.semibold, color: t.color.textFaint, letterSpacing: 1, marginBottom: 6, marginTop: 4, textTransform: 'uppercase', fontFamily: t.font.family }}>
            {label}
        </div>
    );
    const totalRow = (label, value, color) => (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 8 }}>
            <span style={{ fontSize: 12, color: t.color.textMuted, fontWeight: t.font.weight.semibold, fontFamily: t.font.family }}>{label}</span>
            <span style={{ fontSize: 18, fontWeight: 700, color, ...t.numericStyle }}>{fmtN(value)}</span>
        </div>
    );

    return (
        <div style={{
            background: t.color.surface, border: `1px solid ${t.color.border}`, borderRadius: t.radius.md,
            padding: t.space[5], marginBottom: t.space[5],
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0,
        }}>
            <div style={{ paddingRight: t.space[6], borderRight: `1px solid ${t.color.border}` }}>
                {sectionLabel('Odoo Preventas')}
                <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap', marginBottom: t.space[4] }}>
                    <span style={{ fontSize: 11, color: '#155724', background: '#d4edda', padding: '3px 10px', borderRadius: 10, fontWeight: 600 }}>Activos: {fmtN(resumen.odoo_activos)}</span>
                    <span style={{ fontSize: 11, color: '#856404', background: '#fff3cd', padding: '3px 10px', borderRadius: 10, fontWeight: 600 }}>Inactivos: {fmtN(resumen.odoo_inactivos)}</span>
                </div>
                {divider()}
                {sectionLabel('Matching Odoo')}
                {row('Matcheados',  resumen.odoo_matcheados, 'matcheados', 'success')}
                {row('Inactivos',   resumen.odoo_inactivos,  null,         'warning')}
                {row('Sin match',   resumen.solo_odoo,        'inactivar',  'danger')}
                {row('Sin fuente (no se tocan)', resumen.sin_fuente, 'sin_fuente', 'normal')}
                {divider()}
                {sectionLabel('Proveedores en Odoo')}
                <div onClick={onFilterVendor} title="Ver matcheados sin proveedor en Odoo" style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '5px 8px', borderRadius: t.radius.sm,
                    cursor: 'pointer',
                    background: sinVendor ? '#fff3cd' : 'transparent',
                    marginBottom: 2,
                }}>
                    <span style={{ fontSize: 13, color: '#856404', display: 'flex', alignItems: 'center', gap: 4, fontFamily: t.font.family }}>
                        Sin proveedor en Odoo
                        <Icon.ChevronRight size={10} color={t.color.textFaint} />
                    </span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: '#856404', ...t.numericStyle }}>{fmtN(resumen.sin_vendor)}</span>
                </div>
                {divider()}
                {totalRow('Total Odoo', resumen.odoo_total, '#6f42c1')}
            </div>
            <div style={{ paddingLeft: t.space[6] }}>
                {sectionLabel('Scraping')}
                <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap', marginBottom: t.space[4] }}>
                    <span style={{ fontSize: 11, color: '#155724', background: '#d4edda', padding: '3px 10px', borderRadius: 10, fontWeight: 600 }}>Disponibles: {fmtN(resumen.scraper_disponibles)}</span>
                    <span style={{ fontSize: 11, color: t.color.textMuted, background: t.color.surface2, padding: '3px 10px', borderRadius: 10, fontWeight: 600 }}>No disponibles: {fmtN(resumen.scraper_total - resumen.scraper_disponibles)}</span>
                </div>
                {divider()}
                {sectionLabel('Matching Scraping')}
                {row('Matcheados',      resumen.scraper_con_match, 'matcheados', 'success')}
                {row('A crear en Odoo', resumen.solo_scraper,     'nuevos',      'warning')}
                {divider()}
                {totalRow('Total Scraping', resumen.scraper_total, t.color.primary)}
            </div>
        </div>
    );
}

// ─── Componente principal ──────────────────────────────────────────────────────
export default function PreventasSyncPage() {
    const { tokens: t } = useTheme();
    const { showToast } = useToast();

    const [productos, setProductos] = useState([]);
    const [resumen, setResumen] = useState({});
    const [loading, setLoading] = useState(true);
    const [applying, setApplying] = useState(false);
    const [bgApplying, setBgApplying] = useState(false);
    const [recomputing, setRecomputing] = useState(false);
    const [bgRecomputing, setBgRecomputing] = useState(false);
    const [assigningVendor, setAssigningVendor] = useState(false);
    const wasRunningRef = useRef(false);
    const wasApplyingRef = useRef(false);
    const [grupo, setGrupo] = useState('todos');
    const [estado, setEstado] = useState('todos');
    const [matchType, setMatchType] = useState('todos');
    const [sinVendor, setSinVendor] = useState(false);
    const [suppliers, setSuppliers] = useState([]);
    const [supplierId, setSupplierId] = useState('');
    const [search, setSearch] = useState('');
    const [searchInput, setSearchInput] = useState('');
    const searchTimer = useRef(null);
    const [selected, setSelected] = useState(new Set());
    const [detail, setDetail] = useState(null);
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);

    useEffect(() => {
        api.get('/suppliers').then(r => r.success && setSuppliers(r.data || []));
    }, []);

    const fetchData = useCallback(async (p = page) => {
        setLoading(true);
        const [prodRes, resRes] = await Promise.all([
            api.get('/preventas-sync/products', {
                supplierId: supplierId || undefined,
                grupo:     !sinVendor && grupo    !== 'todos' ? grupo      : undefined,
                estado:    !sinVendor && estado   !== 'todos' ? estado     : undefined,
                matchType: !sinVendor && matchType !== 'todos' ? matchType  : undefined,
                sinVendor: sinVendor || undefined,
                search:    search     || undefined,
                page: p, pageSize: PAGE_SIZE,
            }),
            api.get('/preventas-sync/resumen', supplierId ? { supplierId } : undefined),
        ]);
        if (prodRes.success) { setProductos(prodRes.data || []); setTotal(prodRes.pagination?.total || 0); }
        else showToast(prodRes.error || 'Error al cargar productos', 'error');
        if (resRes.success) setResumen(resRes.data || {});
        setLoading(false);
    }, [grupo, estado, supplierId, matchType, search, sinVendor, page]);

    useEffect(() => { setPage(1); fetchData(1); setSelected(new Set()); }, [grupo, estado, supplierId, matchType, search, sinVendor]);
    useEffect(() => { fetchData(page); }, [page]);

    const fetchDataRef = useRef(fetchData);
    useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);

    useEffect(() => {
        let timer;
        async function checkStatus() {
            const res = await api.get('/preventas-sync/recompute/status');
            if (!res.success) return;
            const running = res.data.running;
            setBgRecomputing(running);
            if (!running && wasRunningRef.current) { showToast('Recomputo completado — datos actualizados', 'success'); fetchDataRef.current(1); }
            wasRunningRef.current = running;
            timer = setTimeout(checkStatus, running ? 3000 : 8000);
        }
        checkStatus();
        return () => clearTimeout(timer);
    }, []);

    useEffect(() => {
        let timer;
        async function checkApplyStatus() {
            const res = await api.get('/preventas-sync/apply/status');
            if (!res.success) return;
            const { running, result, error } = res.data;
            setBgApplying(running);
            if (!running && wasApplyingRef.current) {
                if (error) showToast(`Apply masivo falló: ${error}`, 'error');
                else if (result) showToast(`Apply completado: ${resumenApply(result)}`, result.error > 0 || result.omitidos > 0 ? 'warning' : 'success');
                fetchDataRef.current(1); setSelected(new Set());
            }
            wasApplyingRef.current = running;
            timer = setTimeout(checkApplyStatus, running ? 3000 : 10000);
        }
        checkApplyStatus();
        return () => clearTimeout(timer);
    }, []);

    const rowKey = row => row.supplier_product_id ? `sp:${row.supplier_product_id}` : `odoo:${row.odoo_product_id}`;

    function toggleSelect(row) { const key = rowKey(row); setSelected(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; }); }
    function toggleAll() { setSelected(prev => prev.size === productos.length ? new Set() : new Set(productos.map(rowKey))); }
    function buildIds(keys) {
        const ids = [], odoo_ids = [];
        for (const k of keys) { if (k.startsWith('sp:')) ids.push(parseInt(k.slice(3))); else if (k.startsWith('odoo:')) odoo_ids.push(parseInt(k.slice(5))); }
        return { ids, odoo_ids };
    }

    // confirmar: aplica también lo que requiere revisión (solo un producto, desde el detalle)
    async function handleApply(keys, confirmar = false) {
        setApplying(true);
        const { ids, odoo_ids } = buildIds(keys);
        const res = await api.post('/preventas-sync/apply', { ids, odoo_ids, ...(confirmar ? { confirmar: true } : {}) });
        setApplying(false);
        if (res.success) {
            const r = res.data;
            // Un solo producto omitido: mostrar el motivo concreto
            const unicoOmitido = keys.length === 1 && r.omitidos === 1 ? r.detalles.find(d => d.resultado === 'omitido') : null;
            if (unicoOmitido) showToast(`No se aplicó: ${unicoOmitido.motivo}`, 'warning');
            else showToast(`Aplicado: ${resumenApply(r)}`, r.error > 0 || r.omitidos > 0 ? 'warning' : 'success');
            fetchData(page); setSelected(new Set());
        }
        else showToast(res.error || 'Error al aplicar', 'error');
    }

    async function handleApplyGrupo() {
        setApplying(true);
        const res = await api.post('/preventas-sync/apply', { ids: [], odoo_ids: [], grupo: grupo !== 'todos' ? grupo : undefined, estado: estado !== 'todos' ? estado : undefined, supplierId: supplierId || undefined });
        setApplying(false);
        if (res.success) {
            if (res.data.running) { setBgApplying(true); wasApplyingRef.current = true; showToast('Apply iniciado en background — te avisamos cuando termine', 'success'); }
            else { const r = res.data; showToast(`Aplicado: ${resumenApply(r)}`, r.error > 0 || r.omitidos > 0 ? 'warning' : 'success'); setPage(1); fetchData(1); setSelected(new Set()); }
        } else showToast(res.error || 'Error al aplicar', 'error');
    }

    async function handleAssignVendor() {
        setAssigningVendor(true);
        const res = await api.post('/preventas-sync/assign-vendor', supplierId ? { supplierId } : {});
        setAssigningVendor(false);
        if (res.success) {
            const { asignados, omitidos, errores } = res.data;
            const msg = `Proveedor asignado: ${asignados} nuevos${omitidos > 0 ? `, ${omitidos} ya tenían` : ''}${errores > 0 ? `, ${errores} errores` : ''}`;
            showToast(msg, errores > 0 ? 'warning' : 'success');
            setPage(1); fetchData(1);
        } else {
            showToast(res.error || 'Error al asignar proveedor', 'error');
        }
    }

    async function handleRecompute() {
        setRecomputing(true);
        const res = await api.post('/preventas-sync/recompute', {});
        setRecomputing(false);
        if (res.success) { const s = res.data; showToast(`Recomputo listo: ${s.total} productos en ${s.elapsed_ms}ms`, 'success'); setPage(1); fetchData(1); setSelected(new Set()); }
        else showToast(res.error || 'Error al recomputar', 'error');
    }

    const supplierOptions = [{ value: '', label: 'Todos los proveedores' }, ...suppliers.map(s => ({ value: String(s.id), label: s.name }))];

    const cols = [
        {
            key: '_sel',
            label: <input type="checkbox" checked={selected.size === productos.length && productos.length > 0} onChange={toggleAll} />,
            render: (_, row) => <input type="checkbox" checked={selected.has(rowKey(row))} onChange={() => toggleSelect(row)} onClick={e => e.stopPropagation()} />,
        },
        {
            key: 'image_url',
            label: '',
            render: (_, row) => <ProductThumb imageUrl={row.image_url} emoji={row.scraper_name?.[0]} size={36} />,
        },
        {
            key: 'supplier_name',
            label: 'Proveedor',
            render: (_, row) => (
                <div>
                    <div>{row.supplier_name || <span style={{ color: t.color.textFaint }}>—</span>}</div>
                    {row.odoo_vendor_name
                        ? <div style={{ fontSize: 10, color: '#155724', marginTop: 2, fontFamily: t.font.family }}>↳ {row.odoo_vendor_name}</div>
                        : row.supplier_name && <div style={{ fontSize: 10, color: '#856404', marginTop: 2, fontFamily: t.font.family }}>Sin vendor en Odoo</div>
                    }
                </div>
            ),
        },
        {
            key: 'scraper_sku',
            label: 'SKU / Ref',
            render: (_, row) => (
                <div>
                    {row.scraper_sku && <span style={{ fontFamily: t.font.mono, fontSize: 10, background: t.color.surface2, padding: '1px 5px', borderRadius: 3, display: 'block' }}>{row.scraper_sku}</span>}
                    {row.odoo_ref && row.odoo_ref !== row.scraper_sku && <span style={{ fontFamily: t.font.mono, fontSize: 10, background: '#f5f0ff', color: '#6f42c1', padding: '1px 5px', borderRadius: 3, display: 'block', marginTop: 2 }}>{row.odoo_ref}</span>}
                    {!row.scraper_sku && !row.odoo_ref && <span style={{ color: t.color.textFaint }}>—</span>}
                </div>
            ),
        },
        {
            key: 'nombre',
            label: 'Scraper → Odoo',
            render: (_, row) => (
                <div>
                    {row.scraper_name && <div style={{ fontSize: 12, color: t.color.text, fontFamily: t.font.family }} title={row.scraper_name}>{row.scraper_name.slice(0, 40)}</div>}
                    {row.odoo_nombre  && <div style={{ fontSize: 11, color: '#6f42c1', marginTop: 2, fontFamily: t.font.family }} title={row.odoo_nombre}>↳ {row.odoo_nombre.slice(0, 40)}</div>}
                    {!row.scraper_name && !row.odoo_nombre && <span style={{ color: t.color.textFaint }}>—</span>}
                </div>
            ),
        },
        {
            key: 'match_type',
            label: 'Relación',
            render: (_, row) => {
                if (!row.match_type) return <span style={{ color: t.color.textFaint, fontSize: 11 }}>—</span>;
                const mt = MATCH_TYPES.find(m => m.key === row.match_type) || { label: row.match_type, color: '#666', bg: '#eee' };
                return (
                    <div>
                        <span title={`${row.match_type} (${row.match_score}%)`} style={{ background: mt.bg, color: mt.color, padding: '2px 7px', borderRadius: 10, fontSize: 10, fontWeight: 700, display: 'inline-block' }}>
                            {mt.label}
                        </span>
                        <div style={{ fontSize: 10, color: t.color.textMuted, marginTop: 2, ...t.numericStyle }}>{row.match_score}%</div>
                    </div>
                );
            },
        },
        {
            key: 'precios',
            label: 'Precio',
            render: (_, row) => {
                const diff = diffPct(row.precio_preventas, row.odoo_list_price);
                return (
                    <div style={{ fontSize: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <span style={{ color: t.color.textFaint, fontSize: 10 }}>scr.</span>
                            <span style={{ fontWeight: 600, ...t.numericStyle }}>{fmt(row.precio_preventas)}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 2 }}>
                            <span style={{ color: '#6f42c1', fontSize: 10 }}>odoo</span>
                            <span style={{ color: '#6f42c1', ...t.numericStyle }}>
                                {fmt(row.odoo_list_price)}
                                {diff != null && row.odoo_list_price && <span style={{ marginLeft: 3, fontSize: 10, fontWeight: 700, color: Number(diff) > 0 ? t.color.danger : t.color.success }}>{Number(diff) > 0 ? '▲' : '▼'}{Math.abs(diff)}%</span>}
                            </span>
                        </div>
                    </div>
                );
            },
        },
        {
            key: 'costo',
            label: 'Costo',
            render: (_, row) => {
                const d = diffPct(row.costo, row.odoo_standard_price);
                return (
                    <div style={{ fontSize: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <span style={{ color: t.color.textFaint, fontSize: 10 }}>scr.</span>
                            <span style={{ fontWeight: 600, ...t.numericStyle }}>{fmt(row.costo)}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 2 }}>
                            <span style={{ color: '#6f42c1', fontSize: 10 }}>odoo</span>
                            <span style={{ color: '#6f42c1', ...t.numericStyle }}>
                                {fmt(row.odoo_standard_price)}
                                {d != null && row.odoo_standard_price && <span style={{ marginLeft: 3, fontSize: 10, fontWeight: 700, color: Number(d) > 0 ? t.color.danger : t.color.success }}>{Number(d) > 0 ? '▲' : '▼'}{Math.abs(d)}%</span>}
                            </span>
                        </div>
                    </div>
                );
            },
        },
        {
            key: 'estado',
            label: 'Estado',
            render: (_, row) => {
                const b = BADGE[row.estado] || BADGE.sin_cambios;
                return <span style={{ background: b.bg, color: b.color, padding: '3px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>{b.label}</span>;
            },
        },
        {
            key: '_accion',
            label: 'Acción',
            render: (_, row) => {
                const label = ACCION_LABEL[row.estado];
                if (!label) return <span style={{ color: t.color.textFaint, fontSize: 12 }}>—</span>;
                // Sin precio válido: nunca se sincroniza (ej. ZLE sin cuenta de cliente)
                if (row.bloqueo_motivo) {
                    return <span title={row.bloqueo_motivo} style={{ background: t.color.dangerSoft, color: t.color.danger, padding: '3px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>Sin precio: no se sincroniza</span>;
                }
                // Requiere revisión: se abre el detalle para confirmarlo a mano
                if (row.revision_motivo) {
                    return <Button size="sm" variant="secondary" title={row.revision_motivo} onClick={e => { e.stopPropagation(); setDetail(row); }}>Revisar</Button>;
                }
                return <Button size="sm" variant="accent" disabled={applying} onClick={e => { e.stopPropagation(); handleApply([rowKey(row)]); }}>{label}</Button>;
            },
        },
    ];

    const pendientes = Object.entries(resumen).filter(([k]) => ['activar','inactivar','precio_sube','precio_baja','solo_scraper','solo_odoo'].includes(k)).reduce((sum, [, v]) => sum + v, 0);
    const grupoTotal = (() => {
        const NON_ACTIONABLE = new Set(['sin_cambios', 'sin_fuente', 'todos']);
        if (estado && estado !== 'todos') {
            if (NON_ACTIONABLE.has(estado)) return 0;
            if (['inactivar', 'solo_odoo'].includes(estado) && !supplierId) return 0;
            return resumen[estado] || 0;
        }
        switch (grupo) {
            case 'sin_fuente': return 0;
            case 'nuevos':     return resumen.solo_scraper || 0;
            case 'matcheados': return (resumen.activar || 0) + (resumen.precio_sube || 0) + (resumen.precio_baja || 0);
            // Inactivar en bloque solo con un proveedor elegido
            case 'inactivar':  return supplierId ? (resumen.inactivar || 0) + (resumen.solo_odoo || 0) : 0;
            // "Aplicar todo" sin proveedor no inactiva (el backend lo excluye)
            default:           return supplierId ? pendientes : pendientes - (resumen.inactivar || 0) - (resumen.solo_odoo || 0);
        }
    })();

    const chip = (item, active, onClick) => (
        <button key={item.key} onClick={onClick} style={{
            padding: '5px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer',
            border: `2px solid ${active ? item.color : 'transparent'}`,
            background: item.bg, color: item.color,
            fontWeight: active ? 700 : 500,
            display: 'inline-flex', alignItems: 'center', gap: 5,
            transition: 'border-color 0.15s', fontFamily: t.font.family,
        }}>
            {item.label}
            {item.count > 0 && <span style={{ background: item.color, color: '#fff', borderRadius: 10, padding: '0 6px', fontSize: 10, fontWeight: 700 }}>{item.count.toLocaleString('es-AR')}</span>}
        </button>
    );

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>

            {/* Cabecera */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: t.space[3] }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: t.space[3], flexWrap: 'wrap' }}>
                    {bgApplying && <Badge tone="warn">Aplicando cambios en Odoo…</Badge>}
                    {(recomputing || bgRecomputing)
                        ? <Badge tone="warn">Calculando relaciones…</Badge>
                        : <Badge tone="success" dot>Datos al día</Badge>
                    }
                    {resumen.last_computed && (
                        <span style={{ color: t.color.textMuted, fontSize: t.font.size.xs, fontFamily: t.font.family }}>
                            {timeAgo(resumen.last_computed)} · {(resumen.total || 0).toLocaleString('es-AR')} registros
                        </span>
                    )}
                </div>
                <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap' }}>
                    {selected.size > 0 && (
                        <Button variant="primary" disabled={applying} onClick={() => handleApply([...selected])}>
                            {applying ? 'Aplicando…' : `Aplicar seleccionados (${selected.size})`}
                        </Button>
                    )}
                    {selected.size === 0 && grupoTotal > 0 && (
                        <Button variant="accent" disabled={applying} onClick={handleApplyGrupo}>
                            {applying ? 'Aplicando…' : grupo !== 'todos' || estado !== 'todos' ? `Aplicar grupo (${grupoTotal.toLocaleString('es-AR')})` : `Aplicar todo (${grupoTotal.toLocaleString('es-AR')})`}
                        </Button>
                    )}
                    {selected.size === 0 && productos.length > 0 && (
                        <Button variant="secondary" disabled={applying} onClick={() => handleApply(productos.filter(p => ACCION_LABEL[p.estado]).map(rowKey))}>
                            {applying ? 'Aplicando…' : `Aplicar página (${productos.filter(p => ACCION_LABEL[p.estado]).length})`}
                        </Button>
                    )}
                    <Button variant="ghost" leftIcon={<Icon.Refresh size={13} />} disabled={loading} onClick={() => fetchData()}>Actualizar</Button>
                    {resumen.sin_vendor > 0 && (
                        <Button
                            variant="ghost"
                            disabled={assigningVendor}
                            style={{ color: '#856404', borderColor: '#856404' }}
                            onClick={handleAssignVendor}
                            title={`Asignar proveedor en Odoo a ${resumen.sin_vendor} productos matcheados`}
                        >
                            {assigningVendor ? 'Asignando…' : `Asignar proveedor (${resumen.sin_vendor})`}
                        </Button>
                    )}
                    <Button variant="ghost" disabled={recomputing} style={{ color: '#6f42c1', borderColor: '#6f42c1' }} onClick={handleRecompute}>
                        {recomputing ? 'Calculando…' : 'Recomputar'}
                    </Button>
                </div>
            </div>

            {/* Bloque de comparación */}
            {(resumen.odoo_total > 0 || resumen.scraper_total > 0) && (
                <ComparisonBlock
                    resumen={resumen}
                    grupo={grupo}
                    sinVendor={sinVendor}
                    tokens={t}
                    onFilter={g => { setSinVendor(false); setGrupo(g); setEstado('todos'); setMatchType('todos'); setPage(1); setSelected(new Set()); }}
                    onFilterVendor={() => { setSinVendor(v => !v); setGrupo('todos'); setEstado('todos'); setMatchType('todos'); setPage(1); setSelected(new Set()); }}
                />
            )}

            {/* Filtros jerárquicos */}
            {(() => {
                const matcheadosTotal = (resumen.activar || 0) + (resumen.sin_cambios || 0) + (resumen.precio_sube || 0) + (resumen.precio_baja || 0);
                const inactivarTotal  = (resumen.inactivar || 0) + (resumen.solo_odoo || 0);
                const GRUPOS_DEF = [
                    { key: 'todos',      label: 'Todos',       count: resumen.total,             color: '#555',    bg: '#f0f0f0' },
                    { key: 'nuevos',     label: 'Nuevos',      count: resumen.solo_scraper || 0, color: '#155724', bg: '#d4edda' },
                    { key: 'matcheados', label: 'Matcheados',  count: matcheadosTotal,           color: '#004085', bg: '#cce5ff' },
                    { key: 'inactivar',  label: 'A Inactivar', count: inactivarTotal,            color: '#721c24', bg: '#f8d7da' },
                    { key: 'sin_fuente', label: 'Sin fuente',  count: resumen.sin_fuente || 0,   color: '#555',    bg: '#eee'    },
                ];
                const ESTADOS_MATCH = [
                    { key: 'todos',       label: 'Todos',        count: matcheadosTotal,          color: '#555',    bg: '#f0f0f0' },
                    { key: 'activar',     label: 'Desarchivar',  count: resumen.activar || 0,     color: '#0c5460', bg: '#d1ecf1' },
                    { key: 'sin_cambios', label: 'Sin cambios',  count: resumen.sin_cambios || 0, color: '#999',    bg: '#eee'    },
                    { key: 'precio_sube', label: 'Precio ↑',     count: resumen.precio_sube || 0, color: '#dc3545', bg: '#f8d7da' },
                    { key: 'precio_baja', label: 'Precio ↓',     count: resumen.precio_baja || 0, color: '#155724', bg: '#d4edda' },
                ];
                const ESTADOS_INACTIVAR = [
                    { key: 'todos',     label: 'Todos',        count: inactivarTotal,          color: '#555',    bg: '#f0f0f0' },
                    { key: 'inactivar', label: 'Perdió match', count: resumen.inactivar || 0,  color: '#856404', bg: '#fff3cd' },
                    { key: 'solo_odoo', label: 'Sin match',    count: resumen.solo_odoo || 0,  color: '#721c24', bg: '#f8d7da' },
                ];
                return (
                    <div style={{ background: t.color.surface, border: `1px solid ${t.color.border}`, borderRadius: t.radius.md, padding: `${t.space[3]}px ${t.space[5]}px` }}>
                        <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap', alignItems: 'center' }}>
                            {GRUPOS_DEF.map(g => chip(g, !sinVendor && grupo === g.key, () => { setSinVendor(false); setGrupo(g.key); setEstado('todos'); setMatchType('todos'); setPage(1); setSelected(new Set()); }))}
                            {resumen.sin_vendor > 0 && chip(
                                { key: 'sin_vendor', label: 'Sin proveedor en Odoo', count: resumen.sin_vendor || 0, color: '#856404', bg: '#fff3cd' },
                                sinVendor,
                                () => { setSinVendor(v => !v); setGrupo('todos'); setEstado('todos'); setMatchType('todos'); setPage(1); setSelected(new Set()); }
                            )}
                        </div>
                        {grupo === 'matcheados' && (
                            <div style={{ marginTop: t.space[3], paddingTop: t.space[3], borderTop: `1px solid ${t.color.border}` }}>
                                <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap', alignItems: 'center', marginBottom: t.space[2] }}>
                                    <span style={{ fontSize: 10, fontWeight: 700, color: t.color.textFaint, letterSpacing: 1, marginRight: 2, textTransform: 'uppercase' }}>Estado</span>
                                    {ESTADOS_MATCH.map(e => chip(e, estado === e.key, () => { setEstado(e.key); setPage(1); setSelected(new Set()); }))}
                                </div>
                                <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap', alignItems: 'center' }}>
                                    <span style={{ fontSize: 10, fontWeight: 700, color: t.color.textFaint, letterSpacing: 1, marginRight: 2, textTransform: 'uppercase' }}>Tipo Match</span>
                                    {MATCH_TYPES.filter(m => m.key !== 'todos' && m.key !== 'sin_match').map(m => {
                                        const count = (resumen.match_types || {})[m.key] || 0;
                                        return chip({ ...m, count }, matchType === m.key, () => { setMatchType(m.key); setPage(1); setSelected(new Set()); });
                                    })}
                                </div>
                            </div>
                        )}
                        {grupo === 'inactivar' && (
                            <div style={{ marginTop: t.space[3], paddingTop: t.space[3], borderTop: `1px solid ${t.color.border}` }}>
                                <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap', alignItems: 'center' }}>
                                    <span style={{ fontSize: 10, fontWeight: 700, color: t.color.textFaint, letterSpacing: 1, marginRight: 2, textTransform: 'uppercase' }}>Origen</span>
                                    {ESTADOS_INACTIVAR.map(e => chip(e, estado === e.key, () => { setEstado(e.key); setPage(1); setSelected(new Set()); }))}
                                </div>
                            </div>
                        )}
                    </div>
                );
            })()}

            {/* Filtros: proveedor + búsqueda */}
            <div style={{ display: 'flex', gap: t.space[3], flexWrap: 'wrap' }}>
                <Select value={supplierId} onChange={v => { setSupplierId(v); setPage(1); }} options={supplierOptions} style={{ width: 200 }} />
                <Input
                    value={searchInput}
                    onChange={e => {
                        setSearchInput(e.target.value);
                        clearTimeout(searchTimer.current);
                        searchTimer.current = setTimeout(() => { setSearch(e.target.value); setPage(1); }, 350);
                    }}
                    placeholder="Buscar por nombre, SKU, ref. Odoo…"
                    leftIcon={<Icon.Search size={14} />}
                    rightIcon={searchInput
                        ? <button onClick={() => { setSearchInput(''); setSearch(''); setPage(1); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: t.color.textFaint, fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
                        : undefined
                    }
                    style={{ flex: 1, minWidth: 220 }}
                />
            </div>

            {resumen.total === 0 && !loading && (
                <div style={{ padding: 32, textAlign: 'center', background: t.color.surface, borderRadius: t.radius.md, border: `1px solid ${t.color.border}` }}>
                    <p style={{ color: t.color.textMuted, margin: '0 0 12px', fontFamily: t.font.family }}>No hay datos computados todavía.</p>
                    <Button variant="primary" disabled={recomputing} onClick={handleRecompute}>
                        {recomputing ? 'Calculando…' : 'Calcular relaciones'}
                    </Button>
                </div>
            )}

            <DataTable columns={cols} data={productos} loading={loading} onRowClick={setDetail} pagination={{ page, pageSize: PAGE_SIZE, total }} onPageChange={p => setPage(p)} />

            {/* Modal detalle */}
            <Modal isOpen={!!detail} onClose={() => setDetail(null)} title={detail?.scraper_name || detail?.odoo_nombre || 'Detalle'} subtitle={detail?.supplier_name} size="lg">
                {detail && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[6] }}>
                        <div style={{ display: 'flex', gap: t.space[5] }}>
                            <ProductThumb imageUrl={detail.image_url} emoji={detail.scraper_name?.[0]} size={80} />
                            <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: `${t.space[2]}px ${t.space[5]}px`, flex: 1, alignContent: 'start' }}>
                                {[
                                    ['Proveedor',   detail.supplier_name || '—'],
                                    ['SKU scraper', detail.scraper_sku || '—'],
                                    ['Ref. Odoo',   detail.odoo_ref || '—'],
                                    ['Match',       (() => { if (!detail.match_type) return '—'; const m = MATCH_BADGE[detail.match_type] || { label: detail.match_type, color: '#666', bg: '#eee' }; return <span style={{ background: m.bg, color: m.color, padding: '2px 8px', borderRadius: 10, fontSize: 12, fontWeight: 600 }}>{m.label} · {detail.match_score}%</span>; })()],
                                    ['Estado',      (() => { const b = BADGE[detail.estado]; return b ? <span style={{ background: b.bg, color: b.color, padding: '2px 8px', borderRadius: 10, fontSize: 12, fontWeight: 600 }}>{b.label}</span> : '—'; })()],
                                    ['Activo Odoo', detail.odoo_active === true ? 'Sí' : detail.odoo_active === false ? 'No' : '—'],
                                    ['En scraping', detail.available ? 'Sí' : 'No'],
                                ].map(([k, v], i) => (
                                    <>
                                        <span key={`k${i}`} style={{ fontWeight: t.font.weight.medium, color: t.color.textMuted, fontSize: t.font.size.sm, fontFamily: t.font.family }}>{k}</span>
                                        <span key={`v${i}`} style={{ fontSize: t.font.size.sm, color: t.color.text, fontFamily: t.font.family }}>{v}</span>
                                    </>
                                ))}
                            </div>
                        </div>

                        <div style={{ border: `1px solid ${t.color.border}`, borderRadius: t.radius.sm, overflow: 'hidden' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                    <tr style={{ background: t.color.surface2 }}>
                                        {['Concepto', 'Scraping', 'Odoo Preventas', 'Diferencia'].map(h => (
                                            <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: t.font.size.xs, color: t.color.textMuted, fontWeight: t.font.weight.semibold, textTransform: 'uppercase', letterSpacing: '0.04em', fontFamily: t.font.family }}>{h}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {[
                                        ['Precio lista', detail.raw_price,        null,                       null],
                                        ['Costo',        detail.costo,             detail.odoo_standard_price, diffPct(detail.costo,            detail.odoo_standard_price)],
                                        ['Precio venta', detail.precio_preventas,  detail.odoo_list_price,     diffPct(detail.precio_preventas, detail.odoo_list_price)],
                                    ].map(([label, a, b, d]) => (
                                        <tr key={label} style={{ borderTop: `1px solid ${t.color.border}` }}>
                                            <td style={{ padding: '10px 14px', fontWeight: t.font.weight.medium, fontSize: t.font.size.sm, fontFamily: t.font.family, color: t.color.text }}>{label}</td>
                                            <td style={{ padding: '10px 14px', fontSize: t.font.size.sm, ...t.numericStyle, color: t.color.text }}>{fmt(a)}</td>
                                            <td style={{ padding: '10px 14px', fontSize: t.font.size.sm, ...t.numericStyle, color: '#6f42c1' }}>{b != null ? fmt(b) : <span style={{ color: t.color.textFaint }}>—</span>}</td>
                                            <td style={{ padding: '10px 14px', fontSize: t.font.size.sm, ...t.numericStyle }}>
                                                {d != null && <span style={{ color: Number(d) > 0 ? t.color.danger : Number(d) < 0 ? t.color.success : t.color.textMuted, fontWeight: t.font.weight.semibold }}>{Number(d) > 0 ? '+' : ''}{d}%</span>}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        {ACCION_LABEL[detail.estado] && detail.bloqueo_motivo && (
                            <div style={{ background: t.color.dangerSoft, color: t.color.danger, border: `1px solid ${t.color.danger}`, borderRadius: t.radius.sm, padding: '10px 14px', fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                                <strong>No se sincroniza:</strong> {detail.bloqueo_motivo}. Cuando el proveedor tenga precio se va a poder aplicar.
                            </div>
                        )}

                        {ACCION_LABEL[detail.estado] && detail.revision_motivo && (
                            <div style={{ background: t.color.warnSoft, color: t.color.warn, border: `1px solid ${t.color.warn}`, borderRadius: t.radius.sm, padding: '10px 14px', fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                                <strong>Revisalo antes de aplicar:</strong> {detail.revision_motivo}. No entra en los "Aplicar" en bloque; si es correcto, confirmalo acá.
                            </div>
                        )}

                        {ACCION_LABEL[detail.estado] && !detail.bloqueo_motivo && (
                            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                <Button variant="primary" disabled={applying} onClick={() => { handleApply([rowKey(detail)], !!detail.revision_motivo); setDetail(null); }}>
                                    {applying ? 'Aplicando…' : detail.revision_motivo ? `Confirmar: ${ACCION_LABEL[detail.estado]}` : ACCION_LABEL[detail.estado]}
                                </Button>
                            </div>
                        )}
                    </div>
                )}
            </Modal>
        </div>
    );
}
