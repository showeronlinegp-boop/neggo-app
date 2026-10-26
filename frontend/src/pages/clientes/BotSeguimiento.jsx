import { useCallback, useEffect, useState } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { fmtInt } from '../../theme/tokens';
import useIsMobile from '../../hooks/useIsMobile';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Select from '../../components/common/Select';
import Tabs from '../../components/common/Tabs';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import * as Icon from '../../components/common/icons';
import ClienteFicha from './ClienteFicha';
import { fmtFecha, fmtFechaHora } from './clientesUi';

// Monitoreo del bot de seguimiento (Grok Bot, API /api/agente): a quién le toca mensaje hoy y por qué
// no salió todavía, qué mandó y qué le contestaron, qué registró de cada contacto y qué pedidos le
// rechazó la API. Solo lectura: lo que hace el bot se cambia desde el bot.

const PERIODOS = [
    { value: '1', label: 'Hoy' },
    { value: '7', label: 'Últimos 7 días' },
    { value: '30', label: 'Últimos 30 días' },
    { value: '90', label: 'Últimos 90 días' },
];
const REFRESCO_MS = 60 * 1000;

const ETAPA_BOT = { pendiente: 'Sin mensajes', dia_1: 'Día 1', dia_7: 'Día 7', dia_15: 'Día 15', finalizado: 'Finalizado' };
const ESTADO_ENVIO = {
    enviado: { label: 'Salió', tone: 'success' },
    reservado: { label: 'Reservado', tone: 'primary' },
    cancelado: { label: 'No salió', tone: 'danger' },
    vencido: { label: 'Venció la reserva', tone: 'warn' },
};
const MOTIVO_CANCELACION = { agente: 'el WhatsApp no salió', no_contactar: 'pidió que no le escriban' };
const MOTIVO_TONO = {
    reservado: 'primary', pendiente: 'warn', fuera_de_horario: 'muted',
    sin_telefono: 'danger', respuesta_pendiente: 'accent', no_contactar: 'muted',
};
const FEEDBACK_TONO = { error: 'danger', falta: 'warn', mejora: 'primary', comentario: 'muted' };
const FEEDBACK_LABEL = { error: 'Error', falta: 'Falta', mejora: 'Mejora', comentario: 'Comentario' };

function Nombre({ id, nombre, sub, onAbrir, t }) {
    return (
        <div style={{ minWidth: 0 }}>
            <button type="button" onClick={() => onAbrir({ odoo_partner_id: id, partner_name: nombre })} style={{
                background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left',
                fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.text, fontFamily: t.font.family,
            }}>
                {nombre}
            </button>
            {sub && (
                <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, display: 'flex', flexWrap: 'wrap', gap: '0 8px' }}>
                    {sub}
                </div>
            )}
        </div>
    );
}

function Fila({ children, t, last }) {
    return (
        <div style={{
            display: 'flex', gap: t.space[4], alignItems: 'flex-start', flexWrap: 'wrap',
            padding: `${t.space[4]}px ${t.space[6]}px`,
            borderBottom: last ? 'none' : `1px solid ${t.color.border}`,
        }}>
            {children}
        </div>
    );
}

function Vacio({ texto, t }) {
    return <div style={{ padding: t.space[10], textAlign: 'center', fontSize: t.font.size.sm, color: t.color.textMuted }}>{texto}</div>;
}

function Mensaje({ texto, t }) {
    return (
        <div style={{
            fontSize: t.font.size.sm, color: t.color.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            background: t.color.surface2, borderRadius: t.radius.md, padding: '8px 10px', marginTop: 6,
        }}>
            {texto}
        </div>
    );
}

