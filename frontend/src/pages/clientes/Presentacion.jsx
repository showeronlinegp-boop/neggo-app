import { useCallback, useEffect, useState } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { useToast } from '../../context/ToastContext';
import { fmtInt } from '../../theme/tokens';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Modal from '../../components/common/Modal';
import * as Icon from '../../components/common/icons';
import { SOURCE_STATUS_META, linkWhatsApp, mensajePresentacion, nombreLead } from './clientesUi';

// Mensaje de presentación por WhatsApp a los posibles clientes (nota #81).
// Al tocar el botón se abre el chat con el mensaje escrito y queda anotado en el historial.

// "22/10" en hora local (presentacion_at viene como timestamp)
export function fmtDia(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
}

/**
 * Abre WhatsApp con la presentación y la anota. La ventana se abre antes del pedido
 * para que el navegador no la bloquee como popup.
 * @returns {Promise<boolean>} true si quedó anotada
 */
export function usePresentacion() {
    const { showToast } = useToast();
    return useCallback(async (lead) => {
        const link = linkWhatsApp(lead?.phone, mensajePresentacion(lead?.name));
        if (!link) { showToast('No tiene celular cargado', 'error'); return false; }
        window.open(link, '_blank', 'noopener');
        const res = await api.post(`/clientes/seguimiento/lead/${lead.id}/presentacion`, {});
        if (!res.success) {
            showToast(res.error || 'Se abrió WhatsApp pero no se pudo anotar la presentación', 'error');
            return false;
        }
        return true;
    }, [showToast]);
}

/** Botón de la fila / ficha. Si ya se mandó, muestra la fecha (y en la ficha permite volver a mandarla). */
export function BotonPresentacion({ lead, onEnviada, size = 'sm', reenviar = false }) {
    const { tokens: t } = useTheme();
    const mandar = usePresentacion();
    const [enviando, setEnviando] = useState(false);
    if (!lead?.phone) return null;
    const enviada = lead.presentacion_at;

    const click = async (e) => {
        e.stopPropagation();
        setEnviando(true);
        const ok = await mandar(lead);
        setEnviando(false);
        if (ok) onEnviada?.(new Date().toISOString());
    };

    if (enviada && !reenviar) {
        return (
            <span title="Ya se le mandó el mensaje de presentación"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: t.font.size.xs, color: t.color.success, ...t.numericStyle }}>
                <Icon.Check size={14} /> Enviada {fmtDia(enviada)}
            </span>
        );
    }
    return (
        <Button size={size} variant={enviada ? 'secondary' : 'primary'} disabled={enviando}
            leftIcon={<Icon.MessageCircle size={size === 'sm' ? 14 : 16} />} onClick={click}>
            {enviada ? 'Volver a mandar la presentación' : size === 'sm' ? 'Presentación' : 'Mandar presentación'}
        </Button>
    );
}

const LOTE = 50;

/**
 * Cola para mandar presentaciones de a una: muestra un posible cliente, se manda y pasa al siguiente.
 * Usa los mismos filtros que la lista (estado de la agenda, ciudad, etapa, búsqueda).
 */
