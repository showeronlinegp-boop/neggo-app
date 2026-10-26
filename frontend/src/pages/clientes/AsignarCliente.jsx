import { useEffect, useState } from 'react';
import api from '../../api/client';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import * as Icon from '../../components/common/icons';

// Asignar a mano el posible cliente a un cliente de Odoo: es otro contacto de alguien que ya compra
// (otro celular, un empleado, la pareja). Su seguimiento pasa a ese cliente (nota #82).
export default function AsignarCliente({ leadId, nombre, onAsignado, t }) {
    const [abierto, setAbierto] = useState(false);
    const [busqueda, setBusqueda] = useState('');
    const [resultados, setResultados] = useState([]);
    const [buscando, setBuscando] = useState(false);
    const [elegido, setElegido] = useState(null);
    const [guardando, setGuardando] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        setAbierto(false); setBusqueda(''); setResultados([]); setElegido(null); setError(null);
    }, [leadId]);

    useEffect(() => {
        const q = busqueda.trim();
        if (!abierto || q.length < 2) { setResultados([]); return undefined; }
        let cancelado = false;
        setBuscando(true);
        const timer = setTimeout(async () => {
            const res = await api.get('/clientes', { search: q, sort: 'nombre', limit: 8 });
            if (cancelado) return;
            setBuscando(false);
            if (!res.success) { setError(res.error || 'No se pudo buscar'); return; }
            setError(null);
            setResultados(res.data || []);
        }, 300);
        return () => { cancelado = true; clearTimeout(timer); };
    }, [busqueda, abierto]);

    const asignar = async () => {
        if (!elegido) return;
        setGuardando(true);
        setError(null);
        const res = await api.post(`/clientes/leads/${leadId}/asignar`, { partner_id: elegido.odoo_partner_id });
        setGuardando(false);
        if (!res.success) { setError(res.error || 'No se pudo asignar'); return; }
        onAsignado(res.data);
    };

    if (!abierto) {
        return (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: t.space[4], flexWrap: 'wrap' }}>
                <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>¿Ya es cliente con otro contacto?</span>
                <Button size="sm" leftIcon={<Icon.Link size={14} />} onClick={() => setAbierto(true)}>Asignar a un cliente</Button>
            </div>
        );
    }

    return (
        <section style={{
            display: 'flex', flexDirection: 'column', gap: t.space[4], padding: t.space[6],
            border: `1px solid ${t.color.border}`, borderRadius: t.radius.md, background: t.color.bg,
        }}>
            <div style={{ fontSize: t.font.size.sm, color: t.color.text }}>
                Buscá el cliente de Odoo del que {nombre ? <strong>{nombre}</strong> : 'este contacto'} es otro contacto.
                Su seguimiento pasa a ese cliente y deja de figurar como posible cliente.
            </div>
            {elegido ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: t.space[4], flexWrap: 'wrap' }}>
                    <span style={{ fontSize: t.font.size.sm, color: t.color.text }}>
                        Asignar a <strong>{elegido.partner_name}</strong>
                        {elegido.city ? <span style={{ color: t.color.textMuted }}> · {elegido.city}</span> : null}
                    </span>
                    <div style={{ display: 'flex', gap: t.space[2] }}>
                        <Button size="sm" onClick={() => setElegido(null)} disabled={guardando}>Elegir otro</Button>
                        <Button size="sm" variant="primary" onClick={asignar} disabled={guardando}>
                            {guardando ? 'Asignando…' : 'Confirmar'}
                        </Button>
                    </div>
                </div>
            ) : (
                <>
                    <Input autoFocus value={busqueda} onChange={(e) => setBusqueda(e.target.value)}
                        placeholder="Nombre o celular del cliente" aria-label="Buscar el cliente"
                        leftIcon={<Icon.Search size={16} />} />
                    {busqueda.trim().length >= 2 && !buscando && !resultados.length && !error && (
                        <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>No encontré clientes con esa búsqueda.</div>
                    )}
                    {resultados.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', border: `1px solid ${t.color.border}`, borderRadius: t.radius.sm, background: t.color.surface }}>
                            {resultados.map((c, i) => (
                                <button key={c.odoo_partner_id} type="button" onClick={() => setElegido(c)} style={{
                                    display: 'flex', justifyContent: 'space-between', gap: t.space[4], padding: `${t.space[3]}px ${t.space[4]}px`,
                                    background: 'transparent', border: 'none', borderTop: i ? `1px solid ${t.color.border}` : 'none',
                                    textAlign: 'left', cursor: 'pointer', fontFamily: t.font.family,
                                }}>
                                    <span style={{ fontSize: t.font.size.sm, color: t.color.text, fontWeight: t.font.weight.medium }}>{c.partner_name}</span>
                                    <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>
                                        {[c.city, c.phone].filter(Boolean).join(' · ')}
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                    <div>
                        <Button size="sm" variant="ghost" onClick={() => { setAbierto(false); setBusqueda(''); }}>Cancelar</Button>
                    </div>
                </>
            )}
            {error && <div style={{ fontSize: t.font.size.sm, color: t.color.danger }}>{error}</div>}
        </section>
    );
}
