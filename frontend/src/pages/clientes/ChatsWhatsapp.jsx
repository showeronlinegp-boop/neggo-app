import { useCallback, useEffect, useState } from 'react';
import api from '../../api/client';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import * as Icon from '../../components/common/icons';
import Input from '../../components/common/Input';
import { fmtFechaHora } from './clientesUi';
import { ETAPA_TONO, haceCuanto } from './etapasWhatsappUi';

// Cómo se vinculó cada chat (CRM WhatsApp, L1)
const VINCULO = {
    telefono: 'mismo teléfono',
    alta_whatsapp: 'entró por WhatsApp',
    cotizacion: 'cotizaciones nombradas en el chat',
    manual: 'vinculado a mano',
};

// Etapa del prospecto con chat: cuál es, su objetivo y los cambios a mano (Interesado, Descartado, automático)
function EtapaWhatsapp({ leadId, etapa, t, onCambio }) {
    const [descartando, setDescartando] = useState(false);
    const [motivo, setMotivo] = useState('');
    const [guardando, setGuardando] = useState(false);
    const [error, setError] = useState(null);

    const marcar = async (nueva, mot = null) => {
        setGuardando(true);
        setError(null);
        const res = await api.put(`/clientes/leads/${leadId}/etapa-whatsapp`, { etapa: nueva, motivo: mot });
        setGuardando(false);
        if (!res.success) { setError(res.error || 'No se pudo cambiar la etapa'); return; }
        setDescartando(false); setMotivo('');
        onCambio();
    };

    return (
        <div style={{
            display: 'flex', flexDirection: 'column', gap: t.space[3], padding: t.space[4],
            border: `1px solid ${t.color.border}`, borderRadius: t.radius.sm, background: t.color.bg,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: t.space[2], flexWrap: 'wrap' }}>
                <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>Etapa</span>
                <Badge tone={ETAPA_TONO[etapa.etapa]} dot>{etapa.label}</Badge>
                {etapa.manual && <Badge tone="muted">Marcada a mano</Badge>}
                {etapa.espera_respuesta && <Badge tone="accent">{`Te escribió ${haceCuanto(etapa.ultimo_mensaje_at)}`}</Badge>}
            </div>
            {etapa.objetivo && (
                <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>Objetivo para pasar de etapa: {etapa.objetivo}</span>
            )}
            {etapa.motivo && <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>Motivo: {etapa.motivo}</span>}
            {etapa.etapa !== 'no_contactar' && !descartando && (
                <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap' }}>
                    {etapa.etapa !== 'interesado' && (
                        <Button size="sm" variant="primary" disabled={guardando} onClick={() => marcar('interesado')}>Está interesado</Button>
                    )}
                    {etapa.etapa !== 'descartado' && (
                        <Button size="sm" disabled={guardando} onClick={() => setDescartando(true)}>Descartar</Button>
                    )}
                    {etapa.manual && (
                        <Button size="sm" variant="ghost" disabled={guardando} onClick={() => marcar('automatica')}>
                            {`Volver a automático (${etapa.automatica.replace('_', ' ')})`}
                        </Button>
                    )}
                </div>
            )}
            {descartando && (
                <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap', alignItems: 'center' }}>
                    <Input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Por qué: proveedor, no es comercio, no le interesa…"
                        aria-label="Motivo del descarte" style={{ flex: 1, minWidth: 220 }} />
                    <Button size="sm" variant="primary" disabled={guardando || !motivo.trim()} onClick={() => marcar('descartado', motivo)}>Descartar</Button>
                    <Button size="sm" variant="ghost" onClick={() => { setDescartando(false); setMotivo(''); }}>Cancelar</Button>
                </div>
            )}
            {error && <div style={{ fontSize: t.font.size.sm, color: t.color.danger }}>{error}</div>}
        </div>
    );
}

