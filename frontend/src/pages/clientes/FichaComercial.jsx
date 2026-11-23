import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { fmtAR } from '../../theme/tokens';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Modal from '../../components/common/Modal';
import * as Icon from '../../components/common/icons';
import { linkWhatsApp, mensajePresentacion } from './clientesUi';
import { haceCuanto } from './etapasWhatsappUi';

// Ficha comercial del prospecto (067): resumen para vender, objetivos de nutrición (Presentar,
// Conocer e Informar), la charla de los últimos 7 días con buscador, lo que pidió (anotado a mano) y la
// cotización en borrador en Odoo. Va dentro de LeadFicha.

const CAMPOS = [
    { id: 'ciudad', label: 'Ciudad', max: 120 },
    { id: 'rubro', label: 'Rubro (tipo de negocio)', max: 120 },
    { id: 'intereses', label: 'Le interesa', max: 300 },
    { id: 'proveedor_actual', label: 'Hoy le compra a', max: 200 },
    { id: 'trabas', label: 'Lo frena', max: 300 },
    { id: 'volumen', label: 'Cuánto y cada cuánto compra', max: 200 },
    { id: 'compromisos', label: 'Le prometimos', max: 300 },
];
const LOCAL = [
    { value: '', label: 'No sabemos' },
    { value: 'local', label: 'Tiene local' },
    { value: 'online', label: 'Vende online' },
    { value: 'los_dos', label: 'Local y online' },
];
const FUENTE_INFORMADO = { manual: 'lo marcó una persona', chat: 'se lo mandamos por el chat', bot: 'se lo mandó Grok' };
const FUENTE_PRESENTACION = { app: 'se la mandamos desde la app', chat: 'se la mandamos por el chat', bot: 'se la mandó Grok', manual: 'lo marcó una persona' };

export default function FichaComercial({ leadId, telefono, t, onCambio, sinCharla = false }) {
    const { showToast } = useToast();
    const [datos, setDatos] = useState(null);
    const [error, setError] = useState(null);
    const [cotizando, setCotizando] = useState(false);

    const cargar = useCallback(async () => {
        const res = await api.get(`/clientes/leads/${leadId}/ficha`);
        if (!res.success) { setError(res.error || 'No se pudo cargar la ficha'); return; }
        setError(null);
        setDatos(res.data);
    }, [leadId]);
    useEffect(() => { setDatos(null); cargar(); }, [cargar]);

    const cambio = () => { cargar(); onCambio?.(); };

    if (error) return <div style={{ fontSize: t.font.size.sm, color: t.color.danger }}>{error}</div>;
    if (!datos) return <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>Cargando la ficha…</div>;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[10] }}>
            <Objetivos datos={datos} leadId={leadId} telefono={telefono} t={t} showToast={showToast} onCambio={cambio} />
            <Resumen datos={datos} leadId={leadId} t={t} showToast={showToast} onCambio={cambio} />
            <Pedido datos={datos} leadId={leadId} t={t} showToast={showToast} onCambio={cambio} onCotizar={() => setCotizando(true)} />
            {!sinCharla && <Charla datos={datos} leadId={leadId} t={t} showToast={showToast} onCambio={cambio} />}
            {cotizando && (
                <Cotizar leadId={leadId} datos={datos} t={t} showToast={showToast}
                    onClose={() => setCotizando(false)} onHecho={() => { setCotizando(false); cambio(); }} />
            )}
        </div>
    );
}

function Titulo({ t, children, extra }) {
    return (
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: t.space[4], flexWrap: 'wrap' }}>
            <h3 style={{
                margin: 0, fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, color: t.color.textMuted,
                textTransform: 'uppercase', letterSpacing: '0.06em',
            }}>{children}</h3>
            {extra}
        </div>
    );
}

function Tilde({ t, hecho, actual }) {
    return (
        <span aria-hidden="true" style={{
            flex: 'none', width: 20, height: 20, borderRadius: t.radius.full, boxSizing: 'border-box', marginTop: 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: hecho ? t.color.success : 'transparent', color: '#fff',
            border: hecho ? 'none' : `2px solid ${actual ? t.color.accent : t.color.borderStrong}`,
        }}>
            {hecho && <Icon.Check size={12} />}
        </span>
    );
}

