import { useCallback, useEffect, useState } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { fmtInt } from '../../theme/tokens';
import useIsMobile from '../../hooks/useIsMobile';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Tabs from '../../components/common/Tabs';
import LoadingSpinner from '../../components/common/LoadingSpinner';
import * as Icon from '../../components/common/icons';
import LeadFicha from './LeadFicha';
import { fmtFechaHora } from './clientesUi';

// Grok Bot con los posibles clientes (API /api/agente/leads): cuántos mensajes salieron hoy contra
// el tope, quién contestó y los últimos mensajes. Solo lectura: lo que hace el bot se cambia desde
// el bot. Solo entran los celulares de la zona (150 km de Pergamino) y nunca los de Churn.

const REFRESCO_MS = 60 * 1000;
const ETAPA = { presentacion: 'Presentación', recordatorio: 'Recordatorio', cierre: 'Cierre' };
const ESTADO_ENVIO = {
    enviado: { label: 'Salió', tone: 'success' },
    reservado: { label: 'Reservado', tone: 'primary' },
};

function Stat({ label, value, hint, color, t }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>{label}</span>
            <span style={{ fontSize: t.font.size['2xl'], fontWeight: t.font.weight.semibold, lineHeight: 1.1, color: color || t.color.text, ...t.numericStyle }}>
                {value}
            </span>
            {hint && <span style={{ fontSize: t.font.size.xs, color: t.color.textFaint }}>{hint}</span>}
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

function Nombre({ id, nombre, telefono, onAbrir, t }) {
    return (
        <div style={{ minWidth: 0 }}>
            <button type="button" onClick={() => onAbrir(id)} style={{
                background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left',
                fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.text, fontFamily: t.font.family,
            }}>
                {nombre || telefono || 'Sin nombre'}
            </button>
            {nombre && telefono && (
                <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.mono }}>{telefono}</div>
            )}
        </div>
    );
}

function Mensajes({ ultimos, onAbrir, t }) {
    if (!ultimos.length) return <Vacio texto="Grok todavía no les escribió a posibles clientes." t={t} />;
    return ultimos.map((m, i) => (
        <Fila key={m.id} t={t} last={i === ultimos.length - 1}>
            <div style={{ flex: '0 1 200px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Nombre id={m.lead_id} nombre={m.nombre} telefono={m.telefono} onAbrir={onAbrir} t={t} />
                <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, ...t.numericStyle }}>{fmtFechaHora(m.fecha)}</span>
            </div>
            <div style={{ flex: '1 1 300px', minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {m.tipo === 'recibido'
                        ? <Badge tone="accent">Contestó</Badge>
                        : <Badge tone={m.envio_de_etapa ? 'primary' : 'muted'}>{m.envio_de_etapa ? ETAPA[m.etapa] || m.etapa : 'Charla'}</Badge>}
                    {m.envio_de_etapa && ESTADO_ENVIO[m.estado] && <Badge tone={ESTADO_ENVIO[m.estado].tone}>{ESTADO_ENVIO[m.estado].label}</Badge>}
                </div>
                <div style={{
                    fontSize: t.font.size.sm, color: t.color.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    background: t.color.surface2, borderRadius: t.radius.md, padding: '8px 10px', marginTop: 6,
                }}>
                    {m.mensaje}
                </div>
            </div>
        </Fila>
    ));
}

function Respuestas({ lista, onAbrir, t }) {
    if (!lista.length) return <Vacio texto="No hay respuestas sin atender." t={t} />;
    return lista.map((r, i) => (
        <Fila key={r.id} t={t} last={i === lista.length - 1}>
            <div style={{ flex: '1 1 200px' }}><Nombre id={r.id} nombre={r.nombre} telefono={r.telefono} onAbrir={onAbrir} t={t} /></div>
            <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, ...t.numericStyle }}>Contestó {fmtFechaHora(r.ultimo_recibido)}</span>
        </Fila>
    ));
}

function Zona({ r, t }) {
    const filas = Object.entries(r.por_localidad || {}).sort((a, b) => b[1] - a[1]);
    return (
        <>
            <div style={{ padding: `${t.space[4]}px ${t.space[6]}px`, fontSize: t.font.size.xs, color: t.color.textMuted, borderBottom: `1px solid ${t.color.border}` }}>
                Solo se les escribe a los celulares de estas localidades (las características están en backend/config/leadsZona.json).
                Quedan afuera {fmtInt(r.excluidos.fuera_de_zona)} de otras zonas y {fmtInt(r.excluidos.churn)} en Churn.
            </div>
            {filas.map(([loc, n], i) => (
                <Fila key={loc} t={t} last={i === filas.length - 1}>
                    <span style={{ flex: 1, fontSize: t.font.size.sm, color: t.color.text }}>{loc}</span>
                    <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, ...t.numericStyle }}>{fmtInt(n)}</span>
                </Fila>
            ))}
        </>
    );
}

