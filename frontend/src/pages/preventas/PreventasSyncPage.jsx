import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import api from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { useTheme } from '../../theme/ThemeContext';
import DataTable from '../../components/common/DataTable';
import Modal from '../../components/common/Modal';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Select from '../../components/common/Select';
import * as Icon from '../../components/common/icons';

// ─── Estados del sync: cómo se nombran y con qué tono se muestran ──────────────
const ESTADO_INFO = {
    solo_scraper:    { label: 'Crear en Odoo',               tone: 'success' },
    precio_sube:     { label: 'Precio sube',                 tone: 'warn' },
    precio_baja:     { label: 'Precio baja',                 tone: 'primary' },
    activar:         { label: 'Desarchivar',                 tone: 'primary' },
    inactivar:       { label: 'Sin stock en el proveedor',   tone: 'danger' },
    solo_odoo:       { label: 'No está en el proveedor',     tone: 'danger' },
    fuera_preventas: { label: 'Proveedor no va a Preventas', tone: 'danger' },
    sin_cambios:     { label: 'Al día',                      tone: 'muted' },
    sin_fuente:      { label: 'Sin proveedor activo',        tone: 'muted' },
};

// Cómo se vinculó el producto del proveedor con el de Odoo
const VINCULO_INFO = {
    exact_sku:    { label: 'SKU exacto',       tone: 'success' },
    barcode:      { label: 'Código de barras', tone: 'success' },
    internal_ref: { label: 'Ref. interna',     tone: 'success' },
    bracket_code: { label: 'Código en nombre', tone: 'primary' },
    name_key:     { label: 'Mismo nombre',     tone: 'primary' },
    fuzzy_name:   { label: 'Nombre parecido',  tone: 'warn' },
    sin_match:    { label: 'Sin vínculo',      tone: 'muted' },
};

const ACCION_LABEL = {
    solo_scraper: 'Crear', activar: 'Desarchivar', inactivar: 'Archivar',
    precio_sube: 'Actualizar precio', precio_baja: 'Actualizar precio',
    solo_odoo: 'Archivar', fuera_preventas: 'Archivar', sin_cambios: null, sin_fuente: null,
};

// ─── Foto del proveedor al lado de la que tiene hoy Odoo Preventas (nota 180) ──
// Al aplicar, la foto del proveedor solo se sube si el producto se crea o si Odoo no tiene foto.
// "Actualizar foto en Odoo" (nota 181) la pisa a mano. Tras subirla, la URL lleva ?v= para que el
// navegador no muestre la foto vieja que tiene guardada.
const versionFotoOdoo = new Map(); // template_id → momento en que se actualizó desde acá
const URL_FOTO_ODOO = (templateId, size) => {
    const v = versionFotoOdoo.get(templateId);
    return `/api/products/odoo-image/preventas/${templateId}?size=${size}${v ? `&v=${v}` : ''}`;
};
// Se puede pisar la foto de Odoo con la del proveedor: la oferta está vinculada y tiene foto
const puedeActualizarFoto = (row) => !!(row.supplier_product_id && row.odoo_template_id && row.image_url);

function FotoCaja({ t, titulo, src, grande, vacio, nota }) {
    const [error, setError] = useState(false);
    useEffect(() => { setError(false); }, [src]);
    const mostrar = src && !error;
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[2], width: 200 }}>
            <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontWeight: t.font.weight.semibold, textTransform: 'uppercase', letterSpacing: '0.04em', fontFamily: t.font.family }}>{titulo}</span>
            <a
                href={mostrar ? (grande || src) : undefined}
                target="_blank"
                rel="noreferrer"
                title={mostrar ? 'Abrir la foto en grande' : undefined}
                style={{ width: 200, height: 200, borderRadius: t.radius.sm, border: `1px solid ${t.color.border}`, background: t.color.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', cursor: mostrar ? 'zoom-in' : 'default' }}
            >
                {mostrar
                    ? <img key={src} src={src} alt="" onError={() => setError(true)} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                    : <span style={{ fontSize: t.font.size.sm, color: t.color.textFaint, fontFamily: t.font.family, padding: t.space[3], textAlign: 'center' }}>{error ? 'No se pudo cargar la foto' : vacio}</span>}
            </a>
            {nota && <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family }}>{nota}</span>}
        </div>
    );
}

// Versión chica para cada fila de la tabla: proveedor | Odoo
function FotoMini({ t, src, etiqueta, vacio }) {
    const [error, setError] = useState(false);
    useEffect(() => { setError(false); }, [src]);
    const mostrar = src && !error;
    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <div title={mostrar ? undefined : vacio} style={{ width: 44, height: 44, borderRadius: t.radius.sm, border: `1px solid ${t.color.border}`, background: t.color.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
                {mostrar
                    ? <img key={src} src={src} alt="" loading="lazy" onError={() => setError(true)} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                    : <span style={{ fontSize: t.font.size.xs, color: t.color.textFaint, fontFamily: t.font.family }}>—</span>}
            </div>
            <span style={{ fontSize: 10, color: t.color.textFaint, fontFamily: t.font.family, lineHeight: 1 }}>{etiqueta}</span>
        </div>
    );
}

function FotosFila({ t, row, onActualizar }) {
    const fotoOdoo = row.odoo_template_id && row.odoo_has_image !== false ? URL_FOTO_ODOO(row.odoo_template_id, 128) : null;
    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: t.space[1], flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: t.space[2] }}>
                <FotoMini t={t} src={row.image_url || null} etiqueta="Proveedor" vacio="El proveedor no tiene foto" />
                <FotoMini t={t} src={fotoOdoo} etiqueta="Odoo" vacio={row.odoo_template_id ? 'Sin foto en Odoo' : 'Todavía no está en Odoo'} />
            </div>
            {onActualizar && puedeActualizarFoto(row) && (
                <button
                    type="button"
                    title="Reemplazar la foto de Odoo por la del proveedor"
                    onClick={e => { e.stopPropagation(); onActualizar(row); }}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: 'none', background: 'none', padding: '2px 4px', cursor: 'pointer', color: t.color.primary, fontSize: 11, fontFamily: t.font.family, fontWeight: t.font.weight.medium, whiteSpace: 'nowrap' }}
                >
                    <Icon.Refresh size={12} /> Foto a Odoo
                </button>
            )}
        </div>
    );
}