export function ColaPresentaciones({ abierta, filtros, onClose, onEnviada }) {
    const { tokens: t } = useTheme();
    const mandar = usePresentacion();
    const [cola, setCola] = useState([]);
    const [faltan, setFaltan] = useState(null);
    const [salteados, setSalteados] = useState(0);
    const [enviadas, setEnviadas] = useState(0);
    const [cargando, setCargando] = useState(false);
    const [enviando, setEnviando] = useState(false);
    const [error, setError] = useState(null);

    // Los ya mandados salen solos del filtro; los salteados siguen, así que se saltean con el offset
    const cargar = useCallback(async (offset) => {
        setCargando(true);
        setError(null);
        const res = await api.get('/clientes/leads', { ...filtros, presentacion: 'sin', celular: 1, limit: LOTE, offset });
        setCargando(false);
        if (!res.success) { setError(res.error || 'No se pudo cargar la cola'); return; }
        setCola(res.data || []);
        setFaltan(res.pagination?.total ?? (res.data || []).length);
    }, [filtros]);

    useEffect(() => {
        if (!abierta) return;
        setSalteados(0);
        setEnviadas(0);
        cargar(0);
    }, [abierta, cargar]);

    const actual = cola[0];
    const avanzar = (saltear) => {
        const resto = cola.slice(1);
        const nuevosSalteados = salteados + (saltear ? 1 : 0);
        if (saltear) setSalteados(nuevosSalteados);
        if (resto.length) setCola(resto);
        else cargar(nuevosSalteados);
    };

    const enviar = async () => {
        setEnviando(true);
        const ok = await mandar(actual);
        setEnviando(false);
        if (!ok) return;
        setEnviadas((n) => n + 1);
        setFaltan((n) => Math.max((n || 1) - 1, 0));
        onEnviada?.();
        avanzar(false);
    };

    const pendientes = faltan == null ? null : Math.max(faltan - salteados, 0);
    const origen = actual ? SOURCE_STATUS_META[actual.source_status || 'sin_estado'] : null;

    return (
        <Modal isOpen={abierta} onClose={onClose} width={520} title="Mandar presentaciones"
            subtitle={pendientes == null ? 'Cargando…'
                : `Faltan ${fmtInt(pendientes)}${salteados ? ` · ${fmtInt(salteados)} salteado${salteados === 1 ? '' : 's'}` : ''}${enviadas ? ` · ${fmtInt(enviadas)} mandada${enviadas === 1 ? '' : 's'} ahora` : ''}`}
            footer={actual ? (
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: t.space[2], flex: 1, flexWrap: 'wrap' }}>
                    <Button variant="ghost" disabled={enviando || cargando} rightIcon={<Icon.ChevronRight size={16} />}
                        onClick={() => avanzar(true)}>
                        Saltear
                    </Button>
                    <Button variant="primary" disabled={enviando || cargando} leftIcon={<Icon.MessageCircle size={16} />} onClick={enviar}>
                        {enviando ? 'Abriendo…' : 'Mandar por WhatsApp'}
                    </Button>
                </div>
            ) : null}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[4], fontFamily: t.font.family }}>
                {error && <div role="alert" style={{ fontSize: t.font.size.sm, color: t.color.danger }}>{error}</div>}
                {cargando && !actual ? (
                    <div style={{ padding: 24, textAlign: 'center', color: t.color.textMuted, fontSize: t.font.size.sm }}>Cargando…</div>
                ) : !actual ? (
                    <div style={{ padding: 24, textAlign: 'center' }}>
                        <div style={{ fontSize: 15, fontWeight: t.font.weight.medium, color: t.color.text }}>
                            {enviadas ? '¡Listo! No queda nadie en la cola' : 'No hay a quién mandarle'}
                        </div>
                        <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginTop: 4 }}>
                            {salteados ? 'Los que salteaste van a volver a aparecer la próxima vez.' : 'Con estos filtros todos ya recibieron la presentación.'}
                        </div>
                    </div>
                ) : (
                    <>
                        <div>
                            <div style={{ fontSize: t.font.size.lg, fontWeight: t.font.weight.semibold, color: t.color.text }}>
                                {nombreLead(actual)}
                            </div>
                            <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, display: 'flex', flexWrap: 'wrap', gap: '4px 10px', alignItems: 'center', marginTop: 4 }}>
                                <span style={{ fontFamily: t.font.mono }}>{actual.phone}</span>
                                {actual.city && <span>{actual.city}</span>}
                                <Badge tone={origen.tone}>{origen.label}</Badge>
                                {actual.source_list && <span style={{ fontSize: t.font.size.xs, color: t.color.textFaint, fontFamily: t.font.mono }}>{actual.source_list}</span>}
                            </div>
                        </div>
                        <div style={{
                            whiteSpace: 'pre-wrap', fontSize: t.font.size.sm, color: t.color.text, lineHeight: 1.5,
                            padding: '12px 14px', borderRadius: t.radius.md, background: t.color.surface2,
                            border: `1px solid ${t.color.border}`,
                        }}>
                            {mensajePresentacion(actual.name)}
                        </div>
                        <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>
                            Se abre WhatsApp con el mensaje escrito: tocá Enviar allá y volvé. Acá ya queda anotado y pasa al siguiente.
                        </div>
                    </>
                )}
            </div>
        </Modal>
    );
}
