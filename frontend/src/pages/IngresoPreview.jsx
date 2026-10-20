import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ingresoAPI } from '../api/ingresoClient';
import api from '../api/client';
import { getTokens } from '../theme/tokens';
import { useDraggable } from '../hooks/useDraggable';
import { useAuth } from '../context/AuthContext';

// Mapeamos todos los colores del sistema viejo a tokens del nuevo sistema.
// Usamos getTokens a nivel de módulo para que las constantes de componente
// class (ScanToast, OdooImage) que no pueden usar hooks también accedan a ellos.
const _tk = getTokens('light');
const C = {
    primary:   _tk.color.primary,
    secondary: _tk.color.accent,
    bg:        _tk.color.surface2,
    white:     _tk.color.surface,
    text:      _tk.color.text,
    gray:      _tk.color.textMuted,
    border:    _tk.color.border,
    error:     _tk.color.danger,
    errorBg:   _tk.color.dangerSoft,
    success:   _tk.color.success,
    successBg: _tk.color.successSoft,
    warning:   _tk.color.warn,
    warningBg: _tk.color.warnSoft,
    infoBg:    _tk.color.primarySoft,
    blue:      _tk.color.primary,
    checkedBg: _tk.color.successSoft,
};

// La cantidad confirmada de un código es la suma de todos sus renglones.
function preventaConfirmada(items, pi) {
    const code = (pi?.codigo || '').trim().toUpperCase();
    if (!code) {
        const one = items.find(i => i.id === pi?.ingreso_item_id);
        return parseInt(one?.preventa_qty_confirmed, 10) || 0;
    }
    return items.reduce((sum, i) => (
        (i.codigo || '').trim().toUpperCase() === code
            ? sum + (parseInt(i.preventa_qty_confirmed, 10) || 0)
            : sum
    ), 0);
}

const fmtARS = (v) =>
    v != null ? `$${Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';

const pctDiff = (a, b) => {
    if (!a || !b || a === 0) return null;
    return ((b - a) / a * 100).toFixed(1);
};

function useIsMobile(breakpoint = 640) {
    const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= breakpoint);
    useEffect(() => {
        const handler = () => setIsMobile(window.innerWidth <= breakpoint);
        window.addEventListener('resize', handler);
        return () => window.removeEventListener('resize', handler);
    }, [breakpoint]);
    return isMobile;
}

// =============================================
// Toast de scanner HID
// =============================================
function ScanToast({ toast }) {
    if (!toast) return null;
    return (
        <div style={{
            position: 'fixed', bottom: '24px', right: '24px',
            backgroundColor: toast.ok ? '#1B5E20' : '#B71C1C',
            color: C.white, padding: '12px 18px', borderRadius: '8px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.35)', zIndex: 9999,
            fontSize: '14px', fontWeight: 'bold',
            display: 'flex', alignItems: 'center', gap: '10px', maxWidth: '380px',
        }}>
            <span style={{ fontSize: '22px' }}>{toast.ok ? '📦' : '❌'}</span>
            <span>{toast.msg}</span>
        </div>
    );
}

// =============================================
// Imagen lazy de producto Odoo
// =============================================
function OdooImage({ odooId, company = 'neggo', size = 64, version = 0 }) {
    const [failed, setFailed] = useState(false);
    useEffect(() => { setFailed(false); }, [odooId, version]);

    if (!odooId || failed) {
        return (
            <div style={{
                width: size, height: size, flexShrink: 0,
                backgroundColor: '#F0F0F0', borderRadius: '6px',
                border: `1px solid ${C.border}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: Math.round(size * 0.44) + 'px', color: '#CCC'
            }}>📦</div>
        );
    }

    const baseUrl = `/api/ingreso/odoo-image/${odooId}`;
    const params  = [];
    if (company !== 'neggo') params.push(`company=${company}`);
    if (version > 0)         params.push(`v=${version}`);
    const src = params.length ? `${baseUrl}?${params.join('&')}` : baseUrl;

    return (
        <img
            src={src}
            alt=""
            loading="lazy"
            onError={() => setFailed(true)}
            style={{
                width: size, height: size, flexShrink: 0,
                objectFit: 'contain', borderRadius: '6px',
                border: `1px solid ${C.border}`, backgroundColor: '#FAFAFA'
            }}
        />
    );
}

// =============================================
// Input de pack con estado local (permite borrar al tipear)
// =============================================
function PackInput({ value, onSave }) {
    const [local, setLocal] = useState(String(value || 1));

    useEffect(() => { setLocal(String(value || 1)); }, [value]);

    const commit = () => {
        const v = Math.max(1, parseInt(local, 10) || 1);
        setLocal(String(v));
        if (v !== value) onSave(v);
    };

    return (
        <input
            type="number"
            min="1"
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
            onClick={(e) => e.stopPropagation()}
            style={{
                width: '46px', padding: '3px 5px', textAlign: 'center',
                border: `1px solid ${parseInt(local) > 1 ? C.success : C.border}`,
                borderRadius: '4px', fontSize: '13px', fontWeight: 'bold',
                backgroundColor: parseInt(local) > 1 ? C.successBg : C.white
            }}
        />
    );
}

// =============================================
// Contador de recepción física
// =============================================
function ReceivedCounter({ item, onUpdate, isHighlighted }) {
    const isMobile   = useIsMobile();
    const qty        = parseInt(item.cantidad || 0, 10);
    const received   = parseInt(item.received_qty || 0, 10);
    const isComplete = received >= qty;
    const isOver     = received > qty;
    const progress   = qty > 0 ? Math.min(100, (received / qty) * 100) : 0;

    const markComplete = (e) => {
        e.stopPropagation();
        onUpdate(item.id, { received_qty: isComplete ? 0 : qty });
    };

    const checkBtn = (size) => ({
        width: size, height: size, borderRadius: '50%',
        border: `2px solid ${isComplete ? C.success : C.border}`,
        backgroundColor: isComplete ? C.success : 'transparent',
        color: isComplete ? C.white : C.gray,
        fontSize: Math.round(size * 0.5) + 'px', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'all 0.2s', flexShrink: 0
    });

    const numInput = (w, p, fs) => ({
        width: w, textAlign: 'center',
        border: `1px solid ${isOver ? C.warning : isComplete ? C.success : C.border}`,
        borderRadius: '4px', padding: p, fontSize: fs, fontWeight: 'bold',
        color: isOver ? C.warning : isComplete ? C.success : C.text,
        backgroundColor: 'transparent'
    });

    if (isMobile) {
        return (
            <div style={{
                display: 'flex', alignItems: 'center', gap: '10px',
                padding: '10px 12px', borderBottom: `1px solid ${C.border}`,
                backgroundColor: isHighlighted ? '#BBDEFB' : isComplete ? '#F1F8E9' : C.white,
                transition: 'background-color 0.3s'
            }}>
                <button onClick={markComplete} title={isComplete ? 'Desmarcar recibido' : 'Marcar como recibido completo'} style={checkBtn(38)}>✓</button>
                <span style={{ fontSize: '12px', color: C.gray, flexShrink: 0 }}>Recibido:</span>
                <input
                    type="number" min="0" value={received}
                    onChange={(e) => onUpdate(item.id, { received_qty: Math.max(0, parseInt(e.target.value, 10) || 0) })}
                    onClick={(e) => e.stopPropagation()}
                    style={numInput('50px', '5px', '15px')}
                />
                <span style={{ fontSize: '13px', color: C.gray }}>/ {qty}</span>
                <div style={{ flex: 1, height: '5px', backgroundColor: C.border, borderRadius: '3px', overflow: 'hidden', minWidth: '40px' }}>
                    <div style={{ width: `${progress}%`, height: '100%', backgroundColor: isOver ? C.warning : isComplete ? C.success : C.primary, transition: 'width 0.3s' }} />
                </div>
                {isComplete && <span style={{ fontSize: '11px', fontWeight: 'bold', color: C.success, flexShrink: 0 }}>✓ OK</span>}
            </div>
        );
    }

    return (
        <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', gap: '4px', padding: '8px 6px',
            borderRight: `1px solid ${C.border}`, minWidth: '78px',
            backgroundColor: isHighlighted ? '#BBDEFB' : isComplete ? '#F1F8E9' : C.white,
            borderRadius: '6px 0 0 6px', transition: 'background-color 0.3s'
        }}>
            <button onClick={markComplete} title={isComplete ? 'Desmarcar recibido' : 'Marcar como recibido completo'} style={checkBtn(32)}>✓</button>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '2px' }}>
                <input
                    type="number" min="0" value={received}
                    onChange={(e) => onUpdate(item.id, { received_qty: Math.max(0, parseInt(e.target.value, 10) || 0) })}
                    onClick={(e) => e.stopPropagation()}
                    style={numInput('34px', '2px', '13px')}
                />
                <span style={{ fontSize: '10px', color: C.gray }}>/{qty}</span>
            </div>
            <div style={{ width: '52px', height: '3px', backgroundColor: C.border, borderRadius: '2px', overflow: 'hidden' }}>
                <div style={{ width: `${progress}%`, height: '100%', backgroundColor: isOver ? C.warning : isComplete ? C.success : C.primary, transition: 'width 0.3s' }} />
            </div>
        </div>
    );
}