function FotosComparadas({ t, detail, notaAlAplicar = true }) {
    const fotoProveedor = detail.image_url || null;
    const enOdoo = !!detail.odoo_template_id;
    // La ruta compara con Odoo antes de servir la copia en disco: siempre es la foto vigente
    const fotoOdoo = enOdoo && detail.odoo_has_image !== false ? `${URL_FOTO_ODOO(detail.odoo_template_id, 512)}` : null;
    const fotoOdooGrande = enOdoo ? `${URL_FOTO_ODOO(detail.odoo_template_id, 1920)}` : null;

    let notaProveedor = null;
    if (notaAlAplicar && fotoProveedor && detail.supplier_product_id) {
        if (!enOdoo) notaProveedor = 'Se usa al crear el producto en Odoo.';
        else if (detail.odoo_has_image === false) notaProveedor = 'Odoo no tiene foto: se sube al aplicar.';
        else notaProveedor = 'Odoo ya tiene foto: al aplicar no se cambia. Para cambiarla, usá "Actualizar foto en Odoo".';
    }

    return (
        <div style={{ display: 'flex', gap: t.space[5], flexWrap: 'wrap' }}>
            <FotoCaja t={t} titulo="Foto del proveedor" src={fotoProveedor} vacio="El proveedor no tiene foto" nota={notaProveedor} />
            <FotoCaja t={t} titulo="Foto actual en Odoo" src={fotoOdoo} grande={fotoOdooGrande} vacio={enOdoo ? 'Sin foto en Odoo' : 'Todavía no está en Odoo'} />
        </div>
    );
}

// Mismos grupos que el backend (preventasSyncService GRUPO_ESTADOS)
const GRUPO_ESTADOS = {
    nuevos:     ['solo_scraper'],
    precio:     ['precio_sube', 'precio_baja'],
    inactivar:  ['inactivar', 'solo_odoo', 'fuera_preventas'],
    al_dia:     ['sin_cambios', 'sin_fuente'],
};
const ACCIONABLES  = ['solo_scraper', 'precio_sube', 'precio_baja', 'activar', 'inactivar', 'solo_odoo', 'fuera_preventas'];
const INACTIVACION = ['inactivar', 'solo_odoo', 'fuera_preventas'];

// Las tarjetas de arriba: cada una es una vista (filtro) de la tabla
const VISTAS = [
    { key: 'crear',       titulo: 'Crear en Odoo',  ayuda: 'Los tiene el proveedor y no están en Odoo',  tone: 'success', icon: Icon.Plus,    filtro: { grupo: 'nuevos' } },
    { key: 'precio',      titulo: 'Cambiar precio', ayuda: 'El proveedor cambió el precio',               tone: 'warn',    icon: Icon.TrendUp, filtro: { grupo: 'precio' },
      subs: [{ key: 'precio_sube', label: 'Suben' }, { key: 'precio_baja', label: 'Bajan' }] },
    { key: 'desarchivar', titulo: 'Desarchivar',    ayuda: 'Archivados en Odoo que el proveedor volvió a tener', tone: 'primary', icon: Icon.Package, filtro: { estado: 'activar' } },
    { key: 'archivar',    titulo: 'Archivar',       ayuda: 'Activos en Odoo que el proveedor ya no tiene', tone: 'danger',  icon: Icon.Archive, filtro: { grupo: 'inactivar' },
      subs: [{ key: 'inactivar', label: 'Sin stock en el proveedor' }, { key: 'solo_odoo', label: 'No está en el proveedor' }, { key: 'fuera_preventas', label: 'Proveedor no va a Preventas' }] },
    { key: 'al_dia',      titulo: 'Al día',         ayuda: 'No hace falta tocar nada',                     tone: 'muted',   icon: Icon.Check,   filtro: { grupo: 'al_dia' },
      subs: [{ key: 'sin_cambios', label: 'Sin cambios' }, { key: 'sin_fuente', label: 'Sin proveedor activo (no se tocan)' }] },
];

const sumar = (resumen, estados) => estados.reduce((s, e) => s + (resumen[e] || 0), 0);
const fmt = v => v != null ? `$${Number(v).toLocaleString('es-AR', { maximumFractionDigits: 2 })}` : '—';
const fmtN = n => (Number(n) || 0).toLocaleString('es-AR');
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
    return `hace ${hrs} h`;
};

const PAGE_SIZE = 100;

// Texto del resultado de un apply: ok, errores y omitidos por las protecciones
const resumenApply = r => [
    `${r.ok} ok`,
    r.error > 0 ? `${r.error} errores` : null,
    r.omitidos > 0 ? `${r.omitidos} omitidos (revisalos uno por uno)` : null,
].filter(Boolean).join(', ');

// Colores de un tono del sistema de diseño
const toneColors = (t, tone) => ({
    primary: { fg: t.color.primary,   bg: t.color.primarySoft },
    success: { fg: t.color.success,   bg: t.color.successSoft },
    warn:    { fg: t.color.warn,      bg: t.color.warnSoft },
    danger:  { fg: t.color.danger,    bg: t.color.dangerSoft },
    muted:   { fg: t.color.textMuted, bg: t.color.surface2 },
}[tone] || { fg: t.color.textMuted, bg: t.color.surface2 });

// ─── Tarea larga en curso (con barra de avance si se conoce el total) ──────────
function TareaEnCurso({ texto, hechos, total, detalle, t }) {
    const pct = total ? Math.min(100, Math.round((hechos / total) * 100)) : null;
    return (
        <div style={{ background: t.color.warnSoft, border: `1px solid ${t.color.warn}`, borderRadius: t.radius.md, padding: `${t.space[3]}px ${t.space[5]}px`, fontFamily: t.font.family }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: t.space[4], flexWrap: 'wrap', fontSize: t.font.size.sm, color: t.color.text }}>
                <span style={{ fontWeight: t.font.weight.semibold }}>{texto}</span>
                {total ? <span style={{ color: t.color.textMuted, ...t.numericStyle }}>{fmtN(hechos)} de {fmtN(total)}{detalle ? ` · ${detalle}` : ''}</span> : null}
            </div>
            <div style={{ marginTop: t.space[2], height: 6, borderRadius: t.radius.full, background: t.color.surface, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: pct != null ? `${pct}%` : '35%', background: t.color.warn, borderRadius: t.radius.full, transition: 'width 300ms' }} />
            </div>
        </div>
    );
}

// ─── Tarjeta de vista: número grande + qué significa ───────────────────────────
function TarjetaVista({ titulo, ayuda, count, tone, icon: Ico, activa, onClick, extra, t }) {
    const c = toneColors(t, tone);
    return (
        // div y no <button>: adentro puede ir otro botón (Asignar proveedor)
        <div role="button" tabIndex={0} onClick={onClick} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }} style={{
            textAlign: 'left', cursor: 'pointer', fontFamily: t.font.family,
            background: activa ? t.color.primarySoft : t.color.surface,
            border: `${activa ? 2 : 1}px solid ${activa ? t.color.primary : t.color.border}`,
            borderRadius: t.radius.md, padding: activa ? t.space[5] - 1 : t.space[5],
            display: 'flex', flexDirection: 'column', gap: t.space[2], minWidth: 0,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: t.space[2] }}>
                <span style={{ width: 26, height: 26, borderRadius: t.radius.full, background: c.bg, color: c.fg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Ico size={14} />
                </span>
                <span style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.text }}>{titulo}</span>
            </div>
            <span style={{ fontSize: t.font.size['2xl'], fontWeight: t.font.weight.bold, color: count > 0 && tone !== 'muted' ? c.fg : t.color.textMuted, lineHeight: 1.1, ...t.numericStyle }}>{fmtN(count)}</span>
            <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, lineHeight: 1.35 }}>{ayuda}</span>
            {extra}
        </div>
    );
}