function Resumen({ r, isMobile, t }) {
    const stats = [
        { label: 'Salieron', value: r.enviados, hint: 'Mensajes de la cadencia confirmados', color: t.color.success },
        { label: 'No salieron', value: r.cancelados + r.vencidos, hint: `${fmtInt(r.cancelados)} cancelados · ${fmtInt(r.vencidos)} vencidos`, color: r.cancelados + r.vencidos ? t.color.danger : t.color.text },
        { label: 'Respuestas', value: r.recibidos, hint: `${fmtInt(r.notas)} mensajes más del bot en la charla`, color: t.color.text },
        { label: 'Les toca hoy', value: r.toca_hoy, hint: r.toca_hoy == null ? 'No se pudo leer Odoo' : `${fmtInt(r.sin_enviar_hoy)} sin enviar todavía`, color: r.sin_enviar_hoy ? t.color.warn : t.color.text },
        { label: 'Rechazos de la API', value: r.rechazos, hint: 'Pedidos del bot que la API frenó', color: r.rechazos ? t.color.accent : t.color.text },
    ];
    return (
        <Card style={{
            display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(5, minmax(0, 1fr))',
            gap: t.space[6], marginBottom: t.space[6],
        }}>
            {stats.map((s) => (
                <div key={s.label} style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                    <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>{s.label}</span>
                    <span style={{ fontSize: t.font.size['2xl'], fontWeight: t.font.weight.semibold, lineHeight: 1.1, color: s.color, ...t.numericStyle }}>
                        {s.value == null ? '—' : fmtInt(s.value)}
                    </span>
                    <span style={{ fontSize: t.font.size.xs, color: t.color.textFaint }}>{s.hint}</span>
                </div>
            ))}
        </Card>
    );
}

function ParaHoy({ cola, error, meta, onAbrir, t }) {
    const [verTodos, setVerTodos] = useState(false);
    if (!cola) return <Vacio texto={`No se pudo armar la lista de hoy: ${error || 'Odoo no respondió'}`} t={t} />;
    const toca = cola.filter((c) => c.estado === 'toca').sort((a, b) => String(a.vence).localeCompare(String(b.vence)));
    const resto = cola.filter((c) => c.estado !== 'toca')
        .sort((a, b) => (a.estado === b.estado ? (b.dias_desde_compra ?? 0) - (a.dias_desde_compra ?? 0) : a.estado === 'al_dia' ? -1 : 1));
    const filas = verTodos ? [...toca, ...resto] : toca;
    return (
        <>
            <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: t.space[4], flexWrap: 'wrap',
                padding: `${t.space[4]}px ${t.space[6]}px`, borderBottom: `1px solid ${t.color.border}`,
                fontSize: t.font.size.xs, color: t.color.textMuted,
            }}>
                <span>
                    Clientes nuevos en la cadencia (primera compra en los últimos 21 días). Horario de envío: {meta?.ventana_envio}
                    {meta && (meta.ventana_abierta
                        ? <strong style={{ color: t.color.success }}> · abierto ahora</strong>
                        : <span> · cerrado, abre {fmtFechaHora(meta.abre_a)}</span>)}
                </span>
                <Button variant="ghost" size="sm" onClick={() => setVerTodos((v) => !v)}>
                    {verTodos ? 'Ver solo los que les toca hoy' : `Ver también los que están al día (${fmtInt(resto.length)})`}
                </Button>
            </div>
            {filas.length === 0 && <Vacio texto="Hoy no le toca mensaje a ningún cliente." t={t} />}
            {filas.map((c, i) => (
                <Fila key={c.id} t={t} last={i === filas.length - 1}>
                    <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                        <Nombre id={c.id} nombre={c.nombre} onAbrir={onAbrir} t={t} sub={<>
                            <span style={{ fontFamily: t.font.mono }}>{c.telefono || 'Sin celular'}</span>
                            {c.ciudad && <span>{c.ciudad}</span>}
                            {c.contacto && <span>Contacto: {c.contacto}</span>}
                        </>} />
                    </div>
                    <div style={{ flex: '0 1 170px', fontSize: t.font.size.xs, color: t.color.textMuted, ...t.numericStyle }}>
                        <div style={{ color: t.color.text, fontSize: t.font.size.sm }}>Compró el {fmtFecha(c.fecha_primera_compra)}</div>
                        <div>Día {c.dias_desde_compra} · último: {ETAPA_BOT[c.etapa] || c.etapa}</div>
                    </div>
                    <div style={{ flex: '1 1 220px', display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                        {c.estado === 'toca' && (
                            <span style={{ fontSize: t.font.size.sm, color: t.color.text, ...t.numericStyle }}>
                                Le toca <strong>{ETAPA_BOT[c.toca_hoy]}</strong> · hasta el {fmtFecha(c.vence)}
                            </span>
                        )}
                        {c.motivo
                            ? <Badge tone={MOTIVO_TONO[c.motivo] || 'muted'}>{c.motivo_texto}</Badge>
                            : <Badge tone={c.estado === 'cerrado' ? 'muted' : 'success'}>{c.estado === 'cerrado' ? 'Cadencia terminada' : 'Al día'}</Badge>}
                        {c.ultimo_recibido && (
                            <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, ...t.numericStyle }}>
                                Última respuesta: {fmtFechaHora(c.ultimo_recibido)}
                            </span>
                        )}
                    </div>
                </Fila>
            ))}
        </>
    );
}