async function copiar(texto, showToast, aviso) {
    try {
        await navigator.clipboard.writeText(texto);
        showToast(aviso, 'success');
        return true;
    } catch {
        showToast('No se pudo copiar: seleccioná el texto a mano', 'error');
        return false;
    }
}

// ── Objetivos de nutrición ─────────────────────────────────────────────────────────────────

function Objetivos({ datos, leadId, telefono, t, showToast, onCambio }) {
    const o = datos.objetivos;
    const sig = o.siguiente;
    const marcar = async (r, hecho) => {
        const res = await api.put(`/clientes/leads/${leadId}/informado/${r.id}`, { hecho });
        if (!res.success) { showToast(res.error || 'No se pudo marcar', 'error'); return; }
        onCambio();
    };
    const mandar = async (r) => {
        const wa = telefono ? linkWhatsApp(telefono, r.respuesta) : null;
        if (wa) window.open(wa, '_blank', 'noopener');
        else if (!(await copiar(r.respuesta, showToast, 'Respuesta copiada: pegala en el chat'))) return;
        if (!r.hecho) marcar(r, true);
    };
    // Presentación (nota 227): abre WhatsApp con el mensaje (o lo copia) y la anota, igual que en Posibles clientes
    const [presentando, setPresentando] = useState(false);
    const presentar = async () => {
        const texto = mensajePresentacion(datos.lead?.nombre_saludo);
        const wa = telefono ? linkWhatsApp(telefono, texto) : null;
        if (wa) window.open(wa, '_blank', 'noopener');
        else if (!(await copiar(texto, showToast, 'Presentación copiada: pegala en el chat'))) return;
        setPresentando(true);
        const res = await api.post(`/clientes/seguimiento/lead/${leadId}/presentacion`, {});
        setPresentando(false);
        if (!res.success) { showToast(res.error || 'No se pudo anotar la presentación', 'error'); return; }
        onCambio();
    };
    // Tilde a mano (nota 233): ya tiene la presentación sin mandarla desde la app. Solo se destilda
    // lo que marcó una persona; lo que mandó Grok o se vio en el chat queda.
    const tildarPresentacion = async (p) => {
        setPresentando(true);
        const res = await api.put(`/clientes/leads/${leadId}/presentacion`, { hecho: !p.hecho });
        setPresentando(false);
        if (!res.success) { showToast(res.error || 'No se pudo marcar la presentación', 'error'); return; }
        onCambio();
    };

    return (
        <section style={{ display: 'flex', flexDirection: 'column', gap: t.space[4] }}>
            <Titulo t={t} extra={(
                <span style={{ display: 'flex', gap: t.space[2], alignItems: 'center' }}>
                    {o.listo_para_precios && <Badge tone="success">Listo para precios</Badge>}
                    <span style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.text, fontVariantNumeric: 'tabular-nums' }}>
                        {o.hechos} de {o.total}
                    </span>
                </span>
            )}>Objetivos de nutrición</Titulo>

            <Grupo t={t} titulo="Presentar" ayuda="Lo primero: que sepa quiénes somos">
                {(o.presentar || []).map((p) => {
                    const actual = sig && sig.grupo === 'presentar' && sig.id === p.id;
                    const tildable = !p.hecho || p.fuente === 'manual';
                    return (
                        <Fila key={p.id} t={t} actual={actual}>
                            {tildable ? (
                                <button type="button" onClick={() => tildarPresentacion(p)} disabled={presentando}
                                    aria-label={p.hecho ? `Destildar ${p.titulo}` : `Tildar ${p.titulo}: ya la tiene`}
                                    title={p.hecho ? 'Destildar' : 'Ya la tiene: tildar sin mandarla'}
                                    style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', display: 'flex' }}>
                                    <Tilde t={t} hecho={p.hecho} actual={actual} />
                                </button>
                            ) : <Tilde t={t} hecho={p.hecho} actual={actual} />}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                                <span style={{ fontWeight: t.font.weight.semibold, color: t.color.text }}>{p.titulo}</span>
                                <span style={{ color: t.color.textMuted }}>{p.ayuda}</span>
                                {p.hecho && (
                                    <span style={{ fontSize: t.font.size.xs, color: t.color.success }}>
                                        Ya se presentó: {FUENTE_PRESENTACION[p.fuente] || 'anotada'}{p.fecha ? ` (${haceCuanto(p.fecha)})` : ''}
                                    </span>
                                )}
                            </div>
                            {!p.hecho && (
                                <Button size="sm" variant={actual ? 'primary' : 'ghost'} leftIcon={<Icon.MessageCircle size={14} />} disabled={presentando} onClick={presentar}>
                                    {telefono ? 'Mandar' : 'Copiar'}
                                </Button>
                            )}
                        </Fila>
                    );
                })}
                {!telefono && (o.presentar || []).some((p) => !p.hecho) && (
                    <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>Sin teléfono: “Copiar” copia la presentación para pegarla en el chat de WhatsApp Web, y la anota.</span>
                )}
                {(o.presentar || []).some((p) => !p.hecho) && (
                    <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>¿Ya la tiene? Tocá el círculo para tildarla sin mandársela. Así Grok tampoco se la manda.</span>
                )}
            </Grupo>

            <Grupo t={t} titulo="Conocer" ayuda="Lo que tenemos que saber de él">
                {o.conocer.map((c) => {
                    const actual = sig && sig.grupo === 'conocer' && sig.id === c.id;
                    return (
                        <Fila key={c.id} t={t} actual={actual}>
                            <Tilde t={t} hecho={c.hecho} actual={actual} />
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                                <span style={{ fontWeight: t.font.weight.semibold, color: t.color.text }}>{c.titulo}</span>
                                {c.hecho
                                    ? <span style={{ color: t.color.text }}>{c.valor}</span>
                                    : <span style={{ color: t.color.textMuted }}>Preguntale: “{c.pregunta}”</span>}
                            </div>
                            {!c.hecho && (
                                <Button size="sm" variant="ghost" onClick={() => copiar(c.pregunta, showToast, 'Pregunta copiada')}>Copiar</Button>
                            )}
                        </Fila>
                    );
                })}
                <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>Se completan con los datos del resumen (abajo): cargalos a mano o los deja Claude cada noche.</span>
            </Grupo>

            <Grupo t={t} titulo="Informar" ayuda="Lo que tiene que saber de nosotros (Preguntas frecuentes marcadas “Contárselo a todos”)">
                {o.informar.length === 0 && (
                    <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>
                        No hay preguntas frecuentes marcadas “Contárselo a todos” con respuesta. Cargalas en la pestaña Preguntas frecuentes.
                    </span>
                )}
                {o.informar.map((r) => {
                    const actual = sig && sig.grupo === 'informar' && sig.id === r.id;
                    return (
                        <Fila key={r.id} t={t} actual={actual}>
                            <button type="button" onClick={() => marcar(r, !r.hecho)} aria-label={r.hecho ? `Destildar ${r.titulo}` : `Tildar ${r.titulo}`}
                                style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', display: 'flex' }}>
                                <Tilde t={t} hecho={r.hecho} actual={actual} />
                            </button>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                                <span style={{ fontWeight: t.font.weight.semibold, color: t.color.text }}>{r.titulo}</span>
                                <span style={{ color: t.color.textMuted, whiteSpace: 'pre-wrap', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{r.respuesta}</span>
                                {r.hecho && r.fuente && (
                                    <span style={{ fontSize: t.font.size.xs, color: t.color.success }}>
                                        Ya sabe: {FUENTE_INFORMADO[r.fuente] || r.fuente}{r.fecha ? ` (${haceCuanto(r.fecha)})` : ''}
                                    </span>
                                )}
                            </div>
                            <Button size="sm" variant={actual ? 'primary' : 'ghost'} leftIcon={<Icon.MessageCircle size={14} />} onClick={() => mandar(r)}>
                                {telefono ? 'Mandar' : 'Copiar'}
                            </Button>
                        </Fila>
                    );
                })}
                {!telefono && o.informar.length > 0 && (
                    <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>Sin teléfono: “Copiar” copia la respuesta para pegarla en el chat de WhatsApp Web, y la tilda.</span>
                )}
            </Grupo>
        </section>
    );
}

