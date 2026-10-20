import { useState, useEffect } from 'react';
import api from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR, fmtInt } from '../../theme/tokens';
import useIsMobile from '../../hooks/useIsMobile';
import Modal from '../../components/common/Modal';
import Tabs from '../../components/common/Tabs';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import ProductThumb from '../../components/common/ProductThumb';
import ConfirmDialog from '../../components/common/ConfirmDialog';
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

function Acciones({ p, trabajando, onReponer, onPedirArchivar, onPedirActivar, onPublicar, stacked, t }) {
    const busy = trabajando === p.odoo_id;
    const activo = p.active !== false;
    const estilo = stacked ? BTN_MOVIL : undefined;
    const icon = stacked ? 18 : 13;
    // Solo se publica lo vivo y con foto: sin foto el mensaje no sale.
    const publicable = onPublicar && activo && !!p.image_url;

    return (
        <div style={{
            display: 'flex', gap: t.space[2], flexShrink: 0, alignItems: 'stretch',
            flexWrap: stacked ? 'nowrap' : 'wrap', justifyContent: stacked ? 'stretch' : 'flex-end',
            width: stacked ? '100%' : undefined,
        }}>
            {p.estado_cola === 'encargado' ? (
                <Badge tone="accent" dot>Encargado</Badge>
            ) : p.en_cola ? (
                <Badge tone="success" dot>En la cola</Badge>
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
            {publicable && (
                <Button
                    size="sm"
                    variant="secondary"
                    leftIcon={<Icon.MessageCircle size={icon} />}
                    disabled={busy}
                    onClick={() => onPublicar(p)}
                    title="Publicar en WhatsApp"
                    style={stacked ? { ...BTN_MOVIL, flex: '0 0 68px' } : undefined}
                >
                    WhatsApp
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

function FilaProducto({ p, trabajando, onReponer, onPedirArchivar, onPedirActivar, onPublicar, extra, isMobile, t }) {
    const acciones = { p, trabajando, onReponer, onPedirArchivar, onPedirActivar, onPublicar, t };

    if (isMobile) {
        return (
            <div style={{
                display: 'flex', flexDirection: 'column', gap: 10,
                padding: '12px 2px 14px',
                borderTop: `1px solid ${t.color.border}`,
            }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <ProductThumb imageUrl={p.image_url} size={52} />
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
            <ProductThumb imageUrl={p.image_url} size={36} />
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

// Elegir dónde sale la foto: el grupo configurado en Admin → WhatsApp o el estado (novedades).
function PublicarWhatsApp({ producto, onClose, onPublicado, t }) {
    const [config, setConfig] = useState(null);
    const [enviando, setEnviando] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!producto) return;
        let vigente = true;
        setConfig(null);
        setError(null);
        setEnviando(null);
        api.get('/whatsapp/status')
            .then(res => {
                if (!vigente) return;
                if (res.success) setConfig(res.data);
                else setError(res.error || 'No se pudo leer la configuración de WhatsApp');
            })
            .catch(() => { if (vigente) setError('No se pudo leer la configuración de WhatsApp'); });
        return () => { vigente = false; };
    }, [producto]);

    const grupo = config?.settings?.group_subject || config?.settings?.group_jid || null;
    // Grupos y estados salen por números distintos: cada uno con su conexión.
    const sinGrupos = config && config.evolution?.state !== 'open';
    const sinEstados = config && config.evolution_status?.state !== 'open';
    const desconectados = [sinGrupos && 'el de grupos', sinEstados && 'el de estados'].filter(Boolean);

    const publicar = async (destino) => {
        setEnviando(destino);
        setError(null);
        const res = await api.post('/whatsapp/send-now', { company: 'neggo', odoo_id: producto.odoo_id, destino });
        setEnviando(null);
        if (!res.success) { setError(res.error || 'No se pudo publicar'); return; }
        onPublicado(destino === 'estado'
            ? `«${producto.name}» se sube a los estados en unos segundos.`
            : `«${producto.name}» sale al grupo ${grupo ? `«${grupo}» ` : ''}en unos segundos.`);
    };

    const btn = { width: '100%', height: 48, justifyContent: 'flex-start' };

    return (
        <Modal
            isOpen={!!producto}
            onClose={onClose}
            title="Publicar en WhatsApp"
            subtitle={producto?.name}
            size="sm"
        >
            <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[3], fontFamily: t.font.family }}>
                <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>
                    Sale con la foto, el precio de la lista Neggo y el link a la web.
                </div>
                {desconectados.length > 0 && (
                    <div style={{ background: t.color.warnSoft, color: t.color.warn, padding: '10px 12px', borderRadius: t.radius.sm, fontSize: t.font.size.sm }}>
                        No está conectado {desconectados.join(' ni ')}. Lo que mandes ahí queda en la cola y sale cuando lo conectes en Admin → WhatsApp.
                    </div>
                )}
                {error && (
                    <div style={{ background: t.color.dangerSoft, color: t.color.danger, padding: '10px 12px', borderRadius: t.radius.sm, fontSize: t.font.size.sm }}>
                        {error}
                    </div>
                )}
                <Button
                    variant="primary"
                    leftIcon={<Icon.Users size={18} />}
                    disabled={!config || !grupo || !!enviando}
                    onClick={() => publicar('grupo')}
                    style={btn}
                >
                    {enviando === 'grupo' ? 'Publicando…' : grupo ? `Al grupo «${grupo}»` : 'Al grupo (elegilo en Admin → WhatsApp)'}
                </Button>
                <Button
                    variant="secondary"
                    leftIcon={<Icon.MessageCircle size={18} />}
                    disabled={!config || !!enviando}
                    onClick={() => publicar('estado')}
                    style={btn}
                >
                    {enviando === 'estado' ? 'Publicando…' : 'A los estados (novedades)'}
                </Button>
            </div>
        </Modal>
    );
}

export default function ReposicionProveedorModal({ vendorName, onClose, onAgregado, onActivado, onError }) {
    const { tokens: t } = useTheme();
    const { user } = useAuth();
    const isMobile = useIsMobile();
    const [tab, setTab] = useState('activos');
    const [detalle, setDetalle] = useState(null);
    const [loading, setLoading] = useState(true);
    const [trabajando, setTrabajando] = useState(null);
    const [confirmar, setConfirmar] = useState(null);
    const [publicando, setPublicando] = useState(null);
    const [avisoWa, setAvisoWa] = useState(null);

    useEffect(() => {
        if (!vendorName) return;
        let vigente = true;
        setLoading(true);
        setDetalle(null);
        setTab('activos');
        setConfirmar(null);
        setPublicando(null);
        setAvisoWa(null);
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
        onPedirArchivar: (p) => setConfirmar({ tipo: 'archivar', p }),
        onPedirActivar: (p) => setConfirmar({ tipo: 'activar', p }),
        // Publicar en WhatsApp es solo para admin (igual que Admin → WhatsApp).
        onPublicar: user?.role === 'admin' ? (p) => { setAvisoWa(null); setPublicando(p); } : null,
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
                        {avisoWa && (
                            <div style={{
                                display: 'flex', alignItems: 'center', gap: t.space[2],
                                background: t.color.successSoft, color: t.color.success, padding: '10px 12px',
                                borderRadius: t.radius.sm, fontSize: t.font.size.sm, fontFamily: t.font.family,
                                marginBottom: t.space[3],
                            }}>
                                <Icon.Check size={16} />
                                <span style={{ flex: 1, minWidth: 0 }}>{avisoWa}</span>
                                <button
                                    type="button"
                                    onClick={() => setAvisoWa(null)}
                                    aria-label="Cerrar aviso"
                                    style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 4, display: 'flex' }}
                                >
                                    <Icon.X size={14} />
                                </button>
                            </div>
                        )}
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

            <PublicarWhatsApp
                producto={publicando}
                onClose={() => setPublicando(null)}
                onPublicado={(msg) => { setPublicando(null); setAvisoWa(msg); }}
                t={t}
            />

            <ConfirmDialog
                isOpen={!!confirmar}
                onClose={() => setConfirmar(null)}
                onConfirm={confirmarOdoo}
                danger={confirmar?.tipo === 'archivar'}
                title={confirmar?.tipo === 'activar' ? 'Activar en Odoo' : 'Archivar en Odoo'}
                confirmLabel={confirmar?.tipo === 'activar' ? 'Sí, activar' : 'Sí, archivar'}
                message={confirmar?.tipo === 'activar'
                    ? `«${confirmar?.p?.name || ''}» vuelve a estar activo en Odoo. Si estaba en la cola, queda como repuesto.`
                    : `«${confirmar?.p?.name || ''}» se apaga en Odoo porque no queda stock, y entra a la cola como agotado.`}
            />
        </>
    );
}