// ─── De dónde salen los números (plegable) ─────────────────────────────────────
function Numeros({ resumen: r, t }) {
    const fila = (label, valor, fuerte) => (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: t.space[4], padding: '3px 0', fontSize: t.font.size.sm, color: fuerte ? t.color.text : t.color.textMuted, fontWeight: fuerte ? t.font.weight.semibold : t.font.weight.regular }}>
            <span>{label}</span><span style={t.numericStyle}>{fmtN(valor)}</span>
        </div>
    );
    const titulo = txt => <div style={{ fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, color: t.color.textFaint, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: t.space[2] }}>{txt}</div>;
    return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: t.space[10], padding: `${t.space[4]}px ${t.space[5]}px`, borderTop: `1px solid ${t.color.border}`, fontFamily: t.font.family }}>
            <div>
                {titulo('Odoo Preventas')}
                {fila('Productos', r.odoo_total, true)}
                {fila('Activos', r.odoo_activos)}
                {fila('Archivados', r.odoo_inactivos)}
                {fila('Vinculados a un proveedor', r.odoo_matcheados)}
            </div>
            <div>
                {titulo('Proveedores (scraping)')}
                {fila('Productos', r.scraper_total, true)}
                {fila('Disponibles', r.scraper_disponibles)}
                {fila('Vinculados a Odoo', r.scraper_con_match)}
                {fila('Sin vincular', r.scraper_sin_match)}
            </div>
        </div>
    );
}