function Grupo({ t, titulo, ayuda, children }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[3], border: `1px solid ${t.color.border}`, borderRadius: t.radius.md, padding: t.space[6] }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontWeight: t.font.weight.semibold, fontSize: t.font.size.base, color: t.color.text }}>{titulo}</span>
                <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>{ayuda}</span>
            </div>
            {children}
        </div>
    );
}

function Fila({ t, actual, children }) {
    return (
        <div style={{
            display: 'flex', gap: t.space[4], alignItems: 'flex-start', fontSize: t.font.size.sm,
            padding: actual ? t.space[4] : `${t.space[2]}px 0`, borderRadius: t.radius.sm,
            background: actual ? t.color.accentSoft : 'transparent',
        }}>
            {children}
        </div>
    );
}

// ── Resumen para vender ────────────────────────────────────────────────────────────────────

function Resumen({ datos, leadId, t, showToast, onCambio }) {
    const p = datos.perfil || {};
    const [editando, setEditando] = useState(false);
    const [form, setForm] = useState({});
    const [guardando, setGuardando] = useState(false);

    const abrir = () => {
        const f = { resumen: p.resumen || '', tiene_local: p.tiene_local || '' };
        for (const c of CAMPOS) f[c.id] = p[c.id] || (c.id === 'ciudad' ? datos.lead.ciudad || '' : c.id === 'rubro' ? datos.lead.rubro || '' : '');
        setForm(f);
        setEditando(true);
    };
    const guardar = async () => {
        setGuardando(true);
        const res = await api.put(`/clientes/leads/${leadId}/perfil`, { ...form, tiene_local: form.tiene_local || null });
        setGuardando(false);
        if (!res.success) { showToast(res.error || 'No se pudo guardar', 'error'); return; }
        showToast('Guardado', 'success');
        setEditando(false);
        onCambio();
    };

    const quien = p.resumen_por === 'claude' ? 'Lo resumió Claude' : p.resumen_por === 'manual' ? 'Lo escribió una persona' : null;
    const valores = CAMPOS.map((c) => ({ ...c, valor: p[c.id] || (c.id === 'ciudad' ? datos.lead.ciudad : c.id === 'rubro' ? datos.lead.rubro : null) }));
    const local = LOCAL.find((l) => l.value === (p.tiene_local || ''));

    return (
        <section style={{ display: 'flex', flexDirection: 'column', gap: t.space[4] }}>
            <Titulo t={t} extra={!editando && <Button size="sm" variant="ghost" leftIcon={<Icon.Edit2 size={14} />} onClick={abrir}>Editar</Button>}>
                Resumen para vender
            </Titulo>
            {editando ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[4] }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: t.space[2] }}>
                        <span style={etiqueta(t)}>Resumen</span>
                        <textarea rows={4} maxLength={2000} value={form.resumen} onChange={(e) => setForm((f) => ({ ...f, resumen: e.target.value }))}
                            placeholder="Quién es, qué busca, cómo compra hoy, qué lo frena y en qué quedó la charla"
                            style={areaEstilo(t)} />
                    </label>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: t.space[4] }}>
                        {CAMPOS.map((c) => (
                            <label key={c.id} style={{ display: 'flex', flexDirection: 'column', gap: t.space[2] }}>
                                <span style={etiqueta(t)}>{c.label}</span>
                                <Input value={form[c.id]} maxLength={c.max} onChange={(e) => setForm((f) => ({ ...f, [c.id]: e.target.value }))} />
                            </label>
                        ))}
                        <label style={{ display: 'flex', flexDirection: 'column', gap: t.space[2] }}>
                            <span style={etiqueta(t)}>Local</span>
                            <select value={form.tiene_local} onChange={(e) => setForm((f) => ({ ...f, tiene_local: e.target.value }))}
                                style={{ height: t.layout.inputHeight, borderRadius: t.radius.sm, border: `1px solid ${t.color.borderStrong}`, background: t.color.surface, color: t.color.text, fontFamily: t.font.family, fontSize: t.font.size.base, padding: '0 8px' }}>
                                {LOCAL.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                            </select>
                        </label>
                    </div>
                    <div style={{ display: 'flex', gap: t.space[2], justifyContent: 'flex-end' }}>
                        <Button variant="ghost" onClick={() => setEditando(false)}>Cancelar</Button>
                        <Button variant="primary" disabled={guardando} onClick={guardar}>{guardando ? 'Guardando…' : 'Guardar'}</Button>
                    </div>
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[4] }}>
                    {p.resumen
                        ? <p style={{ margin: 0, fontSize: t.font.size.base, lineHeight: 1.5, color: t.color.text, whiteSpace: 'pre-wrap' }}>{p.resumen}</p>
                        : <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>Todavía no hay resumen. Lo arma Claude cada noche con la charla del día, o escribilo con “Editar”.</span>}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: `${t.space[3]}px ${t.space[6]}px` }}>
                        {[...valores, { id: 'local', label: 'Local', valor: p.tiene_local ? local?.label : null }].map((c) => (
                            <div key={c.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>{c.label}</span>
                                <span style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: c.valor ? t.color.text : t.color.warn }}>{c.valor || 'No sabemos'}</span>
                            </div>
                        ))}
                    </div>
                    {quien && (
                        <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>
                            {quien}{p.resumen_at ? ` ${haceCuanto(p.resumen_at)}` : ''}. El resumen queda aunque se borren los mensajes.
                        </span>
                    )}
                </div>
            )}
        </section>
    );
}