function Actividad({ actividad, onAbrir, t }) {
    if (!actividad.length) return <Vacio texto="El bot no registró nada en este período." t={t} />;
    return actividad.map((a, i) => {
        const recibido = a.tipo === 'recibido';
        const estado = a.envio_de_etapa ? ESTADO_ENVIO[a.estado] : null;
        return (
            <Fila key={a.id} t={t} last={i === actividad.length - 1}>
                <span style={{
                    width: 32, height: 32, borderRadius: t.radius.full, flexShrink: 0,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    background: recibido ? t.color.accentSoft : t.color.primarySoft,
                    color: recibido ? t.color.accent : t.color.primary,
                }} title={recibido ? 'Mensaje del cliente' : 'Mensaje del bot'}>
                    {recibido ? <Icon.MessageCircle size={16} /> : <Icon.Bot size={16} />}
                </span>
                <div style={{ flex: '1 1 300px', minWidth: 0 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: t.space[2] }}>
                        <Nombre id={a.cliente_id} nombre={a.cliente} onAbrir={onAbrir} t={t} />
                        <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, ...t.numericStyle }}>
                            {recibido ? 'contestó' : 'bot'} · {fmtFechaHora(a.fecha)}
                        </span>
                        {a.etapa && <Badge tone="muted">{ETAPA_BOT[a.etapa] || a.etapa}</Badge>}
                        {estado && <Badge tone={estado.tone}>{estado.label}</Badge>}
                        {a.motivo_cancelacion && (
                            <span style={{ fontSize: t.font.size.xs, color: t.color.danger }}>
                                {MOTIVO_CANCELACION[a.motivo_cancelacion] || a.motivo_cancelacion}
                            </span>
                        )}
                    </div>
                    <Mensaje texto={a.mensaje} t={t} />
                    {a.productos.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: t.space[2], marginTop: 6 }}>
                            {a.productos.map((p) => (
                                <span key={p.id} style={{
                                    fontSize: t.font.size.xs, border: `1px solid ${t.color.border}`, borderRadius: t.radius.sm,
                                    padding: '3px 8px', color: t.color.text, display: 'inline-flex', flexDirection: 'column',
                                }}>
                                    {p.nombre}
                                    {p.sku && <span style={{ fontFamily: t.font.mono, color: t.color.textMuted }}>{p.sku}</span>}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            </Fila>
        );
    });
}