// =============================================
// Modal búsqueda y vinculación (activos + inactivos)
// =============================================
function ProductSearchModal({ item, onLink, onCancel }) {
    const [search, setSearch]     = useState(item?.codigo || '');
    const [results, setResults]   = useState([]);
    const [loading, setLoading]   = useState(false);
    const [selected, setSelected] = useState(null);
    const { onDragStart, dragStyle, containerStyle, overlayStyle } = useDraggable();

    useEffect(() => {
        if (!search || search.length < 2) { setResults([]); return; }
        const t = setTimeout(async () => {
            setLoading(true);
            try {
                const res = await api.get('/products/odoo', {
                    company: 'neggo', search, limit: 20, include_inactive: 'true'
                });
                if (res.success) setResults(res.data?.products || res.data || []);
            } catch (_) {}
            finally { setLoading(false); }
        }, 350);
        return () => clearTimeout(t);
    }, [search]);

    return (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, ...overlayStyle }}>
            <div style={{ backgroundColor: C.white, borderRadius: '8px', padding: '24px', width: '540px', maxWidth: '92vw', boxShadow: '0 8px 32px rgba(0,0,0,0.25)', ...containerStyle }}>
                <h3 onMouseDown={onDragStart} style={{ marginBottom: '4px', color: C.primary, fontSize: '16px', ...dragStyle }}>🔗 Vincular a producto existente</h3>
                <p style={{ fontSize: '12px', color: C.gray, marginBottom: '12px' }}>
                    Incluye activos e inactivos. La vinculación se persiste para futuras facturas del mismo proveedor.
                </p>

                <div style={{ backgroundColor: C.infoBg, borderRadius: '4px', padding: '8px 12px', marginBottom: '12px', fontSize: '12px', color: C.blue }}>
                    <strong>Ítem:</strong> {item?.codigo && <code style={{ marginRight: '6px' }}>{item.codigo}</code>}{item?.descripcion}
                </div>

                <input
                    autoFocus
                    type="text"
                    placeholder="Buscar por nombre o código interno..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    style={{ width: '100%', padding: '10px 12px', border: `1px solid ${C.border}`, borderRadius: '4px', fontSize: '14px', boxSizing: 'border-box', marginBottom: '10px' }}
                />

                {loading && <p style={{ fontSize: '12px', color: C.gray }}>Buscando...</p>}

                {results.length > 0 && (
                    <div style={{ border: `1px solid ${C.border}`, borderRadius: '4px', maxHeight: '300px', overflowY: 'auto', marginBottom: '14px' }}>
                        {results.map(p => (
                            <div
                                key={p.odoo_id}
                                onClick={() => setSelected(p)}
                                style={{
                                    padding: '8px 12px', cursor: 'pointer',
                                    backgroundColor: selected?.odoo_id === p.odoo_id ? C.infoBg : 'transparent',
                                    borderBottom: `1px solid ${C.border}`, fontSize: '13px',
                                    display: 'flex', gap: '10px', alignItems: 'center'
                                }}
                            >
                                <OdooImage odooId={p.odoo_id} size={40} />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                                        <span style={{ fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                                        <span style={{
                                            fontSize: '10px', fontWeight: 'bold', padding: '1px 7px', borderRadius: '3px', flexShrink: 0,
                                            backgroundColor: p.active ? C.successBg : C.warningBg,
                                            color: p.active ? C.success : C.warning
                                        }}>
                                            {p.active ? 'ACTIVO' : 'INACTIVO'}
                                        </span>
                                    </div>
                                    {p.internal_ref && <div style={{ fontSize: '11px', color: C.gray }}>Ref: {p.internal_ref}</div>}
                                </div>
                                <div style={{ textAlign: 'right', fontSize: '12px', color: C.gray, flexShrink: 0 }}>
                                    {p.standard_price ? fmtARS(p.standard_price) : '—'}
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {!loading && search.length >= 2 && results.length === 0 && (
                    <p style={{ fontSize: '12px', color: C.gray, marginBottom: '14px' }}>Sin resultados para "{search}"</p>
                )}

                {selected && (
                    <div style={{ backgroundColor: C.successBg, border: `1px solid #A5D6A7`, borderRadius: '4px', padding: '10px 12px', marginBottom: '14px', fontSize: '13px' }}>
                        ✅ <strong>{selected.name}</strong>
                        {!selected.active && <span style={{ color: C.warning, marginLeft: '8px' }}>(inactivo — podés reactivarlo después)</span>}
                    </div>
                )}

                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                    <button onClick={onCancel} style={{ padding: '10px 20px', backgroundColor: C.bg, border: `1px solid ${C.border}`, borderRadius: '4px', cursor: 'pointer', fontSize: '14px' }}>
                        Cancelar
                    </button>
                    <button
                        onClick={() => selected && onLink(selected)}
                        disabled={!selected}
                        style={{ padding: '10px 20px', backgroundColor: selected ? C.primary : '#ccc', color: C.white, border: 'none', borderRadius: '4px', cursor: selected ? 'pointer' : 'not-allowed', fontSize: '14px', fontWeight: 'bold' }}
                    >
                        Vincular y guardar
                    </button>
                </div>
            </div>
        </div>
    );
}

// =============================================
// Helper precio lista
// =============================================
function calcPrecioLista(costoUnitario, discountOverride, defaultDiscount, markupOverride, defaultMarkup) {
    const discount = discountOverride !== null && discountOverride !== undefined ? parseFloat(discountOverride) : (defaultDiscount || 0);
    const markup   = markupOverride   !== null && markupOverride   !== undefined ? parseFloat(markupOverride)   : (defaultMarkup   || 0);
    const costo    = discount > 0 ? costoUnitario * (1 - discount / 100) : costoUnitario;
    return markup > 0 ? Math.ceil(costo * (1 + markup / 100)) : null;
}

// =============================================
// Tarjeta de ítem
// =============================================
function ItemCard({ item, ingreso, onItemUpdate, onReject, onReactivate, reactivating, onLinked, onCreated, creating, lastScannedId, preventaMatchMap = {}, onUpdateOdooProduct, onUploadSupplierPhoto, onUploadPhoto, onAssignSupplier, onAssignWebCateg, costoEnvio = 0, totalFacturaMonto = 0, onPreventaBadgeClick, odooCategories = [], odooWebCategories = [] }) {
    const isMobile = useIsMobile();
    const [linkingOpen, setLinkingOpen] = useState(false);
    const [precioVentaInput, setPrecioVentaInput] = useState('');
    const [editandoPrecio, setEditandoPrecio] = useState(false);
    const [uploadingPhoto, setUploadingPhoto] = useState(false);
    const [photoOk, setPhotoOk] = useState(false);
    const [photoVersion, setPhotoVersion] = useState(0);
    const [assigningSupplier, setAssigningSupplier] = useState(false);
    const [assigningWebCateg, setAssigningWebCateg] = useState(false);
    // Confirmación de match fuzzy del proveedor (local, no se persiste)
    const [supplierMatchConfirmed, setSupplierMatchConfirmed] = useState(
        item.supplier_match_level === 'exact_code' || item.supplier_match_level === 'manual'
    );

    const [photoError, setPhotoError] = useState(null);
    const fileInputRef = useRef(null);

    // Sube la foto (del proveedor o un archivo elegido) y refresca la imagen de Odoo
    const subirFoto = async (upload) => {
        setUploadingPhoto(true);
        setPhotoOk(false);
        setPhotoError(null);
        try {
            const result = await upload();
            if (!result?.success) {
                setPhotoError(result?.error || 'No se pudo guardar la foto');
                return;
            }
            setPhotoOk(true);
            setPhotoVersion(v => v + 1); // fuerza reload de la imagen en Odoo
            setTimeout(() => setPhotoOk(false), 4000);
        } catch (err) {
            setPhotoError(err.message || 'No se pudo guardar la foto');
        } finally {
            setUploadingPhoto(false);
        }
    };

    const handleUploadPhoto = () => subirFoto(onUploadSupplierPhoto);

    const handleFileChosen = (e) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // permite volver a elegir el mismo archivo
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) {
            setPhotoError('La foto no puede pesar más de 5MB');
            return;
        }
        subirFoto(() => onUploadPhoto(file));
    };

    const tieneFoto = !!item.odoo_has_image;

    // Edición inline de ref y barcode de Odoo
    const [refInput, setRefInput]         = useState('');
    const [editandoRef, setEditandoRef]   = useState(false);
    const [barcodeInput, setBarcodeInput] = useState('');
    const [editandoBarcode, setEditandoBarcode] = useState(false);
    const [savingOdoo, setSavingOdoo]     = useState(false);

    // Campos adicionales de Odoo (template-level)
    const [editandoCateg, setEditandoCateg]         = useState(false);
    const [editandoWebCateg, setEditandoWebCateg]   = useState(false);

    const saveOdooField = async (field, value) => {
        setSavingOdoo(true);
        try {
            await onUpdateOdooProduct({ [field]: value });
        } catch (_) {}
        finally { setSavingOdoo(false); }
    };

    const saveOdooFields = async (fields) => {
        setSavingOdoo(true);
        try { await onUpdateOdooProduct(fields); } catch (_) {}
        finally { setSavingOdoo(false); }
    };

    const packSize      = Math.max(1, parseInt(item.pack_size || 1, 10));
    const costoUnitario = parseFloat(item.precio_unitario || 0) / packSize;

    // Descuento y markup efectivos (override o default del proveedor)
    const effectiveDiscount = item.discount_override !== null && item.discount_override !== undefined
        ? parseFloat(item.discount_override)
        : (ingreso.default_discount || 0);
    const effectiveMarkup = item.markup_override !== null && item.markup_override !== undefined
        ? parseFloat(item.markup_override)
        : (ingreso.default_markup || 0);

    // Costo con descuento aplicado
    const costoConDescuento = effectiveDiscount > 0
        ? Math.round(costoUnitario * (1 - effectiveDiscount / 100) * 100) / 100
        : costoUnitario;

    // Porción del envío proporcional al total de la factura completa
    const participacion = (totalFacturaMonto > 0 && item.subtotal > 0)
        ? parseFloat(item.subtotal) / totalFacturaMonto
        : 0;
    const envioUnitario = (costoEnvio > 0 && item.cantidad > 0)
        ? Math.round(costoEnvio * participacion / (item.cantidad * packSize) * 100) / 100
        : 0;
    // Costo real de la factura = descuento + porción de envío (ambos ya son por unidad individual)
    const costoConEnvio = Math.round((costoConDescuento + envioUnitario) * 100) / 100;

    // Precio de venta sugerido (basado en costo total con envío)
    const nuevoPrecioLista = effectiveMarkup > 0
        ? Math.ceil(costoConEnvio * (1 + effectiveMarkup / 100))
        : null;

    const costoAnterior = parseFloat(item.precio_odoo_anterior || 0);
    const diff = costoAnterior > 0 ? pctDiff(costoAnterior, costoConEnvio) : null;
    const hayAlerta = diff !== null && Math.abs(parseFloat(diff)) > 5;

    // Cuando el usuario edita el precio de venta directamente,
    // recalcula el markup implícito sobre el costo total (con descuento + envío)
    const handlePrecioBlur = () => {
        const v = parseFloat(precioVentaInput);
        if (!isNaN(v) && v > 0 && costoConEnvio > 0) {
            const impliedMarkup = Math.round((v / costoConEnvio - 1) * 10000) / 100;
            onItemUpdate(item.id, { markup_override: Math.max(0, impliedMarkup) });
        }
        setEditandoPrecio(false);
    };

    const isMatched  = item.estado_item === 'matched';
    const isNew      = item.estado_item === 'pending' || item.estado_item === 'no_match';
    const isRejected = item.estado_item === 'rejected';
    const isInactive = isMatched && item.odoo_active === false;
    const isHighlighted = item.id === lastScannedId;
    const isComplete = isMatched && (item.received_qty || 0) >= item.cantidad;

    let borderColor = isHighlighted ? C.blue : isNew ? '#EF9A9A' : isInactive ? '#FFB74D' : isComplete ? C.success : C.border;
    let bgColor     = isHighlighted ? '#EBF5FF' : isComplete ? '#F1F8E9' : C.white;

    return (
        <div
            data-itemid={item.id}
            style={{
                backgroundColor: bgColor,
                border: `1.5px solid ${borderColor}`,
                borderRadius: '8px',
                display: 'flex',
                flexDirection: isMobile ? 'column' : 'row',
                gap: '0',
                alignItems: 'stretch',
                overflow: 'hidden',
                boxShadow: isHighlighted ? `0 0 0 3px ${C.blue}33` : '0 1px 4px rgba(0,0,0,0.08)',
                transition: 'all 0.3s'
            }}
        >
            {/* COLUMNA IZQUIERDA: Recibido (solo para matcheados) */}
            {isMatched && (
                <ReceivedCounter item={item} onUpdate={onItemUpdate} isHighlighted={isHighlighted} />
            )}

            {/* COLUMNA CENTRO: datos del CSV */}
            <div style={{ flex: 1, padding: '12px 14px', minWidth: 0 }}>
                {/* Código + badge */}
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '5px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '10px', fontWeight: 'bold', fontFamily: 'monospace', backgroundColor: '#ECEFF1', color: '#455A64', padding: '2px 7px', borderRadius: '3px' }}>
                        {item.codigo || 'S/COD'}
                    </span>
                    {isRejected && (
                        <span style={{ fontSize: '10px', fontWeight: 'bold', backgroundColor: C.error, color: '#fff', padding: '2px 7px', borderRadius: '3px' }}>
                            RECHAZADO
                        </span>
                    )}
                    {item.confidence_match > 0 && item.confidence_match < 0.88 && (
                        <span style={{ fontSize: '10px', color: C.gray }}>⚠ {Math.round(item.confidence_match * 100)}% confianza</span>
                    )}
                    {(() => {
                        const confirmed  = item.preventa_qty_confirmed || 0;
                        const matchInfo  = preventaMatchMap[item.id];
                        const cotizado   = matchInfo?.total_cotizado || 0;
                        if (!confirmed && !cotizado) return null;
                        const isConfirmed = confirmed > 0;
                        return (
                            <span
                                onClick={() => onPreventaBadgeClick && onPreventaBadgeClick(item)}
                                title="Ver detalle del pedido preventa"
                                style={{
                                    display: 'inline-flex', alignItems: 'center', gap: '5px',
                                    fontSize: '10px', fontWeight: 'bold',
                                    backgroundColor: isConfirmed ? '#EDE7F6' : '#FFF8E1',
                                    color: isConfirmed ? '#6A1B9A' : '#E65100',
                                    padding: '2px 8px', borderRadius: '3px',
                                    border: `1px solid ${isConfirmed ? '#CE93D8' : '#FFCC02'}`,
                                    cursor: 'pointer',
                                    userSelect: 'none',
                                }}
                            >
                                🛒 PEDIDO PREVENTA
                                <span style={{
                                    backgroundColor: isConfirmed ? '#7B1FA2' : '#FF8F00',
                                    color: '#fff',
                                    padding: '1px 5px', borderRadius: '2px', fontSize: '9px',
                                    fontWeight: 'bold',
                                }}>
                                    {isConfirmed ? `${confirmed}/${item.cantidad}` : `x${cotizado}`}
                                </span>
                            </span>
                        );
                    })()}
                </div>

                <p style={{ fontWeight: 'bold', fontSize: '13px', color: C.text, margin: '0 0 8px', lineHeight: '1.35' }}>
                    {item.descripcion}
                </p>

                {/* Panel triangulación proveedor */}
                {item.supplier_product_id && (
                    <div style={{
                        border: `1px solid ${item.supplier_match_level === 'exact_code' || item.supplier_match_level === 'manual' ? '#A5D6A7' : '#FFE082'}`,
                        backgroundColor: item.supplier_match_level === 'exact_code' || item.supplier_match_level === 'manual' ? '#F1F8E9' : '#FFFDE7',
                        borderRadius: '6px', padding: '8px 10px', marginBottom: '8px',
                        display: 'flex', gap: '10px', alignItems: 'flex-start'
                    }}>
                        {/* Imagen del proveedor */}
                        {item.supplier_image_url ? (
                            <img
                                src={item.supplier_image_url}
                                alt=""
                                loading="lazy"
                                onError={(e) => { e.target.style.display = 'none'; }}
                                style={{ width: '52px', height: '52px', objectFit: 'contain', borderRadius: '4px', border: `1px solid ${C.border}`, flexShrink: 0, backgroundColor: C.white }}
                            />
                        ) : (
                            <div style={{ width: '52px', height: '52px', backgroundColor: '#EEE', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px', flexShrink: 0 }}>📷</div>
                        )}

                        <div style={{ flex: 1, minWidth: 0 }}>
                            {/* Badge de match */}
                            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '3px', flexWrap: 'wrap' }}>
                                <span style={{
                                    fontSize: '10px', fontWeight: 'bold', padding: '2px 7px', borderRadius: '3px',
                                    backgroundColor: item.supplier_match_level === 'exact_code' ? C.successBg : item.supplier_match_level === 'manual' ? C.infoBg : C.warningBg,
                                    color: item.supplier_match_level === 'exact_code' ? C.success : item.supplier_match_level === 'manual' ? C.blue : C.warning
                                }}>
                                    {item.supplier_match_level === 'exact_code' ? '✓ SKU exacto'
                                     : item.supplier_match_level === 'manual' ? '⚡ Manual'
                                     : `≈ Similar ${Math.round(item.supplier_confidence * 100)}%`}
                                </span>
                                {item.supplier_sku && (
                                    <code style={{ fontSize: '10px', color: C.gray }}>{item.supplier_sku}</code>
                                )}
                            </div>

                            {/* Nombre del producto proveedor */}
                            <p style={{ fontSize: '11px', color: C.text, margin: '0 0 4px', lineHeight: '1.3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {item.supplier_product_name_matched}
                            </p>

                            {/* ¿Es correcto? — solo para fuzzy sin confirmar */}
                            {item.supplier_match_level === 'fuzzy' && !supplierMatchConfirmed && (
                                <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
                                    <button
                                        onClick={() => setSupplierMatchConfirmed(true)}
                                        style={{ padding: '2px 10px', fontSize: '11px', fontWeight: 'bold', borderRadius: '4px', border: `1px solid ${C.success}`, backgroundColor: C.successBg, color: C.success, cursor: 'pointer' }}
                                    >
                                        ✓ Es correcto
                                    </button>
                                    <button
                                        onClick={() => onItemUpdate(item.id, { supplier_product_id: null })}
                                        style={{ padding: '2px 10px', fontSize: '11px', fontWeight: 'bold', borderRadius: '4px', border: `1px solid ${C.error}`, backgroundColor: C.errorBg, color: C.error, cursor: 'pointer' }}
                                    >
                                        ✗ No es este
                                    </button>
                                </div>
                            )}

                            {/* Botón subir foto */}
                            {isMatched && item.supplier_image_url && (
                                <button
                                    onClick={handleUploadPhoto}
                                    disabled={uploadingPhoto || photoOk}
                                    style={{
                                        marginTop: '5px', padding: '3px 10px', fontSize: '11px', fontWeight: 'bold',
                                        borderRadius: '4px', cursor: uploadingPhoto || photoOk ? 'default' : 'pointer',
                                        border: `1px solid ${photoOk ? C.success : C.blue}`,
                                        backgroundColor: photoOk ? C.successBg : C.infoBg,
                                        color: photoOk ? C.success : C.blue
                                    }}
                                >
                                    {photoOk ? '✅ Foto subida a Odoo' : uploadingPhoto ? '⏳ Subiendo...' : '📷 Subir foto a Odoo'}
                                </button>
                            )}
                        </div>
                    </div>
                )}

                {/* Precio factura + Pack */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontSize: '12px', color: C.gray }}>
                        Precio: <strong style={{ color: C.text }}>{fmtARS(item.precio_unitario)}</strong>
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', border: `1px solid ${C.border}`, borderRadius: '4px', padding: '2px 8px', backgroundColor: '#FAFAFA' }}>
                        <span style={{ fontSize: '11px', color: C.gray, fontWeight: 'bold' }}>÷</span>
                        <PackInput value={packSize} onSave={(v) => onItemUpdate(item.id, { pack_size: v })} />
                    </div>
                    {packSize > 1 && (
                        <span style={{ fontSize: '12px', color: C.gray }}>
                            Unit: <strong>{fmtARS(costoUnitario)}</strong>
                        </span>
                    )}
                </div>

                {/* Cálculo de precios: descuento → costo neto → markup → lista */}
                {isMatched && (
                    <div style={{ borderTop: `1px dashed ${C.border}`, paddingTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {/* Descuento */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <span style={{ fontSize: '11px', color: C.gray, width: '50px' }}>Dto %</span>
                                <input
                                    type="number"
                                    value={item.discount_override !== null && item.discount_override !== undefined ? item.discount_override : ''}
                                    placeholder={String(ingreso.default_discount || 0)}
                                    min="0" max="100" step="0.5"
                                    onChange={(e) => {
                                        const v = e.target.value === '' ? null : parseFloat(e.target.value);
                                        onItemUpdate(item.id, { discount_override: v });
                                    }}
                                    style={{ width: '54px', padding: '3px 6px', border: `1px solid ${C.border}`, borderRadius: '4px', fontSize: '12px', textAlign: 'right' }}
                                />
                            </div>
                            <span style={{ fontSize: '11px', color: C.gray }}>→</span>
                            <span style={{ fontSize: '12px' }}>
                                Costo neto: <strong style={{ color: effectiveDiscount > 0 ? C.success : C.text }}>{fmtARS(costoConDescuento)}</strong>
                            </span>
                        </div>

                        {/* Envío prorrateado — solo se muestra si hay costo de envío */}
                        {envioUnitario > 0 && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingLeft: '58px' }}>
                                <span style={{ fontSize: '11px', color: C.gray }}>→</span>
                                <span style={{ fontSize: '12px' }}>
                                    🚚 Envío: <strong style={{ color: '#7B61FF' }}>+{fmtARS(envioUnitario)}</strong>
                                    <span style={{ color: C.gray, marginLeft: '6px' }}>= </span>
                                    <strong style={{ color: C.text }}>Costo real: {fmtARS(costoConEnvio)}</strong>
                                </span>
                            </div>
                        )}

                        {/* Markup + precio editable */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <span style={{ fontSize: '11px', color: C.gray, width: '50px' }}>Mkp %</span>
                                <input
                                    type="number"
                                    value={item.markup_override !== null && item.markup_override !== undefined ? item.markup_override : ''}
                                    placeholder={String(ingreso.default_markup || 0)}
                                    min="0" step="0.5"
                                    onChange={(e) => {
                                        const v = e.target.value === '' ? null : parseFloat(e.target.value);
                                        onItemUpdate(item.id, { markup_override: v });
                                        setEditandoPrecio(false);
                                    }}
                                    style={{ width: '54px', padding: '3px 6px', border: `1px solid ${C.border}`, borderRadius: '4px', fontSize: '12px', textAlign: 'right' }}
                                />
                            </div>
                            <span style={{ fontSize: '11px', color: C.gray }}>→</span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                                <span style={{ fontSize: '11px', color: C.blue, fontWeight: 'bold' }}>Lista:</span>
                                {editandoPrecio ? (
                                    <input
                                        autoFocus
                                        type="number"
                                        min="0"
                                        value={precioVentaInput}
                                        onChange={(e) => setPrecioVentaInput(e.target.value)}
                                        onBlur={handlePrecioBlur}
                                        onKeyDown={(e) => e.key === 'Enter' && handlePrecioBlur()}
                                        style={{ width: '80px', padding: '3px 6px', border: `2px solid ${C.blue}`, borderRadius: '4px', fontSize: '13px', fontWeight: 'bold', color: C.blue, textAlign: 'right' }}
                                    />
                                ) : (
                                    <span
                                        onClick={() => { setPrecioVentaInput(String(nuevoPrecioLista || '')); setEditandoPrecio(true); }}
                                        title="Click para editar el precio de venta"
                                        style={{ fontSize: '13px', fontWeight: 'bold', color: nuevoPrecioLista ? C.blue : C.gray, cursor: 'pointer', borderBottom: `1px dashed ${C.blue}`, paddingBottom: '1px' }}
                                    >
                                        {nuevoPrecioLista ? fmtARS(nuevoPrecioLista) : '—'}
                                    </span>
                                )}
                                {!editandoPrecio && nuevoPrecioLista && (
                                    <span style={{ fontSize: '10px', color: C.gray }}>✏</span>
                                )}
                            </div>
                        </div>

                        {/* Apply checkboxes */}
                        <div style={{ display: 'flex', gap: '12px', marginTop: '2px' }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', cursor: 'pointer' }}>
                                <input type="checkbox" checked={Boolean(item.apply_cost)} onChange={(e) => onItemUpdate(item.id, { apply_cost: e.target.checked })} />
                                Aplicar costo
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', cursor: 'pointer' }}>
                                <input type="checkbox" checked={Boolean(item.apply_price)} onChange={(e) => onItemUpdate(item.id, { apply_price: e.target.checked })} />
                                Aplicar lista
                            </label>
                        </div>
                    </div>
                )}

                {/* Acciones para nuevos */}
                {isNew && !isRejected && (
                    <div style={{ marginTop: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                        {(item.match_level === 'fuzzy_name' || item.match_level === 'ref_other_prefix') && item.odoo_product_id && (
                            <>
                                {item.match_level === 'fuzzy_name' ? (
                                    <span style={{ fontSize: '12px', color: C.text }}>
                                        Parecido: <strong>{item.odoo_product_name}</strong>
                                        {item.confidence_match > 0 ? ` (${Math.round(item.confidence_match * 100)}%)` : ''}. Hay que confirmarlo.
                                    </span>
                                ) : (
                                    <span style={{ fontSize: '12px', color: C.text }}>
                                        Mismo código: <strong>{item.odoo_product_name}</strong>
                                        {item.odoo_internal_ref ? <> (<span style={{ fontFamily: 'monospace' }}>{item.odoo_internal_ref}</span>)</> : ''}, pero está cargado con el prefijo de otro proveedor. Confirmalo si es el mismo producto.
                                    </span>
                                )}
                                <button
                                    onClick={() => onLinked(item.id, item.odoo_product_id)}
                                    style={{ padding: '6px 14px', fontSize: '12px', fontWeight: 'bold', borderRadius: '4px', border: `1px solid ${C.success}`, backgroundColor: C.success, color: C.white, cursor: 'pointer' }}
                                >
                                    Confirmar
                                </button>
                            </>
                        )}
                        <button
                            onClick={() => setLinkingOpen(true)}
                            style={{ padding: '6px 14px', fontSize: '12px', fontWeight: 'bold', borderRadius: '4px', border: `1px solid ${C.secondary}`, backgroundColor: C.secondary, color: C.white, cursor: 'pointer' }}
                        >
                            🔗 Vincular
                        </button>
                        <button
                            onClick={() => onCreated(item.id)}
                            disabled={creating === item.id}
                            style={{ padding: '6px 14px', fontSize: '12px', fontWeight: 'bold', borderRadius: '4px', border: `1px solid ${creating === item.id ? '#ccc' : C.primary}`, backgroundColor: creating === item.id ? '#f5f5f5' : C.primary, color: creating === item.id ? '#aaa' : C.white, cursor: creating === item.id ? 'not-allowed' : 'pointer' }}
                        >
                            {creating === item.id ? '⏳ Creando...' : '+ Crear en Odoo'}
                        </button>
                        {item.error_match && (
                            <span style={{ fontSize: '11px', color: C.error, alignSelf: 'center' }}>{item.error_match}</span>
                        )}
                    </div>
                )}
            </div>

            {/* FLECHA separadora */}
            {isMatched && !isMobile && (
                <div style={{ display: 'flex', alignItems: 'center', padding: '0 8px', color: '#BDBDBD', fontSize: '18px', flexShrink: 0 }}>
                    →
                </div>
            )}

            {/* COLUMNA DERECHA: datos de Odoo */}
            {isMatched && (
                <div style={{ flex: isMobile ? 'none' : 1, padding: '12px 14px', backgroundColor: '#FAFAFA', borderLeft: isMobile ? 'none' : `1px solid ${C.border}`, borderTop: isMobile ? `1px solid ${C.border}` : 'none', minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: '10px' }}>
                        {/* Imagen + cargar o cambiar la foto en Odoo */}
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', flexShrink: 0, width: '84px' }}>
                            <OdooImage odooId={item.odoo_product_id} version={photoVersion} />
                            {onUploadPhoto && (item.odoo_company || 'neggo') === 'neggo' && (
                                <>
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept="image/jpeg,image/png,image/webp"
                                        onChange={handleFileChosen}
                                        style={{ display: 'none' }}
                                    />
                                    <button
                                        onClick={() => fileInputRef.current?.click()}
                                        disabled={uploadingPhoto}
                                        title={tieneFoto ? 'Reemplazar la foto del producto en Odoo' : 'Cargar una foto al producto en Odoo'}
                                        style={{
                                            padding: '3px 6px', fontSize: '10px', fontWeight: 'bold', borderRadius: '4px',
                                            cursor: uploadingPhoto ? 'default' : 'pointer', whiteSpace: 'nowrap',
                                            border: `1px solid ${photoOk ? C.success : tieneFoto ? C.border : C.blue}`,
                                            backgroundColor: photoOk ? C.successBg : tieneFoto ? C.white : C.infoBg,
                                            color: photoOk ? C.success : tieneFoto ? C.gray : C.blue,
                                        }}
                                    >
                                        {uploadingPhoto ? '⏳ Subiendo...' : photoOk ? '✅ Guardada' : tieneFoto ? '📷 Cambiar' : '📷 Cargar foto'}
                                    </button>
                                </>
                            )}
                            {photoError && (
                                <span style={{ fontSize: '10px', color: C.error, textAlign: 'center', lineHeight: '1.2' }}>{photoError}</span>
                            )}
                        </div>

                        <div style={{ flex: 1, minWidth: 0 }}>
                            {/* Estado */}
                            <span style={{
                                fontSize: '10px', fontWeight: 'bold', padding: '2px 7px', borderRadius: '3px',
                                backgroundColor: isInactive ? C.warningBg : C.successBg,
                                color: isInactive ? C.warning : C.success
                            }}>
                                {isInactive ? 'INACTIVO' : 'ACTIVO'}
                            </span>

                            {/* Nombre */}
                            <p style={{ fontSize: '12px', fontWeight: 'bold', color: C.text, margin: '6px 0 8px', lineHeight: '1.3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.odoo_product_name}>
                                {item.odoo_product_name}
                            </p>

                            {/* Ref interna (editable) */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}>
                                <span style={{ fontSize: '10px', color: C.gray, width: '28px', flexShrink: 0 }}>Ref</span>
                                {editandoRef ? (
                                    <input
                                        autoFocus
                                        value={refInput}
                                        onChange={(e) => setRefInput(e.target.value)}
                                        onBlur={async () => { await saveOdooField('default_code', refInput); setEditandoRef(false); }}
                                        onKeyDown={async (e) => { if (e.key === 'Enter') { await saveOdooField('default_code', refInput); setEditandoRef(false); } if (e.key === 'Escape') setEditandoRef(false); }}
                                        style={{ flex: 1, padding: '2px 6px', border: `2px solid ${C.primary}`, borderRadius: '4px', fontSize: '11px', fontFamily: 'monospace' }}
                                    />
                                ) : (
                                    <span
                                        onClick={() => { setRefInput(item.odoo_internal_ref || ''); setEditandoRef(true); }}
                                        title="Click para editar la referencia interna"
                                        style={{ fontSize: '11px', fontFamily: 'monospace', color: item.odoo_internal_ref ? C.text : C.gray, cursor: 'pointer', borderBottom: `1px dashed ${C.border}`, flex: 1 }}
                                    >
                                        {item.odoo_internal_ref || 'Sin referencia ✏'}
                                        {item.odoo_internal_ref && <span style={{ color: C.gray, marginLeft: '4px' }}>✏</span>}
                                    </span>
                                )}
                            </div>

                            {/* Barcode (editable) */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '8px' }}>
                                <span style={{ fontSize: '10px', color: C.gray, width: '28px', flexShrink: 0 }}>EAN</span>
                                {editandoBarcode ? (
                                    <input
                                        autoFocus
                                        value={barcodeInput}
                                        onChange={(e) => setBarcodeInput(e.target.value)}
                                        onBlur={async () => { await saveOdooField('barcode', barcodeInput); setEditandoBarcode(false); }}
                                        onKeyDown={async (e) => { if (e.key === 'Enter') { await saveOdooField('barcode', barcodeInput); setEditandoBarcode(false); } if (e.key === 'Escape') setEditandoBarcode(false); }}
                                        style={{ flex: 1, padding: '2px 6px', border: `2px solid ${C.primary}`, borderRadius: '4px', fontSize: '11px', fontFamily: 'monospace' }}
                                    />
                                ) : (
                                    <span
                                        onClick={() => { setBarcodeInput(item.odoo_barcode || ''); setEditandoBarcode(true); }}
                                        title="Click para editar el código de barras"
                                        style={{ fontSize: '11px', fontFamily: 'monospace', color: item.odoo_barcode ? C.text : C.gray, cursor: 'pointer', borderBottom: `1px dashed ${C.border}`, flex: 1 }}
                                    >
                                        {item.odoo_barcode || 'Sin código de barras ✏'}
                                        {item.odoo_barcode && <span style={{ color: C.gray, marginLeft: '4px' }}>✏</span>}
                                    </span>
                                )}
                                {savingOdoo && <span style={{ fontSize: '10px', color: C.gray }}>⏳</span>}
                            </div>

                            {/* Campos adicionales de Odoo */}
                            <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: '8px', marginBottom: '8px', display: 'flex', flexDirection: 'column', gap: '5px' }}>

                                {/* Toggles: POS + Web */}
                                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', cursor: onUpdateOdooProduct ? 'pointer' : 'default', userSelect: 'none', color: C.text }}>
                                        <input
                                            type="checkbox"
                                            checked={item.odoo_available_in_pos ?? false}
                                            disabled={!onUpdateOdooProduct}
                                            onChange={e => saveOdooField('available_in_pos', e.target.checked)}
                                            style={{ cursor: onUpdateOdooProduct ? 'pointer' : 'default' }}
                                        />
                                        POS
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', cursor: onUpdateOdooProduct ? 'pointer' : 'default', userSelect: 'none', color: C.text }}>
                                        <input
                                            type="checkbox"
                                            checked={item.odoo_is_published ?? false}
                                            disabled={!onUpdateOdooProduct}
                                            onChange={e => saveOdooField('is_published', e.target.checked)}
                                            style={{ cursor: onUpdateOdooProduct ? 'pointer' : 'default' }}
                                        />
                                        Web
                                    </label>
                                </div>

                                {/* Categoría de producto */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                    <span style={{ fontSize: '10px', color: C.gray, width: '34px', flexShrink: 0 }}>Categ</span>
                                    {editandoCateg && odooCategories.length > 0 ? (
                                        <select
                                            autoFocus
                                            defaultValue={item.odoo_categ_id || ''}
                                            onBlur={e => {
                                                const opt = odooCategories.find(c => c.id === parseInt(e.target.value, 10));
                                                if (opt) saveOdooFields({ categ_id: opt.id, categ_name: opt.complete_name || opt.name });
                                                setEditandoCateg(false);
                                            }}
                                            onChange={e => {
                                                const opt = odooCategories.find(c => c.id === parseInt(e.target.value, 10));
                                                if (opt) saveOdooFields({ categ_id: opt.id, categ_name: opt.complete_name || opt.name });
                                                setEditandoCateg(false);
                                            }}
                                            style={{ flex: 1, padding: '2px 4px', border: `2px solid ${C.primary}`, borderRadius: '4px', fontSize: '11px' }}
                                        >
                                            <option value="">— seleccionar —</option>
                                            {odooCategories.map(c => <option key={c.id} value={c.id}>{c.complete_name || c.name}</option>)}
                                        </select>
                                    ) : (
                                        <span
                                            onClick={() => onUpdateOdooProduct && setEditandoCateg(true)}
                                            title={onUpdateOdooProduct ? 'Click para editar la categoría' : undefined}
                                            style={{ fontSize: '11px', color: item.odoo_categ_name ? C.text : C.gray, cursor: onUpdateOdooProduct ? 'pointer' : 'default', borderBottom: onUpdateOdooProduct ? `1px dashed ${C.border}` : 'none', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                        >
                                            {item.odoo_categ_name || 'Sin categoría'}
                                            {onUpdateOdooProduct && <span style={{ color: C.gray, marginLeft: '4px' }}>✏</span>}
                                        </span>
                                    )}
                                </div>

                                {/* Categoría web */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                    <span style={{ fontSize: '10px', color: C.gray, width: '34px', flexShrink: 0 }}>Web</span>
                                    {editandoWebCateg && odooWebCategories.length > 0 ? (
                                        <select
                                            autoFocus
                                            defaultValue={item.odoo_web_categ_id || ''}
                                            onBlur={e => {
                                                const opt = odooWebCategories.find(c => c.id === parseInt(e.target.value, 10));
                                                saveOdooFields({ website_categ_id: opt?.id || null, web_categ_name: opt?.name || null });
                                                setEditandoWebCateg(false);
                                            }}
                                            onChange={e => {
                                                const opt = odooWebCategories.find(c => c.id === parseInt(e.target.value, 10));
                                                saveOdooFields({ website_categ_id: opt?.id || null, web_categ_name: opt?.name || null });
                                                setEditandoWebCateg(false);
                                            }}
                                            style={{ flex: 1, padding: '2px 4px', border: `2px solid ${C.primary}`, borderRadius: '4px', fontSize: '11px' }}
                                        >
                                            <option value="">— sin categoría web —</option>
                                            {odooWebCategories.map(c => <option key={c.id} value={c.id}>{c.complete_name || c.name}</option>)}
                                        </select>
                                    ) : (
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flex: 1, minWidth: 0 }}>
                                            <span
                                                onClick={() => onUpdateOdooProduct && setEditandoWebCateg(true)}
                                                title={onUpdateOdooProduct ? 'Click para editar la categoría web' : undefined}
                                                style={{ fontSize: '11px', color: item.odoo_web_categ_name ? C.text : C.gray, cursor: onUpdateOdooProduct ? 'pointer' : 'default', borderBottom: onUpdateOdooProduct ? `1px dashed ${C.border}` : 'none', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                            >
                                                {item.odoo_web_categ_name || 'Sin categoría web'}
                                                {onUpdateOdooProduct && <span style={{ color: C.gray, marginLeft: '4px' }}>✏</span>}
                                            </span>
                                            {/* Botón para asignar categ. web buscando por nombre de la categ. interna */}
                                            {!item.odoo_web_categ_id && item.odoo_categ_id && onAssignWebCateg && (
                                                <button
                                                    onClick={async () => {
                                                        setAssigningWebCateg(true);
                                                        try { await onAssignWebCateg(item.id); }
                                                        catch (_) {}
                                                        finally { setAssigningWebCateg(false); }
                                                    }}
                                                    disabled={assigningWebCateg}
                                                    title={`Buscar categoría web por nombre "${item.odoo_categ_name}" y asignarla`}
                                                    style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '3px', border: `1px solid ${C.primary}`, backgroundColor: 'transparent', color: C.primary, cursor: assigningWebCateg ? 'not-allowed' : 'pointer', opacity: assigningWebCateg ? 0.5 : 1, whiteSpace: 'nowrap', flexShrink: 0 }}
                                                >
                                                    {assigningWebCateg ? '⏳' : '↓ Categ.'}
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>

                                {/* Proveedor — muestra siempre; si no hay y hay proveedor en el ingreso, permite asignar */}
                                {(item.odoo_vendor_name || (ingreso.supplier_id && item.odoo_product_id)) && (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                        <span style={{ fontSize: '10px', color: C.gray, width: '34px', flexShrink: 0 }}>Prov</span>
                                        {item.odoo_vendor_name ? (
                                            <span style={{ fontSize: '11px', color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.odoo_vendor_name}</span>
                                        ) : (
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flex: 1 }}>
                                                <span style={{ fontSize: '11px', color: C.gray, fontStyle: 'italic' }}>Sin proveedor</span>
                                                {onAssignSupplier && (
                                                    <button
                                                        onClick={async () => {
                                                            setAssigningSupplier(true);
                                                            try { await onAssignSupplier(item.id); }
                                                            catch (_) {}
                                                            finally { setAssigningSupplier(false); }
                                                        }}
                                                        disabled={assigningSupplier}
                                                        title={`Asignar "${ingreso.supplier_name}" como proveedor en Odoo`}
                                                        style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '3px', border: `1px solid ${C.blue}`, backgroundColor: 'transparent', color: C.blue, cursor: assigningSupplier ? 'not-allowed' : 'pointer', opacity: assigningSupplier ? 0.5 : 1, whiteSpace: 'nowrap', flexShrink: 0 }}
                                                    >
                                                        {assigningSupplier ? '⏳' : '+ Asignar'}
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* Costo Odoo + PVP + delta */}
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px', marginBottom: '8px' }}>
                                <div style={{ backgroundColor: C.white, border: `1px solid ${hayAlerta ? '#FFB74D' : C.border}`, borderRadius: '4px', padding: '5px 8px' }}>
                                    <div style={{ fontSize: '9px', color: C.gray, textTransform: 'uppercase', fontWeight: 'bold', marginBottom: '2px' }}>Costo Odoo</div>
                                    <div style={{ fontSize: '12px', fontWeight: 'bold', color: hayAlerta ? C.warning : C.text }}>{fmtARS(costoAnterior)}</div>
                                    {diff !== null && (
                                        <div style={{ fontSize: '10px', fontWeight: 'bold', color: parseFloat(diff) > 0 ? C.warning : C.success }}>
                                            {parseFloat(diff) > 0 ? '▲' : '▼'} {Math.abs(diff)}%
                                        </div>
                                    )}
                                </div>
                                <div style={{ backgroundColor: C.white, border: `1px solid ${C.border}`, borderRadius: '4px', padding: '5px 8px' }}>
                                    <div style={{ fontSize: '9px', color: C.gray, textTransform: 'uppercase', fontWeight: 'bold', marginBottom: '2px' }}>PVP Odoo actual</div>
                                    <div style={{ fontSize: '12px', fontWeight: 'bold', color: C.blue }}>{fmtARS(item.odoo_list_price)}</div>
                                </div>
                            </div>

                            {/* Acciones */}
                            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                                {isInactive && (
                                    <button onClick={() => onReactivate(item.id, item.odoo_product_id)} disabled={reactivating === item.id}
                                        style={{ padding: '4px 10px', fontSize: '11px', fontWeight: 'bold', borderRadius: '4px', border: `1px solid ${C.success}`, backgroundColor: C.success, color: C.white, cursor: reactivating === item.id ? 'not-allowed' : 'pointer', opacity: reactivating === item.id ? 0.6 : 1 }}>
                                        {reactivating === item.id ? '⏳' : '⚡ Reactivar'}
                                    </button>
                                )}
                                <button onClick={() => setLinkingOpen(true)}
                                    style={{ padding: '4px 10px', fontSize: '11px', fontWeight: 'bold', borderRadius: '4px', border: `1px solid ${C.blue}`, backgroundColor: 'transparent', color: C.blue, cursor: 'pointer' }}>
                                    🔗 Cambiar
                                </button>
                                <button onClick={() => onLinked(item.id, null)}
                                    style={{ padding: '4px 10px', fontSize: '11px', fontWeight: 'bold', borderRadius: '4px', border: `1px solid ${C.gray}`, backgroundColor: 'transparent', color: C.gray, cursor: 'pointer' }}>
                                    ✕ Desvincular
                                </button>
                                <button onClick={() => onReject(item.id)}
                                    style={{ padding: '4px 10px', fontSize: '11px', fontWeight: 'bold', borderRadius: '4px', border: `1px solid ${C.error}`, backgroundColor: 'transparent', color: C.error, cursor: 'pointer' }}>
                                    Rechazar
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Modal de vinculación inline */}
            {linkingOpen && (
                <ProductSearchModal
                    item={item}
                    onLink={async (product) => {
                        setLinkingOpen(false);
                        await onLinked(item.id, product.odoo_id);
                    }}
                    onCancel={() => setLinkingOpen(false)}
                />
            )}
        </div>
    );
}

// =============================================
// Barra de filtros
// =============================================
function FilterBar({ filterText, setFilterText, filterMissingBarcode, setFilterMissingBarcode, filterMissingRef, setFilterMissingRef, filterCostDiff, setFilterCostDiff }) {
    const active = filterMissingBarcode || filterMissingRef || filterCostDiff || filterText;

    const chipStyle = (on, warn) => ({
        padding: '6px 12px', fontSize: '12px', fontWeight: 'bold',
        borderRadius: '4px', cursor: 'pointer', whiteSpace: 'nowrap',
        border: `1px solid ${on ? (warn ? C.warning : C.primary) : C.border}`,
        backgroundColor: on ? (warn ? C.warningBg : '#EEF2FF') : C.white,
        color: on ? (warn ? C.warning : C.primary) : C.gray
    });

    return (
        <div style={{ display: 'flex', gap: '8px', padding: '10px 16px', borderTop: `1px solid ${C.border}`, backgroundColor: '#FAFAFA', flexWrap: 'wrap', alignItems: 'center' }}>
            <input
                type="text"
                placeholder="🔍 Filtrar por código, descripción o nombre Odoo..."
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                style={{ flex: 1, minWidth: '200px', padding: '7px 12px', border: `1px solid ${C.border}`, borderRadius: '4px', fontSize: '13px' }}
            />
            <button onClick={() => setFilterMissingBarcode(!filterMissingBarcode)} style={chipStyle(filterMissingBarcode, false)} title="Solo sin EAN en Odoo">
                📷 Sin EAN
            </button>
            <button onClick={() => setFilterMissingRef(!filterMissingRef)} style={chipStyle(filterMissingRef, false)} title="Solo sin referencia interna">
                # Sin Ref
            </button>
            <button onClick={() => setFilterCostDiff(!filterCostDiff)} style={chipStyle(filterCostDiff, true)} title="Solo con diferencia de costo >5%">
                ▲ Dif. Costo
            </button>
            {active && (
                <button
                    onClick={() => { setFilterText(''); setFilterMissingBarcode(false); setFilterMissingRef(false); setFilterCostDiff(false); }}
                    style={{ ...chipStyle(true, false), borderColor: C.error, backgroundColor: C.errorBg, color: C.error }}
                >
                    ✕ Limpiar
                </button>
            )}
        </div>
    );
}

// =============================================
// Modal crear producto en Odoo
// =============================================
function CreateOdooModal({ item, ingreso, onConfirm, onCancel }) {
    const { onDragStart, dragStyle, containerStyle, overlayStyle } = useDraggable();
    const markup      = ingreso?.default_markup || 0;
    const prefix      = ingreso?.supplier_prefix || '';

    // Costo real = precio_unitario / pack_size → descuento → + porción de envío
    const packSize        = Math.max(1, parseInt(item.pack_size || 1, 10));
    const costoBase       = parseFloat(item.precio_unitario || 0) / packSize;
    const discount        = item.discount_override !== null && item.discount_override !== undefined
        ? parseFloat(item.discount_override)
        : (ingreso?.default_discount || 0);
    const costoConDto     = discount > 0
        ? Math.round(costoBase * (1 - discount / 100) * 100) / 100
        : costoBase;
    const totalMonto      = parseFloat(ingreso?.total_monto || 0);
    const costoEnvio      = parseFloat(ingreso?.costo_envio || 0);
    const participacion   = (totalMonto > 0 && item.subtotal > 0)
        ? parseFloat(item.subtotal) / totalMonto
        : 0;
    const envioUnitario   = (costoEnvio > 0 && item.cantidad > 0)
        ? Math.round(costoEnvio * participacion / (item.cantidad * packSize) * 100) / 100
        : 0;
    const cost            = Math.round((costoConDto + envioUnitario) * 100) / 100;
    const suggested       = markup > 0 ? Math.round(cost * (1 + markup / 100) * 100) / 100 : cost;

    const [name, setName]           = useState(item.descripcion || '');
    const [salePrice, setSalePrice] = useState(String(suggested || ''));
    const [ref, setRef]             = useState(
        prefix && item.codigo ? `${prefix}-${item.codigo}` : item.codigo || ''
    );
    const [barcode, setBarcode]     = useState('');
    const [publishPos, setPublishPos] = useState(true);
    const [publishWeb, setPublishWeb] = useState(false);

    // Búsqueda de categorías Odoo
    const [categSearch, setCategSearch] = useState('');
    const [categResults, setCategResults] = useState([]);
    const [selectedCateg, setSelectedCateg] = useState(null);
    const [loadingCateg, setLoadingCateg] = useState(false);
    const [autoWebCategId, setAutoWebCategId] = useState(null);

    useEffect(() => {
        if (!categSearch || categSearch.length < 2) { setCategResults([]); return; }
        const t = setTimeout(async () => {
            setLoadingCateg(true);
            try {
                const res = await api.get('/products/odoo/categories', { search: categSearch });
                if (res.success) setCategResults(res.data || []);
            } catch (_) {}
            finally { setLoadingCateg(false); }
        }, 350);
        return () => clearTimeout(t);
    }, [categSearch]);

    const inputStyle = {
        width: '100%', padding: '8px 10px',
        border: `1px solid ${C.border}`, borderRadius: '4px',
        fontSize: '13px', boxSizing: 'border-box'
    };
    const labelStyle = { fontSize: '11px', color: C.gray, marginBottom: '3px', display: 'block' };

    return (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, ...overlayStyle }}>
            <div style={{ backgroundColor: C.white, borderRadius: '10px', padding: '26px', width: '480px', maxWidth: '94vw', boxShadow: '0 10px 40px rgba(0,0,0,0.25)', maxHeight: '90vh', overflowY: 'auto', ...containerStyle }}>
                <h3 onMouseDown={onDragStart} style={{ color: C.primary, fontSize: '16px', margin: '0 0 4px', ...dragStyle }}>+ Crear producto en Odoo</h3>
                <p style={{ color: C.gray, fontSize: '12px', margin: '0 0 18px' }}>
                    Código CSV: <code style={{ backgroundColor: '#ECEFF1', padding: '1px 6px', borderRadius: '3px' }}>{item.codigo || 'S/COD'}</code>
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    {/* Nombre */}
                    <div>
                        <label style={labelStyle}>Nombre del producto *</label>
                        <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} />
                    </div>

                    {/* Precio costo + venta */}
                    <div style={{ display: 'flex', gap: '10px' }}>
                        <div style={{ flex: 1 }}>
                            <label style={labelStyle}>
                                Costo real
                                {packSize > 1 && <span style={{ color: C.blue }}> (÷{packSize})</span>}
                                {discount > 0 && <span style={{ color: C.success }}> −{discount}%</span>}
                                {envioUnitario > 0 && <span style={{ color: '#7B61FF' }}> +envío</span>}
                            </label>
                            <input style={{ ...inputStyle, backgroundColor: C.bg, color: C.gray }} value={fmtARS(cost)} disabled />
                        </div>
                        <div style={{ flex: 1 }}>
                            <label style={labelStyle}>Precio de venta *</label>
                            <input style={inputStyle} type="number" min="0" step="0.01"
                                value={salePrice} onChange={e => setSalePrice(e.target.value)} />
                        </div>
                    </div>

                    {/* Referencia interna */}
                    <div>
                        <label style={labelStyle}>Referencia interna {prefix && <span style={{ color: C.blue }}>(prefijo: {prefix})</span>}</label>
                        <input style={inputStyle} value={ref} onChange={e => setRef(e.target.value)} />
                    </div>

                    {/* Código de barra */}
                    <div>
                        <label style={labelStyle}>Código de barras (EAN)</label>
                        <input style={inputStyle} value={barcode} onChange={e => setBarcode(e.target.value)} placeholder="Opcional" />
                    </div>

                    {/* Categoría Odoo */}
                    <div>
                        <label style={labelStyle}>Categoría en Odoo</label>
                        {selectedCateg ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', backgroundColor: C.infoBg, borderRadius: '4px', border: `1px solid #90CAF9`, fontSize: '13px' }}>
                                <span style={{ flex: 1, color: C.blue }}>{selectedCateg.complete_name}</span>
                                {autoWebCategId && <span style={{ fontSize: '11px', color: C.success }}>✓ categ. web asignada</span>}
                                <button onClick={() => { setSelectedCateg(null); setCategSearch(''); setAutoWebCategId(null); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.gray, fontSize: '14px' }}>✕</button>
                            </div>
                        ) : (
                            <>
                                <input style={inputStyle} placeholder="Buscar categoría..."
                                    value={categSearch} onChange={e => setCategSearch(e.target.value)} />
                                {loadingCateg && <p style={{ fontSize: '11px', color: C.gray, margin: '4px 0' }}>Buscando...</p>}
                                {categResults.length > 0 && (
                                    <div style={{ border: `1px solid ${C.border}`, borderRadius: '4px', maxHeight: '140px', overflowY: 'auto', marginTop: '4px' }}>
                                        {categResults.map(c => (
                                            <div key={c.id} onClick={() => {
                                                setSelectedCateg(c);
                                                setCategResults([]);
                                                setCategSearch('');
                                                // Auto-buscar categoría web con el mismo nombre
                                                api.get('/products/odoo/web-categories', { search: c.name }).then(res => {
                                                    if (res.success && res.data?.length > 0) {
                                                        const exact = res.data.find(w => w.name.toLowerCase() === c.name.toLowerCase());
                                                        setAutoWebCategId((exact || res.data[0]).id);
                                                    }
                                                }).catch(() => {});
                                            }}
                                                style={{ padding: '7px 10px', cursor: 'pointer', fontSize: '12px', borderBottom: `1px solid ${C.border}` }}
                                                onMouseEnter={e => e.currentTarget.style.backgroundColor = C.infoBg}
                                                onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
                                            >
                                                {c.complete_name}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </>
                        )}
                    </div>

                    {/* Publicaciones */}
                    <div style={{ display: 'flex', gap: '20px', paddingTop: '4px' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', cursor: 'pointer' }}>
                            <input type="checkbox" checked={publishPos} onChange={e => setPublishPos(e.target.checked)} />
                            Publicar en punto de venta
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', cursor: 'pointer' }}>
                            <input type="checkbox" checked={publishWeb} onChange={e => setPublishWeb(e.target.checked)} />
                            Publicar en web
                        </label>
                    </div>
                </div>

                <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '22px' }}>
                    <button onClick={onCancel}
                        style={{ padding: '9px 20px', borderRadius: '6px', border: `1px solid ${C.border}`, backgroundColor: C.white, color: C.text, cursor: 'pointer', fontSize: '14px' }}>
                        Cancelar
                    </button>
                    <button
                        onClick={() => onConfirm({
                            name: name.trim(),
                            sale_price: parseFloat(salePrice) || undefined,
                            default_code: ref.trim(),
                            barcode: barcode.trim() || undefined,
                            categ_id: selectedCateg?.id || undefined,
                            website_categ_id: autoWebCategId || undefined,
                            publish_pos: publishPos,
                            publish_web: publishWeb,
                        })}
                        disabled={!name.trim()}
                        style={{ padding: '9px 20px', borderRadius: '6px', border: 'none', backgroundColor: C.primary, color: C.white, cursor: name.trim() ? 'pointer' : 'not-allowed', fontSize: '14px', fontWeight: 'bold', opacity: name.trim() ? 1 : 0.6 }}>
                        Crear en Odoo
                    </button>
                </div>
            </div>
        </div>
    );
}

// =============================================
// Modal partner Odoo (purchase.order)
// =============================================
function PartnerModal({ onConfirm, onCancel, titulo, subtitulo }) {
    const [search, setSearch]     = useState('');
    const [partners, setPartners] = useState([]);
    const [loading, setLoading]   = useState(false);
    const [selected, setSelected] = useState(null);
    const { onDragStart, dragStyle, containerStyle, overlayStyle } = useDraggable();

    useEffect(() => {
        if (!search || search.length < 2) { setPartners([]); return; }
        const t = setTimeout(async () => {
            setLoading(true);
            try {
                const res = await api.get('/products/odoo/partners', { search, limit: 10 });
                if (res.success) setPartners(res.data || []);
            } catch (_) {}
            finally { setLoading(false); }
        }, 400);
        return () => clearTimeout(t);
    }, [search]);

    return (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, ...overlayStyle }}>
            <div style={{ backgroundColor: C.white, borderRadius: '8px', padding: '24px', width: '480px', maxWidth: '90vw', boxShadow: '0 8px 32px rgba(0,0,0,0.2)', ...containerStyle }}>
                <h3 onMouseDown={onDragStart} style={{ marginBottom: '16px', color: C.primary, ...dragStyle }}>{titulo || '🔗 Vincular proveedor en Odoo'}</h3>
                <p style={{ fontSize: '13px', color: C.gray, marginBottom: '16px' }}>
                    {subtitulo || 'Buscá el proveedor para crear la orden de compra. Podés omitir este paso.'}
                </p>
                <input autoFocus type="text" placeholder="Buscar proveedor..." value={search} onChange={(e) => setSearch(e.target.value)}
                    style={{ width: '100%', padding: '10px 12px', border: `1px solid ${C.border}`, borderRadius: '4px', fontSize: '14px', boxSizing: 'border-box', marginBottom: '12px' }} />
                {loading && <p style={{ fontSize: '13px', color: C.gray }}>Buscando...</p>}
                {partners.length > 0 && (
                    <div style={{ border: `1px solid ${C.border}`, borderRadius: '4px', maxHeight: '200px', overflowY: 'auto', marginBottom: '16px' }}>
                        {partners.map(p => (
                            <div key={p.id} onClick={() => setSelected(p)}
                                style={{ padding: '10px 12px', cursor: 'pointer', backgroundColor: selected?.id === p.id ? C.infoBg : 'transparent', borderBottom: `1px solid ${C.border}`, fontSize: '13px' }}>
                                <strong>{p.name}</strong>
                                {p.vat && <span style={{ color: C.gray, marginLeft: '8px' }}>{p.vat}</span>}
                            </div>
                        ))}
                    </div>
                )}
                {selected && (
                    <div style={{ backgroundColor: C.successBg, border: `1px solid #A5D6A7`, borderRadius: '4px', padding: '10px 12px', marginBottom: '16px', fontSize: '13px' }}>
                        ✅ Seleccionado: <strong>{selected.name}</strong>
                    </div>
                )}
                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                    <button onClick={onCancel} style={{ padding: '10px 20px', backgroundColor: C.bg, border: `1px solid ${C.border}`, borderRadius: '4px', cursor: 'pointer', fontSize: '14px' }}>
                        Omitir
                    </button>
                    <button onClick={() => onConfirm(selected?.id || null)}
                        style={{ padding: '10px 20px', backgroundColor: C.primary, color: C.white, border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold' }}>
                        Confirmar ingreso
                    </button>
                </div>
            </div>
        </div>
    );
}

// =============================================
// Modal para vincular manualmente un ítem a una cotización de Preventas
// =============================================
function PreventaLinkModal({ item, quotations, loading, onSave, onCancel }) {
    const [search, setSearch]     = useState('');
    const [selected, setSelected] = useState(null); // { quotation, line }
    const [qty, setQty]           = useState('');
    const { onDragStart, dragStyle, containerStyle, overlayStyle } = useDraggable();

    const todasLasLineas = quotations.flatMap(q =>
        (q.lines || []).map(l => ({ ...l, quotation: q }))
    );

    const filtradas = search.length >= 2
        ? todasLasLineas.filter(l => {
            const s = search.toLowerCase();
            return (l.product_name || '').toLowerCase().includes(s)
                || (l.quotation.client || '').toLowerCase().includes(s)
                || (l.quotation.name || '').toLowerCase().includes(s);
          })
        : todasLasLineas;

    const handleSelect = (line) => {
        setSelected(line);
        setQty(String(Math.min(line.quantity, remainingQty)));
    };

    const linkedQty   = (item.preventa_links || []).reduce((s, l) => s + (l.qty || 0), 0);
    const remainingQty = item.cantidad - linkedQty;

    const handleSave = () => {
        if (!selected) return;
        const q = Math.max(0, Math.min(parseInt(qty) || 0, remainingQty));
        onSave(item.id, {
            preventas_product_id:   selected.product_id,
            preventas_product_name: selected.product_name,
            quotation_id:   selected.quotation?.id   || null,
            quotation_name: selected.quotation?.name || null,
            client:         selected.quotation?.client || null,
            qty: q,
        });
    };

    return (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100, ...overlayStyle }}>
            <div style={{ backgroundColor: C.white, borderRadius: '10px', padding: '24px', width: '600px', maxWidth: '95vw', boxShadow: '0 10px 40px rgba(0,0,0,0.25)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', gap: '14px', ...containerStyle }}>
                <h3 onMouseDown={onDragStart} style={{ color: '#7B1FA2', margin: 0, ...dragStyle }}>🔗 Vincular a cotización de Preventas</h3>
                <p style={{ margin: 0, fontSize: '13px', color: C.gray }}>
                    Ítem: <strong>{item.descripcion}</strong> · En factura: <strong>{item.cantidad}</strong> uds
                    {linkedQty > 0 && <span style={{ color: '#7B1FA2', fontWeight: 'bold' }}> · Ya asignadas: {linkedQty} · Disponibles: {remainingQty}</span>}
                </p>

                <input
                    autoFocus
                    type="text"
                    placeholder="Buscar por producto, cliente o cotización..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    style={{ padding: '9px 12px', border: `1px solid ${C.border}`, borderRadius: '4px', fontSize: '13px' }}
                />

                {loading ? (
                    <p style={{ textAlign: 'center', color: C.gray }}>⏳ Cargando cotizaciones...</p>
                ) : (
                    <div style={{ overflowY: 'auto', flex: 1, maxHeight: '340px', border: `1px solid ${C.border}`, borderRadius: '6px' }}>
                        {filtradas.length === 0 ? (
                            <p style={{ textAlign: 'center', color: C.gray, padding: '24px', fontSize: '13px' }}>
                                {search.length < 2 ? 'Escribí al menos 2 caracteres para buscar.' : 'Sin resultados.'}
                            </p>
                        ) : filtradas.map((l, i) => {
                            const isSel = selected?.line_id === l.line_id ?? selected?.id === l.id;
                            return (
                                <div key={i} onClick={() => handleSelect(l)}
                                    style={{ display: 'flex', gap: '10px', alignItems: 'center', padding: '9px 12px', cursor: 'pointer', borderBottom: `1px solid ${C.border}`, backgroundColor: isSel ? '#EDE7F6' : 'transparent', transition: 'background 0.1s' }}>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontWeight: 'bold', fontSize: '13px', color: isSel ? '#6A1B9A' : C.text }}>{l.product_name}</div>
                                        <div style={{ fontSize: '11px', color: C.gray }}>
                                            {l.quotation.name} · 👤 {l.quotation.client || 'Sin cliente'} · {l.quotation.date ? new Date(l.quotation.date).toLocaleDateString('es-AR') : ''}
                                        </div>
                                    </div>
                                    <span style={{ fontSize: '12px', color: '#7B1FA2', fontWeight: 'bold', flexShrink: 0 }}>x{l.quantity}</span>
                                    <span style={{ fontSize: '11px', color: C.blue, flexShrink: 0 }}>${Number(l.unit_price || 0).toLocaleString('es-AR')}</span>
                                    {isSel && <span style={{ color: '#2E7D32', fontSize: '16px' }}>✓</span>}
                                </div>
                            );
                        })}
                    </div>
                )}

                {selected && (
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'center', backgroundColor: '#F3E5F5', borderRadius: '6px', padding: '10px 14px', fontSize: '13px' }}>
                        <span style={{ flex: 1, color: '#4A148C' }}>Cantidad a confirmar para <strong>{selected.product_name}</strong>:</span>
                        <input
                            type="number" min="0" max={remainingQty}
                            value={qty}
                            onChange={e => setQty(e.target.value)}
                            style={{ width: '60px', padding: '5px 8px', border: `1.5px solid #7B1FA2`, borderRadius: '4px', fontSize: '14px', fontWeight: 'bold', textAlign: 'center' }}
                        />
                        <span style={{ color: C.gray }}>/ {remainingQty} disponibles</span>
                    </div>
                )}

                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                    <button onClick={onCancel} style={{ padding: '9px 20px', border: `1px solid ${C.border}`, borderRadius: '4px', background: C.bg, cursor: 'pointer', fontSize: '14px' }}>Cancelar</button>
                    <button
                        onClick={handleSave}
                        disabled={!selected || !qty}
                        style={{ padding: '9px 20px', border: 'none', borderRadius: '4px', backgroundColor: selected && qty ? '#7B1FA2' : '#ccc', color: C.white, cursor: selected && qty ? 'pointer' : 'not-allowed', fontSize: '14px', fontWeight: 'bold' }}
                    >Vincular</button>
                </div>
            </div>
        </div>
    );
}

// =============================================
// Tarjeta de ítem en el tab Preventa
// =============================================
function PreventaItemCard({ pi, confirmed, imagenId, insuficiente, discount = 0, onConfirm }) {
    const [saving, setSaving] = useState(false);
    const saveTimer = useRef(null);
    const userModified = useRef(false);

    // Combinar líneas del mismo cliente con el mismo artículo (mismo product_id)
    const cotizacionesMerged = (() => {
        const groups = new Map();
        for (const c of pi.cotizaciones) {
            const gKey = c.product_id
                ? `${c.client || ''}|||${c.product_id}`
                : `${c.client || ''}|||__line_${c.line_id}`;
            if (groups.has(gKey)) {
                const g = groups.get(gKey);
                g.quantity += c.quantity;
                g.subtotal = (g.subtotal || 0) + (c.subtotal || 0);
                if (!g._quotation_names.includes(c.quotation_name)) g._quotation_names.push(c.quotation_name);
            } else {
                groups.set(gKey, { ...c, _rowKey: `${c.quotation_id}-${c.line_id}`, _quotation_names: [c.quotation_name] });
            }
        }
        return [...groups.values()];
    })();

    // Estado por cliente: checked (confirmado) + qty (cuánto — default = cotizado completo)
    const initState = (confirmedTotal) => {
        let remaining = confirmedTotal || 0;
        const s = {};
        for (const c of cotizacionesMerged) {
            const key = c._rowKey;
            if (remaining > 0) {
                const assign = Math.min(remaining, c.quantity);
                s[key] = { checked: true, qty: assign };
                remaining -= assign;
            } else {
                s[key] = { checked: false, qty: c.quantity };
            }
        }
        return s;
    };

    const [rows, setRows] = useState(() => initState(confirmed));
    // Solo re-inicializar desde el servidor si el usuario no modificó el estado local.
    // Sin este guard, initState pisa la selección del usuario porque distribuye el total
    // de forma greedy desde el índice 0, ignorando qué ítems específicos se marcaron.
    useEffect(() => {
        if (!userModified.current) {
            setRows(initState(confirmed));
        }
    }, [confirmed]);

    const calcTotal = (s) => Math.min(
        Object.values(s).reduce((sum, v) => sum + (v.checked ? v.qty : 0), 0),
        pi.ingreso_cantidad
    );

    const totalConfirmado = calcTotal(rows);
    const disponibles     = pi.ingreso_cantidad - totalConfirmado;

    const persist = (newRows) => {
        userModified.current = true;
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(async () => {
            setSaving(true);
            await onConfirm(calcTotal(newRows));
            setSaving(false);
        }, 400);
    };

    // Toggle checkbox: confirmar/desconfirmar con el qty actual del input
    const toggleCheck = (key) => {
        const next = { ...rows, [key]: { ...rows[key], checked: !rows[key].checked } };
        setRows(next);
        persist(next);
    };

    // Editar cantidad: si está checked, auto-guarda; si no, solo actualiza el input
    const handleQtyChange = (key, maxQty, rawVal) => {
        const val = Math.max(1, Math.min(maxQty, parseInt(rawVal) || 1));
        const next = { ...rows, [key]: { ...rows[key], qty: val } };
        setRows(next);
        if (rows[key].checked) persist(next); // auto-guarda si ya estaba confirmado
    };

    return (
        <div style={{ backgroundColor: C.white, border: `1.5px solid ${insuficiente ? '#EF9A9A' : '#CE93D8'}`, borderLeft: `4px solid ${insuficiente ? C.error : '#7B1FA2'}`, borderRadius: '8px', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' }}>
            {/* Cabecera */}
            <div style={{ display: 'flex', gap: '14px', padding: '14px 16px', alignItems: 'flex-start' }}>
                <OdooImage odooId={imagenId} company="preventas" size={72} />
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '4px' }}>
                        {pi.codigo && <span style={{ fontSize: '10px', fontFamily: 'monospace', backgroundColor: '#ECEFF1', padding: '2px 7px', borderRadius: '3px', color: '#455A64' }}>{pi.codigo}</span>}
                        {insuficiente && <span style={{ fontSize: '10px', fontWeight: 'bold', backgroundColor: C.errorBg, color: C.error, padding: '2px 7px', borderRadius: '3px' }}>⚠ demanda supera stock</span>}
                    </div>
                    <p style={{ fontWeight: 'bold', fontSize: '14px', color: C.text, margin: '0 0 8px', lineHeight: '1.35' }}>
                        {pi.odoo_product_name || pi.descripcion}
                    </p>
                    <div style={{ display: 'flex', gap: '16px', fontSize: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
                        <span style={{ color: C.gray }}>En factura: <strong style={{ color: C.text }}>{pi.ingreso_cantidad}</strong></span>
                        <span style={{ color: '#7B1FA2', fontWeight: 'bold' }}>Cotizado: {pi.total_cotizado}</span>
                        {pi.precio_factura > 0 && (() => {
                            const costoNeto = discount > 0
                                ? Math.round(pi.precio_factura * (1 - discount / 100) * 100) / 100
                                : pi.precio_factura;
                            return (
                                <span style={{ color: C.gray }}>
                                    Costo: <strong style={{ color: C.text, fontFamily: 'monospace' }}>${Number(costoNeto).toLocaleString('es-AR')}</strong>
                                    {discount > 0 && <span style={{ fontSize: '10px', color: C.gray }}> ({discount}% dto)</span>}
                                </span>
                            );
                        })()}
                        {totalConfirmado > 0
                            ? <span style={{ color: C.success, fontWeight: 'bold' }}>✅ Separado: {totalConfirmado} · {disponibles} disponibles</span>
                            : <span style={{ color: C.gray }}>Sin separar aún</span>}
                        {saving && <span style={{ color: C.gray, fontSize: '11px' }}>⏳</span>}
                    </div>
                </div>
                {totalConfirmado > 0 && (
                    <button
                        onClick={() => {
                            const reset = Object.fromEntries(
                                cotizacionesMerged.map(c => [c._rowKey, { checked: false, qty: c.quantity }])
                            );
                            setRows(reset);
                            persist(reset);
                        }}
                        style={{ fontSize: '11px', color: C.gray, background: 'none', border: `1px solid ${C.border}`, borderRadius: '4px', cursor: 'pointer', padding: '4px 8px', flexShrink: 0 }}
                    >
                        Resetear
                    </button>
                )}
            </div>

            {/* Filas de clientes */}
            <div style={{ borderTop: `1px solid #F3E5F5`, padding: '8px 16px', display: 'flex', flexDirection: 'column', gap: '6px', backgroundColor: '#FAFAFA' }}>
                {cotizacionesMerged.map((c, i) => {
                    const key      = c._rowKey;
                    const row      = rows[key] || { checked: false, qty: c.quantity };
                    const isParcial = row.checked && row.qty < c.quantity;

                    return (
                        <div key={i} style={{
                            display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px',
                            backgroundColor: row.checked ? '#E8F5E9' : '#F3E5F5',
                            border: `1.5px solid ${isParcial ? '#FFE082' : row.checked ? '#A5D6A7' : '#E1BEE7'}`,
                            borderRadius: '6px', fontSize: '12px', flexWrap: 'wrap',
                            opacity: saving ? 0.7 : 1, transition: 'all 0.15s',
                        }}>

                            {/* Checkbox — confirma con el qty que tenga el input */}
                            <div
                                onClick={() => toggleCheck(key)}
                                style={{
                                    width: '18px', height: '18px', borderRadius: '4px', flexShrink: 0, cursor: 'pointer',
                                    border: `2px solid ${row.checked ? '#2E7D32' : '#CE93D8'}`,
                                    backgroundColor: row.checked ? '#2E7D32' : 'transparent',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    color: '#fff', fontSize: '11px', fontWeight: 'bold',
                                }}
                            >{row.checked ? '✓' : ''}</div>

                            {/* Input parcial — cantidad confirmable */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '3px', flexShrink: 0 }}>
                                <button
                                    onClick={() => handleQtyChange(key, c.quantity, row.qty - 1)}
                                    style={{ width: '20px', height: '20px', borderRadius: '3px', border: `1px solid ${C.border}`, background: C.white, cursor: 'pointer', fontSize: '13px', lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}
                                >−</button>
                                <input
                                    type="number" min="1" max={c.quantity}
                                    value={row.qty}
                                    onClick={e => e.stopPropagation()}
                                    onChange={e => handleQtyChange(key, c.quantity, e.target.value)}
                                    style={{ width: '38px', textAlign: 'center', padding: '2px 3px', border: `1.5px solid ${isParcial ? '#FFC107' : row.checked ? '#2E7D32' : C.border}`, borderRadius: '4px', fontSize: '13px', fontWeight: 'bold' }}
                                />
                                <button
                                    onClick={() => handleQtyChange(key, c.quantity, row.qty + 1)}
                                    style={{ width: '20px', height: '20px', borderRadius: '3px', border: `1px solid ${C.border}`, background: C.white, cursor: 'pointer', fontSize: '13px', lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}
                                >+</button>
                                <span style={{ fontSize: '10px', color: C.gray }}>/{c.quantity}</span>
                            </div>

                            <span style={{ fontWeight: 'bold', color: row.checked ? '#2E7D32' : '#4A148C', minWidth: '80px' }}>{c._quotation_names.join(' + ')}</span>
                            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                                <span style={{ color: C.text }}>👤 {c.client || 'Sin cliente'}</span>
                                {c.product_name && <span style={{ fontSize: '11px', color: '#7B1FA2', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.product_name}</span>}
                            </div>
                            <span style={{ color: C.gray, fontSize: '11px' }}>{c.date ? new Date(c.date).toLocaleDateString('es-AR') : '—'}</span>
                            <span style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '8px', backgroundColor: c.state === 'draft' ? C.warningBg : C.infoBg, color: c.state === 'draft' ? C.warning : C.blue }}>
                                {c.state === 'draft' ? 'Borrador' : 'Enviada'}
                            </span>
                            <span style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '8px', backgroundColor: '#E8F5E9', color: '#2E7D32' }}>
                                {c.match_type === 'pre_prefijo_codigo' || c.match_type === 'pre_codigo' ? '🎯 código' : `≈ nombre ${Math.round(c.match_score * 100)}%`}
                            </span>
                            {(() => {
                                const costoBruto = parseFloat(pi.precio_factura || 0);
                                const costo  = discount > 0
                                    ? Math.round(costoBruto * (1 - discount / 100) * 100) / 100
                                    : costoBruto;
                                const precio = parseFloat(c.unit_price || 0);
                                const margen = costo > 0 && precio > 0
                                    ? Math.round((precio - costo) / costo * 100)
                                    : null;
                                const margenColor = margen === null ? C.gray
                                    : margen >= 20 ? '#2E7D32'
                                    : margen >= 0  ? '#E65100'
                                    : C.error;
                                return (
                                    <span style={{ fontSize: '11px', fontFamily: 'monospace', display: 'flex', gap: '4px', alignItems: 'center', flexShrink: 0 }}>
                                        {costo > 0 && <span style={{ color: C.gray }}>${Number(costo).toLocaleString('es-AR')}</span>}
                                        {costo > 0 && precio > 0 && <span style={{ color: C.gray }}>→</span>}
                                        <span style={{ color: C.blue, fontWeight: 'bold' }}>${Number(precio).toLocaleString('es-AR')}</span>
                                        {margen !== null && (
                                            <span style={{ color: margenColor, fontWeight: 'bold', fontSize: '11px' }}>
                                                ({margen >= 0 ? '+' : ''}{margen}%)
                                            </span>
                                        )}
                                    </span>
                                );
                            })()}
                            {row.checked && (
                                <span style={{ fontSize: '10px', fontWeight: 'bold', flexShrink: 0, padding: '2px 8px', borderRadius: '8px', color: isParcial ? '#E65100' : '#2E7D32', backgroundColor: isParcial ? '#FFF3E0' : '#C8E6C9' }}>
                                    {isParcial ? `⚡ ${row.qty}/${c.quantity}` : '✅ COMPLETO'}
                                </span>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// =============================================
// Modal de detalle de preventa — abierto al tocar el badge desde cualquier tab
// =============================================
function PreventaDetailModal({ item, pi, confirmed, discount, onConfirm, onClose, onOpenLink }) {
    const { onDragStart, dragStyle, containerStyle, overlayStyle } = useDraggable();
    const imagenId     = pi?.cotizaciones?.[0]?.product_id || null;
    const insuficiente = pi ? pi.total_cotizado > pi.ingreso_cantidad : false;

    return (
        <div
            onClick={e => e.target === e.currentTarget && onClose()}
            style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100, ...overlayStyle }}
        >
            <div style={{ backgroundColor: C.white, borderRadius: '10px', width: '740px', maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.25)', ...containerStyle }}>
                <div onMouseDown={onDragStart} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: `1px solid #E1BEE7`, backgroundColor: '#F3E5F5', borderRadius: '10px 10px 0 0', ...dragStyle }}>
                    <h3 style={{ margin: 0, color: '#4A148C', fontSize: '15px' }}>🛒 Pedido Preventa · {item.descripcion}</h3>
                    <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: C.gray, lineHeight: 1 }}>✕</button>
                </div>

                <div style={{ padding: '16px' }}>
                    {pi ? (
                        <PreventaItemCard
                            pi={pi}
                            confirmed={confirmed}
                            imagenId={imagenId}
                            insuficiente={insuficiente}
                            discount={discount}
                            onConfirm={onConfirm}
                        />
                    ) : (
                        <div style={{ backgroundColor: C.white, border: `1.5px solid #CE93D8`, borderLeft: `4px solid #7B1FA2`, borderRadius: '8px', padding: '16px' }}>
                            <p style={{ margin: '0 0 6px', fontWeight: 'bold', fontSize: '14px', color: C.text }}>{item.descripcion}</p>
                            <p style={{ margin: '0 0 4px', fontSize: '13px', color: C.gray }}>
                                Vinculado a: <strong style={{ color: '#4A148C' }}>{item.preventas_product_name}</strong>
                            </p>
                            <p style={{ margin: '0 0 14px', fontSize: '13px', color: C.gray }}>
                                Cantidad confirmada: <strong>{item.preventa_qty_confirmed}</strong> / {item.cantidad}
                            </p>
                            <div style={{ display: 'flex', gap: '8px' }}>
                                <button
                                    onClick={onOpenLink}
                                    style={{ fontSize: '12px', padding: '5px 14px', borderRadius: '4px', border: 'none', backgroundColor: '#7B1FA2', color: C.white, cursor: 'pointer', fontWeight: 'bold' }}
                                >Cambiar vinculación</button>
                                <button
                                    onClick={() => { onConfirm(0); onClose(); }}
                                    style={{ fontSize: '12px', padding: '5px 14px', borderRadius: '4px', border: `1px solid ${C.border}`, backgroundColor: 'transparent', color: C.gray, cursor: 'pointer' }}
                                >Quitar</button>
                            </div>
                        </div>
                    )}
                </div>

                <div style={{ padding: '12px 20px', borderTop: `1px solid ${C.border}`, display: 'flex', justifyContent: 'flex-end' }}>
                    <button onClick={onClose} style={{ padding: '9px 24px', border: `1px solid ${C.border}`, borderRadius: '4px', background: C.bg, cursor: 'pointer', fontSize: '14px' }}>
                        Cerrar
                    </button>
                </div>
            </div>
        </div>
    );
}

// =============================================
// Componente principal
// =============================================
// =============================================
// Modal: programar una publicación de WhatsApp con productos del ingreso
// Solo entran productos de Neggo con foto en Odoo. La tanda va a la cola de WhatsApp
// (Admin → WhatsApp) con el texto "Ingreso..." arriba de cada producto.
// =============================================

// "AAAA-MM-DDTHH:mm" en la hora local del navegador, para el input datetime-local
function fechaLocalInput(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function WhatsAppIngresoModal({ ingresoId, items, onClose, onScheduled }) {
    const { onDragStart, dragStyle, containerStyle, overlayStyle } = useDraggable();
    const productos = items.filter(i =>
        i.estado_item === 'matched' && i.odoo_product_id && (i.odoo_company || 'neggo') === 'neggo'
    );
    const conFoto = productos.filter(i => i.odoo_has_image);
    const sinFoto = productos.length - conFoto.length;

    const [seleccion, setSeleccion] = useState(() => new Set(conFoto.map(i => i.id)));
    const [cuando, setCuando]       = useState(() => fechaLocalInput(new Date(Date.now() + 10 * 60 * 1000)));
    const [ahora, setAhora]         = useState(false);
    const [enviando, setEnviando]   = useState(false);
    const [error, setError]         = useState(null);

    const toggle = (id) => setSeleccion(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });

    const programar = async () => {
        setEnviando(true);
        setError(null);
        try {
            const body = { item_ids: [...seleccion] };
            if (ahora) body.send_now = true; else body.scheduled_at = cuando;
            const result = await ingresoAPI.scheduleWhatsApp(ingresoId, body);
            if (!result.success) {
                setError(result.error || 'No se pudo programar la publicación');
                return;
            }
            const { total, omitidos = [] } = result.data;
            onScheduled(
                `📣 ${total} producto${total === 1 ? '' : 's'} en la cola de WhatsApp` +
                (omitidos.length ? ` (${omitidos.length} sin foto o sin precio quedaron afuera)` : '') +
                '. Lo ves en Admin → WhatsApp.'
            );
        } catch (err) {
            setError(err.message || 'Error de conexión');
        } finally {
            setEnviando(false);
        }
    };

    return (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, ...overlayStyle }}>
            <div style={{ backgroundColor: C.white, borderRadius: '8px', padding: '20px', width: '560px', maxWidth: '92vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.2)', ...containerStyle }}>
                <h3 onMouseDown={onDragStart} style={{ margin: '0 0 6px', color: C.primary, ...dragStyle }}>📣 Publicar ingreso en WhatsApp</h3>
                <p style={{ fontSize: '12px', color: C.gray, margin: '0 0 12px' }}>
                    Cada producto sale con foto, nombre y precio de venta, con «Ingreso...» arriba.
                    {sinFoto > 0 && ` ${sinFoto} producto${sinFoto === 1 ? '' : 's'} sin foto no aparece${sinFoto === 1 ? '' : 'n'}: cargales la foto desde la tarjeta.`}
                </p>

                {conFoto.length === 0 ? (
                    <p style={{ fontSize: '13px', color: C.text, padding: '16px', backgroundColor: C.bg, borderRadius: '6px' }}>
                        Ningún producto de este ingreso tiene foto en Odoo todavía.
                    </p>
                ) : (
                    <>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px', fontSize: '12px' }}>
                            <span style={{ color: C.gray }}>{seleccion.size} de {conFoto.length} elegidos</span>
                            <button
                                onClick={() => setSeleccion(seleccion.size === conFoto.length ? new Set() : new Set(conFoto.map(i => i.id)))}
                                style={{ padding: '2px 10px', fontSize: '11px', border: `1px solid ${C.border}`, borderRadius: '4px', backgroundColor: C.white, cursor: 'pointer' }}
                            >
                                {seleccion.size === conFoto.length ? 'Ninguno' : 'Todos'}
                            </button>
                        </div>
                        <div style={{ overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: '6px', marginBottom: '12px', flex: 1, minHeight: '120px' }}>
                            {conFoto.map(i => (
                                <label key={i.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 10px', borderBottom: `1px solid ${C.border}`, cursor: 'pointer', fontSize: '12px' }}>
                                    <input type="checkbox" checked={seleccion.has(i.id)} onChange={() => toggle(i.id)} />
                                    <OdooImage odooId={i.odoo_product_id} size={40} />
                                    <span style={{ flex: 1, minWidth: 0 }}>
                                        <span style={{ display: 'block', fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.odoo_product_name}</span>
                                        <span style={{ display: 'block', fontFamily: 'monospace', fontSize: '10px', color: C.gray }}>{i.odoo_internal_ref || i.codigo || ''}</span>
                                    </span>
                                    <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 'bold', color: Number(i.odoo_list_price) > 0 ? C.text : C.error }}>
                                        {Number(i.odoo_list_price) > 0 ? fmtARS(i.odoo_list_price) : 'Sin precio'}
                                    </span>
                                </label>
                            ))}
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '12px', fontSize: '13px' }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                                <input type="checkbox" checked={ahora} onChange={(e) => setAhora(e.target.checked)} />
                                Publicar ya
                            </label>
                            {!ahora && (
                                <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    Fecha y hora
                                    <input
                                        type="datetime-local"
                                        value={cuando}
                                        onChange={(e) => setCuando(e.target.value)}
                                        style={{ padding: '4px 6px', border: `1px solid ${C.border}`, borderRadius: '4px', fontSize: '13px' }}
                                    />
                                </label>
                            )}
                        </div>
                    </>
                )}

                {error && (
                    <div style={{ backgroundColor: C.errorBg, color: C.error, borderRadius: '4px', padding: '8px 10px', fontSize: '12px', marginBottom: '12px' }}>
                        ❌ {error}
                    </div>
                )}

                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                    <button onClick={onClose} style={{ padding: '10px 18px', backgroundColor: C.bg, border: `1px solid ${C.border}`, borderRadius: '4px', cursor: 'pointer', fontSize: '14px' }}>
                        Cancelar
                    </button>
                    <button
                        onClick={programar}
                        disabled={enviando || seleccion.size === 0 || (!ahora && !cuando)}
                        style={{
                            padding: '10px 18px', backgroundColor: C.primary, color: C.white, border: 'none', borderRadius: '4px',
                            fontSize: '14px', fontWeight: 'bold',
                            cursor: enviando || seleccion.size === 0 ? 'default' : 'pointer',
                            opacity: enviando || seleccion.size === 0 ? 0.6 : 1,
                        }}
                    >
                        {enviando ? '⏳ Programando...' : ahora ? 'Publicar ahora' : 'Programar'}
                    </button>
                </div>
            </div>
        </div>
    );
}

export default function IngresoPreview() {
    const { ingresoId } = useParams();
    const navigate = useNavigate();

    const rematchDone = useRef(false);

    const [loading, setLoading]       = useState(true);
    const [confirming, setConfirming] = useState(false);
    const [mergingDupes, setMergingDupes] = useState(false);

    const [odooCategories, setOdooCategories]       = useState([]);
    const [odooWebCategories, setOdooWebCategories] = useState([]);
    const [generatingOC, setGeneratingOC] = useState(false);
    const [showGenerateOCModal, setShowGenerateOCModal] = useState(false);
    const [syncingOdoo, setSyncingOdoo] = useState(false);
    const [supplementingNeggoOC, setSupplementingNeggoOC] = useState(false);
    const [preventaLinkItem, setPreventaLinkItem]       = useState(null);
    const [allQuotations, setAllQuotations]             = useState([]);
    const [loadingQuotations, setLoadingQuotations]     = useState(false);
    const [error, setError]           = useState(null);
    const [success, setSuccess]       = useState(null);
    const [ingreso, setIngreso]       = useState(null);
    const [items, setItems]           = useState([]);
    const [activeTab, setActiveTab]   = useState('activos');
    const [showPartnerModal, setShowPartnerModal] = useState(false);
    const [showWhatsApp, setShowWhatsApp]         = useState(false);
    const { user } = useAuth();
    const [reactivating, setReactivating] = useState(null);
    const [creating, setCreating]         = useState(null);
    const [createModal, setCreateModal]   = useState(null);

    // Preventa
    const [preventaItems, setPreventaItems]         = useState([]);
    const [loadingPreventa, setLoadingPreventa]     = useState(false);
    const [preventaLoaded, setPreventaLoaded]       = useState(false);
    const [preventaDetailItem, setPreventaDetailItem] = useState(null);

    // Scanner HID
    const [lastScannedId, setLastScannedId] = useState(null);
    const [scanToast, setScanToast]         = useState(null);
    const barcodeBuffer = useRef('');
    const lastKeyTime   = useRef(0);

    // Costo de envío
    const [costoEnvio, setCostoEnvio]     = useState(0);
    const [envioInput, setEnvioInput]     = useState('');
    const [savingEnvio, setSavingEnvio]   = useState(false);

    // Filtros del tab preventa
    const [filterPreventaText, setFilterPreventaText]       = useState('');
    const [filterPreventaPending, setFilterPreventaPending] = useState(false);
    const [filterPreventaClient, setFilterPreventaClient]   = useState('');

    // Filtros
    const [filterText, setFilterText]                     = useState('');
    const [filterMissingBarcode, setFilterMissingBarcode] = useState(false);
    const [filterMissingRef, setFilterMissingRef]         = useState(false);
    const [filterCostDiff, setFilterCostDiff]             = useState(false);

    const isMobile = useIsMobile();

    const loadPreview = useCallback(async ({ silent = false } = {}) => {
        if (!silent) setLoading(true);
        try {
            const result = await ingresoAPI.getPreview(ingresoId);
            if (result.success) {
                setIngreso(result.data.ingreso);
                setItems(result.data.items || []);
                const envio = parseFloat(result.data.ingreso?.costo_envio || 0);
                setCostoEnvio(envio);
                setEnvioInput(envio > 0 ? String(envio) : '');
            } else {
                setError(result.error || 'Error cargando ingreso');
            }
        } catch (err) {
            setError(err.message || 'Error de conexión');
        } finally {
            if (!silent) setLoading(false);
        }
    }, [ingresoId]);

    useEffect(() => { loadPreview(); }, [loadPreview]);

    // Después de cargar una foto, el producto ya se puede publicar en WhatsApp
    const marcarConFoto = useCallback((itemId) => {
        setItems(prev => prev.map(i => (i.id === itemId ? { ...i, odoo_has_image: true } : i)));
    }, []);

    useEffect(() => {
        Promise.all([
            api.get('/products/odoo/categories'),
            api.get('/products/odoo/web-categories'),
        ]).then(([cats, webCats]) => {
            if (cats.success)    setOdooCategories(cats.data || []);
            if (webCats.success) setOdooWebCategories(webCats.data || []);
        }).catch(() => {});
    }, []);

    // Re-match en background: una sola vez tras la carga, solo si hay pendientes.
    useEffect(() => {
        if (rematchDone.current || loading || !ingreso) return;
        const hasPending = items.some(i =>
            (i.estado_item === 'pending' || i.estado_item === 'no_match') && i.codigo
        );
        if (!hasPending) return;
        rematchDone.current = true;
        ingresoAPI.rematch(ingresoId).then(res => {
            if (res.success && res.data?.length > 0) {
                setItems(prev => prev.map(i => {
                    const rm = res.data.find(r => r.id === i.id);
                    return rm ? { ...i, ...rm } : i;
                }));
            }
        }).catch(() => {});
    }, [loading, ingreso, items, ingresoId]);

    const handleItemUpdate = useCallback(async (itemId, data) => {
        // Optimistic update inmediato
        setItems(prev => prev.map(i => i.id === itemId ? { ...i, ...data } : i));
        try {
            const res = await ingresoAPI.updateItem(ingresoId, itemId, data);
            if (res.success) {
                const serverFields = res.data?.item  || {};
                const odooApplied  = res.data?.odoo_applied;
                const siblings     = Array.isArray(res.data?.siblings) ? res.data.siblings : [];
                const merge = { ...serverFields };
                if (odooApplied) {
                    merge.precio_odoo_anterior = odooApplied.cost;
                    merge.odoo_list_price      = odooApplied.list_price;
                }
                if (Object.keys(merge).length > 0 || siblings.length > 0) {
                    setItems(prev => prev.map(i => {
                        const sibling = siblings.find(s => s.id === i.id);
                        if (sibling) return { ...i, preventa_qty_confirmed: sibling.preventa_qty_confirmed };
                        return i.id === itemId ? { ...i, ...merge } : i;
                    }));
                }
            }
        } catch (err) {
            setError(`Error actualizando item: ${err.message}`);
            loadPreview({ silent: true });
        }
    }, [ingresoId, loadPreview]);

    const handleScan = useCallback((code) => {
        const cleanCode = code.trim();
        const found = items.find(i =>
            i.codigo === cleanCode ||
            i.odoo_barcode === cleanCode ||
            i.odoo_internal_ref === cleanCode
        );
        if (!found) {
            setScanToast({ ok: false, msg: `"${cleanCode}" no encontrado en esta factura` });
            setTimeout(() => setScanToast(null), 3000);
            return;
        }
        const newQty = (found.received_qty || 0) + 1;
        handleItemUpdate(found.id, { received_qty: newQty });
        setLastScannedId(found.id);
        if (found.estado_item === 'matched') {
            setActiveTab(found.odoo_active !== false ? 'activos' : 'inactivos');
        }
        setScanToast({ ok: true, msg: `${found.odoo_product_name || found.descripcion} · +1 → ${newQty}/${found.cantidad}` });
        setTimeout(() => setScanToast(null), 3000);
    }, [items, handleItemUpdate]);

    useEffect(() => {
        const onKeyDown = (e) => {
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
            const now = Date.now();
            if (now - lastKeyTime.current > 100) barcodeBuffer.current = '';
            lastKeyTime.current = now;
            if (e.key === 'Enter') {
                if (barcodeBuffer.current.length > 2) handleScan(barcodeBuffer.current.trim());
                barcodeBuffer.current = '';
            } else if (e.key.length === 1) {
                barcodeBuffer.current += e.key;
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [handleScan]);

    useEffect(() => {
        if (!lastScannedId) return;
        const t = setTimeout(() => {
            document.querySelector(`[data-itemid="${lastScannedId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 150);
        return () => clearTimeout(t);
    }, [lastScannedId, activeTab]);

    const handleLinked = useCallback(async (itemId, odooProductId) => {
        try {
            const res = await ingresoAPI.updateItem(ingresoId, itemId, { odoo_product_id: odooProductId });
            if (res.success) {
                const msg = odooProductId
                    ? '✅ Vinculación guardada — se va a matchear automáticamente en futuras facturas del mismo proveedor.'
                    : '🔗 Vínculo eliminado — el ítem volvió a "Nuevos".';
                setSuccess(msg);
                loadPreview({ silent: true });
            } else {
                setError(res.error || 'Error al vincular');
            }
        } catch (err) { setError(err.message); }
    }, [ingresoId, loadPreview]);

    const handleReject = useCallback(async (itemId) => {
        await handleItemUpdate(itemId, { estado_item: 'rejected', motivo_rechazo: 'Rechazado manualmente' });
    }, [handleItemUpdate]);

    const handleRestore = useCallback(async (itemId) => {
        await handleItemUpdate(itemId, { estado_item: 'restore' });
    }, [handleItemUpdate]);

    const handleReactivate = useCallback(async (itemId, odooProductId) => {
        setReactivating(itemId);
        try {
            const res = await api.post(`/ingreso/${ingresoId}/items/${itemId}/reactivate`, { odoo_product_id: odooProductId });
            if (res.success) {
                setSuccess('Producto reactivado en Odoo');
                setItems(prev => prev.map(i => i.id === itemId ? { ...i, odoo_active: true } : i));
            } else setError(res.error || 'Error reactivando');
        } catch (err) { setError(err.message); }
        finally { setReactivating(null); }
    }, [ingresoId]);

    const handleCreateOdoo = useCallback((itemId) => {
        const item = items.find(i => i.id === itemId);
        if (!item) return;
        setCreateModal(item);
    }, [items]);

    const handleCreateOdooConfirm = useCallback(async (fields) => {
        if (!createModal) return;
        setCreating(createModal.id);
        setCreateModal(null);
        try {
            const res = await api.post(`/ingreso/${ingresoId}/items/${createModal.id}/create-odoo`, fields);
            if (res.success) {
                setSuccess(`✅ Producto "${res.data.odoo_product_name}" (${res.data.default_code}) creado en Odoo`);
                loadPreview({ silent: true });
            } else {
                setError(res.error || 'Error creando producto en Odoo');
            }
        } catch (err) { setError(err.message); }
        finally { setCreating(null); }
    }, [createModal, ingresoId, loadPreview]);

    const loadPreventaItems = useCallback(async () => {
        if (preventaLoaded) return;
        setLoadingPreventa(true);
        try {
            const res = await ingresoAPI.getPreventaOdooMatch(ingresoId);
            if (res.success) setPreventaItems(res.data || []);
        } catch (_) {}
        finally { setLoadingPreventa(false); setPreventaLoaded(true); }
    }, [ingresoId, preventaLoaded]);

    useEffect(() => {
        if (activeTab === 'preventa') loadPreventaItems();
    }, [activeTab, loadPreventaItems]);

    // Carga proactiva del match de preventa para mostrar el tag en todas las pestañas
    useEffect(() => {
        if (!loading && ingreso && !preventaLoaded) loadPreventaItems();
    }, [loading, ingreso, preventaLoaded, loadPreventaItems]);

    const handleConfirmClick = () => {
        // Un ítem pending bloquea solo si no tiene ningún plan de preventa
        // (sin preventa_qty_confirmed ni preventas_product_id)
        const bloqueantes = items.filter(i =>
            i.estado_item === 'pending' &&
            !(i.preventa_qty_confirmed > 0) &&
            !i.preventas_product_id
        );
        if (bloqueantes.length > 0) {
            setError(`Hay ${bloqueantes.length} item(s) sin resolver en "Nuevos". Vincinalos, creálos en Odoo, asignálos a preventa o rechazálos antes de confirmar.`);
            return;
        }
        setShowPartnerModal(true);
    };

    const handleConfirm = async (odooPartnerId) => {
        setShowPartnerModal(false);
        setConfirming(true);
        setError(null);
        try {
            const result = await ingresoAPI.confirmIngreso(ingresoId, { odoo_partner_id: odooPartnerId });
            if (result.success) {
                const partes = ['✅ Confirmado.'];
                if (result.data.odoo_purchase_order_id)           partes.push(`OC Neggo: #${result.data.odoo_purchase_order_id}.`);
                if (result.data.odoo_purchase_order_id_preventas) partes.push(`OC Preventas: #${result.data.odoo_purchase_order_id_preventas}.`);
                partes.push(`${result.data.updated_products_count} productos actualizados.`);
                const msg = partes.join(' ');
                navigate('/ingreso', { state: { message: msg } });
            } else setError(result.error || 'Error al confirmar');
        } catch (err) { setError(err.message); }
        finally { setConfirming(false); }
    };

    const handleMergeDuplicates = async () => {
        setMergingDupes(true);
        setError(null);
        try {
            const res = await ingresoAPI.mergeDuplicateItems(ingresoId);
            if (res.success) {
                setSuccess(res.data.message);
                if (res.data.merged_groups > 0) {
                    await loadPreview({ silent: true });
                    setPreventaLoaded(false); // fuerza reload del tab preventa
                }
            } else setError(res.error || 'Error al fusionar duplicados');
        } catch (err) { setError(err.message); }
        finally { setMergingDupes(false); }
    };

    const handleOpenPreventaLink = async (item) => {
        setPreventaLinkItem(item);
        if (allQuotations.length === 0) {
            setLoadingQuotations(true);
            try {
                const res = await api.get('/preventas/odoo-quotations');
                if (res.success) setAllQuotations(res.data || []);
            } catch (_) {}
            finally { setLoadingQuotations(false); }
        }
    };

    const handleSavePreventaLink = async (itemId, preventasProductId, preventasProductName, qty) => {
        try {
            const res = await api.patch(`/ingreso/${ingresoId}/items/${itemId}/preventa-link`, {
                preventas_product_id:   preventasProductId,
                preventas_product_name: preventasProductName,
                preventa_qty_confirmed: qty,
            });
            if (res.success) {
                setItems(prev => prev.map(i => i.id === itemId
                    ? { ...i, preventas_product_id: preventasProductId, preventas_product_name: preventasProductName, preventa_qty_confirmed: qty }
                    : i
                ));
                setPreventaLinkItem(null);
            } else setError(res.error || 'Error al vincular');
        } catch (err) { setError(err.message); }
    };

    const handleAddPreventaLink = async (itemId, linkData) => {
        try {
            const res = await api.post(`/ingreso/${ingresoId}/items/${itemId}/preventa-links`, linkData);
            if (res.success) {
                setItems(prev => prev.map(i => i.id === itemId ? { ...i, ...res.data.item } : i));
                setPreventaLinkItem(null);
            } else setError(res.error || 'Error al agregar link de preventa');
        } catch (err) { setError(err.message); }
    };

    const handleRemovePreventaLink = async (itemId, linkId) => {
        try {
            const res = await api.del(`/ingreso/${ingresoId}/items/${itemId}/preventa-links/${linkId}`);
            if (res.success) {
                setItems(prev => prev.map(i => i.id === itemId ? { ...i, ...res.data.item } : i));
            } else setError(res.error || 'Error al eliminar link de preventa');
        } catch (err) { setError(err.message); }
    };

    const handleGenerateOC = async (odooPartnerId) => {
        if (!odooPartnerId) return;
        setShowGenerateOCModal(false);
        setGeneratingOC(true);
        setError(null);
        try {
            const result = await api.post(`/ingreso/${ingresoId}/generate-oc`, { odoo_partner_id: odooPartnerId });
            if (result.success) {
                const partes = ['✅ OC generada.'];
                if (result.data.odoo_purchase_order_id)           partes.push(`OC Neggo: #${result.data.odoo_purchase_order_id}.`);
                if (result.data.odoo_purchase_order_id_preventas) partes.push(`OC Preventas: #${result.data.odoo_purchase_order_id_preventas}.`);
                if (!result.data.odoo_purchase_order_id && !result.data.odoo_purchase_order_id_preventas) {
                    partes[0] = '⚠️ OC procesada pero sin líneas — revisá que los productos tengan equivalente en Odoo.';
                }
                setSuccess(partes.join(' '));
                loadPreview({ silent: true });
            } else setError(result.error || 'Error generando OC');
        } catch (err) { setError(err.message); }
        finally { setGeneratingOC(false); }
    };

    const handleSupplementNeggoOC = async () => {
        if (!window.confirm('¿Agregás las líneas faltantes a la OC de Neggo en Odoo?')) return;
        setSupplementingNeggoOC(true);
        setError(null);
        try {
            const result = await api.post(`/ingreso/${ingresoId}/supplement-neggo-oc`);
            if (result.success) {
                const added = result.data.added;
                setSuccess(added > 0
                    ? `✅ ${added} línea(s) agregada(s) a OC Neggo #${result.data.oc_neggo_id}.`
                    : `ℹ️ ${result.data.message}`
                );
            } else setError(result.error || 'Error al suplementar OC');
        } catch (err) { setError(err.message); }
        finally { setSupplementingNeggoOC(false); }
    };

    const handleSyncOdoo = async () => {
        setSyncingOdoo(true);
        setError(null);
        try {
            const result = await ingresoAPI.syncOdooPrices(ingresoId);
            if (result.success) {
                setSuccess(`🔄 ${result.data.message} — recargando vista...`);
                await loadPreview({ silent: true });
            } else setError(result.error || 'Error sincronizando precios');
        } catch (err) { setError(err.message); }
        finally { setSyncingOdoo(false); }
    };

    const applyFilters = useCallback((list) => {
        return list.filter(item => {
            if (filterText.trim()) {
                const t = filterText.toLowerCase();
                if (!(
                    (item.codigo || '').toLowerCase().includes(t) ||
                    item.descripcion.toLowerCase().includes(t) ||
                    (item.odoo_product_name || '').toLowerCase().includes(t)
                )) return false;
            }
            if (item.odoo_product_id) {
                if (filterMissingBarcode && item.odoo_barcode) return false;
                if (filterMissingRef    && item.odoo_internal_ref) return false;
                if (filterCostDiff) {
                    const prev = parseFloat(item.precio_odoo_anterior || 0);
                    if (prev > 0) {
                        const pack = Math.max(1, parseInt(item.pack_size || 1, 10));
                        const diff = Math.abs(parseFloat(item.precio_unitario) / pack - prev) / prev;
                        if (diff <= 0.05) return false;
                    }
                }
            }
            return true;
        });
    }, [filterText, filterMissingBarcode, filterMissingRef, filterCostDiff]);

    const handleEnvioChange = useCallback(async (rawValue) => {
        setEnvioInput(rawValue);
        const val = parseFloat(rawValue.replace(',', '.')) || 0;
        setCostoEnvio(val);
        if (ingreso?.estado !== 'pending') return;
        setSavingEnvio(true);
        try {
            await api.patch(`/ingreso/${ingresoId}`, { costo_envio: val });
        } catch (_) {}
        finally { setSavingEnvio(false); }
    }, [ingresoId, ingreso?.estado]);

    const handleUpdateOdooProduct = useCallback(async (itemId, fields) => {
        try {
            const result = await api.patch(`/ingreso/${ingresoId}/items/${itemId}/odoo-product`, fields);
            if (!result.success) {
                setError(result.error || 'Error al guardar en Odoo');
                return;
            }
            const localUpdates = {};
            if (fields.default_code    !== undefined) localUpdates.odoo_internal_ref    = fields.default_code    || null;
            if (fields.barcode         !== undefined) localUpdates.odoo_barcode         = fields.barcode         || null;
            if (fields.available_in_pos !== undefined) localUpdates.odoo_available_in_pos = Boolean(fields.available_in_pos);
            if (fields.is_published    !== undefined) localUpdates.odoo_is_published    = Boolean(fields.is_published);
            if (fields.categ_id        !== undefined) localUpdates.odoo_categ_id        = fields.categ_id        || null;
            if (fields.categ_name      !== undefined) localUpdates.odoo_categ_name      = fields.categ_name      || null;
            if (fields.website_categ_id !== undefined) localUpdates.odoo_web_categ_id   = fields.website_categ_id || null;
            if (fields.web_categ_name  !== undefined) localUpdates.odoo_web_categ_name  = fields.web_categ_name  || null;
            if (Object.keys(localUpdates).length > 0) {
                setItems(prev => prev.map(i => i.id === itemId ? { ...i, ...localUpdates } : i));
            }
        } catch (err) {
            setError(`Error al guardar en Odoo: ${err.message}`);
        }
    }, [ingresoId]);

    if (loading) return <div style={{ padding: '48px', textAlign: 'center', color: C.gray }}>⏳ Cargando...</div>;
    if (!ingreso) return <div style={{ padding: '24px', color: C.error }}>{error || 'Ingreso no encontrado'}</div>;

    // Ítems totalmente asignados a preventa no aparecen en los tabs de Neggo —
    // mostrarlos impulsaría a crear/activar productos sin stock real para Neggo.
    const tieneUnidadesParaNeggo = (i) => (i.preventa_qty_confirmed || 0) < i.cantidad;

    const activos    = items.filter(i => i.estado_item === 'matched' && i.odoo_active !== false && tieneUnidadesParaNeggo(i));
    const inactivos  = items.filter(i => i.estado_item === 'matched' && i.odoo_active === false  && tieneUnidadesParaNeggo(i));
    const nuevos     = items.filter(i => (i.estado_item === 'pending' || i.estado_item === 'no_match') && tieneUnidadesParaNeggo(i));
    const rechazados = items.filter(i => i.estado_item === 'rejected');

    const filteredActivos   = applyFilters(activos);
    const filteredInactivos = applyFilters(inactivos);
    const filteredNuevos    = filterText.trim()
        ? nuevos.filter(i => {
            const t = filterText.toLowerCase();
            return (i.codigo || '').toLowerCase().includes(t) || i.descripcion.toLowerCase().includes(t);
          })
        : nuevos;

    const pendingCount = nuevos.length;
    const canConfirm   = pendingCount === 0 && ingreso.estado === 'pending';

    const hasDuplicateCodes = (() => {
        const seen = new Set();
        return items.some(i => {
            if (!i.codigo) return false;
            const k = i.codigo.toUpperCase();
            if (seen.has(k)) return true;
            seen.add(k);
            return false;
        });
    })();

    // Divisor para el prorrateo de envío: total de la factura completa
    const totalFacturaMonto = parseFloat(ingreso.total_monto || 0);

    const itemsControlables = activos.length + inactivos.length;
    const itemsRecibidos    = items.filter(i => i.estado_item === 'matched' && (i.received_qty || 0) >= i.cantidad).length;

    const anyFilter = filterText || filterMissingBarcode || filterMissingRef || filterCostDiff;

    const preventaMatchMap = preventaItems.reduce((acc, pi) => {
        acc[pi.ingreso_item_id] = pi;
        return acc;
    }, {});

    const cardProps = {
        ingreso, onItemUpdate: handleItemUpdate,
        onReject: handleReject, onReactivate: handleReactivate,
        reactivating, onLinked: handleLinked, onCreated: handleCreateOdoo,
        creating, lastScannedId,
        preventaMatchMap,
        costoEnvio,
        totalFacturaMonto,
        onUpdateOdooProduct: null,
        onUploadSupplierPhoto: null,
        onPreventaBadgeClick: (item) => setPreventaDetailItem(item),
        odooCategories,
        odooWebCategories,
    };

    const TABS = [
        { key: 'activos',    label: `Activos (${anyFilter ? `${filteredActivos.length}/` : ''}${activos.length})`,       color: C.success },
        { key: 'inactivos',  label: `Inactivos (${anyFilter ? `${filteredInactivos.length}/` : ''}${inactivos.length})`, color: C.warning },
        { key: 'nuevos',     label: `Nuevos (${nuevos.length})`,                                                          color: pendingCount > 0 ? C.error : C.blue },
        { key: 'preventa',   label: `Preventa${preventaLoaded && preventaItems.length > 0 ? ` (${preventaItems.length})` : ''}`, color: '#7B1FA2' },
    ];
    if (rechazados.length > 0) TABS.push({ key: 'rechazados', label: `Rechazados (${rechazados.length})`, color: C.error });

    const currentItems = activeTab === 'activos' ? filteredActivos : activeTab === 'inactivos' ? filteredInactivos : activeTab === 'nuevos' ? filteredNuevos : rechazados;

    return (
        <div style={{ maxWidth: '1200px', margin: '0 auto', padding: isMobile ? '12px' : '24px', backgroundColor: C.bg }}>
            <ScanToast toast={scanToast} />
            {showPartnerModal && <PartnerModal onConfirm={handleConfirm} onCancel={() => setShowPartnerModal(false)} />}
            {showGenerateOCModal && <PartnerModal onConfirm={handleGenerateOC} onCancel={() => setShowGenerateOCModal(false)} titulo="Generar OC en Odoo" subtitulo="Seleccioná el proveedor para crear la orden de compra." />}
            {showWhatsApp && (
                <WhatsAppIngresoModal
                    ingresoId={ingresoId}
                    items={items}
                    onClose={() => setShowWhatsApp(false)}
                    onScheduled={(msg) => { setShowWhatsApp(false); setSuccess(msg); }}
                />
            )}
            {preventaLinkItem && (
                <PreventaLinkModal
                    item={preventaLinkItem}
                    quotations={allQuotations}
                    loading={loadingQuotations}
                    onSave={handleAddPreventaLink}
                    onCancel={() => setPreventaLinkItem(null)}
                />
            )}
            {preventaDetailItem && (() => {
                const currentItem = items.find(i => i.id === preventaDetailItem.id) || preventaDetailItem;
                const pi          = preventaMatchMap[currentItem.id];
                const confirmed   = preventaConfirmada(items, { codigo: currentItem.codigo, ingreso_item_id: currentItem.id });
                const discount    = currentItem.discount_override != null
                    ? parseFloat(currentItem.discount_override)
                    : parseFloat(ingreso.default_discount || 0);
                return (
                    <PreventaDetailModal
                        item={currentItem}
                        pi={pi}
                        confirmed={confirmed}
                        discount={discount}
                        onConfirm={(qty) => handleItemUpdate(currentItem.id, { preventa_qty_confirmed: qty })}
                        onClose={() => setPreventaDetailItem(null)}
                        onOpenLink={() => {
                            setPreventaDetailItem(null);
                            handleOpenPreventaLink(currentItem);
                        }}
                    />
                );
            })()}
            {createModal && (
                <CreateOdooModal
                    item={createModal}
                    ingreso={ingreso}
                    onConfirm={handleCreateOdooConfirm}
                    onCancel={() => setCreateModal(null)}
                />
            )}

            {/* Header */}
            <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px', gap: '12px' }}>
                <div>
                    <h1 style={{ color: C.primary, fontSize: '20px', margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                        📋 Ingreso #{ingreso.id}
                        {ingreso.estado === 'confirmado' && (
                            <span style={{ fontSize: '12px', fontWeight: 'bold', padding: '3px 8px', borderRadius: '3px', backgroundColor: C.successBg, color: C.success }}>
                                CONFIRMADO
                            </span>
                        )}
                    </h1>
                    <div style={{ fontSize: '13px', color: C.gray, display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                        <span><strong>{ingreso.comprobante_tipo?.toUpperCase()}</strong>{ingreso.comprobante_numero ? ` · ${ingreso.comprobante_numero}` : ''}</span>
                        {ingreso.supplier_name && <span>🏭 {ingreso.supplier_name}</span>}
                        <span>💰 {fmtARS(ingreso.total_monto)}</span>
                        <span>📅 {new Date(ingreso.created_at).toLocaleDateString('es-AR')}</span>
                        {ingreso.odoo_purchase_order_id && <span style={{ color: C.success }}>🔗 OC Neggo #{ingreso.odoo_purchase_order_id}</span>}
                        {ingreso.odoo_purchase_order_id_preventas && <span style={{ color: '#7B1FA2' }}>🛒 OC Preventas #{ingreso.odoo_purchase_order_id_preventas}</span>}
                        {ingreso.estado === 'confirmado' && !ingreso.odoo_purchase_order_id && !ingreso.odoo_purchase_order_id_preventas && (
                            <span style={{ color: '#E65100', fontSize: '12px' }}>⚠️ Sin OC en Odoo</span>
                        )}
                    </div>
                    <div style={{ fontSize: '11px', color: C.gray, marginTop: '4px' }}>
                        💡 Lector activo — escanear fuera de un campo incrementa la cantidad recibida
                    </div>
                </div>

                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-start', width: isMobile ? '100%' : 'auto' }}>
                    {user?.role === 'admin' && (
                        <button
                            onClick={() => setShowWhatsApp(true)}
                            title="Programar una publicación en el grupo de WhatsApp con los productos de este ingreso que tienen foto"
                            style={{ backgroundColor: C.white, color: C.primary, border: `1px solid ${C.primary}`, borderRadius: '6px', padding: '10px 14px', fontSize: '13px', fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', whiteSpace: 'nowrap' }}
                        >
                            📣 Publicar en WhatsApp
                        </button>
                    )}
                    {ingreso.supplier_name && (
                        <div style={{ display: 'flex', gap: '12px', backgroundColor: C.white, borderRadius: '6px', padding: '10px 16px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', fontSize: '13px' }}>
                            <div><div style={{ color: C.gray, fontSize: '11px' }}>DESCUENTO</div><div style={{ fontWeight: 'bold', fontSize: '16px' }}>{ingreso.default_discount || 0}%</div></div>
                            <div style={{ width: '1px', backgroundColor: C.border }} />
                            <div><div style={{ color: C.gray, fontSize: '11px' }}>MARKUP</div><div style={{ fontWeight: 'bold', fontSize: '16px' }}>{ingreso.default_markup || 0}%</div></div>
                        </div>
                    )}

                    {/* Costo de envío */}
                    <div style={{ backgroundColor: C.white, borderRadius: '6px', padding: '10px 16px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', minWidth: '160px' }}>
                        <div style={{ color: C.gray, fontSize: '11px', marginBottom: '4px' }}>🚚 COSTO ENVÍO</div>
                        {ingreso.estado === 'pending' ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span style={{ color: C.gray, fontSize: '13px' }}>$</span>
                                <input
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    value={envioInput}
                                    onChange={e => handleEnvioChange(e.target.value)}
                                    placeholder="0"
                                    style={{ width: '90px', padding: '4px 6px', border: `1px solid ${C.border}`, borderRadius: '4px', fontSize: '14px', fontWeight: 'bold' }}
                                />
                                {savingEnvio && <span style={{ fontSize: '11px', color: C.gray }}>⏳</span>}
                            </div>
                        ) : (
                            <div style={{ fontWeight: 'bold', fontSize: '16px', color: costoEnvio > 0 ? C.text : C.gray }}>
                                {costoEnvio > 0 ? fmtARS(costoEnvio) : '—'}
                            </div>
                        )}
                    </div>
                    {itemsControlables > 0 && (
                        <div style={{ backgroundColor: C.white, borderRadius: '6px', padding: '10px 16px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', minWidth: '160px' }}>
                            <div style={{ color: C.gray, fontSize: '11px', marginBottom: '4px' }}>RECEPCIÓN FÍSICA</div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <div style={{ flex: 1, backgroundColor: C.border, borderRadius: '4px', height: '6px', overflow: 'hidden' }}>
                                    <div style={{ width: `${(itemsRecibidos / itemsControlables) * 100}%`, height: '100%', backgroundColor: C.success, transition: 'width 0.3s' }} />
                                </div>
                                <span style={{ fontWeight: 'bold', fontSize: '14px', color: itemsRecibidos === itemsControlables ? C.success : C.text }}>
                                    {itemsRecibidos}/{itemsControlables}
                                </span>
                            </div>
                        </div>
                    )}

                    {/* Sync precios Odoo */}
                    <button
                        onClick={handleSyncOdoo}
                        disabled={syncingOdoo}
                        title="Traer precios actuales de Odoo para todos los ítems matcheados"
                        style={{
                            backgroundColor: syncingOdoo ? '#ccc' : C.white,
                            color: syncingOdoo ? C.gray : C.primary,
                            border: `1px solid ${syncingOdoo ? '#ccc' : C.primary}`,
                            borderRadius: '6px', padding: '10px 14px',
                            fontSize: '12px', fontWeight: 'bold',
                            cursor: syncingOdoo ? 'not-allowed' : 'pointer',
                            boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
                            whiteSpace: 'nowrap'
                        }}
                    >
                        <span style={{ fontSize: '16px' }}>{syncingOdoo ? '⏳' : '🔄'}</span>
                        <span>{syncingOdoo ? 'Sincronizando...' : 'Sync Odoo'}</span>
                    </button>
                </div>
            </div>

            {/* Alertas */}
            {error && (
                <div style={{ backgroundColor: C.errorBg, color: C.error, padding: '12px 16px', borderRadius: '6px', marginBottom: '16px', fontSize: '14px' }}>
                    ❌ {error}
                    <button onClick={() => setError(null)} style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer', color: C.error, fontWeight: 'bold' }}>✕</button>
                </div>
            )}
            {success && (
                <div style={{ backgroundColor: C.successBg, color: C.success, padding: '12px 16px', borderRadius: '6px', marginBottom: '16px', fontSize: '14px' }}>
                    {success}
                    <button onClick={() => setSuccess(null)} style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer', color: C.success, fontWeight: 'bold' }}>✕</button>
                </div>
            )}

            {/* Panel tabs + contenido */}
            <div style={{ backgroundColor: C.white, borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)', marginBottom: '16px' }}>
                {/* Tabs */}
                <div style={{ display: 'flex', borderBottom: `1px solid ${C.border}`, overflowX: 'auto' }}>
                    {TABS.map(tab => (
                        <button
                            key={tab.key}
                            onClick={() => setActiveTab(tab.key)}
                            style={{
                                padding: '14px 20px', border: 'none',
                                borderBottom: activeTab === tab.key ? `3px solid ${tab.color}` : '3px solid transparent',
                                background: 'none', cursor: 'pointer',
                                fontWeight: activeTab === tab.key ? 'bold' : 'normal',
                                color: activeTab === tab.key ? tab.color : C.gray,
                                fontSize: '14px', whiteSpace: 'nowrap', transition: 'all 0.15s'
                            }}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>

                {/* Filtros (tabs con items Odoo o nuevos) */}
                {(activeTab === 'activos' || activeTab === 'inactivos') && (
                    <FilterBar
                        filterText={filterText} setFilterText={setFilterText}
                        filterMissingBarcode={filterMissingBarcode} setFilterMissingBarcode={setFilterMissingBarcode}
                        filterMissingRef={filterMissingRef} setFilterMissingRef={setFilterMissingRef}
                        filterCostDiff={filterCostDiff} setFilterCostDiff={setFilterCostDiff}
                    />
                )}
                {activeTab === 'nuevos' && (
                    <div style={{ padding: '10px 16px', borderTop: `1px solid ${C.border}`, backgroundColor: '#FAFAFA' }}>
                        <input type="text" placeholder="🔍 Filtrar nuevos..."
                            value={filterText} onChange={(e) => setFilterText(e.target.value)}
                            style={{ width: '100%', maxWidth: '360px', padding: '7px 12px', border: `1px solid ${C.border}`, borderRadius: '4px', fontSize: '13px', boxSizing: 'border-box' }} />
                    </div>
                )}

                {/* Barra de progreso por tab (activos/inactivos) */}
                {(activeTab === 'activos' || activeTab === 'inactivos') && currentItems.length > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 16px', borderTop: `1px solid ${C.border}`, fontSize: '12px', color: C.gray, backgroundColor: '#FAFAFA' }}>
                        <span>Recepción:</span>
                        {(() => {
                            const src = activeTab === 'activos' ? filteredActivos : filteredInactivos;
                            const done = src.filter(i => (i.received_qty || 0) >= i.cantidad).length;
                            return (
                                <>
                                    <div style={{ flex: 1, maxWidth: '200px', backgroundColor: C.border, borderRadius: '4px', height: '6px', overflow: 'hidden' }}>
                                        <div style={{ width: `${src.length > 0 ? (done / src.length) * 100 : 0}%`, height: '100%', backgroundColor: C.success, transition: 'width 0.3s' }} />
                                    </div>
                                    <span style={{ fontWeight: 'bold', color: done === src.length ? C.success : C.text }}>{done}/{src.length}</span>
                                </>
                            );
                        })()}
                    </div>
                )}

                {/* Tab Preventa */}
                {activeTab === 'preventa' && (
                    <div style={{ padding: '16px' }}>
                        {loadingPreventa ? (
                            <p style={{ textAlign: 'center', color: C.gray, padding: '32px' }}>⏳ Consultando cotizaciones en Odoo Preventas...</p>
                        ) : preventaItems.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: '48px', color: C.gray }}>
                                <div style={{ fontSize: '40px', marginBottom: '12px' }}>🛒</div>
                                <p style={{ fontWeight: 'bold' }}>Ningún artículo de esta factura aparece en cotizaciones abiertas de Odoo Preventas.</p>
                                <p style={{ fontSize: '13px' }}>Se compara por código contra todas las cotizaciones. Un nombre parecido no alcanza para proponerla.</p>
                            </div>
                        ) : (() => {
                            const totalSeparado = items.reduce((s, i) => s + (parseInt(i.preventa_qty_confirmed, 10) || 0), 0);
                            const pendienteCount = preventaItems.filter(pi => preventaConfirmada(items, pi) <= 0).length;

                            const clientesUnicos = [...new Set(
                                preventaItems.flatMap(pi => pi.cotizaciones.map(c => c.client).filter(Boolean))
                            )].sort();

                            const filteredPreventa = preventaItems.filter(pi => {
                                const nombre = (pi.odoo_product_name || pi.descripcion || '').toLowerCase();
                                if (filterPreventaText && !nombre.includes(filterPreventaText.toLowerCase())) return false;
                                if (filterPreventaPending && preventaConfirmada(items, pi) > 0) return false;
                                if (filterPreventaClient && !pi.cotizaciones.some(c => c.client === filterPreventaClient)) return false;
                                return true;
                            });

                            return (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                    {/* Resumen global */}
                                    <div style={{ backgroundColor: '#EDE7F6', borderRadius: '8px', padding: '12px 16px', fontSize: '13px', color: '#4527A0', display: 'flex', gap: '24px', flexWrap: 'wrap', alignItems: 'center' }}>
                                        <span><strong>{preventaItems.length}</strong> artículo{preventaItems.length !== 1 ? 's' : ''} en cotizaciones</span>
                                        <span>Total cotizado: <strong>{preventaItems.reduce((s, pi) => s + pi.total_cotizado, 0)}</strong> uds</span>
                                        <span>Separados: <strong style={{ color: totalSeparado > 0 ? '#2E7D32' : '#4527A0' }}>{totalSeparado}</strong> uds</span>
                                        {pendienteCount > 0 && <span style={{ color: C.warning }}>⏳ {pendienteCount} sin separar</span>}
                                    </div>

                                    {/* Filtros */}
                                    <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                                        <input
                                            type="text"
                                            placeholder="🔍 Buscar artículo..."
                                            value={filterPreventaText}
                                            onChange={e => setFilterPreventaText(e.target.value)}
                                            style={{ padding: '7px 12px', border: `1px solid ${C.border}`, borderRadius: '4px', fontSize: '13px', width: '220px' }}
                                        />
                                        <select
                                            value={filterPreventaClient}
                                            onChange={e => setFilterPreventaClient(e.target.value)}
                                            style={{ padding: '7px 10px', border: `1px solid ${C.border}`, borderRadius: '4px', fontSize: '13px', color: filterPreventaClient ? C.text : C.gray, backgroundColor: C.white, cursor: 'pointer' }}
                                        >
                                            <option value="">👤 Todos los clientes</option>
                                            {clientesUnicos.map(cl => (
                                                <option key={cl} value={cl}>{cl}</option>
                                            ))}
                                        </select>
                                        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', cursor: 'pointer', userSelect: 'none' }}>
                                            <input
                                                type="checkbox"
                                                checked={filterPreventaPending}
                                                onChange={e => setFilterPreventaPending(e.target.checked)}
                                            />
                                            Solo pendientes ({pendienteCount})
                                        </label>
                                        {(filterPreventaText || filterPreventaPending || filterPreventaClient) && (
                                            <button
                                                onClick={() => { setFilterPreventaText(''); setFilterPreventaPending(false); setFilterPreventaClient(''); }}
                                                style={{ fontSize: '12px', color: C.gray, background: 'none', border: `1px solid ${C.border}`, borderRadius: '4px', padding: '4px 8px', cursor: 'pointer' }}
                                            >
                                                Limpiar filtros
                                            </button>
                                        )}
                                        {filteredPreventa.length !== preventaItems.length && (
                                            <span style={{ fontSize: '12px', color: C.gray }}>Mostrando {filteredPreventa.length} de {preventaItems.length}</span>
                                        )}
                                    </div>

                                    {filteredPreventa.length === 0 ? (
                                        <p style={{ textAlign: 'center', color: C.gray, padding: '24px' }}>Sin resultados para los filtros aplicados.</p>
                                    ) : filteredPreventa.map(pi => {
                                        const ingresoItem  = items.find(i => i.id === pi.ingreso_item_id);
                                        const confirmed    = preventaConfirmada(items, pi);
                                        const insuficiente = pi.total_cotizado > pi.ingreso_cantidad;
                                        const imagenId     = pi.cotizaciones[0]?.product_id || null;
                                        const discount     = ingresoItem?.discount_override != null
                                            ? parseFloat(ingresoItem.discount_override)
                                            : parseFloat(ingreso.default_discount || 0);
                                        return (
                                            <PreventaItemCard
                                                key={pi.ingreso_item_id}
                                                pi={pi}
                                                confirmed={confirmed}
                                                imagenId={imagenId}
                                                insuficiente={insuficiente}
                                                discount={discount}
                                                onConfirm={(qty) => handleItemUpdate(pi.ingreso_item_id, { preventa_qty_confirmed: qty })}
                                            />
                                        );
                                    })}

                                    {/* Ítems sin match automático — vinculación manual */}
                                    {(() => {
                                        const matchedIds = new Set(preventaItems.map(pi => pi.ingreso_item_id));
                                        const sinMatch = items.filter(i =>
                                            i.estado_item !== 'rejected' && !matchedIds.has(i.id)
                                        );
                                        if (sinMatch.length === 0) return null;
                                        return (
                                            <div style={{ marginTop: '12px', borderTop: `2px dashed #E1BEE7`, paddingTop: '12px' }}>
                                                <p style={{ fontSize: '12px', color: '#7B1FA2', fontWeight: 'bold', marginBottom: '8px' }}>
                                                    🔍 Sin match automático — podés vincularlos manualmente a una cotización
                                                </p>
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                                    {sinMatch.map(item => {
                                                        // Links efectivos: array nuevo o legado de campo único
                                                        const links = Array.isArray(item.preventa_links) && item.preventa_links.length > 0
                                                            ? item.preventa_links
                                                            : item.preventas_product_id
                                                                ? [{ id: `legacy-${item.id}`, preventas_product_name: item.preventas_product_name, qty: item.preventa_qty_confirmed || 0, legacy: true }]
                                                                : [];
                                                        const totalLinked = links.reduce((s, l) => s + (l.qty || 0), 0);
                                                        const remaining   = item.cantidad - totalLinked;
                                                        const hasLinks    = links.length > 0;

                                                        return (
                                                            <div key={item.id} style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 14px', backgroundColor: hasLinks ? '#F9FBE7' : C.white, border: `1px solid ${hasLinks ? '#C5E1A5' : C.border}`, borderRadius: '6px', fontSize: '13px' }}>
                                                                {/* Fila superior: código + descripción + cantidad total */}
                                                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                                                    {item.codigo && <span style={{ fontFamily: 'monospace', fontSize: '11px', backgroundColor: '#ECEFF1', padding: '2px 6px', borderRadius: '3px', color: '#455A64' }}>{item.codigo}</span>}
                                                                    <span style={{ flex: 1, fontWeight: 'bold', color: C.text }}>{item.descripcion}</span>
                                                                    <span style={{ color: C.gray, fontSize: '12px', fontFamily: 'monospace' }}>x{item.cantidad}</span>
                                                                    {hasLinks && (
                                                                        <span style={{ fontSize: '11px', fontWeight: 'bold', color: remaining === 0 ? C.success : C.warning }}>
                                                                            {totalLinked}/{item.cantidad} asignadas
                                                                        </span>
                                                                    )}
                                                                </div>

                                                                {/* Lista de links */}
                                                                {links.map(link => (
                                                                    <div key={link.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', backgroundColor: '#E8F5E9', border: `1px solid #A5D6A7`, borderRadius: '4px', padding: '5px 10px', fontSize: '12px' }}>
                                                                        <span style={{ color: '#2E7D32', flexShrink: 0 }}>✅</span>
                                                                        <span style={{ flex: 1, color: '#2E7D32', fontWeight: 'bold' }}>{link.preventas_product_name || '—'}</span>
                                                                        {link.quotation_name && <span style={{ color: C.gray, fontSize: '11px' }}>{link.quotation_name}{link.client ? ` · ${link.client}` : ''}</span>}
                                                                        <span style={{ color: C.text, fontFamily: 'monospace', fontWeight: 'bold', flexShrink: 0 }}>x{link.qty}</span>
                                                                        <button
                                                                            onClick={() => link.legacy
                                                                                ? handleSavePreventaLink(item.id, null, null, 0)
                                                                                : handleRemovePreventaLink(item.id, link.id)
                                                                            }
                                                                            style={{ background: 'none', border: 'none', color: C.gray, cursor: 'pointer', fontSize: '14px', lineHeight: 1, padding: '0 2px', flexShrink: 0 }}
                                                                            title="Quitar este link"
                                                                        >✕</button>
                                                                    </div>
                                                                ))}

                                                                {/* Botón agregar */}
                                                                {remaining > 0 && (
                                                                    <button
                                                                        onClick={() => handleOpenPreventaLink(item)}
                                                                        style={{ alignSelf: 'flex-start', fontSize: '11px', padding: '4px 12px', borderRadius: '4px', border: 'none', backgroundColor: '#7B1FA2', color: C.white, cursor: 'pointer', fontWeight: 'bold' }}
                                                                    >
                                                                        {hasLinks ? `+ Agregar otra cotización (${remaining} restantes)` : '+ Vincular cotización'}
                                                                    </button>
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        );
                                    })()}
                                </div>
                            );
                        })()}
                    </div>
                )}

                {/* Lista de tarjetas */}
                {activeTab !== 'preventa' && (
                <div style={{ padding: isMobile ? '10px' : '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {currentItems.length === 0 ? (
                        <p style={{ textAlign: 'center', color: C.gray, padding: '32px' }}>
                            {anyFilter ? 'No hay ítems que coincidan con el filtro.' : 'No hay ítems en esta pestaña.'}
                        </p>
                    ) : (
                        currentItems.map(item => (
                            activeTab === 'rechazados' ? (
                                <div key={item.id} style={{ display: 'flex', gap: '12px', padding: '12px 14px', backgroundColor: C.errorBg, border: `1px solid #FFCDD2`, borderRadius: '8px', fontSize: '13px', alignItems: 'center' }}>
                                    <code style={{ color: C.gray }}>{item.codigo || '—'}</code>
                                    <span style={{ fontWeight: 'bold', flex: 1 }}>{item.descripcion}</span>
                                    <span style={{ color: C.gray }}>x{item.cantidad}</span>
                                    <span style={{ color: C.error, flex: 1 }}>{item.motivo_rechazo}</span>
                                    {ingreso.estado === 'pending' && (
                                        <button
                                            onClick={() => handleRestore(item.id)}
                                            style={{ padding: '4px 12px', fontSize: '12px', backgroundColor: C.white, color: C.primary, border: `1px solid ${C.primary}`, borderRadius: '4px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                                        >
                                            ↩ Restaurar
                                        </button>
                                    )}
                                </div>
                            ) : (
                                <ItemCard
                                    key={item.id}
                                    item={item}
                                    {...cardProps}
                                    onUpdateOdooProduct={(fields) => handleUpdateOdooProduct(item.id, fields)}
                                    onUploadSupplierPhoto={async () => {
                                        const result = await api.post(`/ingreso/${ingresoId}/items/${item.id}/upload-supplier-photo`, {});
                                        if (result.success) marcarConFoto(item.id);
                                        return result;
                                    }}
                                    onUploadPhoto={async (file) => {
                                        const result = await ingresoAPI.uploadPhoto(ingresoId, item.id, file);
                                        if (result.success) marcarConFoto(item.id);
                                        return result;
                                    }}
                                    onAssignSupplier={ingreso.supplier_id ? async (itemId) => {
                                        try {
                                            const result = await ingresoAPI.assignSupplier(ingresoId, itemId);
                                            if (result.success) {
                                                setItems(prev => prev.map(i =>
                                                    i.id === itemId ? { ...i, odoo_vendor_name: result.data.vendor_name } : i
                                                ));
                                            } else {
                                                setError(result.error || 'Error al asignar proveedor');
                                            }
                                        } catch (err) {
                                            setError(`Error al asignar proveedor: ${err.message}`);
                                        }
                                    } : null}
                                    onAssignWebCateg={async (itemId) => {
                                        try {
                                            const result = await ingresoAPI.assignWebCategFromProduct(ingresoId, itemId);
                                            if (result.success) {
                                                setItems(prev => prev.map(i =>
                                                    i.id === itemId
                                                        ? { ...i, odoo_web_categ_id: result.data.web_categ_id, odoo_web_categ_name: result.data.web_categ_name }
                                                        : i
                                                ));
                                            } else {
                                                setError(result.error || 'Error al asignar categoría web');
                                            }
                                        } catch (err) {
                                            setError(`Error al asignar categoría web: ${err.message}`);
                                        }
                                    }}
                                />
                            )
                        ))
                    )}
                </div>
                )}
            </div>

            {/* Footer */}
            {ingreso.estado === 'pending' && (
                <div style={{ backgroundColor: C.white, borderRadius: '8px', padding: '16px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)', display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: '10px', alignItems: isMobile ? 'stretch' : 'center', flexWrap: 'wrap' }}>
                    <button
                        onClick={handleConfirmClick}
                        disabled={confirming || !canConfirm}
                        style={{ backgroundColor: confirming || !canConfirm ? '#ccc' : C.primary, color: C.white, border: 'none', padding: '14px 28px', borderRadius: '6px', fontSize: '15px', fontWeight: 'bold', cursor: confirming || !canConfirm ? 'not-allowed' : 'pointer' }}
                    >
                        {confirming ? '⏳ Confirmando...' : '✓ Confirmar e importar'}
                    </button>
                    {hasDuplicateCodes && (
                        <button
                            onClick={handleMergeDuplicates}
                            disabled={mergingDupes}
                            title="Fusiona artículos con el mismo código sumando cantidades y unidades recibidas"
                            style={{ backgroundColor: mergingDupes ? '#ccc' : '#E65100', color: C.white, border: 'none', padding: '12px 20px', borderRadius: '6px', fontSize: '14px', fontWeight: 'bold', cursor: mergingDupes ? 'not-allowed' : 'pointer' }}
                        >
                            {mergingDupes ? '⏳ Fusionando...' : '⚡ Fusionar duplicados'}
                        </button>
                    )}
                    <button onClick={() => navigate('/ingreso')} style={{ backgroundColor: C.bg, color: C.text, border: `1px solid ${C.border}`, padding: isMobile ? '12px 20px' : '12px 20px', borderRadius: '6px', fontSize: '14px', cursor: 'pointer', textAlign: 'center' }}>
                        Volver
                    </button>
                    {pendingCount > 0 && (
                        <span style={{ fontSize: '13px', color: C.warning }}>⚠️ {pendingCount} ítem(s) sin resolver en "Nuevos".</span>
                    )}
                    {canConfirm && itemsRecibidos < itemsControlables && (
                        <span style={{ fontSize: '13px', color: C.gray }}>💡 Recibiste {itemsRecibidos}/{itemsControlables} ítems físicamente. Podés confirmar igual.</span>
                    )}
                </div>
            )}
            {ingreso.estado === 'confirmado' && (
                <div style={{ backgroundColor: C.white, borderRadius: '8px', padding: '16px 20px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)', display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ backgroundColor: C.successBg, color: C.success, padding: '10px 16px', borderRadius: '6px', fontSize: '14px', fontWeight: 'bold' }}>
                        ✅ Confirmado el {new Date(ingreso.confirmed_at).toLocaleString('es-AR')}
                    </div>
                    {!ingreso.odoo_purchase_order_id && !ingreso.odoo_purchase_order_id_preventas && (
                        <button
                            onClick={() => setShowGenerateOCModal(true)}
                            disabled={generatingOC}
                            style={{ backgroundColor: generatingOC ? '#ccc' : '#E65100', color: C.white, border: 'none', padding: '10px 20px', borderRadius: '4px', fontSize: '14px', fontWeight: 'bold', cursor: generatingOC ? 'not-allowed' : 'pointer' }}
                        >
                            {generatingOC ? '⏳ Generando...' : '🔗 Generar OC en Odoo'}
                        </button>
                    )}
                    {ingreso.odoo_purchase_order_id && (
                        <button
                            onClick={handleSupplementNeggoOC}
                            disabled={supplementingNeggoOC}
                            title="Agrega a la OC de Neggo los ítems matched que no están en ella"
                            style={{ backgroundColor: supplementingNeggoOC ? '#ccc' : '#1565C0', color: C.white, border: 'none', padding: '10px 20px', borderRadius: '4px', fontSize: '14px', fontWeight: 'bold', cursor: supplementingNeggoOC ? 'not-allowed' : 'pointer' }}
                        >
                            {supplementingNeggoOC ? '⏳ Procesando...' : '➕ Completar OC Neggo'}
                        </button>
                    )}
                    <button onClick={() => navigate('/ingreso')} style={{ backgroundColor: C.bg, color: C.text, border: `1px solid ${C.border}`, padding: '10px 16px', borderRadius: '4px', fontSize: '14px', cursor: 'pointer' }}>
                        Volver
                    </button>
                </div>
            )}
        </div>
    );
}
