import { useEffect, useState } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import Drawer from '../../components/common/Drawer';
import AsignarCliente from './AsignarCliente';
import ChatsWhatsapp from './ChatsWhatsapp';
import FichaComercial from './FichaComercial';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import * as Icon from '../../components/common/icons';
import Seguimiento from './Seguimiento';
import { BotonPresentacion, fmtDia } from './Presentacion';
import { SOURCE_STATUS_META, fmtFecha, linkWhatsApp, nombreLead } from './clientesUi';

// Título de la ficha con lápiz para cambiar el nombre (nota 236). Vacío = sin nombre a mano
// (se ve el de WhatsApp o el teléfono). Usa el mismo endpoint que la ficha de Chats (nota 230).
function NombreTitulo({ t, lead, onRenombrado }) {
    const [editando, setEditando] = useState(false);
    const [valor, setValor] = useState('');
    const [guardando, setGuardando] = useState(false);
    const [error, setError] = useState(null);

    const empezar = () => { setValor(lead.name || ''); setError(null); setEditando(true); };
    const guardar = async () => {
        const limpio = valor.replace(/\s+/g, ' ').trim();
        if (limpio === (lead.name || '')) { setEditando(false); return; }
        setGuardando(true);
        const res = await api.put(`/clientes/leads/${lead.id}/nombre`, { nombre: limpio });
        setGuardando(false);
        if (!res.success) { setError(res.error || 'No se pudo cambiar el nombre'); return; }
        setEditando(false);
        onRenombrado(res.data);
    };

    if (!editando) {
        return (
            <span style={{ display: 'flex', alignItems: 'center', gap: t.space[2], minWidth: 0 }}>
                <span style={{ overflowWrap: 'anywhere' }}>{nombreLead(lead)}</span>
                <button type="button" onClick={empezar} aria-label="Cambiar el nombre" title="Cambiar el nombre" style={{
                    flexShrink: 0, width: 30, height: 30, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    border: `1px solid ${t.color.border}`, borderRadius: t.radius.md, background: t.color.surface,
                    color: t.color.textMuted, cursor: 'pointer',
                }}><Icon.Edit2 size={14} /></button>
            </span>
        );
    }
    return (
        <span style={{ display: 'flex', flexDirection: 'column', gap: t.space[2], width: '100%' }}>
            <span style={{ display: 'flex', gap: t.space[2], alignItems: 'center', flexWrap: 'wrap' }}>
                <input type="text" value={valor} autoFocus maxLength={200} aria-label="Nombre del posible cliente"
                    placeholder="Nombre (vacío = el de WhatsApp o el teléfono)"
                    onChange={(e) => setValor(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') guardar(); if (e.key === 'Escape') { e.stopPropagation(); setEditando(false); } }}
                    style={{
                        flex: '1 1 220px', minWidth: 0, height: 36, padding: '0 10px', borderRadius: t.radius.md,
                        border: `1px solid ${t.color.borderStrong}`, background: t.color.surface, color: t.color.text,
                        fontFamily: t.font.family, fontSize: t.font.size.base,
                    }} />
                <Button variant="primary" size="sm" onClick={guardar} disabled={guardando}>{guardando ? 'Guardando…' : 'Guardar'}</Button>
                <Button variant="ghost" size="sm" onClick={() => setEditando(false)} disabled={guardando}>Cancelar</Button>
            </span>
            {error && <span style={{ fontSize: t.font.size.xs, fontWeight: t.font.weight.regular, color: t.color.danger }}>{error}</span>}
        </span>
    );
}

// Ficha de un posible cliente: datos de contacto, de dónde vino y su seguimiento.
export default function LeadFicha({ leadId, resumen, onClose, onCambio }) {
    const { tokens: t } = useTheme();
    const [lead, setLead] = useState(null);
    const [error, setError] = useState(null);
    // Para que el historial muestre la presentación recién anotada
    const [version, setVersion] = useState(0);

    const presentada = (at) => {
        setLead((l) => (l ? { ...l, presentacion_at: at } : l));
        setVersion((v) => v + 1);
        onCambio?.();
    };

    useEffect(() => {
        if (!leadId) return undefined;
        let cancelado = false;
        setLead(null);
        setError(null);
        api.get(`/clientes/leads/${leadId}`).then((res) => {
            if (cancelado) return;
            if (!res.success) { setError(res.error || 'No se pudo cargar el posible cliente'); return; }
            setLead(res.data);
        });
        return () => { cancelado = true; };
    }, [leadId]);

    const datos = lead || resumen;
    const wa = datos?.phone ? linkWhatsApp(datos.phone) : null;
    const origen = SOURCE_STATUS_META[datos?.source_status || 'sin_estado'];

    return (
        <Drawer
            isOpen={!!leadId}
            onClose={onClose}
            title={nombreLead(datos)}
            titleContent={lead ? (
                <NombreTitulo key={lead.id} t={t} lead={lead}
                    onRenombrado={(r) => { setLead((l) => (l ? { ...l, name: r.name } : l)); onCambio?.(); }} />
            ) : null}
            subtitle={[datos?.city, datos?.phone, datos?.email].filter(Boolean).join(' · ') || null}
            width={760}
            footer={wa || datos?.email ? (
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: t.space[2], flex: 1, flexWrap: 'wrap' }}>
                    {datos?.email && (
                        <a href={`mailto:${datos.email}`} style={{ textDecoration: 'none' }}>
                            <Button variant="secondary">Escribile un mail</Button>
                        </a>
                    )}
                    {wa && lead && <BotonPresentacion lead={lead} size="md" reenviar onEnviada={presentada} />}
                    {wa && (
                        <a href={wa} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
                            <Button variant={lead?.presentacion_at ? 'primary' : 'secondary'} leftIcon={<Icon.MessageCircle size={16} />}>Escribile por WhatsApp</Button>
                        </a>
                    )}
                </div>
            ) : null}
        >
            <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[10], fontFamily: t.font.family }}>
                {error && <div style={{ fontSize: t.font.size.sm, color: t.color.danger }}>{error}</div>}
                {datos && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: t.space[2], alignItems: 'center' }}>
                        <Badge tone="accent">Posible cliente</Badge>
                        {datos.source === 'google_contacts' && (
                            <Badge tone={origen.tone} >{`Agenda: ${origen.label}${datos.source_list ? ` ${datos.source_list}` : ''}`}</Badge>
                        )}
                        <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>
                            {datos.source === 'google_contacts' ? 'Importado de los contactos'
                                : datos.source === 'whatsapp' ? 'Entró por el WhatsApp del negocio' : 'Cargado a mano'} el {fmtFecha(String(datos.created_at).slice(0, 10))}
                        </span>
                        {lead && (lead.presentacion_at
                            ? <Badge tone="success">{`Presentación enviada el ${fmtDia(lead.presentacion_at)}`}</Badge>
                            : <Badge tone="muted">Sin presentación</Badge>)}
                    </div>
                )}
                {datos && (
                    <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>
                        Cuando compre y aparezca en Odoo con este mismo teléfono, pasa solo a Clientes con todo su seguimiento.
                    </div>
                )}
                {leadId && <FichaComercial key={`ficha-${version}`} leadId={leadId} telefono={datos?.phone || null} t={t} onCambio={onCambio} />}
                {leadId && (
                    <AsignarCliente leadId={leadId} nombre={datos ? nombreLead(datos) : null} t={t}
                        onAsignado={() => { onCambio?.(); onClose(); }} />
                )}
                {leadId && <ChatsWhatsapp leadId={leadId} t={t} onCambio={onCambio} onSacado={onClose} />}
                {leadId && <Seguimiento key={version} tipo="lead" id={leadId} onCambio={onCambio} />}
            </div>
        </Drawer>
    );
}