function Contactos({ contactos, onAbrir, t }) {
    if (!contactos.length) return <Vacio texto="El bot todavía no registró ningún contacto." t={t} />;
    return contactos.map((c, i) => (
        <Fila key={c.cliente_id} t={t} last={i === contactos.length - 1}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <Nombre id={c.cliente_id} nombre={c.cliente} onAbrir={onAbrir} t={t} sub={<>
                    {c.telefono && <span style={{ fontFamily: t.font.mono }}>{c.telefono}</span>}
                    {c.contacto && <span>Contacto: <strong style={{ color: t.color.text }}>{c.contacto}</strong></span>}
                </>} />
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: t.space[2], marginTop: 6 }}>
                    <Badge tone={c.etapa === 'pendiente' ? 'muted' : 'primary'}>{ETAPA_BOT[c.etapa] || c.etapa}</Badge>
                    {c.no_contactar && <Badge tone="danger">No contactar desde {fmtFecha(c.no_contactar_at)}</Badge>}
                </div>
            </div>
            <div style={{ flex: '0 1 190px', fontSize: t.font.size.xs, color: t.color.textMuted, display: 'flex', flexDirection: 'column', gap: 2, ...t.numericStyle }}>
                <span>Mensajes enviados: <strong style={{ color: t.color.text }}>{fmtInt(c.enviados)}</strong></span>
                <span>Último contacto: {c.ultimo_contacto ? fmtFechaHora(c.ultimo_contacto) : '—'}</span>
                <span>Próximo mensaje: {c.proxima_accion ? fmtFecha(c.proxima_accion) : '—'}</span>
            </div>
            <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                {c.ultima_respuesta ? (
                    <>
                        <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, ...t.numericStyle }}>
                            Última respuesta · {fmtFechaHora(c.ultima_respuesta_fecha)}
                        </span>
                        <Mensaje texto={c.ultima_respuesta} t={t} />
                    </>
                ) : (
                    <span style={{ fontSize: t.font.size.xs, color: t.color.textFaint }}>Sin respuestas</span>
                )}
            </div>
        </Fila>
    ));
}

function Rechazos({ rechazos, onAbrir, t }) {
    if (!rechazos.length) return <Vacio texto="La API no rechazó ningún pedido del bot en este período." t={t} />;
    return rechazos.map((r, i) => (
        <Fila key={r.id} t={t} last={i === rechazos.length - 1}>
            <div style={{ flex: '0 1 130px', fontSize: t.font.size.xs, color: t.color.textMuted, ...t.numericStyle }}>{fmtFechaHora(r.fecha)}</div>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <div style={{ fontSize: t.font.size.sm, color: t.color.text }}>{r.accion}</div>
                <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, display: 'flex', flexWrap: 'wrap', gap: '0 8px' }}>
                    {r.cliente_id && <Nombre id={r.cliente_id} nombre={r.cliente} onAbrir={onAbrir} t={t} />}
                    {r.id_externo && <span style={{ fontFamily: t.font.mono }}>{r.id_externo}</span>}
                </div>
            </div>
            <div style={{ flex: '1 1 220px', display: 'flex', alignItems: 'center', gap: t.space[2], flexWrap: 'wrap' }}>
                <Badge tone={r.status >= 500 ? 'danger' : 'warn'}>{r.motivo}</Badge>
                <span style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textFaint }}>
                    {r.status}{r.codigo ? ` · ${r.codigo}` : ''}
                </span>
            </div>
        </Fila>
    ));
}

function Feedback({ feedback, t }) {
    if (!feedback.length) return <Vacio texto="El bot no dejó feedback." t={t} />;
    return feedback.map((f, i) => (
        <Fila key={f.id} t={t} last={i === feedback.length - 1}>
            <div style={{ flex: '0 1 130px', display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                <Badge tone={FEEDBACK_TONO[f.tipo] || 'muted'}>{FEEDBACK_LABEL[f.tipo] || f.tipo}</Badge>
                <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, ...t.numericStyle }}>{fmtFechaHora(f.fecha)}</span>
            </div>
            <div style={{ flex: '1 1 300px', minWidth: 0 }}>
                {f.endpoint && <div style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textMuted }}>{f.endpoint}</div>}
                <div style={{ fontSize: t.font.size.sm, color: t.color.text, whiteSpace: 'pre-wrap' }}>{f.mensaje}</div>
            </div>
        </Fila>
    ));
}

