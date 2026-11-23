import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { fmtInt } from '../../theme/tokens';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import * as Icon from '../../components/common/icons';
import LeadFicha from './LeadFicha';
import ClienteFicha from './ClienteFicha';
import PosiblesClientes from './PosiblesClientes';
import { ETAPA_TONO, haceCuanto } from './etapasWhatsappUi';
import { HEALTH_META } from './clientesUi';

// Contactos del WhatsApp del negocio en cuatro grupos según cómo está la charla:
// Activos (mensajes de los últimos 7 días: la charla se puede leer), Conversación abierta (7 a 15),
// Sin conversación abierta (más de 15) y Sin chat (nunca escribieron). Prospectos y clientes juntos
// o por separado. Ver backend/services/crmFichaService.js (contactos).

const GRUPOS = [
    { id: 'activos', titulo: 'Activos', desc: 'Hubo mensajes en los últimos 7 días. La charla se puede leer.', color: 'success' },
    { id: 'abiertos', titulo: 'Conversación abierta', desc: 'El último mensaje fue hace 7 a 15 días. Todavía se puede retomar.', color: 'primary' },
    { id: 'dormidos', titulo: 'Sin conversación abierta', desc: 'Hace más de 15 días que nadie escribe en el chat.', color: 'warn' },
    { id: 'sinchat', titulo: 'Sin chat', desc: 'Nunca hablaron con el WhatsApp del negocio.', color: 'textMuted' },
];
const TIPOS = [['todos', 'Todos'], ['prospecto', 'Prospectos'], ['cliente', 'Clientes']];
const PAGE = 50;

