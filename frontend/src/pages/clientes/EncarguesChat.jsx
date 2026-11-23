import { useCallback, useEffect, useState } from 'react';
import api from '../../api/client';
import { fmtAR } from '../../theme/tokens';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import * as Icon from '../../components/common/icons';
import { ESTADO_ENCARGUE, FormCotizado, fmtCantidad, haceCuanto } from '../reposicion/ReposicionACotizar';

// Encargues a cotizar dentro del botón «Pedidos» de Chats (nota 248): lo que el contacto pidió y
// no tenemos. Queda para averiguar en Reposición › A cotizar; cuando se consigue, acá se ve el
// precio para avisarle. Solo en la app: no crea nada en Odoo.

export default function EncarguesChat({ t, contacto, Titulo }) {
    const [items, setItems] = useState(null);
    const [error, setError] = useState(null);
    const [texto, setTexto] = useState('');
    const [cantidad, setCantidad] = useState('');
    const [nota, setNota] = useState('');
    const [guardando, setGuardando] = useState(false);
    const [trabajando, setTrabajando] = useState(null);
    const [cotizando, setCotizando] = useState(null);
    const base = `/encargues-cotizar/contacto/${contacto.tipo}/${contacto.id}`;

    const cargar = useCallback(async () => {
        const res = await api.get(base);
        if (!res.success) { setError(res.error || 'No se pudieron leer los encargues'); return; }
        setError(null);
        setItems(res.data || []);
    }, [base]);
    useEffect(() => { cargar(); }, [cargar]);

    const agregar = async (e) => {
        e.preventDefault();
        if (!texto.trim()) return;
        setGuardando(true);
        const res = await api.post(base, { texto, cantidad, nota, contacto_nombre: contacto.nombre || contacto.numero || null });
        setGuardando(false);
        if (!res.success) { setError(res.error || 'No se pudo guardar el encargue'); return; }
        setTexto(''); setCantidad(''); setNota('');
        await cargar();
    };

    const cambiar = async (it, body) => {
        setTrabajando(it.id);
        const res = await api.put(`/encargues-cotizar/${it.id}/estado`, body);
        setTrabajando(null);
        if (!res.success) { setError(res.error || 'No se pudo cambiar el encargue'); return; }
        setCotizando(null);
        await cargar();
    };

    const borrar = async (it) => {
        setTrabajando(it.id);
        const res = await api.del(`/encargues-cotizar/${it.id}`);
        setTrabajando(null);
        if (!res.success) { setError(res.error || 'No se pudo borrar el encargue'); return; }
        await cargar();
    };

    return (
        <section style={{ display: 'flex', flexDirection: 'column', gap: t.space[3] }}>
            <Titulo t={t}>Encargues a cotizar</Titulo>
            <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, lineHeight: 1.5 }}>
                Lo que te pide y no tenés. Aparece en Reposición › A cotizar para que lo preguntes al armar los pedidos a proveedores.
            </span>
            {error && <span style={{ fontSize: t.font.size.sm, color: t.color.danger }}>{error}</span>}
            {items === null && !error && <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>Cargando…</span>}
            {items?.map((it) => {
                const est = ESTADO_ENCARGUE[it.estado] || { label: it.estado, tone: 'muted' };
                const ocupado = trabajando === it.id;
                const cant = fmtCantidad(it.cantidad);
                return (
                    <div key={it.id} style={{
                        display: 'flex', flexDirection: 'column', gap: t.space[2], padding: '8px 10px', borderRadius: t.radius.md,
                        border: `1px solid ${t.color.border}`, background: t.color.surface,
                    }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: t.space[3] }}>
                            <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                                <span style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.text }}>
                                    {cant && <span style={{ ...t.numericStyle }}>{cant} × </span>}{it.texto}
                                </span>
                                <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>
                                    {[haceCuanto(it.created_at), it.nota].filter(Boolean).join(' · ')}
                                </span>
                                {it.precio !== null && (
                                    <span style={{ fontSize: t.font.size.sm, color: t.color.text }}>
                                        <span style={{ ...t.numericStyle, fontWeight: t.font.weight.semibold }}>{fmtAR(it.precio)}</span>
                                        {it.proveedor ? ` · ${it.proveedor}` : ''}
                                    </span>
                                )}
                            </span>
                            <Badge tone={est.tone}>{est.label}</Badge>
                        </div>
                        {cotizando === it.id ? (
                            <FormCotizado t={t} trabajando={ocupado} listId={`prov-chat-${it.id}`} onCancelar={() => setCotizando(null)}
                                onGuardar={(v) => cambiar(it, { estado: 'cotizado', ...v })} />
                        ) : (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: t.space[2] }}>
                                {it.estado === 'pendiente' && (
                                    <>
                                        <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setCotizando(it.id)}>Lo conseguí</Button>
                                        <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => cambiar(it, { estado: 'no_se_consigue' })}>No se consigue</Button>
                                        <Button size="sm" variant="ghost" leftIcon={<Icon.Trash2 size={13} />} disabled={ocupado} onClick={() => borrar(it)}
                                            aria-label="Borrar el encargue" title="Borrar (si lo cargaste por error)">Borrar</Button>
                                    </>
                                )}
                                {it.estado === 'cotizado' && (
                                    <Button size="sm" leftIcon={<Icon.MessageCircle size={13} />} disabled={ocupado} onClick={() => cambiar(it, { estado: 'avisado' })}>Ya le avisé</Button>
                                )}
                                {(it.estado === 'avisado' || it.estado === 'no_se_consigue') && (
                                    <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => cambiar(it, { estado: 'pendiente' })}>Reabrir</Button>
                                )}
                            </div>
                        )}
                    </div>
                );
            })}
            <form onSubmit={agregar} style={{ display: 'flex', flexDirection: 'column', gap: t.space[2] }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: t.space[2] }}>
                    <Input placeholder="¿Qué te pidió? Ej.: termo Stanley 1 litro verde" aria-label="Qué te pidió"
                        value={texto} onChange={(e) => setTexto(e.target.value)} style={{ flex: '1 1 240px' }} />
                    <Input inputMode="decimal" placeholder="Cantidad" aria-label="Cantidad"
                        value={cantidad} onChange={(e) => setCantidad(e.target.value)} style={{ width: 110 }} />
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: t.space[2] }}>
                    <Input placeholder="Nota (opcional): marca, color, para cuándo…" aria-label="Nota"
                        value={nota} onChange={(e) => setNota(e.target.value)} style={{ flex: '1 1 240px' }} />
                    <Button type="submit" variant="secondary" leftIcon={<Icon.Plus size={14} />} disabled={guardando || !texto.trim()}>
                        {guardando ? 'Guardando…' : 'Anotar encargue'}
                    </Button>
                </div>
            </form>
        </section>
    );
}
