import { useEffect, useState } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import Drawer from '../../components/common/Drawer';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import * as Icon from '../../components/common/icons';
import Seguimiento from './Seguimiento';
import { SOURCE_STATUS_META, fmtFecha, linkWhatsApp, nombreLead } from './clientesUi';

// Ficha de un posible cliente: datos de contacto, de dónde vino y su seguimiento.
export default function LeadFicha({ leadId, resumen, onClose, onCambio }) {
    const { tokens: t } = useTheme();
    const [lead, setLead] = useState(null);
    const [error, setError] = useState(null);

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
            subtitle={[datos?.city, datos?.phone, datos?.email].filter(Boolean).join(' · ') || null}
            width={560}
            footer={wa || datos?.email ? (
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: t.space[2], flex: 1, flexWrap: 'wrap' }}>
                    {datos?.email && (
                        <a href={`mailto:${datos.email}`} style={{ textDecoration: 'none' }}>
                            <Button variant="secondary">Escribile un mail</Button>
                        </a>
                    )}
                    {wa && (
                        <a href={wa} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
                            <Button variant="primary" leftIcon={<Icon.MessageCircle size={16} />}>Escribile por WhatsApp</Button>
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
                            {datos.source === 'google_contacts' ? 'Importado de los contactos' : 'Cargado a mano'} el {fmtFecha(String(datos.created_at).slice(0, 10))}
                        </span>
                    </div>
                )}
                {datos && (
                    <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>
                        Cuando compre y aparezca en Odoo con este mismo teléfono, pasa solo a Clientes con todo su seguimiento.
                    </div>
                )}
                {leadId && <Seguimiento tipo="lead" id={leadId} onCambio={onCambio} />}
            </div>
        </Drawer>
    );
}