export default function Contactos({ onCambio }) {
    const { tokens: t } = useTheme();
    const [grupo, setGrupo] = useState('activos');
    const [tipo, setTipo] = useState('todos');
    const [q, setQ] = useState('');
    const [soloEsperan, setSoloEsperan] = useState(false);
    const [datos, setDatos] = useState(null);
    const [items, setItems] = useState([]);
    const [error, setError] = useState(null);
    const [cargando, setCargando] = useState(false);
    const [abierto, setAbierto] = useState(null);
    const huboCambios = useRef(false);

    const cargar = useCallback(async (offset = 0) => {
        setCargando(true);
        const res = await api.get('/clientes/contactos', { grupo: grupo === 'sinchat' ? 'activos' : grupo, tipo, q: q.trim(), solo_esperan: soloEsperan ? 'true' : '', limit: PAGE, offset });
        setCargando(false);
        if (!res.success) { setError(res.error || 'No se pudieron cargar los contactos'); return; }
        setError(null);
        setDatos(res.data);
        setItems((prev) => (offset ? [...prev, ...res.data.items] : res.data.items));
    }, [grupo, tipo, q, soloEsperan]);

    useEffect(() => {
        const id = setTimeout(() => cargar(0), q ? 300 : 0);
        return () => clearTimeout(id);
    }, [cargar, q]);

    const cerrar = () => {
        setAbierto(null);
        if (huboCambios.current) { huboCambios.current = false; cargar(0); onCambio?.(); }
    };

    const conteo = datos?.conteo;
    const actual = GRUPOS.find((g) => g.id === grupo);
    const conFiltroEspera = grupo === 'activos' || grupo === 'abiertos' || grupo === 'dormidos';

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[6], fontFamily: t.font.family }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: t.space[4], alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, maxWidth: 620, lineHeight: 1.5 }}>
                    Todos los que hablan con el WhatsApp del negocio, y los que todavía no, según cómo está la charla.
                </div>
                <div role="group" aria-label="Qué contactos ver" style={{ display: 'flex', gap: 4, padding: 4, background: t.color.surface2, border: `1px solid ${t.color.border}`, borderRadius: t.radius.md }}>
                    {TIPOS.map(([v, label]) => (
                        <button key={v} type="button" aria-pressed={tipo === v} onClick={() => setTipo(v)} style={{
                            border: 0, cursor: 'pointer', height: 32, padding: '0 14px', borderRadius: t.radius.sm, fontFamily: t.font.family,
                            fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold,
                            background: tipo === v ? t.color.surface : 'transparent', color: tipo === v ? t.color.text : t.color.textMuted,
                            boxShadow: tipo === v ? t.shadow.card : 'none',
                        }}>{label}</button>
                    ))}
                </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: t.space[4] }}>
                {GRUPOS.map((g) => {
                    const c = conteo?.[g.id];
                    const n = g.id === 'sinchat' && tipo === 'cliente' ? null : c?.[tipo];
                    const esperan = c?.esperan?.[tipo] || 0;
                    const on = grupo === g.id;
                    return (
                        <button key={g.id} type="button" aria-pressed={on} onClick={() => { setGrupo(g.id); setSoloEsperan(false); }} style={{
                            textAlign: 'left', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: t.space[2], padding: t.space[8],
                            borderRadius: t.radius.lg, background: t.color.surface, fontFamily: t.font.family, color: t.color.text,
                            border: `2px solid ${on ? t.color.primary : t.color.border}`, boxShadow: on ? t.shadow.pop : 'none',
                        }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: t.space[2] }}>
                                <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: t.radius.full, background: t.color[g.color] }} />
                                <span style={{ fontWeight: t.font.weight.semibold }}>{g.titulo}</span>
                            </span>
                            <span style={{ fontSize: t.font.size['2xl'], fontWeight: t.font.weight.bold, fontVariantNumeric: 'tabular-nums' }}>
                                {n === null || n === undefined ? '—' : fmtInt(n)}
                            </span>
                            <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, lineHeight: 1.4 }}>{g.desc}</span>
                            <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                {esperan > 0 && <Badge tone="accent">{`${fmtInt(esperan)} esperan respuesta`}</Badge>}
                                {tipo === 'todos' && c && g.id !== 'sinchat' && <Badge tone="muted">{`${fmtInt(c.prospecto)} prospectos · ${fmtInt(c.cliente)} clientes`}</Badge>}
                                {g.id === 'sinchat' && <Badge tone="muted">Solo prospectos</Badge>}
                            </span>
                        </button>
                    );
                })}
            </div>

            {grupo === 'sinchat' ? (
                tipo === 'cliente'
                    ? <Card style={{ color: t.color.textMuted }}>Los clientes de Odoo que nunca escribieron todavía no se listan acá: están en la pestaña Clientes.</Card>
                    : <PosiblesClientes whatsapp="sin" />
            ) : (
                <Card padding={false} style={{ overflow: 'hidden' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: t.space[4], alignItems: 'center', justifyContent: 'space-between', padding: `${t.space[6]}px ${t.space[8]}px`, borderBottom: `1px solid ${t.color.border}` }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontWeight: t.font.weight.semibold, fontSize: t.font.size.lg, color: t.color.text }}>{actual.titulo}</span>
                            <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>Primero los que te escribieron y esperan respuesta.</span>
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: t.space[3], alignItems: 'center' }}>
                            <Input style={{ minWidth: 240 }} leftIcon={<Icon.Search size={16} />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nombre, teléfono o chat" aria-label="Buscar contacto" />
                            {conFiltroEspera && (
                                <Button variant={soloEsperan ? 'accent' : 'secondary'} aria-pressed={soloEsperan} onClick={() => setSoloEsperan((v) => !v)}>
                                    Solo los que esperan respuesta
                                </Button>
                            )}
                        </div>
                    </div>
                    {error && <div style={{ padding: t.space[8], color: t.color.danger }}>{error}</div>}
                    {!error && items.length === 0 && !cargando && (
                        <div style={{ padding: t.space[8], color: t.color.textMuted, fontSize: t.font.size.sm }}>No hay contactos en este grupo{q ? ` con “${q}”` : ''}.</div>
                    )}
                    {items.map((c) => <FilaContacto key={`${c.tipo}-${c.id}`} c={c} t={t} onAbrir={() => setAbierto(c)} />)}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: t.space[4], padding: `${t.space[4]}px ${t.space[8]}px`, borderTop: `1px solid ${t.color.border}`, fontSize: t.font.size.sm, color: t.color.textMuted }}>
                        <span>{datos ? `${fmtInt(items.length)} de ${fmtInt(datos.total)}` : ''}</span>
                        {datos && items.length < datos.total && (
                            <Button size="sm" variant="secondary" disabled={cargando} onClick={() => cargar(items.length)}>{cargando ? 'Cargando…' : 'Ver más'}</Button>
                        )}
                        {grupo === 'activos' && <span>Después de 7 días el texto se borra; quedan el resumen y quién escribió último.</span>}
                    </div>
                </Card>
            )}

            {abierto?.tipo === 'prospecto' && (
                <LeadFicha leadId={abierto.id} resumen={{ id: abierto.id, name: abierto.nombre, phone: abierto.numero }} onClose={cerrar}
                    onCambio={() => { huboCambios.current = true; }} />
            )}
            {abierto?.tipo === 'cliente' && (
                <ClienteFicha partnerId={abierto.id} resumen={{ odoo_partner_id: abierto.id, partner_name: abierto.nombre }} onClose={cerrar}
                    onCambio={() => { huboCambios.current = true; }} />
            )}
        </div>
    );
}