function etiqueta(t) {
    return { fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, color: t.color.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' };
}

function areaEstilo(t) {
    return {
        width: '100%', boxSizing: 'border-box', resize: 'vertical', padding: '10px 12px',
        border: `1px solid ${t.color.borderStrong}`, borderRadius: t.radius.sm,
        background: t.color.surface, color: t.color.text, fontFamily: t.font.family, fontSize: t.font.size.base, lineHeight: 1.45,
    };
}

// ── Charla de los últimos 7 días ───────────────────────────────────────────────────────────

function Charla({ datos, leadId, t, showToast, onCambio }) {
    const [q, setQ] = useState('');
    const mensajes = datos.charla.mensajes;
    const anotados = useMemo(() => new Set(datos.items.map((i) => i.mensaje_id).filter(Boolean)), [datos.items]);
    const filtro = q.trim().toLowerCase();
    const visibles = filtro ? mensajes.filter((m) => (m.texto || '').toLowerCase().includes(filtro)) : mensajes;

    const anotar = async (m) => {
        const res = await api.post(`/clientes/leads/${leadId}/pedido`, { texto: m.texto.slice(0, 300), chat: m.chat, mensaje_id: m.id });
        if (!res.success) { showToast(res.error || 'No se pudo anotar', 'error'); return; }
        showToast('Anotado en Lo que pidió: elegí el producto', 'success');
        onCambio();
    };

    let ultimoDia = null;
    return (
        <section style={{ display: 'flex', flexDirection: 'column', gap: t.space[4] }}>
            <Titulo t={t} extra={<span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>{mensajes.length} mensajes · se borran a los 7 días, el resumen queda</span>}>
                Charla de los últimos 7 días
            </Titulo>
            {mensajes.length > 0 && (
                <Input leftIcon={<Icon.Search size={16} />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar en la charla" aria-label="Buscar en la charla"
                    rightIcon={filtro ? <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, whiteSpace: 'nowrap' }}>{visibles.length} de {mensajes.length}</span> : null} />
            )}
            <div style={{
                maxHeight: 440, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: t.space[3],
                padding: t.space[6], background: t.color.surface2, borderRadius: t.radius.md,
            }}>
                {mensajes.length === 0 && (
                    <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, textAlign: 'center' }}>
                        No hay mensajes de los últimos 7 días en el WhatsApp del negocio.
                    </span>
                )}
                {filtro && visibles.length === 0 && mensajes.length > 0 && (
                    <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, textAlign: 'center' }}>Nada con “{q}” en la charla. Probá en el resumen.</span>
                )}
                {visibles.map((m) => {
                    const dia = m.fecha.slice(0, 10);
                    const sepa = dia !== ultimoDia;
                    ultimoDia = dia;
                    const nuestro = m.de === 'neggo';
                    return (
                        <div key={`${m.chat}-${m.id}`} style={{ display: 'contents' }}>
                            {sepa && (
                                <span style={{ alignSelf: 'center', fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, color: t.color.textMuted, padding: `${t.space[1]}px 0` }}>
                                    {new Date(m.fecha).toLocaleDateString('es-AR', { weekday: 'long', day: '2-digit', month: '2-digit' })}
                                </span>
                            )}
                            <div style={{
                                alignSelf: nuestro ? 'flex-end' : 'flex-start', maxWidth: '82%', display: 'flex', flexDirection: 'column', gap: 4,
                                padding: '8px 12px', background: nuestro ? t.color.primarySoft : t.color.surface,
                                border: nuestro ? 'none' : `1px solid ${t.color.border}`,
                                borderRadius: nuestro ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
                            }}>
                                <span style={{ fontSize: t.font.size.sm, color: m.texto ? t.color.text : t.color.textMuted, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                                    {m.texto ? <Resaltado texto={m.texto} q={filtro} t={t} /> : `[${m.tipo}]`}
                                </span>
                                <span style={{ display: 'flex', gap: t.space[3], alignItems: 'center', justifyContent: 'flex-end' }}>
                                    {!nuestro && m.texto && (anotados.has(m.id)
                                        ? <span style={{ fontSize: t.font.size.xs, color: t.color.success, fontWeight: t.font.weight.semibold }}>Anotado</span>
                                        : (
                                            <button type="button" onClick={() => anotar(m)} style={{
                                                fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, color: t.color.accent, cursor: 'pointer',
                                                background: 'transparent', border: `1px solid ${t.color.accent}`, borderRadius: t.radius.full, padding: '2px 8px', fontFamily: t.font.family,
                                            }}>+ Anotar pedido</button>
                                        ))}
                                    <span style={{ fontSize: 11, color: t.color.textMuted, fontVariantNumeric: 'tabular-nums' }}>
                                        {nuestro ? 'Neggo · ' : ''}{m.fecha.slice(11, 16)}
                                    </span>
                                </span>
                            </div>
                        </div>
                    );
                })}
            </div>
        </section>
    );
}