// ─── Confirmación de "Aplicar" (bloque o selección) con el desglose ───────────
// conteo: { listos, revision_costo, revision_vinculo, sin_precio, sin_accion? }
function ConfirmarAplicar({ t, tipo, conteo, alcance, incluirCosto, setIncluirCosto, onClose, onConfirm }) {
    const c = conteo || {};
    const aAplicar = (c.listos || 0) + (incluirCosto ? (c.revision_costo || 0) : 0);
    const fila = (texto, n, color) => n > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: t.space[4], padding: '3px 0', fontSize: t.font.size.sm, color: color || t.color.text }}>
            <span>{texto}</span><span style={t.numericStyle}>{fmtN(n)}</span>
        </div>
    );
    return (
        <Modal
            isOpen={!!tipo}
            onClose={onClose}
            title="Aplicar cambios en Odoo Preventas"
            subtitle={alcance || (tipo === 'seleccion' ? 'Productos seleccionados' : undefined)}
            size="sm"
            footer={
                <>
                    <Button variant="ghost" onClick={onClose}>Cancelar</Button>
                    <Button variant="primary" disabled={aAplicar === 0} onClick={onConfirm}>
                        {aAplicar === 0 ? 'Nada para aplicar' : `Aplicar ${fmtN(aAplicar)}`}
                    </Button>
                </>
            }
        >
            <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[4], fontFamily: t.font.family }}>
                <div>
                    {fila('Listos para aplicar', c.listos)}
                    {fila('Con cambio de costo de más del 20%', c.revision_costo, t.color.warn)}
                    {fila('Vinculados por nombre parecido u otro código (no entran)', c.revision_vinculo, t.color.textMuted)}
                    {fila('Sin precio del proveedor (no se sincronizan)', c.sin_precio, t.color.textMuted)}
                    {fila('Sin nada que hacer', c.sin_accion, t.color.textMuted)}
                </div>
                {c.revision_costo > 0 && (
                    <label style={{
                        display: 'flex', gap: t.space[3], alignItems: 'flex-start', cursor: 'pointer',
                        padding: t.space[3], borderRadius: t.radius.md, background: t.color.warnSoft,
                        fontSize: t.font.size.sm, color: t.color.text, lineHeight: 1.45,
                    }}>
                        <input type="checkbox" checked={incluirCosto} onChange={e => setIncluirCosto(e.target.checked)} style={{ marginTop: 3 }} />
                        <span>
                            Aplicar también los {fmtN(c.revision_costo)} con cambio de costo grande.
                            <span style={{ display: 'block', color: t.color.textMuted, fontSize: t.font.size.xs, marginTop: 2 }}>
                                Mirá antes la tabla: un salto de +100% suele ser un pack contado como unidad.
                            </span>
                        </span>
                    </label>
                )}
                <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>
                    Antes de escribir se vuelve a leer Odoo: si alguien cambió el costo a mano, ese producto se saltea.
                </div>
            </div>
        </Modal>
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
    const [vendorProgreso, setVendorProgreso] = useState(null);
    const wasAssigningRef = useRef(false);
    const wasRunningRef = useRef(false);
    const wasApplyingRef = useRef(false);
    // vista: 'todos' | key de VISTAS | 'sin_vendor'; sub: 'todos' | estado puntual dentro de la vista
    const [vista, setVista] = useState('todos');
    const [sub, setSub] = useState('todos');
    const [matchType, setMatchType] = useState('todos');
    const [suppliers, setSuppliers] = useState([]);
    const [supplierId, setSupplierId] = useState('');
    const [search, setSearch] = useState('');
    const [searchInput, setSearchInput] = useState('');
    const searchTimer = useRef(null);
    // Selección: key → fila (para saber qué revisión pide cada seleccionado)
    const [selected, setSelected] = useState(new Map());
    const [detail, setDetail] = useState(null);
    // Fila cuya foto se va a pisar en Odoo (confirmación desde la tabla, nota 181)
    const [fotoPisar, setFotoPisar] = useState(null);
    const [subiendoFoto, setSubiendoFoto] = useState(false);
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [verNumeros, setVerNumeros] = useState(false);
    // Qué haría el "Aplicar" en bloque con los filtros actuales (lo calcula el backend)
    const [aplicables, setAplicables] = useState(null);
    // Diálogo de confirmación: null | 'bloque' | 'seleccion'
    const [confirmar, setConfirmar] = useState(null);
    const [incluirCosto, setIncluirCosto] = useState(false);

    const sinVendor = vista === 'sin_vendor';
    const vistaDef = VISTAS.find(v => v.key === vista);

    // Filtro que corresponde a la vista elegida (grupo o estado del backend)
    const filtro = sinVendor ? {} : sub !== 'todos' ? { estado: sub } : (vistaDef?.filtro || {});

    useEffect(() => {
        api.get('/suppliers').then(r => r.success && setSuppliers(r.data || []));
    }, []);

    const fetchData = useCallback(async (p = page) => {
        setLoading(true);
        const [prodRes, resRes] = await Promise.all([
            api.get('/preventas-sync/products', {
                supplierId: supplierId || undefined,
                grupo:     filtro.grupo,
                estado:    filtro.estado,
                matchType: !sinVendor && matchType !== 'todos' ? matchType : undefined,
                sinVendor: sinVendor || undefined,
                search:    search || undefined,
                page: p, pageSize: PAGE_SIZE,
            }),
            api.get('/preventas-sync/resumen', supplierId ? { supplierId } : undefined),
        ]);
        if (prodRes.success) { setProductos(prodRes.data || []); setTotal(prodRes.pagination?.total || 0); setAplicables(prodRes.aplicables || null); }
        else showToast(prodRes.error || 'Error al cargar productos', 'error');
        if (resRes.success) setResumen(resRes.data || {});
        setLoading(false);
    }, [vista, sub, supplierId, matchType, search, page]);

    useEffect(() => { setPage(1); fetchData(1); setSelected(new Map()); }, [vista, sub, supplierId, matchType, search]);
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
                if (error) showToast(`Los cambios en bloque fallaron: ${error}`, 'error');
                else if (result) showToast(`Cambios aplicados: ${resumenApply(result)}`, result.error > 0 || result.omitidos > 0 ? 'warning' : 'success');
                fetchDataRef.current(1); setSelected(new Map());
            }
            wasApplyingRef.current = running;
            timer = setTimeout(checkApplyStatus, running ? 3000 : 10000);
        }
        checkApplyStatus();
        return () => clearTimeout(timer);
    }, []);

    // Asignar proveedor corre en segundo plano en el backend: seguimos el avance y avisamos al terminar
    useEffect(() => {
        let timer;
        async function checkVendorStatus() {
            const res = await api.get('/preventas-sync/assign-vendor/status');
            if (res.success) {
                const { running, progreso, result, error } = res.data;
                setAssigningVendor(running);
                setVendorProgreso(running ? progreso : null);
                if (!running && wasAssigningRef.current) {
                    if (error) showToast(`No se pudo asignar proveedor: ${error}`, 'error');
                    else if (result) {
                        const sinPartner = result.sin_partner?.length ? `. Sin proveedor en Odoo: ${result.sin_partner.join(', ')}` : '';
                        const msg = `Proveedor asignado: ${result.asignados} nuevos${result.omitidos > 0 ? `, ${result.omitidos} ya tenían` : ''}${result.errores > 0 ? `, ${result.errores} con error` : ''}${sinPartner}`;
                        showToast(msg, result.errores > 0 ? 'warning' : 'success');
                    }
                    fetchDataRef.current(1);
                }
                wasAssigningRef.current = running;
            }
            timer = setTimeout(checkVendorStatus, wasAssigningRef.current ? 3000 : 10000);
        }
        checkVendorStatus();
        return () => clearTimeout(timer);
    }, []);

    const rowKey = row => row.supplier_product_id ? `sp:${row.supplier_product_id}` : `odoo:${row.odoo_product_id}`;

    function toggleSelect(row) { const key = rowKey(row); setSelected(prev => { const n = new Map(prev); n.has(key) ? n.delete(key) : n.set(key, row); return n; }); }
    function toggleAll() { setSelected(prev => prev.size === productos.length ? new Map() : new Map(productos.map(r => [rowKey(r), r]))); }
    function buildIds(keys) {
        const ids = [], odoo_ids = [];
        for (const k of keys) { if (k.startsWith('sp:')) ids.push(parseInt(k.slice(3))); else if (k.startsWith('odoo:')) odoo_ids.push(parseInt(k.slice(5))); }
        return { ids, odoo_ids };
    }

    function elegirVista(key) {
        // Tocar la tarjeta activa la deselecciona y vuelve a "todos"
        setVista(prev => prev === key ? 'todos' : key);
        setSub('todos'); setMatchType('todos'); setPage(1); setSelected(new Map());
    }

    // confirmarUno: aplica también lo que requiere revisión (un solo producto, desde la fila o el detalle)
    // aceptarCambioCosto: aplica también los cambios de costo grandes (selección de varios)
    async function handleApply(keys, confirmarUno = false, aceptarCambioCosto = false) {
        setApplying(true);
        const { ids, odoo_ids } = buildIds(keys);
        const res = await api.post('/preventas-sync/apply', {
            ids, odoo_ids,
            ...(confirmarUno ? { confirmar: true } : {}),
            ...(aceptarCambioCosto ? { aceptarCambioCosto: true } : {}),
        });
        setApplying(false);
        if (res.success) {
            const r = res.data;
            // Un solo producto omitido: mostrar el motivo concreto
            const unicoOmitido = keys.length === 1 && r.omitidos === 1 ? r.detalles.find(d => d.resultado === 'omitido') : null;
            if (unicoOmitido) showToast(`No se aplicó: ${unicoOmitido.motivo}`, 'warning');
            else showToast(`Aplicado: ${resumenApply(r)}`, r.error > 0 || r.omitidos > 0 ? 'warning' : 'success');
            fetchData(page); setSelected(new Map());
        }
        else showToast(res.error || 'Error al aplicar', 'error');
    }

    // "No es este" (nota 179): el vínculo está mal. No toca Odoo: la oferta pasa a "Crear en Odoo"
    // y queda para crearla como artículo nuevo (o dejarla para después).
    // Desde la fila no se abre nada (nota 180); desde el detalle, el detalle pasa a mostrar la oferta sola.
    async function handleNoEsEste(row, { desdeDetalle = false } = {}) {
        setApplying(true);
        const res = await api.post('/preventas-sync/rechazar-vinculo', { supplierProductId: row.supplier_product_id });
        setApplying(false);
        if (!res.success) { showToast(res.error || 'No se pudo guardar', 'error'); return; }
        showToast('Listo: ese vínculo no se vuelve a proponer. Quedó en "Crear en Odoo"', 'success');
        setSelected(prev => { const n = new Map(prev); n.delete(rowKey(row)); return n; });
        if (desdeDetalle) setDetail(res.data || null);
        fetchData(page);
    }

    // "Actualizar foto en Odoo" (nota 181): pisa la foto de Odoo Preventas con la del proveedor,
    // aunque ya tenga una. Escribe en Odoo; el resto del producto no se toca.
    async function handleActualizarFoto(row, { desdeDetalle = false } = {}) {
        setSubiendoFoto(true);
        const res = await api.post('/preventas-sync/actualizar-foto', { supplierProductId: row.supplier_product_id });
        setSubiendoFoto(false);
        if (!res.success) { showToast(res.error || 'No se pudo actualizar la foto', 'error'); return; }
        versionFotoOdoo.set(row.odoo_template_id, Date.now());
        showToast('Listo: la foto del proveedor ya está en Odoo', 'success');
        setFotoPisar(null);
        if (desdeDetalle) setDetail(res.data || { ...row, odoo_has_image: true });
        fetchData(page);
    }

    // El bloque aplica la vista tal cual se ve filtrada (vista, proveedor, búsqueda y tipo de vínculo)
    async function handleApplyBloque(aceptarCambioCosto) {
        setApplying(true);
        const res = await api.post('/preventas-sync/apply', {
            ids: [], odoo_ids: [],
            grupo: filtro.grupo, estado: filtro.estado, supplierId: supplierId || undefined,
            matchType: matchType !== 'todos' ? matchType : undefined,
            search: search || undefined,
            ...(aceptarCambioCosto ? { aceptarCambioCosto: true } : {}),
        });
        setApplying(false);
        if (res.success) {
            if (res.data.running) { setBgApplying(true); wasApplyingRef.current = true; showToast('Aplicando en segundo plano — te avisamos cuando termine', 'success'); }
            else { const r = res.data; showToast(`Aplicado: ${resumenApply(r)}`, r.error > 0 || r.omitidos > 0 ? 'warning' : 'success'); setPage(1); fetchData(1); setSelected(new Map()); }
        } else showToast(res.error || 'Error al aplicar', 'error');
    }

    async function handleAssignVendor() {
        if (assigningVendor) return;
        setAssigningVendor(true);
        const res = await api.post('/preventas-sync/assign-vendor', supplierId ? { supplierId } : {});
        if (res.success) {
            wasAssigningRef.current = true;
            showToast('Asignando proveedores en Odoo — puede tardar unos minutos, te avisamos cuando termine', 'success');
        } else {
            setAssigningVendor(false);
            showToast(res.error || 'Error al asignar proveedor', 'error');
        }
    }

    async function handleRecompute() {
        setRecomputing(true);
        const res = await api.post('/preventas-sync/recompute', {});
        setRecomputing(false);
        if (res.success) { const s = res.data; showToast(`Recomputo listo: ${s.total} productos en ${s.elapsed_ms}ms`, 'success'); setPage(1); fetchData(1); setSelected(new Map()); }
        else showToast(res.error || 'Error al recomputar', 'error');
    }

    // ─── Cuántos cambios se aplicarían en bloque en la vista actual ───────────
    const estadosVista = filtro.estado ? [filtro.estado] : filtro.grupo ? GRUPO_ESTADOS[filtro.grupo] : ACCIONABLES;
    const archivaSinProveedor = !supplierId && estadosVista.some(e => INACTIVACION.includes(e)) && sumar(resumen, estadosVista.filter(e => INACTIVACION.includes(e))) > 0;
    // El backend cuenta, con los mismos filtros de la tabla, cuántos están listos y cuántos piden revisión
    const bloque = sinVendor || !aplicables ? { listos: 0, revision_costo: 0, revision_vinculo: 0, sin_precio: 0 } : aplicables;
    const enBloque = bloque.listos + bloque.revision_costo;

    // Lo mismo para la selección, con las filas tildadas
    const seleccion = { listos: 0, revision_costo: 0, revision_vinculo: 0, sin_precio: 0, sin_accion: 0 };
    for (const row of selected.values()) {
        if (!ACCION_LABEL[row.estado]) seleccion.sin_accion++;
        else if (row.bloqueo_motivo) seleccion.sin_precio++;
        else if (row.revision_tipo === 'vinculo') seleccion.revision_vinculo++;
        else if (row.revision_tipo === 'costo') seleccion.revision_costo++;
        else seleccion.listos++;
    }

    function abrirConfirmar(tipo) {
        const c = tipo === 'bloque' ? bloque : seleccion;
        // Si no hay ninguno listo, el tilde de los cambios de costo arranca marcado (si no, no se aplicaría nada)
        setIncluirCosto(c.listos === 0 && c.revision_costo > 0);
        setConfirmar(tipo);
    }

    function aplicarConfirmado() {
        const tipo = confirmar;
        setConfirmar(null);
        if (tipo === 'bloque') handleApplyBloque(incluirCosto);
        else handleApply([...selected.keys()], false, incluirCosto);
    }

    const supplierOptions = [{ value: '', label: 'Todos los proveedores' }, ...suppliers.map(s => ({ value: String(s.id), label: s.name }))];
    const matchOptions = [
        { value: 'todos', label: 'Cualquier vínculo' },
        ...Object.entries(VINCULO_INFO).map(([k, v]) => ({ value: k, label: `${v.label} (${fmtN((resumen.match_types || {})[k])})` })),
    ];

    const precioDoble = (prov, odoo) => {
        const d = diffPct(prov, odoo);
        return (
            <div style={{ fontSize: t.font.size.sm, textAlign: 'right', ...t.numericStyle }}>
                <div style={{ fontWeight: t.font.weight.semibold, color: t.color.text }}>{fmt(prov)}</div>
                <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: 2 }}>
                    Odoo {fmt(odoo)}
                    {d != null && Number(d) !== 0 && <span style={{ marginLeft: 4, fontWeight: t.font.weight.bold, color: Number(d) > 0 ? t.color.danger : t.color.success }}>{Number(d) > 0 ? '▲' : '▼'}{Math.abs(d)}%</span>}
                </div>
            </div>
        );
    };

    const cols = [
        {
            key: '_sel',
            label: <input type="checkbox" title="Seleccionar la página" checked={selected.size === productos.length && productos.length > 0} onChange={toggleAll} />,
            render: (_, row) => <input type="checkbox" checked={selected.has(rowKey(row))} onChange={() => toggleSelect(row)} onClick={e => e.stopPropagation()} />,
        },
        {
            key: 'producto',
            label: 'Producto',
            render: (_, row) => {
                const nombre = row.scraper_name || row.odoo_nombre;
                const sku = row.scraper_sku || row.odoo_ref;
                const otroNombreOdoo = row.scraper_name && row.odoo_nombre && row.odoo_nombre !== row.scraper_name;
                return (
                    <div style={{ display: 'flex', alignItems: 'center', gap: t.space[4], minWidth: 320, maxWidth: 480 }}>
                        <FotosFila t={t} row={row} onActualizar={setFotoPisar} />
                        <div style={{ minWidth: 0 }}>
                            <div title={nombre} style={{ fontSize: t.font.size.sm, color: t.color.text, fontFamily: t.font.family, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nombre || '—'}</div>
                            {otroNombreOdoo && <div title={row.odoo_nombre} style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>En Odoo: {row.odoo_nombre}</div>}
                            {sku && <div style={{ fontFamily: t.font.mono, fontSize: 11, color: t.color.textFaint, marginTop: 1 }}>{sku}{row.odoo_ref && row.scraper_sku && row.odoo_ref !== row.scraper_sku ? ` · Odoo ${row.odoo_ref}` : ''}</div>}
                        </div>
                    </div>
                );
            },
        },
        {
            key: 'supplier_name',
            label: 'Proveedor',
            render: (_, row) => (
                <div style={{ fontFamily: t.font.family, fontSize: t.font.size.sm }}>
                    <div style={{ color: t.color.text }}>{row.supplier_name || <span style={{ color: t.color.textFaint }}>—</span>}</div>
                    {row.supplier_name && !row.odoo_vendor_name && row.odoo_product_id && <div style={{ fontSize: t.font.size.xs, color: t.color.warn, marginTop: 2 }}>Sin proveedor en Odoo</div>}
                </div>
            ),
        },
        {
            key: 'match_type',
            label: 'Vínculo',
            render: (_, row) => {
                if (!row.match_type) return <span style={{ color: t.color.textFaint }}>—</span>;
                const v = VINCULO_INFO[row.match_type] || { label: row.match_type, tone: 'muted' };
                return <span title={`Coincidencia ${row.match_score}%`}><Badge tone={v.tone}>{v.label}{row.match_score != null && row.match_score < 100 ? ` · ${row.match_score}%` : ''}</Badge></span>;
            },
        },
        { key: 'precios', label: 'Precio venta', render: (_, row) => precioDoble(row.precio_preventas, row.odoo_list_price) },
        { key: 'costo',   label: 'Costo',        render: (_, row) => precioDoble(row.costo, row.odoo_standard_price) },
        {
            key: '_accion',
            label: 'Qué hay que hacer',
            render: (_, row) => {
                const info = ESTADO_INFO[row.estado] || ESTADO_INFO.sin_cambios;
                const label = ACCION_LABEL[row.estado];
                let accion = null;
                if (label && row.bloqueo_motivo) {
                    accion = <span title={row.bloqueo_motivo} style={{ fontSize: t.font.size.xs, color: t.color.danger, fontFamily: t.font.family }}>Sin precio: no se sincroniza</span>;
                } else if (label && row.revision_motivo && row.revision_tipo === 'vinculo' && row.supplier_product_id && row.odoo_product_id) {
                    // Vínculo dudoso: se elige acá mismo si es el mismo producto o si va como artículo nuevo
                    accion = (
                        <div style={{ display: 'flex', gap: t.space[2] }}>
                            <Button size="sm" variant="secondary" disabled={applying} title={`Es el mismo producto: ${label.toLowerCase()}`}
                                onClick={e => { e.stopPropagation(); handleApply([rowKey(row)], true); }}>
                                Es este
                            </Button>
                            <Button size="sm" variant="ghost" disabled={applying} title="No es el mismo producto: no se vuelve a proponer y pasa a Crear en Odoo"
                                onClick={e => { e.stopPropagation(); handleNoEsEste(row); }}>
                                No es este
                            </Button>
                        </div>
                    );
                } else if (label && row.revision_motivo) {
                    // Se confirma acá mismo, sin abrir el detalle: el motivo queda a la vista abajo
                    accion = (
                        <Button size="sm" variant="secondary" disabled={applying} title={`${row.revision_motivo}. Tocá para aplicarlo igual.`}
                            onClick={e => { e.stopPropagation(); handleApply([rowKey(row)], true); }}>
                            Confirmar
                        </Button>
                    );
                } else if (label) {
                    accion = <Button size="sm" variant="accent" disabled={applying} onClick={e => { e.stopPropagation(); handleApply([rowKey(row)]); }}>{label}</Button>;
                }
                return (
                    <div style={{ minWidth: 220, maxWidth: 300 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: t.space[3] }}>
                            <Badge tone={info.tone}>{info.label}</Badge>
                            {accion}
                        </div>
                        {label && !row.bloqueo_motivo && row.revision_motivo && (
                            <div style={{ fontSize: t.font.size.xs, color: t.color.warn, fontFamily: t.font.family, marginTop: 4, lineHeight: 1.35 }}>
                                {row.revision_motivo}
                            </div>
                        )}
                    </div>
                );
            },
        },
    ];

    const hayDatos = resumen.odoo_total > 0 || resumen.scraper_total > 0;
    const calculando = recomputing || bgRecomputing;
    const pillStyle = activa => ({
        padding: '4px 12px', borderRadius: t.radius.full, fontSize: t.font.size.xs, cursor: 'pointer', fontFamily: t.font.family,
        border: `1px solid ${activa ? t.color.primary : t.color.border}`,
        background: activa ? t.color.primarySoft : t.color.surface,
        color: activa ? t.color.primary : t.color.textMuted,
        fontWeight: activa ? t.font.weight.semibold : t.font.weight.medium,
        display: 'inline-flex', alignItems: 'center', gap: 6,
    });

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[6] }}>

            {/* 1. Estado de los datos + acciones de mantenimiento */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: t.space[3] }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: t.space[3], flexWrap: 'wrap', fontFamily: t.font.family }}>
                    {calculando ? <Badge tone="warn" dot>Calculando relaciones…</Badge> : <Badge tone="success" dot>Datos al día</Badge>}
                    {resumen.last_computed && (
                        <span style={{ color: t.color.textMuted, fontSize: t.font.size.xs }}>
                            Calculados {timeAgo(resumen.last_computed)} · {fmtN(resumen.total)} productos comparados
                        </span>
                    )}
                </div>
                <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap' }}>
                    <Button variant="ghost" size="sm" leftIcon={<Icon.Refresh size={13} />} disabled={loading} onClick={() => fetchData()}>Actualizar</Button>
                    <Button variant="ghost" size="sm" disabled={calculando} onClick={handleRecompute} title="Vuelve a comparar todos los productos de los proveedores con Odoo">
                        {calculando ? 'Calculando…' : 'Recalcular comparación'}
                    </Button>
                </div>
            </div>

            {/* 2. Tareas largas en curso */}
            {assigningVendor && (
                <TareaEnCurso t={t} texto="Asignando proveedor en Odoo…" hechos={vendorProgreso?.hechos || 0} total={vendorProgreso?.total || 0} detalle={vendorProgreso?.proveedor} />
            )}
            {bgApplying && <TareaEnCurso t={t} texto="Aplicando cambios en Odoo… te avisamos cuando termine" />}

            {resumen.total === 0 && !loading && (
                <div style={{ padding: t.space[12], textAlign: 'center', background: t.color.surface, borderRadius: t.radius.md, border: `1px solid ${t.color.border}` }}>
                    <p style={{ color: t.color.textMuted, margin: `0 0 ${t.space[4]}px`, fontFamily: t.font.family }}>Todavía no se comparó nada.</p>
                    <Button variant="primary" disabled={recomputing} onClick={handleRecompute}>
                        {recomputing ? 'Calculando…' : 'Comparar proveedores con Odoo'}
                    </Button>
                </div>
            )}

            {/* 3. Qué hay que hacer: cada tarjeta filtra la tabla */}
            {hayDatos && (
                <div style={{ background: t.color.surface, border: `1px solid ${t.color.border}`, borderRadius: t.radius.md }}>
                    <div style={{ padding: `${t.space[4]}px ${t.space[5]}px 0`, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: t.space[3], flexWrap: 'wrap', fontFamily: t.font.family }}>
                        <span style={{ fontSize: t.font.size.base, fontWeight: t.font.weight.semibold, color: t.color.text }}>Qué hay que hacer en Odoo Preventas</span>
                        <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>Tocá una tarjeta para ver esos productos abajo</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: t.space[4], padding: t.space[5] }}>
                        {VISTAS.map(v => (
                            <TarjetaVista key={v.key} t={t} titulo={v.titulo} ayuda={v.ayuda} tone={v.tone} icon={v.icon}
                                count={sumar(resumen, v.filtro.estado ? [v.filtro.estado] : GRUPO_ESTADOS[v.filtro.grupo])}
                                activa={vista === v.key} onClick={() => elegirVista(v.key)} />
                        ))}
                        {(resumen.sin_vendor > 0 || assigningVendor) && (
                            <TarjetaVista t={t} titulo="Sin proveedor en Odoo" ayuda="Vinculados, pero en Odoo no figura a quién se le compra" tone="warn" icon={Icon.Truck}
                                count={resumen.sin_vendor} activa={sinVendor} onClick={() => elegirVista('sin_vendor')}
                                extra={
                                    <span onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} style={{ marginTop: t.space[1] }}>
                                        <Button size="sm" variant="secondary" disabled={assigningVendor} onClick={handleAssignVendor}>
                                            {assigningVendor ? 'Asignando…' : 'Asignar proveedor'}
                                        </Button>
                                    </span>
                                } />
                        )}
                    </div>
                    <button type="button" onClick={() => setVerNumeros(v => !v)} style={{
                        width: '100%', background: 'transparent', border: 'none', borderTop: `1px solid ${t.color.border}`, cursor: 'pointer',
                        padding: `${t.space[3]}px ${t.space[5]}px`, display: 'flex', alignItems: 'center', gap: t.space[2],
                        fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family,
                    }}>
                        <span style={{ display: 'inline-flex', transform: verNumeros ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 120ms' }}><Icon.ChevronDown size={12} /></span>
                        {verNumeros ? 'Ocultar' : 'Ver'} de dónde salen los números
                    </button>
                    {verNumeros && <Numeros resumen={resumen} t={t} />}
                </div>
            )}

            {/* 4. Tabla: filtros + acción en bloque + productos */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[4] }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: t.space[3], flexWrap: 'wrap', fontFamily: t.font.family }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: t.space[2], flexWrap: 'wrap' }}>
                        <span style={{ fontSize: t.font.size.lg, fontWeight: t.font.weight.semibold, color: t.color.text }}>
                            {sinVendor ? 'Sin proveedor en Odoo' : vistaDef ? vistaDef.titulo : 'Todos los productos'}
                        </span>
                        <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, ...t.numericStyle }}>{fmtN(total)}</span>
                        {vista !== 'todos' && (
                            <button type="button" onClick={() => elegirVista(vista)} style={{ ...pillStyle(false), padding: '2px 10px' }}>
                                <Icon.X size={11} /> Ver todos
                            </button>
                        )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: t.space[3], flexWrap: 'wrap' }}>
                        {selected.size > 0 ? (
                            <>
                                <button type="button" onClick={() => setSelected(new Map())} style={{ ...pillStyle(false), border: 'none', background: 'transparent' }}>Limpiar selección</button>
                                <Button variant="primary" disabled={applying} onClick={() => abrirConfirmar('seleccion')}>
                                    {applying ? 'Aplicando…' : `Aplicar ${fmtN(selected.size)} seleccionados`}
                                </Button>
                            </>
                        ) : enBloque > 0 ? (
                            <Button variant="accent" disabled={applying || bgApplying} onClick={() => abrirConfirmar('bloque')}>
                                {applying ? 'Aplicando…' : `Aplicar los ${fmtN(enBloque)} cambios`}
                            </Button>
                        ) : null}
                    </div>
                </div>

                {/* Avisos sobre el "Aplicar" en bloque */}
                {selected.size === 0 && archivaSinProveedor && (
                    <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family }}>
                        Para archivar en bloque elegí un proveedor (no se archivan todos los proveedores juntos). También podés seleccionar productos.
                    </div>
                )}
                {selected.size === 0 && bloque.revision_vinculo > 0 && (
                    <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family }}>
                        {fmtN(bloque.revision_vinculo)} {bloque.revision_vinculo === 1 ? 'producto está vinculado' : 'productos están vinculados'} por nombre parecido o con otro código: no entran en el bloque, elegí en cada fila "Es este" o "No es este" (va como artículo nuevo).
                    </div>
                )}

                {vistaDef?.subs && (
                    <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap' }}>
                        {[{ key: 'todos', label: 'Todos', count: sumar(resumen, vistaDef.subs.map(s => s.key)) }, ...vistaDef.subs.map(s => ({ ...s, count: resumen[s.key] || 0 }))].map(s => (
                            <button key={s.key} type="button" onClick={() => { setSub(s.key); setPage(1); setSelected(new Map()); }} style={pillStyle(sub === s.key)}>
                                {s.label} <span style={t.numericStyle}>{fmtN(s.count)}</span>
                            </button>
                        ))}
                    </div>
                )}

                <div style={{ display: 'flex', gap: t.space[3], flexWrap: 'wrap' }}>
                    <Input
                        value={searchInput}
                        onChange={e => {
                            setSearchInput(e.target.value);
                            clearTimeout(searchTimer.current);
                            searchTimer.current = setTimeout(() => { setSearch(e.target.value); setPage(1); }, 350);
                        }}
                        placeholder="Buscá por nombre, SKU o ref. de Odoo…"
                        leftIcon={<Icon.Search size={14} />}
                        rightIcon={searchInput
                            ? <button onClick={() => { setSearchInput(''); setSearch(''); setPage(1); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: t.color.textFaint, fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
                            : undefined
                        }
                        style={{ flex: 1, minWidth: 220 }}
                    />
                    <Select value={supplierId} onChange={v => { setSupplierId(v); setPage(1); }} options={supplierOptions} style={{ width: 220 }} />
                    {!sinVendor && <Select value={matchType} onChange={v => { setMatchType(v); setPage(1); }} options={matchOptions} style={{ width: 220 }} />}
                </div>

                <DataTable columns={cols} data={productos} loading={loading} onRowClick={setDetail} pagination={{ page, pageSize: PAGE_SIZE, total }} onPageChange={p => setPage(p)} />
            </div>

            <ConfirmarAplicar
                t={t}
                tipo={confirmar}
                conteo={confirmar === 'seleccion' ? seleccion : bloque}
                alcance={confirmar === 'bloque' ? [
                    vistaDef ? vistaDef.titulo : 'todas las vistas',
                    supplierId ? suppliers.find(s => String(s.id) === String(supplierId))?.name || 'el proveedor elegido' : 'todos los proveedores',
                    search ? `búsqueda "${search}"` : null,
                    matchType !== 'todos' ? `vínculo: ${VINCULO_INFO[matchType]?.label || matchType}` : null,
                ].filter(Boolean).join(' · ') : null}
                incluirCosto={incluirCosto}
                setIncluirCosto={setIncluirCosto}
                onClose={() => setConfirmar(null)}
                onConfirm={aplicarConfirmado}
            />

            {/* Confirmar "Foto a Odoo" desde la fila (nota 181) */}
            <Modal
                isOpen={!!fotoPisar}
                onClose={() => { if (!subiendoFoto) setFotoPisar(null); }}
                title="Actualizar foto en Odoo"
                subtitle={fotoPisar?.odoo_nombre || fotoPisar?.scraper_name}
                size="md"
                footer={
                    <>
                        <Button variant="ghost" disabled={subiendoFoto} onClick={() => setFotoPisar(null)}>Cancelar</Button>
                        <Button variant="primary" disabled={subiendoFoto} onClick={() => handleActualizarFoto(fotoPisar)}>
                            {subiendoFoto ? 'Subiendo…' : 'Usar la foto del proveedor'}
                        </Button>
                    </>
                }
            >
                {fotoPisar && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[4], fontFamily: t.font.family }}>
                        <FotosComparadas t={t} detail={fotoPisar} notaAlAplicar={false} />
                        <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>
                            {fotoPisar.odoo_has_image === false
                                ? 'El producto no tiene foto en Odoo: se sube la del proveedor.'
                                : 'La foto que tiene hoy Odoo Preventas se reemplaza por la del proveedor. El resto del producto no cambia.'}
                        </span>
                    </div>
                )}
            </Modal>

            {/* Detalle */}
            <Modal isOpen={!!detail} onClose={() => setDetail(null)} title={detail?.scraper_name || detail?.odoo_nombre || 'Detalle'} subtitle={detail?.supplier_name} size="lg">
                {detail && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[6] }}>
                        <FotosComparadas t={t} detail={detail} />
                        {puedeActualizarFoto(detail) && (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: t.space[4], fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                                <span>{detail.odoo_has_image === false ? 'Odoo no tiene foto: podés subir la del proveedor ya.' : '¿La del proveedor está mejor? Reemplaza la foto que tiene Odoo.'}</span>
                                <Button variant="secondary" size="sm" leftIcon={<Icon.Refresh size={13} />} disabled={subiendoFoto} onClick={() => handleActualizarFoto(detail, { desdeDetalle: true })}>
                                    {subiendoFoto ? 'Subiendo…' : 'Actualizar foto en Odoo'}
                                </Button>
                            </div>
                        )}

                        <div style={{ display: 'flex', gap: t.space[5] }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: `${t.space[2]}px ${t.space[5]}px`, flex: 1, alignContent: 'start' }}>
                                {[
                                    ['Proveedor',      detail.supplier_name || '—'],
                                    ['Nombre en Odoo', detail.odoo_nombre || '—'],
                                    ['SKU proveedor',  detail.scraper_sku ? <span style={{ fontFamily: t.font.mono }}>{detail.scraper_sku}</span> : '—'],
                                    ['Ref. Odoo',      detail.odoo_ref ? <span style={{ fontFamily: t.font.mono }}>{detail.odoo_ref}</span> : '—'],
                                    ['Vínculo',        (() => { if (!detail.match_type) return '—'; const v = VINCULO_INFO[detail.match_type] || { label: detail.match_type, tone: 'muted' }; return <Badge tone={v.tone}>{v.label} · {detail.match_score}%</Badge>; })()],
                                    ['Qué hay que hacer', (() => { const e = ESTADO_INFO[detail.estado]; return e ? <Badge tone={e.tone}>{e.label}</Badge> : '—'; })()],
                                    ['Activo en Odoo', detail.odoo_active === true ? 'Sí' : detail.odoo_active === false ? 'No (archivado)' : '—'],
                                    ['Disponible en el proveedor', detail.available ? 'Sí' : 'No'],
                                ].map(([k, v]) => (
                                    <Fragment key={k}>
                                        <span style={{ fontWeight: t.font.weight.medium, color: t.color.textMuted, fontSize: t.font.size.sm, fontFamily: t.font.family }}>{k}</span>
                                        <span style={{ fontSize: t.font.size.sm, color: t.color.text, fontFamily: t.font.family }}>{v}</span>
                                    </Fragment>
                                ))}
                            </div>
                        </div>

                        <div style={{ border: `1px solid ${t.color.border}`, borderRadius: t.radius.sm, overflow: 'hidden' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                    <tr style={{ background: t.color.surface2 }}>
                                        {['Concepto', 'Proveedor', 'Odoo Preventas', 'Diferencia'].map(h => (
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
                                            <td style={{ padding: '10px 14px', fontSize: t.font.size.sm, ...t.numericStyle, color: t.color.text }}>{b != null ? fmt(b) : <span style={{ color: t.color.textFaint }}>—</span>}</td>
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

                        {detail.supplier_product_id && detail.odoo_product_id && (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: t.space[4], fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                                <span>¿No es el mismo producto? Se deja de vincular, no se vuelve a proponer y pasa a "Crear en Odoo" como artículo nuevo.</span>
                                <Button variant="secondary" disabled={applying} onClick={() => handleNoEsEste(detail, { desdeDetalle: true })}>No es este</Button>
                            </div>
                        )}

                        {ACCION_LABEL[detail.estado] && !detail.bloqueo_motivo && (
                            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                <Button variant="primary" disabled={applying} onClick={() => { handleApply([rowKey(detail)], !!detail.revision_motivo); setDetail(null); }}>
                                    {applying ? 'Aplicando…' : detail.revision_tipo === 'vinculo' ? `Es este: ${ACCION_LABEL[detail.estado].toLowerCase()}` : detail.revision_motivo ? `Confirmar: ${ACCION_LABEL[detail.estado]}` : ACCION_LABEL[detail.estado]}
                                </Button>
                            </div>
                        )}
                    </div>
                )}
            </Modal>
        </div>
    );
}
