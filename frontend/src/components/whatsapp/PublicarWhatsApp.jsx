import { useState, useEffect } from 'react';
import api from '../../api/client';
import Modal from '../common/Modal';
import Button from '../common/Button';
import * as Icon from '../common/icons';

// Suma un producto a la cola de WhatsApp (tanda de 1: respeta el intervalo y los reintentos).
// La usan Reposición y Productos Odoo. company: 'neggo' o 'preventas' (lista de precios del mensaje).
export default function PublicarWhatsApp({ producto, company = 'neggo', onClose, onPublicado, t }) {
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
    // Los estados no se usan más (se borró la instancia neggo-estados): solo se publica al grupo.
    const desconectados = [sinGrupos && 'el de grupos'].filter(Boolean);

    const publicar = async (destino) => {
        setEnviando(destino);
        setError(null);
        const res = await api.post('/whatsapp/send-now', { company, odoo_id: producto.odoo_id, destino });
        setEnviando(null);
        if (!res.success) { setError(res.error || 'No se pudo publicar'); return; }
        onPublicado(destino === 'estado'
            ? `«${producto.name}» se sube a los estados en unos segundos.`
            : `«${producto.name}» entró a la cola de WhatsApp: sale al grupo ${grupo ? `«${grupo}» ` : ''}en cuanto le toque.`);
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
                    Sale con la foto, el precio de la lista {company === 'preventas' ? 'Preventas' : 'Neggo'} y el link a la web.
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
                    {enviando === 'grupo' ? 'Sumando a la cola…' : grupo ? `Al grupo «${grupo}»` : 'Al grupo (elegilo en Admin → WhatsApp)'}
                </Button>
            </div>
        </Modal>
    );
}