function Resaltado({ texto, q, t }) {
    if (!q) return texto;
    const partes = [];
    const low = texto.toLowerCase();
    let i = 0;
    let j;
    while ((j = low.indexOf(q, i)) !== -1) {
        if (j > i) partes.push(texto.slice(i, j));
        partes.push(<mark key={j} style={{ background: t.color.warnSoft, color: t.color.text, borderRadius: 3, padding: '0 1px' }}>{texto.slice(j, j + q.length)}</mark>);
        i = j + q.length;
    }
    if (i < texto.length) partes.push(texto.slice(i));
    return partes;
}

// ── Lo que pidió ───────────────────────────────────────────────────────────────────────────

function Pedido({ datos, leadId, t, showToast, onCambio, onCotizar }) {
    const [nuevo, setNuevo] = useState('');
    const [eligiendo, setEligiendo] = useState(null);
    const pendientes = datos.items.filter((i) => !i.cotizacion);
    const cotizables = pendientes.filter((i) => i.product_id).length;

    const agregar = async () => {
        const texto = nuevo.trim();
        if (!texto) return;
        const res = await api.post(`/clientes/leads/${leadId}/pedido`, { texto });
        if (!res.success) { showToast(res.error || 'No se pudo anotar', 'error'); return; }
        setNuevo('');
        setEligiendo(res.data.id);
        onCambio();
    };
    const cambiar = async (it, campos) => {
        const res = await api.put(`/clientes/leads/${leadId}/pedido/${it.id}`, campos);
        if (!res.success) { showToast(res.error || 'No se pudo guardar', 'error'); return; }
        onCambio();
    };
    const borrar = async (it) => {
        const res = await api.del(`/clientes/leads/${leadId}/pedido/${it.id}`);
        if (!res.success) { showToast(res.error || 'No se pudo borrar', 'error'); return; }
        onCambio();
    };

    return (
        <section style={{ display: 'flex', flexDirection: 'column', gap: t.space[4] }}>
            <Titulo t={t}>Lo que pidió</Titulo>
            {datos.items.length === 0 && (
                <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>Todavía nada. Tocá “+ Anotar pedido” en un mensaje de la charla, o escribilo acá abajo.</span>
            )}
            {datos.items.map((it) => (
                <div key={it.id} style={{ display: 'flex', flexDirection: 'column', gap: t.space[2], borderTop: `1px solid ${t.color.border}`, paddingTop: t.space[3] }}>
                    <div style={{ display: 'flex', gap: t.space[3], alignItems: 'center' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                            <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>“{it.texto}”</span>
                            {it.product_name
                                ? <span style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.text }}>{it.product_name}</span>
                                : <span style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.warn }}>Falta elegir el producto de Odoo</span>}
                        </div>
                        {it.cotizacion ? (
                            <Badge tone="success">{`En ${it.cotizacion.nombre || 'cotización'}`}</Badge>
                        ) : (
                            <>
                                <input type="number" min="0" step="1" aria-label={`Cantidad de ${it.texto}`} defaultValue={it.cantidad ?? ''} placeholder="Cant."
                                    onBlur={(e) => { const v = e.target.value; if (String(v) !== String(it.cantidad ?? '')) cambiar(it, { cantidad: v === '' ? null : v }); }}
                                    style={{ width: 72, height: 32, borderRadius: t.radius.sm, border: `1px solid ${t.color.borderStrong}`, padding: '0 8px', fontFamily: t.font.family, fontSize: t.font.size.sm, color: t.color.text, background: t.color.surface, fontVariantNumeric: 'tabular-nums' }} />
                                <Button size="sm" variant="ghost" onClick={() => setEligiendo(eligiendo === it.id ? null : it.id)}>{it.product_id ? 'Cambiar' : 'Elegir'}</Button>
                                <Button size="sm" variant="ghost" aria-label={`Borrar ${it.texto}`} onClick={() => borrar(it)}><Icon.Trash2 size={14} /></Button>
                            </>
                        )}
                    </div>
                    {eligiendo === it.id && !it.cotizacion && (
                        <ElegirProducto t={t} inicial={it.texto} onElegido={(p) => { setEligiendo(null); cambiar(it, { product_id: p.id }); }} />
                    )}
                </div>
            ))}
            <div style={{ display: 'flex', gap: t.space[2] }}>
                <Input style={{ flex: 1 }} value={nuevo} maxLength={300} placeholder="Anotar a mano: 12 vasos térmicos" aria-label="Anotar un pedido a mano"
                    onChange={(e) => setNuevo(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') agregar(); }} />
                <Button variant="secondary" leftIcon={<Icon.Plus size={16} />} onClick={agregar}>Anotar</Button>
            </div>
            {pendientes.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[2] }}>
                    <Button variant="accent" leftIcon={<Icon.ShoppingCart size={16} />} disabled={!cotizables} onClick={onCotizar}>
                        {cotizables ? `Crear cotización en Odoo (${cotizables})` : 'Elegí los productos para cotizar'}
                    </Button>
                    <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, lineHeight: 1.4 }}>
                        Queda en borrador en Odoo (Neggo) con los productos elegidos; el precio lo pone Odoo. No se le manda nada al cliente.
                    </span>
                </div>
            )}
            {datos.cotizaciones.length > 0 && (
                <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>
                    Cotizaciones creadas: {datos.cotizaciones.map((c) => c.nombre).filter(Boolean).join(', ')}
                </span>
            )}
        </section>
    );
}