function FilaContacto({ c, t, onAbrir }) {
    const esCliente = c.tipo === 'cliente';
    const salud = esCliente && c.health ? HEALTH_META[c.health] : null;
    const sig = c.objetivos?.siguiente;
    return (
        <button type="button" onClick={onAbrir} style={{
            display: 'flex', flexWrap: 'wrap', gap: `${t.space[3]}px ${t.space[8]}px`, alignItems: 'center', width: '100%', textAlign: 'left',
            padding: `${t.space[5]}px ${t.space[8]}px`, border: 0, borderTop: `1px solid ${t.color.border}`, background: 'transparent',
            cursor: 'pointer', fontFamily: t.font.family, color: t.color.text,
        }}>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: '2 1 220px', minWidth: 0 }}>
                <span style={{ fontWeight: t.font.weight.semibold, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.nombre || 'Sin nombre'}</span>
                <span style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textMuted }}>{c.numero || c.chat}</span>
            </span>
            <span style={{ flex: '0 0 96px' }}>
                <Badge tone={esCliente ? 'success' : 'primary'}>{esCliente ? 'Cliente' : 'Prospecto'}</Badge>
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 150px', minWidth: 0 }}>
                {esCliente
                    ? (salud ? <Badge tone={salud.tone}>{salud.label}</Badge> : <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>Sin datos de compra</span>)
                    : c.etapa && (
                        <>
                            <span><Badge tone={ETAPA_TONO[c.etapa.id] || 'muted'}>{c.etapa.label}</Badge></span>
                            {c.etapa.objetivo && <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>{c.etapa.objetivo}</span>}
                        </>
                    )}
            </span>
            <span style={{ display: 'flex', gap: t.space[2], alignItems: 'center', flex: '1 1 170px', minWidth: 0 }}>
                {c.espera_respuesta && <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: t.radius.full, background: t.color.accent, flex: 'none' }} />}
                <span style={{ fontSize: t.font.size.sm, fontWeight: c.espera_respuesta ? t.font.weight.semibold : t.font.weight.regular }}>
                    {c.ultimo_mensaje_at ? `${c.espera_respuesta ? 'Te escribió' : 'Le escribimos'} ${haceCuanto(c.ultimo_mensaje_at)}` : 'Sin mensajes'}
                </span>
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 180px', minWidth: 0 }}>
                {c.objetivos && (
                    <>
                        <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontVariantNumeric: 'tabular-nums' }}>
                            Objetivos {c.objetivos.hechos} de {c.objetivos.total}{c.objetivos.tiene_resumen ? ' · con resumen' : ''}
                        </span>
                        <span style={{ fontSize: t.font.size.sm, color: c.objetivos.listo_para_precios ? t.color.success : t.color.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {c.objetivos.listo_para_precios ? 'Listo para precios' : sig ? `Falta: ${sig.titulo}` : ''}
                        </span>
                    </>
                )}
            </span>
            <Icon.ChevronRight size={16} />
        </button>
    );
}
