import { useState, useEffect, useCallback } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR, fmtInt } from '../../theme/tokens';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import * as Icon from '../../components/common/icons';

// Pestaña «A cotizar» de Reposición (nota 248): mercadería que no tenemos y un cliente o
// prospecto pidió que averigüemos. Se carga desde el botón «Pedidos» de Clientes › Chats.
// Al armar los pedidos a proveedores se pregunta precio; si se consigue queda «Cotizado» con
// precio y proveedor hasta que se le avisa al cliente. Solo vive en la app: no toca Odoo.

export const ESTADO_ENCARGUE = {
    pendiente:      { label: 'A averiguar',     tone: 'warn' },
    cotizado:       { label: 'Cotizado',        tone: 'success' },
    avisado:        { label: 'Avisado',         tone: 'muted' },
    no_se_consigue: { label: 'No se consigue',  tone: 'danger' },
};

export function haceCuanto(iso) {
    if (!iso) return '';
    const dias = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (dias <= 0) return 'hoy';
    if (dias === 1) return 'ayer';
    return `hace ${dias} días`;
}

export function fmtCantidad(c) {
    if (c === null || c === undefined) return null;
    return Number.isInteger(c) ? fmtInt(c) : String(c).replace('.', ',');
}

/** Precio + proveedor para pasarlo a «Cotizado». */
export function FormCotizado({ t, proveedores = [], trabajando, onGuardar, onCancelar, listId }) {
    const [precio, setPrecio] = useState('');
    const [proveedor, setProveedor] = useState('');
    const enviar = (e) => {
        e.preventDefault();
        onGuardar({ precio, proveedor });
    };
    return (
        <form onSubmit={enviar} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: t.space[2] }}>
            <Input autoFocus inputMode="decimal" placeholder="Precio por unidad" aria-label="Precio por unidad"
                value={precio} onChange={(e) => setPrecio(e.target.value)} style={{ width: 150 }} />
            <Input placeholder="Proveedor (opcional)" aria-label="Proveedor" list={proveedores.length ? listId : undefined}
                value={proveedor} onChange={(e) => setProveedor(e.target.value)} style={{ width: 220 }} />
            {proveedores.length > 0 && (
                <datalist id={listId}>
                    {proveedores.map((p) => <option key={p} value={p} />)}
                </datalist>
            )}
            <Button size="sm" type="submit" disabled={trabajando || !precio.trim()}>Guardar</Button>
            <Button size="sm" variant="ghost" type="button" onClick={onCancelar}>Cancelar</Button>
        </form>
    );
}

const FILTROS = [
    { value: 'abiertos', label: 'Abiertos' },
    { value: 'cerrados', label: 'Cerrados' },
];