function ElegirProducto({ t, inicial, onElegido }) {
    const [q, setQ] = useState(inicial.split(/\s+/).filter((w) => w.length >= 3).slice(0, 3).join(' '));
    const [res, setRes] = useState(null);
    useEffect(() => {
        let vivo = true;
        const term = q.trim();
        if (term.length < 2) { setRes([]); return undefined; }
        const id = setTimeout(async () => {
            const r = await api.get('/clientes/productos-neggo', { q: term });
            if (vivo) setRes(r.success ? r.data : []);
        }, 250);
        return () => { vivo = false; clearTimeout(id); };
    }, [q]);
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[2], background: t.color.surface2, borderRadius: t.radius.md, padding: t.space[4] }}>
            <Input autoFocus leftIcon={<Icon.Search size={16} />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar producto de Neggo (nombre o código)" aria-label="Buscar producto" />
            {res === null && <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>Buscando…</span>}
            {res && res.length === 0 && q.trim().length >= 2 && <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>No encontré productos activos con eso.</span>}
            {(res || []).map((p) => (
                <button key={p.id} type="button" onClick={() => onElegido(p)} style={{
                    display: 'flex', justifyContent: 'space-between', gap: t.space[3], alignItems: 'center', textAlign: 'left', cursor: 'pointer',
                    background: t.color.surface, border: `1px solid ${t.color.border}`, borderRadius: t.radius.sm, padding: '8px 10px', fontFamily: t.font.family,
                }}>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                        <span style={{ fontSize: t.font.size.sm, color: t.color.text }}>{p.nombre}</span>
                        {p.codigo && <span style={{ fontSize: t.font.size.xs, fontFamily: t.font.mono, color: t.color.textMuted }}>{p.codigo}</span>}
                    </span>
                    {p.precio_lista !== null && <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>${fmtAR(p.precio_lista)}</span>}
                </button>
            ))}
        </div>
    );
}

