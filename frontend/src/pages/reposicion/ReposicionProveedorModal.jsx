import { useState, useEffect, useCallback } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR, fmtInt } from '../../theme/tokens';
import useIsMobile from '../../hooks/useIsMobile';
import Modal from '../../components/common/Modal';
import Tabs from '../../components/common/Tabs';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import ProductThumb from '../../components/common/ProductThumb';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import FotoAmpliada from '../../components/common/FotoAmpliada';
import * as Icon from '../../components/common/icons';

const BTN_MOVIL = {
    flex: 1,
    minWidth: 0,
    height: 52,
    flexDirection: 'column',
    gap: 3,
    padding: '6px 4px',
    fontSize: 11,
};

function Acciones({ p, trabajando, onReponer, onQuitar, onPedirArchivar, onPedirActivar, stacked, t }) {
    const busy = trabajando === p.odoo_id;
    const activo = p.active !== false;
    const estilo = stacked ? BTN_MOVIL : undefined;
    const icon = stacked ? 18 : 13;

    return (
        <div style={{
            display: 'flex', gap: t.space[2], flexShrink: 0, alignItems: 'stretch',
            flexWrap: stacked ? 'nowrap' : 'wrap', justifyContent: stacked ? 'stretch' : 'flex-end',
            width: stacked ? '100%' : undefined,
        }}>
            {p.estado_cola === 'encargado' ? (
                <Badge tone="accent" dot>Encargado</Badge>
            ) : p.en_cola ? (
                // Si se marcó por error, se puede sacar de la cola
                <div style={{
                    display: 'flex', alignItems: 'center', gap: t.space[2],
                    flex: stacked ? 1 : undefined, minWidth: 0,
                }}>
                    <Badge tone="success" dot>En la cola</Badge>
                    <Button
                        size="sm"
                        variant="ghost"
                        leftIcon={<Icon.X size={icon} />}
                        disabled={busy}
                        onClick={() => onQuitar(p)}
                        title="Sacarlo de la cola de reposición"
                        style={estilo}
                    >
                        Quitar
                    </Button>
                </div>
            ) : (
                <Button
                    size="sm"
                    variant="primary"
                    leftIcon={<Icon.Plus size={icon} />}
                    disabled={busy}
                    onClick={() => onReponer(p)}
                    style={estilo}
                >
                    Reponer
                </Button>
            )}
            {activo ? (
                <Button
                    size="sm"
                    variant="danger"
                    leftIcon={<Icon.Archive size={icon} />}
                    disabled={busy}
                    onClick={() => onPedirArchivar(p)}
                    style={estilo}
                >
                    Archivar
                </Button>
            ) : (
                <Button
                    size="sm"
                    variant="success"
                    leftIcon={<Icon.Check size={icon} />}
                    disabled={busy}
                    onClick={() => onPedirActivar(p)}
                    style={estilo}
                >
                    Activar
                </Button>
            )}
        </div>
    );
}

function MetaProducto({ p, extra, t }) {
    return (
        <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, display: 'flex', flexWrap: 'wrap', gap: '0 8px' }}>
            <span style={{ fontFamily: t.font.mono }}>{p.internal_ref || p.barcode || '—'}</span>
            {extra}
            {p.active !== false && p.qty_available != null && (
                <span style={{ ...t.numericStyle }}>Stock {fmtInt(p.qty_available)}</span>
            )}
            {parseFloat(p.standard_price) > 0 && (
                <span style={{ ...t.numericStyle }}>Costo {fmtAR(p.standard_price)}</span>
            )}
        </div>
    );
}

// Miniatura que abre la foto en grande; sin foto queda como estaba
function MiniaturaTocable({ p, size, onVerFoto, t }) {
    if (!p.image_url) return <ProductThumb imageUrl={p.image_url} size={size} />;
    return (
        <button
            type="button"
            onClick={() => onVerFoto(p)}
            aria-label={`Ver foto de ${p.name}`}
            title="Ver foto en grande"
            style={{
                padding: 0, border: 'none', background: 'none', cursor: 'zoom-in',
                borderRadius: t.radius.sm, flexShrink: 0, lineHeight: 0,
            }}
        >
            <ProductThumb imageUrl={p.image_url} size={size} />
        </button>
    );
}

