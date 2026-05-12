import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ingresoAPI } from '../api/ingresoClient';
import api from '../api/client';
import { useTheme } from '../theme/ThemeContext';
import { fmtAR } from '../theme/tokens';
import Card from '../components/common/Card';
import Badge from '../components/common/Badge';
import Button from '../components/common/Button';
import Select from '../components/common/Select';
import ConfirmDialog from '../components/common/ConfirmDialog';
import * as Icon from '../components/common/icons';

const fmtARS = (v) => v != null ? `$${Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';

const ESTADO_OPTS = [
    { value: '',           label: 'Todos los estados' },
    { value: 'pending',    label: 'Pendientes' },
    { value: 'confirmado', label: 'Confirmados' },
];

export default function IngresoList() {
    const { tokens: t } = useTheme();
    const navigate = useNavigate();
    const location = useLocation();

    const [ingresos, setIngresos] = useState([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [successMsg, setSuccessMsg] = useState(location.state?.message || null);
    const [counts, setCounts] = useState({ pending: 0, confirmado: 0 });
    const [suppliers, setSuppliers] = useState([]);
    const [confirmDelete, setConfirmDelete] = useState(null);
    const [deleting, setDeleting] = useState(false);

    const [filtroEstado, setFiltroEstado] = useState('');
    const [filtroSupplier, setFiltroSupplier] = useState('');
    const [filtroDesde, setFiltroDesde] = useState('');
    const [filtroHasta, setFiltroHasta] = useState('');
    const [page, setPage] = useState(0);
    const LIMIT = 20;

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const filters = { limit: LIMIT, offset: page * LIMIT };
            if (filtroEstado)   filters.estado      = filtroEstado;
            if (filtroSupplier) filters.supplier_id = filtroSupplier;
            if (filtroDesde)    filters.desde       = filtroDesde;
            if (filtroHasta)    filters.hasta       = filtroHasta;
            const res = await ingresoAPI.listIngresos(filters);
            if (res.success) { setIngresos(Array.isArray(res.data) ? res.data : (res.data?.data || [])); setTotal(res.pagination?.total || 0); }
            else setError(res.error || 'Error cargando ingresos');
        } catch (err) { setError(err.message); }
        finally { setLoading(false); }
    }, [filtroEstado, filtroSupplier, filtroDesde, filtroHasta, page]);

    useEffect(() => { load(); }, [load]);

    useEffect(() => {
        Promise.all([
            ingresoAPI.listIngresos({ estado: 'pending',    limit: 1, offset: 0 }),
            ingresoAPI.listIngresos({ estado: 'confirmado', limit: 1, offset: 0 }),
        ]).then(([pRes, cRes]) => setCounts({ pending: pRes.pagination?.total || 0, confirmado: cRes.pagination?.total || 0 })).catch(() => {});
    }, []);

    useEffect(() => {
        api.get('/suppliers', { limit: 100 }).then(res => { if (res.success) setSuppliers(res.data?.data || res.data || []); }).catch(() => {});
    }, []);

    useEffect(() => { if (location.state?.message) window.history.replaceState({}, ''); }, []);

    async function handleDelete() {
        if (!confirmDelete) return;
        setDeleting(true);
        try {
            const res = await ingresoAPI.deleteIngreso(confirmDelete.id);
            if (res.success) { setConfirmDelete(null); setSuccessMsg(`Ingreso #${confirmDelete.id} eliminado`); load(); }
            else { setError(res.error || 'Error al eliminar'); setConfirmDelete(null); }
        } catch (err) { setError(err.message); setConfirmDelete(null); }
        finally { setDeleting(false); }
    }

    const totalPages = Math.ceil(total / LIMIT);
    const resetFiltros = () => { setFiltroEstado(''); setFiltroSupplier(''); setFiltroDesde(''); setFiltroHasta(''); setPage(0); };
    const hayFiltros = filtroEstado || filtroSupplier || filtroDesde || filtroHasta;

    const supplierOptions = [{ value: '', label: 'Todos los proveedores' }, ...suppliers.map(s => ({ value: String(s.id), label: s.name }))];
    const dateInputStyle = { padding: `0 12px`, height: t.layout.inputHeight, border: `1px solid ${t.color.borderStrong}`, borderRadius: t.radius.sm, fontSize: t.font.size.sm, fontFamily: t.font.family, color: t.color.text, background: t.color.surface, boxSizing: 'border-box' };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>

            {/* Acción */}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button variant="primary" leftIcon={<Icon.PackageDown size={15} />} onClick={() => navigate('/ingreso/new')}>
                    Nuevo ingreso
                </Button>
            </div>

            {/* Mensajes */}
            {successMsg && (
                <div style={{ background: t.color.successSoft, color: t.color.success, padding: '12px 16px', borderRadius: t.radius.sm, fontSize: t.font.size.sm, fontFamily: t.font.family, display: 'flex', justifyContent: 'space-between' }}>
                    <span>{successMsg}</span>
                    <button onClick={() => setSuccessMsg(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: t.color.success, fontWeight: 'bold' }}>✕</button>
                </div>
            )}
            {error && (
                <div style={{ background: t.color.dangerSoft, color: t.color.danger, padding: '12px 16px', borderRadius: t.radius.sm, fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                    {error}
                </div>
            )}

            {/* Stats */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: t.space[3] }}>
                <StatTile label="Total" value={counts.pending + counts.confirmado} active={!filtroEstado} accentColor={t.color.primary} tokens={t} onClick={resetFiltros} />
                <StatTile label="Pendientes" value={counts.pending} active={filtroEstado === 'pending'} accentColor={t.color.warn} tokens={t} onClick={() => { setFiltroEstado('pending'); setPage(0); }} />
                <StatTile label="Confirmados" value={counts.confirmado} active={filtroEstado === 'confirmado'} accentColor={t.color.success} tokens={t} onClick={() => { setFiltroEstado('confirmado'); setPage(0); }} />
            </div>

            {/* Filtros */}
            <Card padding={false} style={{ padding: t.space[5] }}>
                <div style={{ display: 'flex', gap: t.space[3], flexWrap: 'wrap', alignItems: 'center' }}>
                    <Select value={filtroEstado} onChange={v => { setFiltroEstado(v); setPage(0); }} options={ESTADO_OPTS} style={{ width: 180 }} />
                    <Select value={filtroSupplier} onChange={v => { setFiltroSupplier(v); setPage(0); }} options={supplierOptions} style={{ width: 200 }} />
                    <div style={{ display: 'flex', alignItems: 'center', gap: t.space[2] }}>
                        <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family }}>Desde</span>
                        <input type="date" value={filtroDesde} onChange={e => { setFiltroDesde(e.target.value); setPage(0); }} style={dateInputStyle} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: t.space[2] }}>
                        <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family }}>Hasta</span>
                        <input type="date" value={filtroHasta} onChange={e => { setFiltroHasta(e.target.value); setPage(0); }} style={dateInputStyle} />
                    </div>
                    {hayFiltros && <Button size="sm" variant="ghost" leftIcon={<Icon.X size={13} />} onClick={resetFiltros}>Limpiar</Button>}
                    <Button size="sm" variant="ghost" leftIcon={<Icon.Refresh size={13} />} onClick={load} style={{ marginLeft: 'auto' }}>Actualizar</Button>
                </div>
            </Card>

            {/* Lista */}
            {loading ? (
                <div style={{ textAlign: 'center', padding: 48, color: t.color.textMuted, fontFamily: t.font.family }}>Cargando…</div>
            ) : ingresos.length === 0 ? (
                <Card style={{ padding: '64px 24px', textAlign: 'center' }}>
                    <div style={{ fontSize: 48, marginBottom: 12 }}>📋</div>
                    <div style={{ fontSize: t.font.size.lg, fontWeight: t.font.weight.semibold, color: t.color.text, marginBottom: 8, fontFamily: t.font.family }}>
                        {hayFiltros ? 'No hay ingresos con esos filtros' : 'No hay ingresos registrados todavía'}
                    </div>
                    <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                        {hayFiltros ? 'Probá limpiar los filtros' : 'Subí tu primer CSV para empezar'}
                    </div>
                    {!hayFiltros && (
                        <Button variant="primary" style={{ marginTop: t.space[5] }} onClick={() => navigate('/ingreso/new')}>
                            + Nuevo ingreso
                        </Button>
                    )}
                </Card>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[3] }}>
                    {ingresos.map(ingreso => (
                        <IngresoRow
                            key={ingreso.id}
                            ingreso={ingreso}
                            tokens={t}
                            onClick={() => navigate(`/ingreso/${ingreso.id}`)}
                            onDelete={ingreso.estado === 'pending' ? () => setConfirmDelete(ingreso) : null}
                        />
                    ))}
                </div>
            )}

            {/* Paginación */}
            {totalPages > 1 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family, ...t.numericStyle }}>{total} registros</span>
                    <div style={{ display: 'flex', gap: t.space[2] }}>
                        <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>← Anterior</Button>
                        <span style={{ display: 'flex', alignItems: 'center', fontSize: t.font.size.sm, color: t.color.textMuted, padding: '0 8px' }}>
                            {page + 1} / {totalPages}
                        </span>
                        <Button size="sm" variant="secondary" disabled={page >= totalPages - 1} onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}>Siguiente →</Button>
                    </div>
                </div>
            )}

            <ConfirmDialog
                isOpen={!!confirmDelete}
                onClose={() => setConfirmDelete(null)}
                onConfirm={handleDelete}
                title="Eliminar ingreso"
                message={`¿Eliminás el Ingreso #${confirmDelete?.id}${confirmDelete?.comprobante_tipo ? ` (${confirmDelete.comprobante_tipo.toUpperCase()}${confirmDelete.comprobante_numero ? ` · ${confirmDelete.comprobante_numero}` : ''})` : ''}? Esta acción no se puede deshacer.`}
                confirmLabel={deleting ? 'Eliminando…' : 'Eliminar'}
                danger
            />
        </div>
    );
}