// ── Crear la cotización en Odoo ────────────────────────────────────────────────────────────

function Cotizar({ leadId, datos, t, showToast, onClose, onHecho }) {
    const [parecidos, setParecidos] = useState(null);
    const [error, setError] = useState(null);
    const [elegido, setElegido] = useState(null);
    const [creando, setCreando] = useState(false);
    const items = datos.items.filter((i) => !i.cotizacion && i.product_id);
    const nombre = datos.lead.nombre;

    useEffect(() => {
        api.get(`/clientes/leads/${leadId}/contactos-odoo`).then((res) => {
            if (!res.success) { setError(res.error || 'No se pudo buscar en Odoo'); setParecidos([]); return; }
            setParecidos(res.data || []);
            const mismo = (res.data || []).find((p) => p.mismo_telefono);
            setElegido(mismo ? mismo.id : (nombre ? 'nuevo' : null));
        });
    }, [leadId, nombre]);

    const crear = async () => {
        setCreando(true);
        const body = elegido === 'nuevo' ? { crear_contacto: true } : { cliente_id: elegido };
        const res = await api.post(`/clientes/leads/${leadId}/cotizar`, body);
        setCreando(false);
        if (!res.success) { showToast(res.error || 'No se pudo crear la cotización', 'error'); return; }
        showToast(`Cotización ${res.data.nombre || ''} creada en borrador en Odoo`, 'success');
        onHecho();
    };

    return (
        <Modal isOpen onClose={onClose} title="Crear cotización en Odoo" width={560}
            footer={(
                <>
                    <Button variant="ghost" onClick={onClose}>Cancelar</Button>
                    <Button variant="accent" disabled={!elegido || creando || !items.length} onClick={crear}>{creando ? 'Creando…' : 'Crear en borrador'}</Button>
                </>
            )}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[6], fontFamily: t.font.family, fontSize: t.font.size.sm, color: t.color.text }}>
                <div>
                    Se crea en <strong>Odoo (Neggo)</strong> una cotización en borrador con {items.length} producto{items.length === 1 ? '' : 's'}:
                    <ul style={{ margin: `${t.space[2]}px 0 0`, paddingLeft: 18 }}>
                        {items.map((i) => <li key={i.id}>{i.cantidad || 1} × {i.product_name}</li>)}
                    </ul>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[3] }}>
                    <span style={{ fontWeight: t.font.weight.semibold }}>¿A qué contacto de Odoo?</span>
                    {parecidos === null && <span style={{ color: t.color.textMuted }}>Buscando contactos parecidos en Odoo…</span>}
                    {error && <span style={{ color: t.color.danger }}>{error}</span>}
                    {(parecidos || []).map((p) => (
                        <Opcion key={p.id} t={t} checked={elegido === p.id} onChange={() => setElegido(p.id)}
                            titulo={p.nombre} detalle={[p.telefono, p.ciudad].filter(Boolean).join(' · ')}
                            badge={p.mismo_telefono ? 'Mismo teléfono' : null} />
                    ))}
                    {parecidos && parecidos.length === 0 && !error && <span style={{ color: t.color.textMuted }}>No hay contactos parecidos en Odoo.</span>}
                    <Opcion t={t} checked={elegido === 'nuevo'} disabled={!nombre} onChange={() => setElegido('nuevo')}
                        titulo={nombre ? `Crear contacto nuevo: ${nombre}` : 'Crear contacto nuevo (falta el nombre del prospecto)'}
                        detalle={datos.lead.telefono || 'sin teléfono'} />
                </div>
                <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, lineHeight: 1.4 }}>
                    El precio lo pone Odoo. No se le manda nada al cliente: revisala y mandala desde Odoo. Al estar en Odoo con su teléfono, en la próxima vuelta del cruce pasa a Clientes con todo su seguimiento.
                </span>
            </div>
        </Modal>
    );
}

function Opcion({ t, checked, onChange, titulo, detalle, badge, disabled }) {
    return (
        <label style={{
            display: 'flex', gap: t.space[3], alignItems: 'flex-start', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1,
            border: `1px solid ${checked ? t.color.primary : t.color.border}`, borderRadius: t.radius.sm, padding: '8px 10px',
        }}>
            <input type="radio" name="contacto-odoo" checked={checked} disabled={disabled} onChange={onChange} style={{ marginTop: 3 }} />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
                <span style={{ fontWeight: t.font.weight.medium }}>{titulo}</span>
                {detalle && <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>{detalle}</span>}
            </span>
            {badge && <Badge tone="success">{badge}</Badge>}
        </label>
    );
}
