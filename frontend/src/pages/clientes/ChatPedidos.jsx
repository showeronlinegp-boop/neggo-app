import { useCallback, useEffect, useState } from 'react';
import api from '../../api/client';
import { fmtAR } from '../../theme/tokens';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Modal from '../../components/common/Modal';
import * as Icon from '../../components/common/icons';
import { LoQuePidio } from './FichaComercial';
import EncarguesChat from './EncarguesChat';

// Pedidos en Chats (nota 229): etiquetas «Pedido activo» / «Cotización abierta» en la lista y en la
// cabecera de la conversación, y el botón «Pedidos» de arriba a la derecha con el detalle.
// Pedido activo = confirmado en Odoo y todavía sin entregar (lo que está en Pedidos › Armado).
// Cotización abierta = borrador o enviada de los últimos 60 días, sin factura ni ticket.

const ESTADO_ARMADO = {
    pendiente: { label: 'Para armar', tone: 'muted' },
    armando: { label: 'Armando', tone: 'accent' },
    armado: { label: 'Para controlar', tone: 'warn' },
    controlando: { label: 'Controlando', tone: 'primary' },
};
const ESTADO_COTIZ = { draft: 'Borrador', sent: 'Enviada' };
const EMPRESA = { neggo: 'Neggo', preventas: 'Preventas' };

/** Cantidades por clave de chat («cliente:12») para las etiquetas de la lista. */
export async function leerPedidosDeChats(items) {
    const claves = [...new Set((items || []).map((c) => c.clave))].slice(0, 300);
    if (!claves.length) return {};
    const res = await api.get('/clientes/chats-pedidos', { claves: claves.join(',') });
    return res.success ? res.data || {} : {};
}

export function EtiquetasPedidos({ p }) {
    if (!p) return null;
    return (
        <>
            {p.activos > 0 && <Badge tone="accent">{p.activos > 1 ? `${p.activos} pedidos activos` : 'Pedido activo'}</Badge>}
            {p.cotizaciones > 0 && <Badge tone="warn">{p.cotizaciones > 1 ? `${p.cotizaciones} cotizaciones abiertas` : 'Cotización abierta'}</Badge>}
        </>
    );
}