export default function ReposicionACotizar({ recargar, proveedores = [], onCambio, onAviso, onError, isMobile }) {
    const { tokens: t } = useTheme();
    const [grupo, setGrupo] = useState('abiertos');
    const [items, setItems] = useState(null);
    const [cotizando, setCotizando] = useState(null);
    const [trabajando, setTrabajando] = useState(null);

    const cargar = useCallback(async () => {
        const res = await api.get('/encargues-cotizar', { grupo });
        if (res.success) setItems(res.data || []);
        else onError?.(res.error || 'No se pudieron leer los encargues a cotizar');
    }, [grupo, onError]);
    useEffect(() => { setItems(null); cargar(); }, [cargar, recargar]);

    const cambiar = async (it, body, aviso) => {
        setTrabajando(it.id);
        const res = await api.put(`/encargues-cotizar/${it.id}/estado`, body);
        setTrabajando(null);
        if (!res.success) { onError?.(res.error || 'No se pudo cambiar el encargue'); return; }
        setCotizando(null);
        onAviso?.(aviso);
        await cargar();
        onCambio?.();
    };

    const nombresProv = proveedores.map((p) => p.vendor_name).filter(Boolean);
    const pend = (items || []).filter((i) => i.estado === 'pendiente').length;
    const cot = (items || []).filter((i) => i.estado === 'cotizado').length;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[4], fontFamily: t.font.family }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: t.space[3], padding: isMobile ? '0 12px' : undefined }}>
                <div style={{ display: 'flex', gap: t.space[2] }}>
                    {FILTROS.map((f) => (
                        <Button key={f.value} size="sm" variant={grupo === f.value ? 'primary' : 'secondary'} onClick={() => setGrupo(f.value)}>
                            {f.label}
                        </Button>
                    ))}
                </div>
                <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>
                    {grupo === 'abiertos'
                        ? 'Lo que te pidieron y no tenés. Preguntalo al armar los pedidos; cuando lo consigas cargá el precio y avisale al cliente.'
                        : 'Avisados y los que no se consiguieron. Se cargan en Clientes › Chats › Pedidos.'}
                </span>
            </div>

            {items === null ? (
                <Card><div style={{ padding: 40, textAlign: 'center', color: t.color.textMuted }}>Cargando…</div></Card>
            ) : items.length === 0 ? (
                <Card>
                    <div style={{ padding: isMobile ? 28 : 40, textAlign: 'center', color: t.color.textMuted, maxWidth: 420, margin: '0 auto', lineHeight: 1.5 }}>
                        {grupo === 'abiertos'
                            ? 'No hay nada para averiguar. Cuando un cliente te pida algo que no tenés, cargalo en Clientes › Chats, botón «Pedidos».'
                            : 'Todavía no se cerró ningún encargue.'}
                    </div>
                </Card>
            ) : (
                <>
                    {grupo === 'abiertos' && (
                        <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, padding: isMobile ? '0 12px' : undefined, ...t.numericStyle }}>
                            <span style={{ fontWeight: t.font.weight.semibold, color: t.color.text }}>{fmtInt(pend)}</span> para averiguar
                            {' · '}
                            <span style={{ fontWeight: t.font.weight.semibold, color: t.color.text }}>{fmtInt(cot)}</span> cotizados sin avisar
                        </div>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[2] }}>
                        {items.map((it) => {
                            const est = ESTADO_ENCARGUE[it.estado] || { label: it.estado, tone: 'muted' };
                            const ocupado = trabajando === it.id;
                            const cant = fmtCantidad(it.cantidad);
                            return (
                                <Card key={it.id}>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[2], padding: isMobile ? '12px' : '12px 16px' }}>
                                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: t.space[3], flexWrap: 'wrap' }}>
                                            <div style={{ flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', gap: 2 }}>
                                                <span style={{ fontSize: t.font.size.base, fontWeight: t.font.weight.semibold, color: t.color.text }}>
                                                    {cant && <span style={{ ...t.numericStyle }}>{cant} × </span>}{it.texto}
                                                </span>
                                                <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>
                                                    {[it.contacto.nombre || (it.contacto.tipo === 'cliente' ? 'Cliente' : 'Prospecto'), haceCuanto(it.created_at), it.creado_por ? `cargó ${it.creado_por}` : null].filter(Boolean).join(' · ')}
                                                </span>
                                                {it.nota && <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontStyle: 'italic' }}>{it.nota}</span>}
                                                {it.precio !== null && (
                                                    <span style={{ fontSize: t.font.size.sm, color: t.color.text }}>
                                                        <span style={{ ...t.numericStyle, fontWeight: t.font.weight.semibold }}>{fmtAR(it.precio)}</span>
                                                        {it.proveedor ? ` · ${it.proveedor}` : ''}
                                                    </span>
                                                )}
                                            </div>
                                            <Badge tone={est.tone}>{est.label}</Badge>
                                        </div>
                                        {cotizando === it.id ? (
                                            <FormCotizado t={t} proveedores={nombresProv} trabajando={ocupado} listId={`prov-encargue-${it.id}`}
                                                onCancelar={() => setCotizando(null)}
                                                onGuardar={(v) => cambiar(it, { estado: 'cotizado', ...v }, 'Quedó cotizado. Avisale al cliente y marcalo como avisado.')} />
                                        ) : (
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: t.space[2] }}>
                                                {it.estado === 'pendiente' && (
                                                    <>
                                                        <Button size="sm" leftIcon={<Icon.Check size={13} />} disabled={ocupado} onClick={() => setCotizando(it.id)}>Lo conseguí</Button>
                                                        <Button size="sm" variant="ghost" leftIcon={<Icon.X size={13} />} disabled={ocupado}
                                                            onClick={() => cambiar(it, { estado: 'no_se_consigue' }, 'Quedó como «No se consigue».')}>No se consigue</Button>
                                                    </>
                                                )}
                                                {it.estado === 'cotizado' && (
                                                    <>
                                                        <Button size="sm" leftIcon={<Icon.MessageCircle size={13} />} disabled={ocupado}
                                                            onClick={() => cambiar(it, { estado: 'avisado' }, 'Listo, quedó como avisado.')}>Ya le avisé</Button>
                                                        <Button size="sm" variant="ghost" disabled={ocupado}
                                                            onClick={() => cambiar(it, { estado: 'pendiente' }, 'Volvió a «A averiguar».')}>Volver a averiguar</Button>
                                                    </>
                                                )}
                                                {(it.estado === 'avisado' || it.estado === 'no_se_consigue') && (
                                                    <Button size="sm" variant="ghost" leftIcon={<Icon.Refresh size={13} />} disabled={ocupado}
                                                        onClick={() => cambiar(it, { estado: 'pendiente' }, 'Volvió a «A averiguar».')}>Reabrir</Button>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </Card>
                            );
                        })}
                    </div>
                </>
            )}
        </div>
    );
}