// Chats del WhatsApp del negocio de un posible cliente: los vinculados y, si falta, elegir uno a mano.
// Los chats viejos (antes del 14/11) llegan sin número: solo se pueden vincular acá.
export default function ChatsWhatsapp({ leadId, t, onCambio }) {
    const [datos, setDatos] = useState(null);
    const [error, setError] = useState(null);
    const [eligiendo, setEligiendo] = useState(false);
    const [guardando, setGuardando] = useState(null);

    const cargar = useCallback(async () => {
        const res = await api.get(`/clientes/leads/${leadId}/whatsapp`);
        if (!res.success) { setError(res.error || 'No se pudieron leer los chats de WhatsApp'); return; }
        setError(null);
        setDatos(res.data);
    }, [leadId]);

    useEffect(() => {
        setDatos(null); setEligiendo(false); setError(null);
        if (leadId) cargar();
    }, [leadId, cargar]);

    const vincular = async (chat) => {
        setGuardando(chat);
        const res = await api.post(`/clientes/leads/${leadId}/whatsapp`, { chat });
        setGuardando(null);
        if (!res.success) { setError(res.error || 'No se pudo vincular el chat'); return; }
        setEligiendo(false);
        await cargar();
        onCambio?.();
    };

    const desvincular = async (chat) => {
        setGuardando(chat);
        const res = await api.del(`/clientes/leads/${leadId}/whatsapp/${encodeURIComponent(chat)}`);
        setGuardando(null);
        if (!res.success) { setError(res.error || 'No se pudo desvincular el chat'); return; }
        await cargar();
        onCambio?.();
    };

    const texto = { fontSize: t.font.size.sm, color: t.color.text };
    const suave = { fontSize: t.font.size.xs, color: t.color.textMuted };
    const fila = {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: t.space[4], flexWrap: 'wrap',
        padding: `${t.space[3]}px ${t.space[4]}px`,
    };

    return (
        <section style={{ display: 'flex', flexDirection: 'column', gap: t.space[4] }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: t.space[2] }}>
                <Icon.MessageCircle size={16} />
                <span style={{ ...texto, fontWeight: t.font.weight.semibold }}>WhatsApp del negocio</span>
            </div>
            {error && <div style={{ fontSize: t.font.size.sm, color: t.color.danger }}>{error}</div>}
            {!datos && !error && <div style={suave}>Buscando sus chats…</div>}

            {datos && datos.etapa && (
                <EtapaWhatsapp leadId={leadId} etapa={datos.etapa} t={t}
                    onCambio={async () => { await cargar(); onCambio?.(); }} />
            )}

            {datos && datos.vinculados.length > 0 && (
                <div style={{ border: `1px solid ${t.color.border}`, borderRadius: t.radius.sm, background: t.color.surface }}>
                    {datos.vinculados.map((c, i) => (
                        <div key={c.chat} style={{ ...fila, borderTop: i ? `1px solid ${t.color.border}` : 'none' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                                <span style={{ ...texto, fontFamily: c.numero ? t.font.mono : t.font.family }}>
                                    {c.numero || 'Chat sin número'}
                                </span>
                                <span style={suave}>
                                    {VINCULO[c.vinculado_por] || c.vinculado_por}
                                    {c.ultimo_mensaje_at ? ` · último mensaje ${fmtFechaHora(c.ultimo_mensaje_at)}` : ''}
                                </span>
                            </div>
                            <Button size="sm" variant="ghost" disabled={guardando === c.chat} onClick={() => desvincular(c.chat)}>
                                {guardando === c.chat ? 'Sacando…' : 'No es este'}
                            </Button>
                        </div>
                    ))}
                </div>
            )}

            {datos && datos.vinculados.length === 0 && !eligiendo && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: t.space[4], flexWrap: 'wrap' }}>
                    <span style={suave}>No encontramos su chat. Los chats de antes del 14/11 llegan sin número y se vinculan a mano.</span>
                    <Button size="sm" leftIcon={<Icon.Link size={14} />} onClick={() => setEligiendo(true)}
                        disabled={!datos.candidatos.length}>
                        {datos.candidatos.length ? 'Elegir su chat' : 'Sin chats para elegir'}
                    </Button>
                </div>
            )}

            {datos && eligiendo && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[3] }}>
                    <span style={suave}>Chats de los últimos 8 días que no son de nadie. Primero los que se parecen al nombre.</span>
                    <div style={{ border: `1px solid ${t.color.border}`, borderRadius: t.radius.sm, background: t.color.surface }}>
                        {datos.candidatos.map((c, i) => (
                            <div key={c.chat} style={{ ...fila, borderTop: i ? `1px solid ${t.color.border}` : 'none' }}>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                                    <span style={{ display: 'flex', gap: t.space[2], alignItems: 'center', flexWrap: 'wrap' }}>
                                        <span style={texto}>{c.nombre || 'Sin nombre'}</span>
                                        {c.coincide && <Badge tone="accent">Nombre parecido</Badge>}
                                    </span>
                                    <span style={{ ...suave, fontFamily: c.numero ? t.font.mono : t.font.family }}>
                                        {c.numero || 'sin número'} · último mensaje {fmtFechaHora(c.ultimo_mensaje_at)}
                                    </span>
                                </div>
                                <Button size="sm" variant="primary" disabled={Boolean(guardando)} onClick={() => vincular(c.chat)}>
                                    {guardando === c.chat ? 'Vinculando…' : 'Es este'}
                                </Button>
                            </div>
                        ))}
                    </div>
                    <div>
                        <Button size="sm" variant="ghost" onClick={() => setEligiendo(false)}>Cancelar</Button>
                    </div>
                </div>
            )}
        </section>
    );
}