function FilaProducto({ p, trabajando, onReponer, onQuitar, onPedirArchivar, onPedirActivar, onVerFoto, extra, isMobile, t }) {
    const acciones = { p, trabajando, onReponer, onQuitar, onPedirArchivar, onPedirActivar, t };

    if (isMobile) {
        return (
            <div style={{
                display: 'flex', flexDirection: 'column', gap: 10,
                padding: '12px 2px 14px',
                borderTop: `1px solid ${t.color.border}`,
            }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <MiniaturaTocable p={p} size={52} onVerFoto={onVerFoto} t={t} />
                    <div style={{ flex: 1, minWidth: 0, fontFamily: t.font.family }}>
                        <div title={p.name} style={{
                            fontSize: t.font.size.base, fontWeight: t.font.weight.semibold, color: t.color.text,
                            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                        }}>
                            {p.name}
                        </div>
                        <MetaProducto p={p} extra={extra} t={t} />
                    </div>
                </div>
                <Acciones {...acciones} stacked />
            </div>
        );
    }

    return (
        <div style={{
            display: 'flex', alignItems: 'center', gap: t.space[3],
            padding: '8px 4px', borderTop: `1px solid ${t.color.border}`,
        }}>
            <MiniaturaTocable p={p} size={36} onVerFoto={onVerFoto} t={t} />
            <div style={{ flex: 1, minWidth: 0, fontFamily: t.font.family }}>
                <div title={p.name} style={{
                    fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.text,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                    {p.name}
                </div>
                <MetaProducto p={p} extra={extra} t={t} />
            </div>
            <Acciones {...acciones} />
        </div>
    );
}

export default function ReposicionProveedorModal({ vendorName, onClose, onAgregado, onQuitado, onActivado, onError }) {
    const { tokens: t } = useTheme();
    const isMobile = useIsMobile();
    const [tab, setTab] = useState('activos');
    const [detalle, setDetalle] = useState(null);
    const [loading, setLoading] = useState(true);
    const [trabajando, setTrabajando] = useState(null);
    const [confirmar, setConfirmar] = useState(null);
    const [foto, setFoto] = useState(null);
    const cerrarFoto = useCallback(() => setFoto(null), []);

    useEffect(() => {
        if (!vendorName) return;
        let vigente = true;
        setLoading(true);
        setDetalle(null);
        setTab('activos');
        setConfirmar(null);
        setFoto(null);
        api.get('/reposicion/proveedor', { nombre: vendorName })
            .then(res => {
                if (!vigente) return;
                if (res.success) setDetalle(res.data);
                else onError(res.error || 'No se pudo cargar el proveedor');
            })
            .catch(() => { if (vigente) onError('No se pudo cargar el proveedor'); })
            .finally(() => { if (vigente) setLoading(false); });
        return () => { vigente = false; };
    }, [vendorName, onError]);

    const marcarEnCola = (lista, odooId, extra = {}) =>
        lista.map(x => x.odoo_id === odooId ? { ...x, en_cola: true, estado_cola: x.estado_cola || 'pendiente', ...extra } : x);

    const reponer = async (p) => {
        setTrabajando(p.odoo_id);
        const res = await api.post('/reposicion', { odoo_id: p.odoo_id });
        setTrabajando(null);
        if (!res.success) { onError(res.error || 'No se pudo marcar para reponer'); return; }
        setDetalle(prev => {
            if (!prev) return prev;
            return {
                ...prev,
                activos: marcarEnCola(prev.activos, p.odoo_id),
                archivados: marcarEnCola(prev.archivados, p.odoo_id),
            };
        });
        onAgregado(res.data);
    };

    const quitar = async (p) => {
        setTrabajando(p.odoo_id);
        const res = await api.del(`/reposicion/producto/${p.odoo_id}`);
        setTrabajando(null);
        if (!res.success) { onError(res.error || 'No se pudo sacar de la cola'); return; }
        const sacar = (lista) => lista.map(x => x.odoo_id === p.odoo_id ? { ...x, en_cola: false, estado_cola: null } : x);
        setDetalle(prev => prev && { ...prev, activos: sacar(prev.activos), archivados: sacar(prev.archivados) });
        onQuitado?.(res.data);
    };

    const confirmarOdoo = async () => {
        const accion = confirmar;
        if (!accion?.p) return;
        const p = accion.p;
        setConfirmar(null);
        setTrabajando(p.odoo_id);
        if (accion.tipo === 'activar') {
            const res = await api.post('/reposicion/activar', { odoo_id: p.odoo_id });
            setTrabajando(null);
            if (!res.success) { onError(res.error || 'No se pudo activar en Odoo'); return; }
            setDetalle(prev => {
                if (!prev) return prev;
                const ya = prev.activos.some(x => x.odoo_id === p.odoo_id);
                const activo = { ...p, active: true, en_cola: false, estado_cola: null };
                return {
                    ...prev,
                    archivados: prev.archivados.filter(x => x.odoo_id !== p.odoo_id),
                    n_archivados_total: Math.max(0, (prev.n_archivados_total || 0) - 1),
                    n_activos_total: ya ? prev.n_activos_total : (prev.n_activos_total || 0) + 1,
                    activos: ya
                        ? prev.activos.map(x => x.odoo_id === p.odoo_id ? activo : x)
                        : [activo, ...prev.activos],
                };
            });
            onActivado?.(res.data);
            return;
        }
        const res = await api.post('/reposicion/archivar', { odoo_id: p.odoo_id });
        setTrabajando(null);
        if (!res.success) { onError(res.error || 'No se pudo archivar en Odoo'); return; }
        setDetalle(prev => {
            if (!prev) return prev;
            const ya = prev.archivados.some(x => x.odoo_id === p.odoo_id);
            const archivado = {
                ...p,
                active: false,
                en_cola: true,
                estado_cola: res.data?.estado || 'pendiente',
            };
            return {
                ...prev,
                activos: prev.activos.filter(x => x.odoo_id !== p.odoo_id),
                n_activos_total: Math.max(0, (prev.n_activos_total || 0) - 1),
                archivados: ya ? marcarEnCola(prev.archivados, p.odoo_id, { active: false }) : [archivado, ...prev.archivados],
                n_archivados_total: ya ? prev.n_archivados_total : (prev.n_archivados_total || 0) + 1,
            };
        });
        onAgregado(res.data);
    };

    const activos = detalle?.activos || [];
    const archivados = detalle?.archivados || [];
    const propsFila = {
        trabajando,
        onReponer: reponer,
        onQuitar: quitar,
        onPedirArchivar: (p) => setConfirmar({ tipo: 'archivar', p }),
        onPedirActivar: (p) => setConfirmar({ tipo: 'activar', p }),
        onVerFoto: setFoto,
        isMobile,
        t,
    };

    return (
        <>
            <Modal
                isOpen={!!vendorName}
                onClose={onClose}
                title={vendorName}
                subtitle={isMobile
                    ? 'Reponer, archivar o volver a activar en Odoo.'
                    : 'Reponer lo que falta, archivar en Odoo lo sin stock, o activar un archivado.'}
                size="lg"
                fullScreen={isMobile}
            >
                {loading ? (
                    <div style={{ padding: 32, textAlign: 'center', color: t.color.textMuted, fontFamily: t.font.family }}>
                        Cargando…
                    </div>
                ) : (
                    <>
                        <Tabs
                            fullWidth={isMobile}
                            tabs={[
                                { value: 'activos', label: 'Activos', count: detalle?.n_activos_total || 0, icon: <Icon.Package size={14} /> },
                                { value: 'archivados', label: 'Archivados', count: detalle?.n_archivados_total || 0, icon: <Icon.Archive size={14} /> },
                            ]}
                            value={tab}
                            onChange={setTab}
                        />

                        {tab === 'activos' && (
                            <div style={{ marginTop: t.space[4] }}>
                                {!isMobile && (
                                    <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginBottom: t.space[3], fontFamily: t.font.family }}>
                                        Productos vivos, ordenados por lo más vendido de la semana. Reponer: queda poco. Archivar: se apaga en Odoo.
                                    </div>
                                )}
                                {detalle?.ventas_error && (
                                    <div style={{
                                        background: t.color.warnSoft, color: t.color.warn, padding: '12px 14px',
                                        borderRadius: t.radius.sm, fontSize: t.font.size.sm, fontFamily: t.font.family,
                                        marginBottom: t.space[3],
                                    }}>
                                        No pudimos leer las ventas de Odoo ({detalle.ventas_error}). El listado igual está, sin ese orden.
                                    </div>
                                )}
                                {activos.length === 0 ? (
                                    <div style={{ padding: '28px 8px', textAlign: 'center', color: t.color.textMuted, fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                                        Este proveedor no tiene productos activos.
                                    </div>
                                ) : (
                                    <>
                                        {activos.map(p => (
                                            <FilaProducto
                                                key={p.odoo_id}
                                                p={p}
                                                {...propsFila}
                                                extra={p.qty_semana > 0
                                                    ? <span style={{ ...t.numericStyle }}>{fmtInt(p.qty_semana)} vendidos</span>
                                                    : null}
                                            />
                                        ))}
                                        {(detalle?.n_activos_total || 0) > activos.length && (
                                            <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: t.space[3], fontFamily: t.font.family }}>
                                                Mostramos los {activos.length} más vendidos de {fmtInt(detalle.n_activos_total)} activos.
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        )}

                        {tab === 'archivados' && (
                            <div style={{ marginTop: t.space[4] }}>
                                {!isMobile && (
                                    <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginBottom: t.space[3], fontFamily: t.font.family }}>
                                        Ya no están en Odoo, ordenados por lo más vendido de la semana. Reponer los suma a la cola. Activar los vuelve a prender en Odoo.
                                    </div>
                                )}
                                {archivados.length === 0 ? (
                                    <div style={{ padding: '28px 8px', textAlign: 'center', color: t.color.textMuted, fontSize: t.font.size.sm, fontFamily: t.font.family }}>
                                        Este proveedor no tiene productos archivados.
                                    </div>
                                ) : (
                                    <>
                                        {archivados.map(p => (
                                            <FilaProducto
                                                key={p.odoo_id}
                                                p={p}
                                                {...propsFila}
                                                extra={p.qty_semana > 0
                                                    ? <span style={{ ...t.numericStyle }}>{fmtInt(p.qty_semana)} vendidos</span>
                                                    : null}
                                            />
                                        ))}
                                        {(detalle?.n_archivados_total || 0) > archivados.length && (
                                            <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, marginTop: t.space[3], fontFamily: t.font.family }}>
                                                Mostramos los {archivados.length} más vendidos de {fmtInt(detalle.n_archivados_total)} archivados.
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        )}
                    </>
                )}
            </Modal>

            <FotoAmpliada
                imageUrl={foto?.image_url}
                nombre={foto?.name}
                detalle={foto ? (foto.internal_ref || foto.barcode) : null}
                onClose={cerrarFoto}
            />

            <ConfirmDialog
                isOpen={!!confirmar}
                onClose={() => setConfirmar(null)}
                onConfirm={confirmarOdoo}
                danger={confirmar?.tipo === 'archivar'}
                title={confirmar?.tipo === 'activar' ? 'Activar en Odoo' : 'Archivar en Odoo'}
                confirmLabel={confirmar?.tipo === 'activar' ? 'Sí, activar' : 'Sí, archivar'}
                message={confirmar?.tipo === 'activar'
                    ? `«${confirmar?.p?.name || ''}» vuelve a estar activo en Odoo y en el Punto de Venta, y sale de la lista de reposición.`
                    : `«${confirmar?.p?.name || ''}» se apaga en Odoo porque no queda stock, y entra a la cola como agotado.`}
            />
        </>
    );
}
