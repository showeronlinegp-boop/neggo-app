import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { fmtInt } from '../../theme/tokens';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import * as Icon from '../../components/common/icons';
import Select from '../../components/common/Select';
import LeadFicha from './LeadFicha';
import { ETAPA_TONO, haceCuanto } from './etapasWhatsappUi';

const POR_COLUMNA = 30;
const SIN_CIUDAD = '__sin_ciudad__';

// Clave de ciudad sin mayúsculas, tildes ni espacios de más ("Colón" y "colon " son la misma)
const claveCiudad = (c) => String(c || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');

// Opciones del filtro: las ciudades de los prospectos del tablero, de la más usada a la menos,
// con la forma de escribirla que más se repite
function opcionesCiudad(etapas) {
    const porClave = new Map();
    let sinCiudad = 0;
    for (const g of etapas) {
        for (const l of g.items) {
            const k = claveCiudad(l.city);
            if (!k) { sinCiudad += 1; continue; }
            const e = porClave.get(k) || { total: 0, formas: new Map() };
            e.total += 1;
            const forma = String(l.city).trim();
            e.formas.set(forma, (e.formas.get(forma) || 0) + 1);
            porClave.set(k, e);
        }
    }
    const ciudades = [...porClave.entries()].map(([k, e]) => ({
        value: k,
        nombre: [...e.formas.entries()].sort((a, b) => b[1] - a[1])[0][0],
        total: e.total,
    })).sort((a, b) => b.total - a.total || a.nombre.localeCompare(b.nombre, 'es'));
    return [
        { value: '', label: 'Todas las ciudades' },
        ...ciudades.map((c) => ({ value: c.value, label: `${c.nombre} · ${fmtInt(c.total)}` })),
        ...(sinCiudad ? [{ value: SIN_CIUDAD, label: `Sin ciudad · ${fmtInt(sinCiudad)}` }] : []),
    ];
}

// Prospectos (posibles clientes) que tienen chat con el WhatsApp del negocio, en columnas por etapa.
// Cada columna dice su objetivo: cumplirlo es lo que lo pasa a la siguiente.
export default function EmbudoWhatsapp({ onCambio }) {
    const { tokens: t } = useTheme();
    const [datos, setDatos] = useState(null);
    const [error, setError] = useState(null);
    const [soloEsperan, setSoloEsperan] = useState(false);
    const [ciudad, setCiudad] = useState('');
    const [abierto, setAbierto] = useState(null);
    const huboCambios = useRef(false);
    // Columnas abiertas completas (por defecto se ven las primeras POR_COLUMNA tarjetas)
    const [completas, setCompletas] = useState({});
    const [proveedores, setProveedores] = useState(null);
    const [verProveedores, setVerProveedores] = useState(false);

    const cargarProveedores = useCallback(async () => {
        const res = await api.get('/clientes/leads/whatsapp-proveedores');
        if (res.success) setProveedores(res.data || []);
    }, []);
    useEffect(() => { cargarProveedores(); }, [cargarProveedores]);

    const noEsProveedor = async (chat) => {
        const res = await api.put(`/clientes/whatsapp/chats/${encodeURIComponent(chat)}/proveedor`, { es: false });
        if (!res.success) { setError(res.error || 'No se pudo marcar el chat'); return; }
        setProveedores((prev) => (prev || []).filter((p) => p.chat !== chat));
    };

    const cargar = useCallback(async () => {
        const res = await api.get('/clientes/leads/whatsapp-embudo');
        if (!res.success) { setError(res.error || 'No se pudo cargar el embudo'); return; }
        setError(null);
        setDatos(res.data);
    }, []);
    useEffect(() => { cargar(); }, [cargar]);

    const cerrarFicha = () => {
        setAbierto(null);
        if (huboCambios.current) { huboCambios.current = false; cargar(); cargarProveedores(); onCambio?.(); }
    };

    const etapas = datos?.etapas || [];
    const ciudades = opcionesCiudad(etapas);
    const enCiudad = (l) => !ciudad || (ciudad === SIN_CIUDAD ? !claveCiudad(l.city) : claveCiudad(l.city) === ciudad);
    const porCiudad = etapas.map((g) => ({ ...g, items: g.items.filter(enCiudad) }));
    // Con ciudad elegida, el botón de "esperan respuesta" cuenta solo los de esa ciudad
    const esperanEnCiudad = ciudad
        ? porCiudad.reduce((n, g) => n + g.items.filter((i) => i.espera_respuesta).length, 0)
        : datos?.espera_respuesta;
    const columnas = porCiudad.map((g) => ({
        ...g, items: soloEsperan ? g.items.filter((i) => i.espera_respuesta) : g.items,
    }));

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[6], fontFamily: t.font.family }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: t.space[4], flexWrap: 'wrap' }}>
                <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, maxWidth: 640 }}>
                    Prospectos que hablan con el WhatsApp del negocio. La etapa se mueve sola según quién escribió último
                    y lo que informa Grok; <strong>Interesado</strong> y <strong>Descartado</strong> los marcás vos desde la ficha.
                </div>
                {datos && (
                    <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap', alignItems: 'center' }}>
                        {ciudades.length > 1 && (
                            <Select value={ciudad} onChange={setCiudad} options={ciudades} placeholder="Ciudad" style={{ width: 200 }} />
                        )}
                        <Button size="sm" variant={soloEsperan ? 'primary' : 'secondary'} onClick={() => setSoloEsperan((v) => !v)}>
                            {`Te escribieron y esperan respuesta · ${fmtInt(esperanEnCiudad)}`}
                        </Button>
                        {proveedores && proveedores.length > 0 && (
                            <Button size="sm" variant={verProveedores ? 'primary' : 'secondary'} onClick={() => setVerProveedores((v) => !v)}>
                                {`Proveedores ocultos · ${fmtInt(proveedores.length)}`}
                            </Button>
                        )}
                        <Button size="sm" variant="ghost" leftIcon={<Icon.Refresh size={14} />} onClick={() => { cargar(); cargarProveedores(); }}>Actualizar</Button>
                    </div>
                )}
            </div>

            {verProveedores && proveedores && (
                <Card padding={false}>
                    <div style={{ padding: `${t.space[4]}px ${t.space[6]}px`, fontSize: t.font.size.sm, color: t.color.textMuted, borderBottom: `1px solid ${t.color.border}` }}>
                        Chats que no entran al tablero porque son de proveedores. Los nuevos se reconocen por el nombre; si alguno no es proveedor, sacalo de acá y en la próxima vuelta (15 min) entra como prospecto.
                    </div>
                    {proveedores.map((p, i) => (
                        <div key={p.chat} style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: t.space[4], flexWrap: 'wrap',
                            padding: `${t.space[3]}px ${t.space[6]}px`, borderTop: i ? `1px solid ${t.color.border}` : 'none',
                        }}>
                            <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                                <span style={{ fontSize: t.font.size.sm, color: t.color.text }}>{p.nombre || 'Sin nombre'}</span>
                                <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>
                                    {[p.numero, p.por === 'manual' ? 'marcado a mano' : `por el nombre (${p.proveedor})`, p.ultimo_mensaje_at ? `último mensaje ${haceCuanto(p.ultimo_mensaje_at)}` : null].filter(Boolean).join(' · ')}
                                </span>
                            </span>
                            <Button size="sm" variant="ghost" onClick={() => noEsProveedor(p.chat)}>No es proveedor</Button>
                        </div>
                    ))}
                </Card>
            )}

            {error && <div role="alert" style={{ fontSize: t.font.size.sm, color: t.color.danger }}>{error}</div>}
            {!datos && !error && <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>Cargando…</div>}
            {datos && datos.total === 0 && (
                <Card>
                    <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>
                        Todavía no hay prospectos con chat. El cruce con el WhatsApp del negocio corre cada 15 minutos.
                    </div>
                </Card>
            )}

            {datos && datos.total > 0 && (
                <div style={{ overflowX: 'auto', paddingBottom: t.space[2] }}>
                    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columnas.length}, minmax(210px, 1fr))`, gap: t.space[4], minWidth: columnas.length * 220 }}>
                        {columnas.map((g) => (
                            <div key={g.id} style={{
                                background: t.color.surface2, borderRadius: t.radius.md, padding: t.space[4],
                                display: 'flex', flexDirection: 'column', gap: t.space[3], minWidth: 0,
                            }}>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: t.space[2] }}>
                                        <Badge tone={ETAPA_TONO[g.id]} dot>{g.label}</Badge>
                                        <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, ...t.numericStyle }}>{fmtInt(g.items.length)}</span>
                                    </div>
                                    {g.objetivo && (
                                        <span style={{ fontSize: t.font.size.xs, color: t.color.textFaint }}>Objetivo: {g.objetivo}</span>
                                    )}
                                </div>
                                {(completas[g.id] ? g.items : g.items.slice(0, POR_COLUMNA)).map((l) => (
                                    <button key={l.id} type="button" onClick={() => setAbierto(l)} style={{
                                        textAlign: 'left', cursor: 'pointer', background: t.color.surface,
                                        border: `1px solid ${l.espera_respuesta ? t.color.accent : t.color.border}`,
                                        borderRadius: t.radius.sm, padding: t.space[3], fontFamily: t.font.family,
                                        display: 'flex', flexDirection: 'column', gap: 4,
                                    }}>
                                        <span style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.text }}>
                                            {l.name || 'Sin nombre'}
                                        </span>
                                        <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.mono }}>
                                            {[l.phone || 'sin número', l.city].filter(Boolean).join(' · ')}
                                        </span>
                                        <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                            {l.espera_respuesta && <Badge tone="accent">{`Te escribió ${haceCuanto(l.ultimo_mensaje_at)}`}</Badge>}
                                            {!l.espera_respuesta && l.ultimo_mensaje_at && (
                                                <span style={{ fontSize: t.font.size.xs, color: t.color.textFaint }}>Último mensaje {haceCuanto(l.ultimo_mensaje_at)}</span>
                                            )}
                                            {l.entro_por_whatsapp && <Badge tone="muted">Nuevo por WhatsApp</Badge>}
                                            {l.manual && <Badge tone="muted">Marcada a mano</Badge>}
                                        </span>
                                    </button>
                                ))}
                                {g.items.length > POR_COLUMNA && !completas[g.id] && (
                                    <Button size="sm" variant="ghost" onClick={() => setCompletas((c) => ({ ...c, [g.id]: true }))}>
                                        {`Ver los ${fmtInt(g.items.length)}`}
                                    </Button>
                                )}
                                {!g.items.length && <span style={{ fontSize: t.font.size.xs, color: t.color.textFaint }}>Nadie en esta etapa</span>}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <LeadFicha leadId={abierto?.id} resumen={abierto} onClose={cerrarFicha} onCambio={() => { huboCambios.current = true; }} />
        </div>
    );
}