export default function BotLeads() {
    const { tokens: t } = useTheme();
    const isMobile = useIsMobile();
    const [data, setData] = useState(null);
    const [vista, setVista] = useState('mensajes');
    const [cargando, setCargando] = useState(true);
    const [error, setError] = useState(null);
    const [abierto, setAbierto] = useState(null);

    const cargar = useCallback(async () => {
        const res = await api.get('/clientes/leads/bot');
        if (res.success) { setData(res.data); setError(null); } else setError(res.error || 'No se pudo leer la actividad del bot');
        setCargando(false);
    }, []);

    useEffect(() => {
        cargar();
        // Se actualiza solo mientras la pestaña está abierta
        const id = setInterval(cargar, REFRESCO_MS);
        return () => clearInterval(id);
    }, [cargar]);

    const m = data?.meta;
    const r = data?.por_resultado || {};

    return (
        <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: t.space[4], flexWrap: 'wrap', marginBottom: t.space[4] }}>
                <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, maxWidth: 680 }}>
                    Lo que hace el bot de WhatsApp con los posibles clientes: presentación, recordatorio a los 7 días y cierre a los 14.
                    Si contestan, la cadencia se frena y sigue la charla. Se actualiza solo cada minuto.
                </div>
                <Button variant="secondary" leftIcon={<Icon.Refresh size={16} />} disabled={cargando}
                    onClick={() => { setCargando(true); cargar(); }}>
                    {cargando ? 'Actualizando…' : 'Actualizar'}
                </Button>
            </div>

            {error && <Card style={{ marginBottom: t.space[4], color: t.color.danger, fontSize: t.font.size.sm }}>{error}</Card>}
            {!data && cargando && <div style={{ display: 'flex', justifyContent: 'center', padding: t.space[16] }}><LoadingSpinner /></div>}

            {data && (
                <>
                    <Card style={{
                        display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(5, minmax(0, 1fr))',
                        gap: t.space[6], marginBottom: t.space[6],
                    }}>
                        <Stat t={t} label="Hoy" value={`${fmtInt(m.enviados_hoy)} / ${fmtInt(m.tope_diario)}`}
                            hint={m.ventana_abierta ? `Quedan ${fmtInt(m.quedan_hoy)} · horario abierto` : `Cerrado, abre ${fmtFechaHora(m.abre_a)}`}
                            color={m.quedan_hoy ? t.color.text : t.color.success} />
                        <Stat t={t} label="En la cola de hoy" value={fmtInt(data.cola_hoy)} hint={`${fmtInt(data.en_zona)} posibles clientes en la zona`} />
                        <Stat t={t} label="Sin contactar" value={fmtInt(data.sin_contactar)} hint="Todavía sin presentación" />
                        <Stat t={t} label="Interesados" value={fmtInt(r.interesado || 0)} hint="Pasan a Templado con una acción en Mi día" color={r.interesado ? t.color.success : t.color.text} />
                        <Stat t={t} label="No quieren" value={fmtInt((r.no_interesado || 0) + (r.no_contactar || 0))}
                            hint={`${fmtInt(r.no_contactar || 0)} pidieron que no les escriban (pasan a Churn)`} />
                    </Card>
                    <Tabs
                        value={vista}
                        onChange={setVista}
                        style={{ marginBottom: t.space[4], overflowX: 'auto' }}
                        tabs={[
                            { value: 'mensajes', label: 'Mensajes', icon: <Icon.MessageCircle size={16} />, count: data.ultimos.length },
                            { value: 'respuestas', label: 'Respuestas sin atender', icon: <Icon.Bell size={16} />, count: data.respuestas_pendientes.length },
                            { value: 'zona', label: 'Zona', icon: <Icon.Users size={16} /> },
                        ]}
                    />
                    <Card padding={false}>
                        {vista === 'mensajes' && <Mensajes ultimos={data.ultimos} onAbrir={setAbierto} t={t} />}
                        {vista === 'respuestas' && <Respuestas lista={data.respuestas_pendientes} onAbrir={setAbierto} t={t} />}
                        {vista === 'zona' && <Zona r={data} t={t} />}
                    </Card>
                </>
            )}

            <LeadFicha leadId={abierto} onClose={() => setAbierto(null)} />
        </>
    );
}