export default function BotSeguimiento() {
    const { tokens: t } = useTheme();
    const isMobile = useIsMobile();
    const [dias, setDias] = useState('7');
    const [vista, setVista] = useState('hoy');
    const [data, setData] = useState(null);
    const [cargando, setCargando] = useState(true);
    const [error, setError] = useState(null);
    const [abierto, setAbierto] = useState(null);

    const cargar = useCallback(async (refresh = false) => {
        const res = await api.get(`/clientes/bot?dias=${dias}${refresh ? '&refresh=1' : ''}`);
        if (res.success) { setData(res.data); setError(null); } else setError(res.error || 'No se pudo leer la actividad del bot');
        setCargando(false);
    }, [dias]);

    useEffect(() => {
        setCargando(true);
        cargar();
        // Se actualiza solo mientras la pestaña está abierta
        const id = setInterval(() => cargar(), REFRESCO_MS);
        return () => clearInterval(id);
    }, [cargar]);

    const actualizar = async () => { setCargando(true); await cargar(true); };

    return (
        <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: t.space[4], flexWrap: 'wrap', marginBottom: t.space[4] }}>
                <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, maxWidth: 640 }}>
                    Lo que hace el bot de WhatsApp con los clientes nuevos (mensajes de los días 1, 7 y 15). Se actualiza solo cada minuto.
                </div>
                <div style={{ display: 'flex', gap: t.space[3], alignItems: 'center', flexWrap: 'wrap' }}>
                    <Select value={dias} onChange={setDias} options={PERIODOS} style={{ width: isMobile ? 170 : 190 }} />
                    <Button variant="secondary" leftIcon={<Icon.Refresh size={16} />} disabled={cargando} onClick={actualizar}>
                        {cargando ? 'Actualizando…' : 'Actualizar'}
                    </Button>
                </div>
            </div>

            {error && (
                <Card style={{ marginBottom: t.space[4], color: t.color.danger, fontSize: t.font.size.sm }}>{error}</Card>
            )}

            {!data && cargando && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: t.space[16] }}><LoadingSpinner /></div>
            )}

            {data && (
                <>
                    <Resumen r={data.resumen} isMobile={isMobile} t={t} />
                    <Tabs
                        value={vista}
                        onChange={setVista}
                        style={{ marginBottom: t.space[4], overflowX: 'auto' }}
                        tabs={[
                            { value: 'hoy', label: 'Para hoy', icon: <Icon.Bell size={16} />, count: data.resumen.toca_hoy },
                            { value: 'actividad', label: 'Mensajes', icon: <Icon.MessageCircle size={16} />, count: data.actividad.length },
                            { value: 'contactos', label: 'Contactos', icon: <Icon.Users size={16} />, count: data.contactos.length },
                            { value: 'rechazos', label: 'Rechazos', icon: <Icon.X size={16} />, count: data.rechazos.length },
                            { value: 'feedback', label: 'Feedback', icon: <Icon.FileText size={16} />, count: data.feedback.length },
                        ]}
                    />
                    <Card padding={false}>
                        {vista === 'hoy' && <ParaHoy cola={data.cola} error={data.cola_error} meta={data.meta} onAbrir={setAbierto} t={t} />}
                        {vista === 'actividad' && <Actividad actividad={data.actividad} onAbrir={setAbierto} t={t} />}
                        {vista === 'contactos' && <Contactos contactos={data.contactos} onAbrir={setAbierto} t={t} />}
                        {vista === 'rechazos' && <Rechazos rechazos={data.rechazos} onAbrir={setAbierto} t={t} />}
                        {vista === 'feedback' && <Feedback feedback={data.feedback} t={t} />}
                    </Card>
                </>
            )}

            <ClienteFicha partnerId={abierto?.odoo_partner_id} resumen={abierto} onClose={() => setAbierto(null)} />
        </>
    );
}