function StatTile({ label, value, active, accentColor, tokens: t, onClick }) {
    return (
        <div
            onClick={onClick}
            style={{
                background: active ? `${accentColor}18` : t.color.surface,
                border: `1.5px solid ${active ? accentColor : t.color.border}`,
                borderRadius: t.radius.md,
                padding: `${t.space[3]}px ${t.space[5]}px`,
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: t.space[3],
                transition: 'all 150ms',
            }}
        >
            <div>
                <div style={{ fontSize: t.font.size['2xl'], fontWeight: t.font.weight.semibold, color: active ? accentColor : t.color.text, ...t.numericStyle }}>
                    {value}
                </div>
                <div style={{ fontSize: t.font.size.xs, color: active ? accentColor : t.color.textMuted, fontWeight: active ? t.font.weight.semibold : t.font.weight.regular, fontFamily: t.font.family }}>
                    {label}
                </div>
            </div>
        </div>
    );
}

function IngresoRow({ ingreso, tokens: t, onClick, onDelete }) {
    const isPending = ingreso.estado === 'pending';
    const [hovered, setHovered] = useState(false);

    return (
        <div
            onClick={onClick}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
                background: t.color.surface,
                border: `1px solid ${isPending ? t.color.warn + '66' : t.color.border}`,
                borderLeft: `4px solid ${isPending ? t.color.warn : t.color.success}`,
                borderRadius: t.radius.md,
                padding: `14px 18px`,
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: t.space[5], flexWrap: 'wrap',
                boxShadow: hovered ? t.shadow.pop : t.shadow.card,
                transition: 'box-shadow 120ms',
            }}
        >
            {/* ID */}
            <div style={{ minWidth: 48 }}>
                <div style={{ fontSize: t.font.size.xs, color: t.color.textFaint, fontFamily: t.font.family }}>ID</div>
                <div style={{ fontSize: 18, fontWeight: t.font.weight.semibold, color: t.color.primary, ...t.numericStyle }}>#{ingreso.id}</div>
            </div>

            {/* Estado */}
            <Badge tone={isPending ? 'warn' : 'success'} dot>
                {isPending ? 'Pendiente' : 'Confirmado'}
            </Badge>

            {/* Comprobante */}
            <div style={{ flex: 1, minWidth: 140 }}>
                <div style={{ fontSize: t.font.size.xs, color: t.color.textFaint, fontFamily: t.font.family, marginBottom: 2 }}>Comprobante</div>
                <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.text, fontFamily: t.font.family }}>
                    {ingreso.comprobante_tipo?.toUpperCase()}
                    {ingreso.comprobante_numero ? ` · ${ingreso.comprobante_numero}` : ''}
                </div>
            </div>

            {/* Proveedor */}
            <div style={{ flex: 1, minWidth: 140 }}>
                <div style={{ fontSize: t.font.size.xs, color: t.color.textFaint, fontFamily: t.font.family, marginBottom: 2 }}>Proveedor</div>
                <div style={{ fontSize: t.font.size.sm, color: ingreso.supplier_name ? t.color.text : t.color.textFaint, fontStyle: ingreso.supplier_name ? 'normal' : 'italic', fontFamily: t.font.family }}>
                    {ingreso.supplier_name || 'Sin especificar'}
                </div>
            </div>

            {/* Ítems */}
            <div style={{ minWidth: 60, textAlign: 'center' }}>
                <div style={{ fontSize: t.font.size.xs, color: t.color.textFaint, fontFamily: t.font.family, marginBottom: 2 }}>Ítems</div>
                <div style={{ fontSize: 15, fontWeight: t.font.weight.semibold, color: t.color.text, ...t.numericStyle }}>{ingreso.items_count || '—'}</div>
            </div>

            {/* Total */}
            <div style={{ minWidth: 110, textAlign: 'right' }}>
                <div style={{ fontSize: t.font.size.xs, color: t.color.textFaint, fontFamily: t.font.family, marginBottom: 2 }}>Total</div>
                <div style={{ fontSize: 15, fontWeight: t.font.weight.semibold, color: t.color.primary, ...t.numericStyle }}>{fmtARS(ingreso.total_monto)}</div>
            </div>

            {/* Fecha */}
            <div style={{ minWidth: 100, textAlign: 'right' }}>
                <div style={{ fontSize: t.font.size.xs, color: t.color.textFaint, fontFamily: t.font.family, marginBottom: 2 }}>
                    {isPending ? 'Creado' : 'Confirmado'}
                </div>
                <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family }}>
                    {isPending ? fmtDate(ingreso.created_at) : fmtDate(ingreso.confirmed_at)}
                </div>
            </div>

            {/* OC Odoo */}
            {ingreso.odoo_purchase_order_id && (
                <Badge tone="success">OC #{ingreso.odoo_purchase_order_id}</Badge>
            )}

            {/* Eliminar */}
            {onDelete && (
                <button
                    onClick={e => { e.stopPropagation(); onDelete(); }}
                    title="Eliminar ingreso"
                    style={{ flexShrink: 0, padding: '4px 8px', borderRadius: t.radius.sm, border: `1px solid ${t.color.danger}`, background: t.color.dangerSoft, color: t.color.danger, cursor: 'pointer', fontSize: 13 }}
                >
                    🗑️
                </button>
            )}

            <Icon.ChevronRight size={16} color={t.color.textFaint} style={{ flexShrink: 0 }} />
        </div>
    );
}