export function BotonPedidos({ t, compacto, p, onClick }) {
    const n = (p?.activos || 0) + (p?.cotizaciones || 0);
    const etiqueta = n ? `Pedidos (${n})` : 'Pedidos';
    if (compacto) {
        return (
            <button type="button" onClick={onClick} aria-label={`Ver y cargar pedidos${n ? `: ${n} abiertos` : ''}`} title="Pedidos" style={{
                position: 'relative', flex: 'none', width: 36, height: 36, borderRadius: t.radius.md, border: `1px solid ${t.color.border}`,
                background: t.color.surface, color: n ? t.color.accent : t.color.textMuted, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
                <Icon.ShoppingCart size={18} />
                {n > 0 && (
                    <span aria-hidden="true" style={{
                        position: 'absolute', top: -5, right: -5, minWidth: 16, height: 16, padding: '0 4px', boxSizing: 'border-box', borderRadius: t.radius.full,
                        background: t.color.accent, color: '#fff', fontSize: 10, fontWeight: t.font.weight.bold, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>{n}</span>
                )}
            </button>
        );
    }
    return <Button size="sm" variant="secondary" leftIcon={<Icon.ShoppingCart size={14} />} onClick={onClick}>{etiqueta}</Button>;
}

function fecha(iso) {
    if (!iso) return '';
    const d = new Date(String(iso).length === 10 ? `${iso}T12:00:00` : iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
}

function Titulo({ t, children }) {
    return (
        <h3 style={{
            margin: 0, fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, color: t.color.textMuted,
            textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>{children}</h3>
    );
}

function Fila({ t, nombre, empresa, cuando, total, badge, href }) {
    const cuerpo = (
        <>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                <span style={{ fontFamily: t.font.mono, fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.text }}>{nombre || 'Sin número'}</span>
                <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>{[EMPRESA[empresa] || empresa, cuando].filter(Boolean).join(' · ')}</span>
            </span>
            {total ? <span style={{ fontSize: t.font.size.sm, color: t.color.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmtAR(total)}</span> : null}
            {badge}
            {href && <Icon.ChevronRight size={16} />}
        </>
    );
    const estilo = {
        display: 'flex', alignItems: 'center', gap: t.space[3], padding: '8px 10px', borderRadius: t.radius.md,
        border: `1px solid ${t.color.border}`, background: t.color.surface, color: t.color.textMuted, textDecoration: 'none', fontFamily: t.font.family,
    };
    return href
        ? <a href={href} target="_blank" rel="noreferrer" title="Abrir en Pedidos › Armado (pestaña nueva)" style={estilo}>{cuerpo}</a>
        : <div style={estilo}>{cuerpo}</div>;
}

export function PedidosModal({ t, contacto, open, onClose, onCambio, onVerFicha }) {
    const [datos, setDatos] = useState(null);
    const [error, setError] = useState(null);
    const tipo = contacto?.tipo;
    const id = contacto?.id;

    const cargar = useCallback(async () => {
        if (!tipo || !id) return;
        const res = await api.get(`/clientes/chats-pedidos/${tipo}/${id}`);
        if (!res.success) { setError(res.error || 'No se pudieron leer los pedidos'); return; }
        setError(null);
        setDatos(res.data);
    }, [tipo, id]);
    useEffect(() => { if (open) { setDatos(null); cargar(); } }, [open, cargar]);

    if (!open || !contacto) return null;
    const esProspecto = tipo === 'prospecto';
    const cambio = () => { cargar(); onCambio?.(); };

    return (
        <Modal isOpen onClose={onClose} title="Pedidos" subtitle={contacto.nombre || contacto.numero || undefined} width={560}
            footer={<Button variant="ghost" onClick={onClose}>Cerrar</Button>}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[8], fontFamily: t.font.family }}>
                {error && <span style={{ fontSize: t.font.size.sm, color: t.color.danger }}>{error}</span>}
                {!datos && !error && <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>Cargando…</span>}
                {datos && (
                    <>
                        <section style={{ display: 'flex', flexDirection: 'column', gap: t.space[3] }}>
                            <Titulo t={t}>Pedidos activos</Titulo>
                            {datos.activos.length === 0
                                ? <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>No tiene pedidos confirmados sin entregar.</span>
                                : datos.activos.map((p) => {
                                    const est = ESTADO_ARMADO[p.estado] || { label: p.estado, tone: 'muted' };
                                    return (
                                        <Fila key={`a-${p.envio_id}`} t={t} nombre={p.nombre} empresa={p.company} cuando={fecha(p.fecha)} total={p.total}
                                            badge={<Badge tone={est.tone}>{est.label}</Badge>} href={`/pedidos/armado/${p.envio_id}`} />
                                    );
                                })}
                        </section>
                        <section style={{ display: 'flex', flexDirection: 'column', gap: t.space[3] }}>
                            <Titulo t={t}>Cotizaciones abiertas</Titulo>
                            {datos.cotizaciones.length === 0
                                ? <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>No tiene cotizaciones abiertas de los últimos 60 días.</span>
                                : datos.cotizaciones.map((c) => (
                                    <Fila key={`c-${c.company}-${c.odoo_id || c.nombre}`} t={t} nombre={c.nombre} empresa={c.company}
                                        cuando={[fecha(c.fecha), c.desde_ficha ? 'creada desde la ficha' : null].filter(Boolean).join(' · ')} total={c.total}
                                        badge={<Badge tone="warn">{ESTADO_COTIZ[c.estado] || 'Abierta'}</Badge>} />
                                ))}
                        </section>
                        <EncarguesChat t={t} contacto={contacto} Titulo={Titulo} />
                        <section style={{ display: 'flex', flexDirection: 'column', gap: t.space[3] }}>
                            {esProspecto
                                ? <LoQuePidio leadId={id} t={t} onCambio={cambio} />
                                : (
                                    <>
                                        <Titulo t={t}>Cargarle un pedido</Titulo>
                                        <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, lineHeight: 1.5 }}>
                                            Es cliente de Odoo: el pedido se carga como cotización en Odoo. En su ficha están las compras y las cotizaciones de antes.
                                        </span>
                                        {onVerFicha && <Button variant="secondary" onClick={onVerFicha}>Abrir la ficha del cliente</Button>}
                                    </>
                                )}
                        </section>
                    </>
                )}
            </div>
        </Modal>
    );
}
