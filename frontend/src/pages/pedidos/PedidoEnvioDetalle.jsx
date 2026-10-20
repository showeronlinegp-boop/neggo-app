import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import useIsMobile from '../../hooks/useIsMobile';
import useBarcodeScan from '../../hooks/useBarcodeScan';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Modal from '../../components/common/Modal';
import ProductThumb from '../../components/common/ProductThumb';
import * as Icon from '../../components/common/icons';

const SOPORTA_CAMERA = typeof window !== 'undefined'
    && 'BarcodeDetector' in window
    && navigator.mediaDevices?.getUserMedia;

const fmtARS = (v) => `$${Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ESTADO = {
    pendiente:   { label: 'Para armar',     tone: 'muted' },
    armando:     { label: 'Armando',        tone: 'accent' },
    armado:      { label: 'Para controlar', tone: 'warn' },
    controlando: { label: 'Controlando',    tone: 'primary' },
    saldado:     { label: 'Saldado',        tone: 'success' },
};

function qtyDe(item, estado) {
    return estado === 'controlando' || estado === 'saldado'
        ? Number(item.qty_controlada) || 0
        : Number(item.qty_armada) || 0;
}

// Hasta cuánto se cuenta. Con el envío 1 validado, el control es sobre lo armado:
// el resto quedó en el backorder del envío 1, pendiente de armar.
function topeDe(item, envio) {
    const pedida = Number(item.qty_pedida) || 0;
    const controlEnvio1 = (envio.estado === 'controlando' || envio.estado === 'saldado')
        && envio.odoo_picking_state === 'done';
    return controlEnvio1 ? Math.min(pedida, Number(item.qty_armada) || 0) : pedida;
}

export default function PedidoEnvioDetalle() {
    const { id } = useParams();
    const navigate = useNavigate();
    const { tokens: t } = useTheme();
    const isMobile = useIsMobile();
    const videoRef = useRef(null);
    const streamRef = useRef(null);
    const detectorRef = useRef(null);
    const rafRef = useRef(null);
    const ultimoCode = useRef('');
    const ultimoAt = useRef(0);
    const saldarEnVuelo = useRef(false);

    const [envio, setEnvio] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [aviso, setAviso] = useState(null);
    const [trabajando, setTrabajando] = useState(false);
    const [manual, setManual] = useState('');
    const [camaraOn, setCamaraOn] = useState(false);
    const [saldarOpen, setSaldarOpen] = useState(false);
    const [foto, setFoto] = useState(null);
    const [busqueda, setBusqueda] = useState('');
    const [soloFaltan, setSoloFaltan] = useState(false);
    const [faltanteOpen, setFaltanteOpen] = useState(null);
    const [faltanteQty, setFaltanteQty] = useState(0);
    const [terminarOpen, setTerminarOpen] = useState(false);

    const cargar = useCallback(async () => {
        const res = await api.get(`/pedido-envios/${id}`);
        if (!res.success) {
            setError(res.error || 'No se pudo cargar el pedido');
            setLoading(false);
            return;
        }
        setEnvio(res.data);
        if (res.data?.odoo_sync_error) {
            setError(res.data.odoo_sync_error);
        }
        setLoading(false);
    }, [id]);

    useEffect(() => { cargar(); }, [cargar]);

    const detenerCamara = useCallback(() => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
        streamRef.current?.getTracks().forEach((tr) => tr.stop());
        streamRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
        setCamaraOn(false);
    }, []);

    useEffect(() => () => detenerCamara(), [detenerCamara]);

    const aplicar = (res, okMsg) => {
        if (!res.success) {
            setError(res.error || 'No se pudo guardar');
            return false;
        }
        setEnvio(res.data);
        setError(null);
        if (okMsg) setAviso(okMsg);
        return true;
    };

    const escanear = useCallback(async (code) => {
        const c = String(code || '').trim();
        if (!c || trabajando) return;
        if (c === ultimoCode.current && Date.now() - ultimoAt.current < 2500) return;
        ultimoCode.current = c;
        ultimoAt.current = Date.now();
        setTrabajando(true);
        const res = await api.post(`/pedido-envios/${id}/escanear`, { code: c });
        setTrabajando(false);
        if (!res.success) {
            setError(res.error || `No encontré ${c} en este pedido`);
            return;
        }
        setEnvio(res.data);
        setError(null);
        setAviso(`Sumé 1 de «${c}»`);
        setManual('');
    }, [id, trabajando]);

    useBarcodeScan(escanear, {
        enabled: envio?.estado === 'controlando'
            || (envio?.estado === 'armando' && (envio.odoo_state === 'sale' || envio.odoo_state === 'done')),
    });

    const iniciarCamara = async () => {
        if (!SOPORTA_CAMERA) {
            setError('Este navegador no abre la cámara. Usá la pistola o escribí el código.');
            return;
        }
        try {
            detectorRef.current = new window.BarcodeDetector({
                formats: ['ean_13', 'ean_8', 'code_128', 'qr_code', 'upc_a', 'upc_e'],
            });
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: 'environment' } },
            });
            streamRef.current = stream;
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                await videoRef.current.play();
            }
            setCamaraOn(true);
            const tick = async () => {
                try {
                    if (videoRef.current && detectorRef.current) {
                        const codes = await detectorRef.current.detect(videoRef.current);
                        if (codes?.[0]?.rawValue) await escanear(codes[0].rawValue);
                    }
                } catch { /* frame fallido */ }
                rafRef.current = requestAnimationFrame(tick);
            };
            rafRef.current = requestAnimationFrame(tick);
        } catch (err) {
            setError(err.message || 'No se pudo abrir la cámara');
            detenerCamara();
        }
    };

    const setEstado = async (estado) => {
        setTrabajando(true);
        const res = await api.post(`/pedido-envios/${id}/estado`, { estado });
        setTrabajando(false);
        let okMsg = null;
        if (res.success && estado === 'armando' && res.data?.odoo_picking_name) {
            okMsg = `Atado al envío 1: ${res.data.odoo_picking_name}. Queda abierto en Odoo.`;
        }
        if (res.success && estado === 'armado' && res.data?.odoo_picking_name) {
            if (res.data.odoo_picking_backorder_name) {
                okMsg = `Validé ${res.data.odoo_picking_name}. Lo que faltó quedó en ${res.data.odoo_picking_backorder_name}.`;
            } else if (res.data.odoo_picking_state === 'done') {
                okMsg = `Validé el envío 1: ${res.data.odoo_picking_name}.`;
            } else {
                okMsg = `Armado listo. El envío ${res.data.odoo_picking_name} sigue abierto (no había cantidades para validar).`;
            }
        }
        aplicar(res, okMsg);
    };

    // Como Odoo: si falta algo, preguntar antes de validar el envío 1
    const pedirTerminarArmado = () => {
        const incompletos = (envio.items || []).filter((it) => qtyDe(it, envio.estado) < (Number(it.qty_pedida) || 0));
        if (incompletos.length) {
            setTerminarOpen(true);
            return;
        }
        setEstado('armado');
    };

    const confirmarTerminarArmado = async () => {
        setTerminarOpen(false);
        await setEstado('armado');
    };

    const setQtyAbs = async (item, qty, okMsg) => {
        const campo = envio.estado === 'controlando' ? 'qty_controlada' : 'qty_armada';
        const nueva = Math.max(0, Math.min(topeDe(item, envio), qty));
        if (nueva === (Number(item[campo]) || 0)) return;
        setTrabajando(true);
        const res = await api.patch(`/pedido-envios/items/${item.id}`, { [campo]: nueva });
        setTrabajando(false);
        aplicar(res, okMsg);
    };

    const setQty = (item, delta) => {
        const campo = envio.estado === 'controlando' ? 'qty_controlada' : 'qty_armada';
        return setQtyAbs(item, (Number(item[campo]) || 0) + delta);
    };

    const marcarTodo = (item) => setQtyAbs(
        item,
        topeDe(item, envio),
        `Marqué que llegó todo: ${item.product_name}`,
    );

    const abrirFaltante = (item, motivo) => {
        setFaltanteOpen({ item, motivo });
        setFaltanteQty(qtyDe(item, envio.estado));
        setError(null);
    };

    const confirmarFaltante = async () => {
        if (!faltanteOpen) return;
        const { item, motivo } = faltanteOpen;
        setTrabajando(true);
        const res = await api.post(`/pedido-envios/items/${item.id}/faltante`, {
            motivo,
            qty: faltanteQty,
        });
        setTrabajando(false);
        const labels = {
            archivado: 'archivado en Odoo. Lo que contaste en este pedido se mantiene',
            reponer: 'en la cola de reposición. Lo que contaste en este pedido se mantiene',
            faltante: 'marcado como faltante',
        };
        if (!aplicar(res, `«${item.product_name}» ${labels[motivo]}.`)) return;
        setFaltanteOpen(null);
    };

    const confirmarSaldar = async () => {
        if (saldarEnVuelo.current) return;
        saldarEnVuelo.current = true;
        setTrabajando(true);
        try {
            const res = await api.post(`/pedido-envios/${id}/saldar`);
            const salida = res.success ? res.data.odoo_salida : null;
            if (!aplicar(res, res.success
                ? (salida?.picking
                    ? `Entrega ${salida.picking.name} validada en Odoo con lo controlado.`
                        + (salida.backorder ? ` Lo que faltó quedó en ${salida.backorder.name}.` : '')
                    : res.data.backorder_odoo_name
                    ? `Odoo quedó con lo controlado. Pendientes en ${res.data.backorder_odoo_name}.`
                    : 'Odoo quedó igual a lo controlado. No había pendientes.')
                : null)) return;
            setSaldarOpen(false);
        } finally {
            saldarEnVuelo.current = false;
            setTrabajando(false);
        }
    };

    if (loading) {
        return <div style={{ padding: 24, color: t.color.textMuted, fontFamily: t.font.family }}>Cargando pedido…</div>;
    }
    if (!envio) {
        return (
            <div style={{ padding: 24, fontFamily: t.font.family }}>
                <div style={{ color: t.color.danger }}>{error || 'No está este pedido'}</div>
                <Button variant="ghost" onClick={() => navigate('/pedidos/armado')} style={{ marginTop: 12 }}>Volver</Button>
            </div>
        );
    }

    const est = ESTADO[envio.estado] || ESTADO.pendiente;
    const confirmadoEnOdoo = envio.odoo_state === 'sale' || envio.odoo_state === 'done';
    const editable = (envio.estado === 'armando' && confirmadoEnOdoo) || envio.estado === 'controlando';
    const campo = envio.estado === 'controlando' ? 'qty_controlada' : 'qty_armada';
    const preview = envio.preview || { queda: [], pendientes: [], iguales: [] };
    const pad = isMobile ? 12 : 20;

    return (
        <div style={{ padding: pad, paddingBottom: 96, maxWidth: 720, margin: '0 auto', fontFamily: t.font.family }}>
            <button
                type="button"
                onClick={() => navigate('/pedidos/armado')}
                style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', background: 'transparent',
                    color: t.color.textMuted, cursor: 'pointer', fontFamily: t.font.family, fontSize: t.font.size.sm,
                    padding: '4px 0 12px', minHeight: 40,
                }}
            >
                <Icon.ArrowLeft size={16} /> Volver a la lista
            </button>

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                <div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <h1 style={{ margin: 0, fontSize: 22, fontWeight: t.font.weight.semibold, color: t.color.text, fontFamily: t.font.mono }}>
                            {envio.odoo_order_name}
                        </h1>
                        <Badge tone={est.tone} dot>{est.label}</Badge>
                    </div>
                    <div style={{ color: t.color.textMuted, marginTop: 4 }}>{envio.partner_name || 'Sin cliente'}</div>
                    {envio.assembled_by_name && (
                        <div style={{ fontSize: 12, color: t.color.textFaint, marginTop: 4 }}>Armó {envio.assembled_by_name}</div>
                    )}
                    {envio.checked_by_name && (
                        <div style={{ fontSize: 12, color: t.color.textFaint }}>Controló {envio.checked_by_name}</div>
                    )}
                    {envio.odoo_picking_name && (
                        <div style={{ fontSize: 12, color: t.color.textFaint, marginTop: 4 }}>
                            Envío 1: {envio.odoo_picking_name}
                            {envio.odoo_picking_state === 'done' ? ' · validado'
                                : envio.odoo_picking_state === 'assigned' ? ' · abierto'
                                    : envio.odoo_picking_state ? ` · ${envio.odoo_picking_state}` : ' · abierto'}
                        </div>
                    )}
                    {envio.odoo_picking_backorder_name && (
                        <div style={{ fontSize: 12, color: t.color.warn, marginTop: 4 }}>
                            Faltantes en Odoo: {envio.odoo_picking_backorder_name}
                        </div>
                    )}
                    {envio.backorder_odoo_name && (
                        <div style={{ fontSize: 12, color: t.color.success, marginTop: 4 }}>Pendientes: {envio.backorder_odoo_name}</div>
                    )}
                </div>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
                {envio.estado === 'pendiente' && (
                    <Button variant="primary" disabled={trabajando} onClick={() => setEstado('armando')}
                        style={{ height: 48, flex: 1, minWidth: 160 }}>
                        {trabajando ? 'Confirmando en Odoo…' : 'Empezar a armar'}
                    </Button>
                )}
                {envio.estado === 'armando' && (
                    <>
                        {(!confirmadoEnOdoo || !envio.odoo_picking_id || envio.odoo_sync_error) && (
                            <Button variant="primary" disabled={trabajando} onClick={() => setEstado('armando')}
                                style={{ height: 48, flex: 1, minWidth: 160 }}>
                                {trabajando ? 'Confirmando en Odoo…' : 'Confirmar en Odoo y atar envío 1'}
                            </Button>
                        )}
                        <Button variant="success" disabled={trabajando || !confirmadoEnOdoo} onClick={pedirTerminarArmado}
                            style={{ height: 48, flex: 1, minWidth: 160 }} leftIcon={<Icon.Check size={16} />}>
                            {trabajando ? 'Validando envío 1…' : 'Terminar armado'}
                        </Button>
                        <Button variant="ghost" disabled={trabajando} onClick={() => setEstado('pendiente')} style={{ height: 48 }}>
                            Volver a pendientes
                        </Button>
                    </>
                )}
                {envio.estado === 'armado' && (
                    <>
                        <Button variant="primary" disabled={trabajando} onClick={() => setEstado('controlando')}
                            style={{ height: 48, flex: 1, minWidth: 160 }}>
                            Empezar control
                        </Button>
                        <Button variant="ghost" disabled={trabajando} onClick={() => setEstado('armando')} style={{ height: 48 }}>
                            Seguir armando
                        </Button>
                    </>
                )}
                {envio.estado === 'controlando' && (
                    <>
                        <Button variant="success" disabled={trabajando} onClick={() => setSaldarOpen(true)}
                            style={{ height: 48, flex: 1, minWidth: 160 }} leftIcon={<Icon.Check size={16} />}>
                            Cerrar y saldar
                        </Button>
                        <Button variant="ghost" disabled={trabajando} onClick={() => setEstado('armado')} style={{ height: 48 }}>
                            Volver
                        </Button>
                    </>
                )}
            </div>

            {editable && (
                <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <Input
                            value={manual}
                            onChange={(e) => setManual(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') escanear(manual); }}
                            placeholder="Pasá el código de un producto de este pedido"
                            leftIcon={<Icon.ScanBarcode size={16} />}
                            style={{ flex: 1 }}
                        />
                        <Button variant="secondary" onClick={() => escanear(manual)} disabled={!manual.trim() || trabajando} style={{ height: 38 }}>
                            Contar
                        </Button>
                    </div>
                    {SOPORTA_CAMERA && (
                        <Button variant="ghost" leftIcon={<Icon.Camera size={16} />}
                            onClick={camaraOn ? detenerCamara : iniciarCamara} style={{ height: 44 }}>
                            {camaraOn ? 'Cerrar cámara' : 'Escanear con la cámara'}
                        </Button>
                    )}
                    {camaraOn && (
                        <video ref={videoRef} playsInline muted
                            style={{ width: '100%', borderRadius: t.radius.md, background: '#000', maxHeight: 220, objectFit: 'cover' }} />
                    )}
                    <div style={{ fontSize: 12, color: t.color.textFaint }}>
                        {envio.estado === 'controlando'
                            ? 'El control arranca en cero: volvé a pasar cada producto de la lista. No agrega ítems nuevos.'
                            : 'Suma 1 a un producto que ya está en la orden. No sirve para agregar ítems nuevos.'}
                    </div>
                </div>
            )}

            <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Input
                    value={busqueda}
                    onChange={(e) => setBusqueda(e.target.value)}
                    placeholder="Buscá los que faltan…"
                    leftIcon={<Icon.Search size={16} />}
                    style={{ flex: 1, minWidth: 180 }}
                />
                <button
                    type="button"
                    onClick={() => setSoloFaltan((v) => !v)}
                    style={{
                        height: 38, padding: '0 12px', borderRadius: t.radius.sm,
                        border: `1px solid ${soloFaltan ? t.color.primary : t.color.borderStrong}`,
                        background: soloFaltan ? t.color.primarySoft : t.color.surface,
                        color: soloFaltan ? t.color.primary : t.color.textMuted,
                        fontFamily: t.font.family, fontSize: t.font.size.sm, fontWeight: t.font.weight.medium,
                        cursor: 'pointer', whiteSpace: 'nowrap',
                    }}
                >
                    Sólo los que faltan
                </button>
            </div>

            {aviso && (
                <div style={{ marginTop: 12, padding: '10px 12px', background: t.color.successSoft, color: t.color.success, borderRadius: t.radius.sm, fontSize: t.font.size.sm }}>
                    {aviso}
                </div>
            )}
            {envio.estado === 'armando' && !confirmadoEnOdoo && (
                <div style={{ marginTop: 12, padding: '10px 12px', background: t.color.warnSoft, color: t.color.warn, borderRadius: t.radius.sm, fontSize: t.font.size.sm }}>
                    Este pedido todavía no está confirmado en Odoo. Confirmalo para poder armarlo.
                </div>
            )}
            {error && (
                <div style={{ marginTop: 12, padding: '10px 12px', background: t.color.dangerSoft, color: t.color.danger, borderRadius: t.radius.sm, fontSize: t.font.size.sm }}>
                    {error}
                </div>
            )}

            <div style={{ marginTop: 12, border: `1px solid ${t.color.border}`, borderRadius: t.radius.md, overflow: 'hidden', background: t.color.surface }}>
                {(() => {
                    const q = busqueda.trim().toLowerCase();
                    const lista = (envio.items || []).filter((it) => {
                        const pedida = topeDe(it, envio);
                        const actual = qtyDe(it, envio.estado);
                        // Lo que no se armó no se controla: va abajo, en pendientes de armar
                        if (pedida <= 0 && (Number(it.qty_pedida) || 0) > 0) return false;
                        if (soloFaltan && !(actual < pedida)) return false;
                        if (!q) return true;
                        const blob = `${it.product_name || ''} ${it.barcode || ''} ${it.internal_ref || ''}`.toLowerCase();
                        return blob.includes(q);
                    });
                    if (lista.length === 0) {
                        return (
                            <div style={{ padding: 20, color: t.color.textMuted, fontSize: t.font.size.sm }}>
                                {q || soloFaltan ? 'Ningún ítem coincide. Probá sacarle el filtro o otra búsqueda.' : 'Este pedido no tiene productos.'}
                            </div>
                        );
                    }
                    return lista.map((it) => {
                    const pedida = topeDe(it, envio);
                    const actual = qtyDe(it, envio.estado);
                    const completo = actual >= pedida && pedida > 0;
                    return (
                        <div key={it.id} style={{
                            padding: 12, borderTop: `1px solid ${t.color.border}`,
                            background: completo ? t.color.successSoft : undefined,
                            display: 'flex', flexDirection: 'column', gap: 10,
                        }}>
                            <div style={{ display: 'flex', gap: 10 }}>
                                <button
                                    type="button"
                                    onClick={() => it.image_url && setFoto(it)}
                                    title={it.image_url ? 'Ver foto grande' : undefined}
                                    style={{
                                        padding: 0, border: 'none', background: 'transparent', cursor: it.image_url ? 'pointer' : 'default',
                                        lineHeight: 0, flexShrink: 0,
                                    }}
                                >
                                    <ProductThumb imageUrl={it.image_url} size={56} />
                                </button>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{
                                        fontWeight: t.font.weight.medium, color: t.color.text,
                                        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                                    }}>
                                        {it.product_name}
                                    </div>
                                    <div style={{ fontFamily: t.font.mono, fontSize: 12, color: t.color.textMuted, marginTop: 2 }}>
                                        {it.internal_ref || it.barcode || 'sin código'}
                                    </div>
                                    {it.faltante_motivo && (
                                        <div style={{ marginTop: 4 }}>
                                            <Badge tone={it.faltante_motivo === 'archivado' ? 'danger' : 'warn'} dot>
                                                {it.faltante_motivo === 'archivado' ? 'Archivado' : it.faltante_motivo === 'reponer' ? 'A reponer' : 'Faltante'}
                                            </Badge>
                                        </div>
                                    )}
                                    {envio.estado === 'controlando' && (
                                        <div style={{ fontSize: 11, color: t.color.textFaint, marginTop: 4 }}>
                                            Armado: {Number(it.qty_armada) || 0} / {Number(it.qty_pedida) || 0}
                                        </div>
                                    )}
                                </div>
                                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                                    <div style={{ fontWeight: t.font.weight.semibold, ...t.numericStyle, color: completo ? t.color.success : t.color.text }}>
                                        {actual}/{pedida}
                                    </div>
                                    {it.price_unit != null && (
                                        <div title="Precio de venta (unitario)" style={{ fontSize: 12, color: t.color.textMuted, marginTop: 2, ...t.numericStyle }}>
                                            {fmtARS(it.price_unit)}
                                        </div>
                                    )}
                                </div>
                            </div>

                            {editable && (
                                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                    <Button size="sm" variant="secondary" disabled={trabajando || actual <= 0}
                                        onClick={() => setQty(it, -1)}
                                        style={{ width: 48, height: 48, padding: 0 }} aria-label="Restar">
                                        <Icon.Minus size={18} />
                                    </Button>
                                    <div style={{ minWidth: 36, textAlign: 'center', fontWeight: t.font.weight.semibold, ...t.numericStyle }}>
                                        {Number(it[campo]) || 0}
                                    </div>
                                    <Button size="sm" variant="secondary" disabled={trabajando || actual >= pedida}
                                        onClick={() => setQty(it, 1)}
                                        style={{ width: 48, height: 48, padding: 0 }} aria-label="Sumar">
                                        <Icon.Plus size={18} />
                                    </Button>
                                    {!completo && pedida > 0 && (
                                        <Button
                                            size="sm"
                                            variant="success"
                                            disabled={trabajando}
                                            onClick={() => marcarTodo(it)}
                                            leftIcon={<Icon.Check size={14} />}
                                            style={{ height: 48 }}
                                        >
                                            Llegó todo
                                        </Button>
                                    )}
                                    {completo && (
                                        <Badge tone="success" dot>Llegó todo</Badge>
                                    )}
                                    {envio.company_key === 'neggo' && (
                                        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                                            <Button size="sm" variant="danger" disabled={trabajando}
                                                onClick={() => abrirFaltante(it, 'archivado')}
                                                leftIcon={<Icon.Archive size={14} />}>
                                                Archivar
                                            </Button>
                                            <Button size="sm" variant="ghost" disabled={trabajando}
                                                onClick={() => abrirFaltante(it, 'reponer')}>
                                                Reponer
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                    });
                })()}
            </div>

            {(() => {
                const pendArmar = (envio.estado === 'controlando' || envio.estado === 'saldado')
                    && envio.odoo_picking_state === 'done'
                    ? (envio.items || []).filter((it) => topeDe(it, envio) < (Number(it.qty_pedida) || 0))
                    : [];
                if (!pendArmar.length) return null;
                return (
                    <div style={{ marginTop: 16, border: `1px solid ${t.color.border}`, borderRadius: t.radius.md, overflow: 'hidden', background: t.color.surface }}>
                        <div style={{ padding: '10px 12px', background: t.color.warnSoft, color: t.color.warn, fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold }}>
                            Pendiente de armar{envio.odoo_picking_backorder_name ? ` · ${envio.odoo_picking_backorder_name}` : ''}
                        </div>
                        {pendArmar.map((it) => {
                            const falta = (Number(it.qty_pedida) || 0) - topeDe(it, envio);
                            return (
                                <div key={it.id} style={{ padding: 12, borderTop: `1px solid ${t.color.border}`, display: 'flex', gap: 10, alignItems: 'center' }}>
                                    <ProductThumb imageUrl={it.image_url} size={40} />
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ color: t.color.text, fontSize: t.font.size.sm }}>{it.product_name}</div>
                                        <div style={{ fontFamily: t.font.mono, fontSize: 12, color: t.color.textMuted, marginTop: 2 }}>
                                            {it.internal_ref || it.barcode || 'sin código'}
                                        </div>
                                    </div>
                                    <div style={{ fontWeight: t.font.weight.semibold, color: t.color.warn, ...t.numericStyle }}>× {falta}</div>
                                </div>
                            );
                        })}
                    </div>
                );
            })()}

            <Modal
                isOpen={saldarOpen}
                onClose={() => setSaldarOpen(false)}
                title="Cerrar y saldar en Odoo"
                subtitle={`${envio.odoo_order_name} va a quedar con lo que controlaste`}
                fullScreen={isMobile}
                footer={(
                    <>
                        <Button variant="ghost" onClick={() => setSaldarOpen(false)} disabled={trabajando}>Cancelar</Button>
                        <Button variant="success" onClick={confirmarSaldar} disabled={trabajando}>
                            {trabajando ? 'Escribiendo Odoo…' : 'Saldar ahora'}
                        </Button>
                    </>
                )}
            >
                <div style={{ fontFamily: t.font.family, fontSize: t.font.size.sm, color: t.color.text }}>
                    <p style={{ marginTop: 0 }}>
                        {envio.odoo_picking_state === 'done'
                            ? 'Esto valida la entrega en Odoo con lo que controlaste. Si falta algo, queda en un backorder de la entrega.'
                            : 'Esto escribe la orden en Odoo. Lo que no controlaste se va a un pedido nuevo en borrador.'}
                    </p>
                    {preview.queda.length === 0 && preview.pendientes.length === 0 && (
                        <div style={{ color: t.color.success }}>Controlaste todo. La orden no cambia de cantidades.</div>
                    )}
                    {preview.queda.map((l) => (
                        <div key={l.odoo_line_id} style={{ padding: '8px 0', borderTop: `1px solid ${t.color.border}` }}>
                            {l.product_name}: {l.qty_pedida} → {l.qty_nueva || 'sale de la orden'}
                        </div>
                    ))}
                    {preview.pendientes.length > 0 && (
                        <div style={{ marginTop: 12 }}>
                            <div style={{ fontWeight: t.font.weight.semibold, marginBottom: 6 }}>Pedido nuevo con pendientes</div>
                            {preview.pendientes.map((l) => (
                                <div key={l.odoo_line_id} style={{ padding: '4px 0' }}>
                                    {l.product_name} × {l.qty_pendiente}
                                </div>
                            ))}
                        </div>
                    )}
                    {preview.cancela_original && (
                        <div style={{ marginTop: 12, color: t.color.danger }}>
                            No controlaste nada: se cancela la orden original en Odoo y todo pasa al pedido de pendientes.
                        </div>
                    )}
                </div>
            </Modal>

            <Modal
                isOpen={terminarOpen}
                onClose={() => setTerminarOpen(false)}
                title="¿Terminar con faltantes?"
                subtitle={`${envio.odoo_order_name} no está completo`}
                fullScreen={isMobile}
                footer={(
                    <>
                        <Button variant="ghost" onClick={() => setTerminarOpen(false)} disabled={trabajando}>Volver a revisar</Button>
                        <Button variant="success" onClick={confirmarTerminarArmado} disabled={trabajando}>
                            Sí, terminar así
                        </Button>
                    </>
                )}
            >
                <div style={{ fontFamily: t.font.family, fontSize: t.font.size.sm, color: t.color.text }}>
                    <p style={{ marginTop: 0 }}>¿Seguro que no hay estos productos?</p>
                    {(envio.items || [])
                        .filter((it) => qtyDe(it, envio.estado) < (Number(it.qty_pedida) || 0))
                        .map((it) => {
                            const pedida = Number(it.qty_pedida) || 0;
                            const actual = qtyDe(it, envio.estado);
                            return (
                                <div key={it.id} style={{
                                    display: 'flex', justifyContent: 'space-between', gap: 12,
                                    padding: '8px 0', borderTop: `1px solid ${t.color.border}`,
                                }}>
                                    <span>{it.product_name}</span>
                                    <span style={{ ...t.numericStyle, color: t.color.warn, flexShrink: 0 }}>
                                        {actual}/{pedida} · faltan {pedida - actual}
                                    </span>
                                </div>
                            );
                        })}
                    <p style={{ marginBottom: 0, color: t.color.textMuted }}>
                        {(envio.items || []).some((it) => qtyDe(it, envio.estado) > 0)
                            ? 'Odoo valida el envío 1 con lo que armaste: eso pasa a control de salida y lo que falta queda en otro envío, pendiente de armar.'
                            : 'No armaste nada: el envío 1 queda abierto en Odoo, sin validar.'}
                    </p>
                </div>
            </Modal>

            <Modal
                isOpen={!!foto}
                onClose={() => setFoto(null)}
                title={foto?.product_name || 'Foto'}
                subtitle={foto?.internal_ref || foto?.barcode || undefined}
                fullScreen={isMobile}
            >
                {foto?.image_url && (
                    <img
                        src={foto.image_url}
                        alt={foto.product_name || ''}
                        style={{
                            display: 'block', width: '100%', maxHeight: isMobile ? '70dvh' : 520,
                            objectFit: 'contain', background: t.color.surface2, borderRadius: t.radius.md,
                        }}
                    />
                )}
            </Modal>

            <Modal
                isOpen={!!faltanteOpen}
                onClose={() => setFaltanteOpen(null)}
                title={faltanteOpen?.motivo === 'archivado' ? 'Archivar producto' : 'Marcar para reponer'}
                subtitle={faltanteOpen?.item?.product_name}
                fullScreen={isMobile}
                footer={(
                    <>
                        <Button variant="ghost" onClick={() => setFaltanteOpen(null)} disabled={trabajando}>Cancelar</Button>
                        <Button
                            variant={faltanteOpen?.motivo === 'archivado' ? 'danger' : 'success'}
                            onClick={confirmarFaltante}
                            disabled={trabajando}
                        >
                            {trabajando
                                ? 'Guardando…'
                                : faltanteOpen?.motivo === 'archivado' ? 'Archivar' : 'Reponer'}
                        </Button>
                    </>
                )}
            >
                {faltanteOpen && (
                    <div style={{ fontFamily: t.font.family, fontSize: t.font.size.sm, color: t.color.text }}>
                        <p style={{ marginTop: 0 }}>
                            Lo que ya contaste en este pedido se mantiene. No hace falta dejarlo en 0.
                            Lo que falte queda pendiente para cuando saldemos.
                        </p>
                        {faltanteOpen.motivo === 'archivado' && (
                            <p style={{ color: t.color.danger }}>
                                Archivar lo saca de venta en Odoo y lo manda a la cola de reposición.
                            </p>
                        )}
                        <div style={{ marginTop: 12 }}>
                            <div style={{ fontWeight: t.font.weight.medium, marginBottom: 6 }}>
                                ¿Cuántas van en este pedido? (pedida: {Number(faltanteOpen.item.qty_pedida) || 0})
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <Button size="sm" variant="secondary"
                                    disabled={faltanteQty <= 0}
                                    onClick={() => setFaltanteQty((n) => Math.max(0, n - 1))}
                                    style={{ width: 48, height: 48, padding: 0 }}>
                                    <Icon.Minus size={18} />
                                </Button>
                                <div style={{ minWidth: 40, textAlign: 'center', fontWeight: t.font.weight.semibold, fontSize: 18, ...t.numericStyle }}>
                                    {faltanteQty}
                                </div>
                                <Button size="sm" variant="secondary"
                                    disabled={faltanteQty >= topeDe(faltanteOpen.item, envio)}
                                    onClick={() => setFaltanteQty((n) => Math.min(topeDe(faltanteOpen.item, envio), n + 1))}
                                    style={{ width: 48, height: 48, padding: 0 }}>
                                    <Icon.Plus size={18} />
                                </Button>
                            </div>
                            <div style={{ marginTop: 8, fontSize: 12, color: t.color.textFaint }}>
                                Faltan {(Number(faltanteOpen.item.qty_pedida) || 0) - faltanteQty} para el pedido de pendientes.
                            </div>
                        </div>
                    </div>
                )}
            </Modal>
        </div>
    );
}
