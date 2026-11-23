import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { useToast } from '../../context/ToastContext';
import { fmtInt } from '../../theme/tokens';
import useIsMobile from '../../hooks/useIsMobile';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import * as Icon from '../../components/common/icons';
import FichaComercial from './FichaComercial';
import LeadFicha from './LeadFicha';
import ClienteFicha from './ClienteFicha';
import { ETAPA_TONO } from './etapasWhatsappUi';
import { HEALTH_META, iniciales } from './clientesUi';
import GrupoAvisosModal, { BadgeGrupoAvisos, textoGrupoAvisos } from './GrupoAvisos';

// Chats del WhatsApp del negocio como en WhatsApp: a la izquierda la lista (el más reciente arriba),
// al tocar uno la conversación de los últimos 7 días, y tocando el nombre se despliega la ficha.
// Por defecto se ven los chats de los últimos 15 días; el buscador encuentra cualquiera.
// En el celular va una pantalla por vez: lista → conversación → ficha.
// La app NO manda mensajes por el WhatsApp del negocio: se responde en WhatsApp Web.

const FILTROS = [
    { id: 'todos', label: 'Todos' },
    { id: 'esperan', label: 'Esperan respuesta' },
    { id: 'prospecto', label: 'Prospectos' },
    { id: 'cliente', label: 'Clientes' },
    { id: 'dormidos', label: 'Sin conversación abierta' },
];
const PAGE = 60;
const REFRESCO_LISTA_MS = 60 * 1000;
const REFRESCO_CHAT_MS = 30 * 1000;
// Alto mínimo en compu: en pantallas más bajas scrollea la página entera
const ALTO_MIN_PX = 320;
// Aire entre el chat y el borde de abajo de la ventana (el mismo que usa la lista de Clientes)
const MARGEN_ABAJO = 16;

function horaLista(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const hoy = new Date();
    if (d.toDateString() === hoy.toDateString()) return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    const ayer = new Date(hoy.getTime() - 86400000);
    if (d.toDateString() === ayer.toDateString()) return 'Ayer';
    if (hoy.getTime() - d.getTime() < 6 * 86400000) return d.toLocaleDateString('es-AR', { weekday: 'short' });
    return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
}

// Chat sin teléfono (@lid): el número antes de "@lid" es lo que se pone en la lupa de WhatsApp Web
function codigoLid(c) {
    if (c?.numero) return null;
    const m = /^(\d+)@lid$/.exec(String(c?.chat || ''));
    return m ? m[1] : null;
}

function linkWhatsappWeb(c) {
    const d = String(c?.numero || '').replace(/\D/g, '');
    return d.length >= 10 ? `https://web.whatsapp.com/send?phone=${d}` : 'https://web.whatsapp.com/';
}

export default function Chats() {
    const { tokens: t } = useTheme();
    const { showToast } = useToast();
    const isMobile = useIsMobile();
    const [filtro, setFiltro] = useState('todos');
    const [q, setQ] = useState('');
    const [datos, setDatos] = useState(null);
    const [items, setItems] = useState([]);
    const [error, setError] = useState(null);
    const [cargando, setCargando] = useState(false);
    const [abierto, setAbierto] = useState(null);
    const [verFicha, setVerFicha] = useState(false);
    // Ancho real de la pantalla de chats: si no entran las tres columnas, la ficha se abre encima
    const caja = useRef(null);
    const [ancho, setAncho] = useState(1200);
    useEffect(() => {
        if (!caja.current || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(([e]) => setAncho(e.contentRect.width));
        ro.observe(caja.current);
        return () => ro.disconnect();
    }, []);
    const fichaEncima = !isMobile && ancho < 1180;
    const compacto = isMobile || ancho < 900;
    // En el celular: 'lista' | 'chat' | 'ficha'
    const [panel, setPanel] = useState('lista');
    const [fichaCompleta, setFichaCompleta] = useState(null);
    const [version, setVersion] = useState(0);
    const [verGrupoAvisos, setVerGrupoAvisos] = useState(false);

    const cargar = useCallback(async (offset = 0, silencio = false) => {
        if (!silencio) setCargando(true);
        const res = await api.get('/clientes/chats', { filtro, q: q.trim(), limit: PAGE, offset });
        setCargando(false);
        if (!res.success) { if (!silencio) setError(res.error || 'No se pudieron cargar los chats'); return; }
        setError(null);
        setDatos(res.data);
        setItems((prev) => (offset ? [...prev, ...res.data.items] : res.data.items));
    }, [filtro, q]);

    useEffect(() => {
        const id = setTimeout(() => cargar(0), q ? 350 : 0);
        return () => clearTimeout(id);
    }, [cargar, q]);
    useEffect(() => {
        const id = setInterval(() => cargar(0, true), REFRESCO_LISTA_MS);
        return () => clearInterval(id);
    }, [cargar]);

    const abrir = (c) => {
        setAbierto(c);
        if (isMobile) setPanel('chat');
    };
    const tocarNombre = () => {
        if (isMobile) setPanel('ficha');
        else setVerFicha((v) => !v);
    };

    // En compu ocupa todo lo que queda de la ventana debajo de las pestañas, hasta MARGEN_ABAJO del
    // borde, así no scrollea la página (nota #223; Clientes recorta el aire de abajo del <main>).
    // Se mide contra la ventana: el <main> crece con el contenido y medir contra él hacía un círculo.
    const [altoPx, setAltoPx] = useState(null);
    const medirAlto = useCallback(() => {
        if (isMobile || !caja.current) { setAltoPx(null); return; }
        const main = caja.current.closest('[data-app-main]');
        const top = caja.current.getBoundingClientRect().top + window.scrollY + (main?.scrollTop || 0);
        const px = Math.max(ALTO_MIN_PX, Math.floor(window.innerHeight - top - MARGEN_ABAJO));
        setAltoPx((prev) => (prev != null && Math.abs(prev - px) <= 1 ? prev : px));
    }, [isMobile]);
    useLayoutEffect(() => { medirAlto(); });
    useEffect(() => {
        window.addEventListener('resize', medirAlto);
        return () => window.removeEventListener('resize', medirAlto);
    }, [medirAlto]);
    const alto = isMobile ? 'calc(100dvh - 170px)' : (altoPx ?? 'calc(100vh - 230px)');
    const verLista = !isMobile || panel === 'lista';
    const verChat = !isMobile || panel === 'chat';
    const verPanelFicha = abierto && (isMobile ? panel === 'ficha' : verFicha);

    return (
        <div ref={caja} style={{
            position: 'relative', display: 'flex', height: alto, minHeight: isMobile ? 480 : ALTO_MIN_PX, boxSizing: 'border-box', fontFamily: t.font.family, color: t.color.text,
            background: t.color.surface, border: `1px solid ${t.color.border}`, borderRadius: t.radius.lg, overflow: 'hidden',
        }}>
            {verLista && (
                <Lista t={t} isMobile={isMobile} filtro={filtro} setFiltro={setFiltro} q={q} setQ={setQ}
                    datos={datos} items={items} error={error} cargando={cargando} abierto={abierto}
                    onAbrir={abrir} onMas={() => cargar(items.length)} onGrupoAvisos={() => setVerGrupoAvisos(true)} />
            )}
            {verChat && (
                <Conversacion t={t} isMobile={isMobile} compacto={compacto} contacto={abierto} showToast={showToast}
                    onVolver={() => setPanel('lista')} onNombre={tocarNombre} fichaAbierta={verPanelFicha}
                    onAnotado={() => setVersion((v) => v + 1)} />
            )}
            {verPanelFicha && (
                <PanelFicha t={t} showToast={showToast} isMobile={isMobile} encima={fichaEncima} contacto={abierto} version={version}
                    onCerrar={() => (isMobile ? setPanel('chat') : setVerFicha(false))}
                    onCompleta={() => setFichaCompleta(abierto)} onCambio={() => cargar(0, true)}
                    onRenombrado={(r) => {
                        const cambio = (c) => (c && c.clave === abierto.clave ? { ...c, nombre: r.nombre, nombre_whatsapp: r.nombre_whatsapp } : c);
                        setAbierto(cambio);
                        setItems((prev) => prev.map(cambio));
                    }} />
            )}
            {fichaCompleta?.tipo === 'prospecto' && (
                <LeadFicha leadId={fichaCompleta.id} resumen={{ id: fichaCompleta.id, name: fichaCompleta.nombre, phone: fichaCompleta.numero }}
                    onClose={() => { setFichaCompleta(null); setVersion((v) => v + 1); cargar(0, true); }} onCambio={() => {}} />
            )}
            {fichaCompleta?.tipo === 'cliente' && (
                <ClienteFicha partnerId={fichaCompleta.id} resumen={{ odoo_partner_id: fichaCompleta.id, partner_name: fichaCompleta.nombre }}
                    onClose={() => setFichaCompleta(null)} onCambio={() => {}} />
            )}
            <GrupoAvisosModal t={t} open={verGrupoAvisos} onClose={() => setVerGrupoAvisos(false)} showToast={showToast}
                onActualizado={() => cargar(0, true)} />
        </div>
    );
}

function Avatar({ t, c, tam = 46 }) {
    const cliente = c?.tipo === 'cliente';
    return (
        <span aria-hidden="true" style={{
            flex: 'none', width: tam, height: tam, borderRadius: t.radius.full, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: t.font.weight.bold, fontSize: Math.round(tam / 2.8),
            background: c?.nombre ? (cliente ? t.color.successSoft : t.color.primarySoft) : t.color.surface2,
            color: c?.nombre ? (cliente ? t.color.success : t.color.primary) : t.color.textMuted,
        }}>{c?.nombre ? iniciales(c.nombre) : '?'}</span>
    );
}

function Etiquetas({ t, c }) {
    const cliente = c.tipo === 'cliente';
    const salud = cliente && c.health ? HEALTH_META[c.health] : null;
    return (
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <Badge tone={cliente ? 'success' : 'primary'}>{cliente ? 'Cliente' : 'Prospecto'}</Badge>
            {!cliente && c.etapa && <Badge tone={ETAPA_TONO[c.etapa.id] || 'muted'}>{c.etapa.label}</Badge>}
            {salud && <Badge tone={salud.tone}>{salud.label}</Badge>}
            <BadgeGrupoAvisos ga={c.grupo_avisos} />
        </span>
    );
}

// ── Lista de chats ─────────────────────────────────────────────────────────────────────────

function Lista({ t, isMobile, filtro, setFiltro, q, setQ, datos, items, error, cargando, abierto, onAbrir, onMas, onGrupoAvisos }) {
    return (
        <aside aria-label="Chats" style={{
            flex: isMobile ? '1 1 auto' : '0 0 360px', minWidth: 0, display: 'flex', flexDirection: 'column',
            borderRight: isMobile ? 'none' : `1px solid ${t.color.border}`,
        }}>
            <div style={{ padding: t.space[6], display: 'flex', flexDirection: 'column', gap: t.space[4], borderBottom: `1px solid ${t.color.border}` }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: t.space[2], height: 38, padding: '0 12px', borderRadius: t.radius.md, background: t.color.surface2, color: t.color.textMuted }}>
                    <Icon.Search size={16} />
                    <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar nombre, teléfono o mensaje" aria-label="Buscar chat"
                        style={{ border: 0, outline: 0, background: 'transparent', fontFamily: t.font.family, fontSize: t.font.size.sm, color: t.color.text, width: '100%' }} />
                </label>
                <div role="group" aria-label="Filtrar chats" style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
                    {FILTROS.map((f) => {
                        const on = filtro === f.id;
                        return (
                            <button key={f.id} type="button" aria-pressed={on} onClick={() => setFiltro(f.id)} style={{
                                flex: 'none', height: 30, padding: '0 12px', borderRadius: t.radius.full, cursor: 'pointer', fontFamily: t.font.family,
                                fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold,
                                border: on ? 'none' : `1px solid ${t.color.border}`, background: on ? t.color.primary : t.color.surface, color: on ? '#fff' : t.color.textMuted,
                            }}>{f.label}</button>
                        );
                    })}
                </div>
                {q.trim() && <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>Buscando en todos los chats, también los viejos.</span>}
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
                {error && <div style={{ padding: t.space[6], color: t.color.danger, fontSize: t.font.size.sm }}>{error}</div>}
                {!error && !cargando && items.length === 0 && (
                    <div style={{ padding: t.space[6], color: t.color.textMuted, fontSize: t.font.size.sm }}>
                        {q.trim() ? `No hay chats con “${q.trim()}”.` : 'No hay chats con este filtro.'}
                    </div>
                )}
                {items.map((c) => {
                    const on = abierto?.clave === c.clave;
                    return (
                        <button key={c.clave} type="button" onClick={() => onAbrir(c)} aria-current={on} style={{
                            width: '100%', display: 'flex', gap: t.space[4], alignItems: 'center', padding: `${t.space[4]}px ${t.space[6]}px`,
                            border: 0, borderBottom: `1px solid ${t.color.border}`, cursor: 'pointer', textAlign: 'left', fontFamily: t.font.family,
                            color: t.color.text, background: on ? t.color.primarySoft : t.color.surface,
                        }}>
                            <Avatar t={t} c={c} />
                            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                                <span style={{ display: 'flex', justifyContent: 'space-between', gap: t.space[2], alignItems: 'baseline' }}>
                                    <span style={{ fontWeight: t.font.weight.semibold, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.nombre || c.numero || codigoLid(c) || 'Sin nombre'}</span>
                                    <span style={{ flex: 'none', fontSize: 11, color: c.espera_respuesta ? t.color.accent : t.color.textMuted, fontWeight: c.espera_respuesta ? t.font.weight.bold : t.font.weight.regular }}>
                                        {horaLista(c.ultimo_mensaje_at)}
                                    </span>
                                </span>
                                <span style={{ display: 'flex', justifyContent: 'space-between', gap: t.space[2], alignItems: 'center' }}>
                                    <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                        {c.preview ? `${c.preview.de === 'neggo' ? 'Neggo: ' : ''}${c.preview.texto}` : 'Sin mensajes en los últimos 7 días'}
                                    </span>
                                    {c.sin_leer > 0 && (
                                        <span aria-label={`${c.sin_leer} sin responder`} style={{
                                            flex: 'none', minWidth: 20, height: 20, padding: '0 6px', boxSizing: 'border-box', borderRadius: t.radius.full,
                                            background: t.color.accent, color: '#fff', fontSize: 11, fontWeight: t.font.weight.bold, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        }}>{c.sin_leer}</span>
                                    )}
                                </span>
                                <Etiquetas t={t} c={c} />
                            </span>
                        </button>
                    );
                })}
                {datos && items.length < datos.total && (
                    <div style={{ padding: t.space[4], display: 'flex', justifyContent: 'center' }}>
                        <Button size="sm" variant="secondary" disabled={cargando} onClick={onMas}>{cargando ? 'Cargando…' : 'Ver más'}</Button>
                    </div>
                )}
            </div>
            <div style={{ padding: `${t.space[3]}px ${t.space[6]}px`, borderTop: `1px solid ${t.color.border}`, fontSize: t.font.size.xs, color: t.color.textMuted, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: t.space[2] }}>
                <span>{datos ? `${fmtInt(datos.total)} chats · ${fmtInt(datos.esperan)} esperan respuesta` : 'Cargando…'}</span>
                <button type="button" onClick={onGrupoAvisos} style={{
                    flex: 'none', border: `1px solid ${t.color.border}`, background: t.color.surface, color: t.color.primary, borderRadius: t.radius.full,
                    padding: '3px 10px', fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, fontFamily: t.font.family, cursor: 'pointer',
                }}>Grupo de avisos</button>
            </div>
        </aside>
    );
}

// ── Conversación ───────────────────────────────────────────────────────────────────────────

function Conversacion({ t, isMobile, compacto, contacto, showToast, onVolver, onNombre, fichaAbierta, onAnotado }) {
    const [datos, setDatos] = useState(null);
    const [error, setError] = useState(null);
    const [buscando, setBuscando] = useState(false);
    const [qChat, setQChat] = useState('');
    const [faqs, setFaqs] = useState([]);
    const [anotados, setAnotados] = useState(new Set());
    const fondo = useRef(null);

    const chat = contacto?.chat;
    const cargar = useCallback(async (silencio = false) => {
        if (!chat) return;
        const res = await api.get(`/clientes/chats/${encodeURIComponent(chat)}/mensajes`);
        if (!res.success) { if (!silencio) setError(res.error || 'No se pudo cargar la conversación'); return; }
        setError(null);
        setDatos(res.data);
    }, [chat]);
    useEffect(() => { setDatos(null); setQChat(''); setBuscando(false); setAnotados(new Set()); cargar(); }, [cargar]);
    useEffect(() => {
        if (!chat) return undefined;
        const id = setInterval(() => cargar(true), REFRESCO_CHAT_MS);
        return () => clearInterval(id);
    }, [cargar, chat]);
    useEffect(() => {
        api.get('/clientes/respuestas').then((res) => {
            if (res.success) setFaqs((res.data || []).filter((r) => r.activa && r.respuesta.trim()));
        });
    }, []);
    // Al abrir, la charla arranca abajo (lo último), como en WhatsApp
    useEffect(() => {
        if (fondo.current && !qChat) fondo.current.scrollTop = fondo.current.scrollHeight;
    }, [datos, qChat]);

    if (!contacto) {
        return (
            <section style={{ flex: '999 1 420px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: t.color.surface2, color: t.color.textMuted, fontSize: t.font.size.sm, padding: t.space[8], textAlign: 'center' }}>
                Elegí un chat de la lista para ver la conversación.
            </section>
        );
    }

    const mensajes = datos?.mensajes || [];
    const filtro = qChat.trim().toLowerCase();
    const visibles = filtro ? mensajes.filter((m) => (m.texto || '').toLowerCase().includes(filtro)) : mensajes;
    const esProspecto = contacto.tipo === 'prospecto';

    const copiarRespuesta = async (r) => {
        try {
            await navigator.clipboard.writeText(r.respuesta);
        } catch {
            showToast('No se pudo copiar: seleccioná el texto a mano', 'error');
            return;
        }
        showToast(`Copiada “${r.pregunta}”: pegala en WhatsApp Web`, 'success');
        if (esProspecto && r.informar_a_todos) {
            await api.put(`/clientes/leads/${contacto.id}/informado/${r.id}`, { hecho: true });
            onAnotado();
        }
    };
    const responder = async () => {
        const url = linkWhatsappWeb(contacto);
        if (url === 'https://web.whatsapp.com/') {
            // Sin teléfono: se busca el chat en WhatsApp Web por el código (lupa)
            const codigo = codigoLid(contacto) || String(contacto.chat || '').split('@')[0];
            try { await navigator.clipboard.writeText(codigo); showToast('Código del chat copiado: pegalo en la lupa de WhatsApp Web', 'success'); } catch { /* sin portapapeles */ }
        }
        window.open(url, 'whatsapp-web');
    };
    const anotar = async (m) => {
        const res = await api.post(`/clientes/leads/${contacto.id}/pedido`, { texto: m.texto.slice(0, 300), chat: m.chat, mensaje_id: m.id });
        if (!res.success) { showToast(res.error || 'No se pudo anotar', 'error'); return; }
        setAnotados((s) => new Set([...s, m.id]));
        showToast('Anotado en Lo que pidió: elegí el producto en la ficha', 'success');
        onAnotado();
    };

    let ultimoDia = null;
    return (
        <section aria-label="Conversación" style={{ flex: '999 1 420px', minWidth: 0, display: 'flex', flexDirection: 'column', background: t.color.surface2 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: t.space[3], padding: `${t.space[3]}px ${t.space[4]}px`, background: t.color.surface, borderBottom: `1px solid ${t.color.border}` }}>
                {isMobile && (
                    <button type="button" onClick={onVolver} aria-label="Volver a los chats" style={botonIcono(t)}><Icon.ArrowLeft size={18} /></button>
                )}
                <button type="button" onClick={onNombre} aria-expanded={!!fichaAbierta} aria-label={`Ver la ficha de ${contacto.nombre || 'este contacto'}`} style={{
                    flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: t.space[4], background: 'transparent', border: 0, padding: 4,
                    borderRadius: t.radius.md, cursor: 'pointer', textAlign: 'left', color: t.color.text, fontFamily: t.font.family,
                }}>
                    <Avatar t={t} c={contacto} tam={40} />
                    <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span style={{ fontWeight: t.font.weight.semibold, fontSize: t.font.size.lg, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{contacto.nombre || contacto.numero || codigoLid(contacto) || 'Sin nombre'}</span>
                        <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {[contacto.numero || (codigoLid(contacto) && `sin número: buscá ${codigoLid(contacto)} en WhatsApp Web`), 'tocá para ver la ficha'].filter(Boolean).join(' · ')}
                        </span>
                    </span>
                </button>
                <button type="button" onClick={() => { setBuscando((b) => !b); setQChat(''); }} aria-label="Buscar en la charla" aria-pressed={buscando}
                    style={{ ...botonIcono(t), background: buscando ? t.color.primarySoft : t.color.surface, color: buscando ? t.color.primary : t.color.textMuted }}>
                    <Icon.Search size={18} />
                </button>
                {compacto
                    ? <button type="button" onClick={responder} aria-label="Responder en WhatsApp Web" style={{ ...botonIcono(t), background: t.color.primary, color: '#fff', border: 'none' }}><Icon.MessageCircle size={18} /></button>
                    : <Button size="sm" variant="primary" leftIcon={<Icon.MessageCircle size={14} />} onClick={responder}>Responder en WhatsApp Web</Button>}
            </div>
            {buscando && (
                <div style={{ display: 'flex', alignItems: 'center', gap: t.space[2], padding: `${t.space[2]}px ${t.space[4]}px`, background: t.color.surface, borderBottom: `1px solid ${t.color.border}` }}>
                    <input type="search" autoFocus value={qChat} onChange={(e) => setQChat(e.target.value)} placeholder="Buscar en esta charla" aria-label="Buscar en esta charla"
                        style={{ flex: 1, height: 34, border: `1px solid ${t.color.borderStrong}`, borderRadius: t.radius.sm, padding: '0 10px', fontFamily: t.font.family, fontSize: t.font.size.sm, color: t.color.text, background: t.color.surface }} />
                    {filtro && <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, whiteSpace: 'nowrap' }}>{visibles.length} de {mensajes.length}</span>}
                </div>
            )}
            <div ref={fondo} tabIndex={0} aria-label="Mensajes" style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: t.space[2], padding: isMobile ? t.space[4] : `${t.space[6]}px ${t.space[10]}px` }}>
                <span style={{ alignSelf: 'center', fontSize: t.font.size.xs, color: t.color.textMuted, background: t.color.surface, border: `1px solid ${t.color.border}`, borderRadius: t.radius.full, padding: '4px 12px', textAlign: 'center' }}>
                    Se ven los mensajes de los últimos 7 días · lo anterior está en el resumen de la ficha
                </span>
                {error && <span style={{ alignSelf: 'center', color: t.color.danger, fontSize: t.font.size.sm }}>{error}</span>}
                {!datos && !error && <span style={{ alignSelf: 'center', color: t.color.textMuted, fontSize: t.font.size.sm }}>Cargando…</span>}
                {datos && mensajes.length === 0 && <span style={{ alignSelf: 'center', color: t.color.textMuted, fontSize: t.font.size.sm, padding: t.space[8] }}>No hay mensajes en los últimos 7 días.</span>}
                {filtro && visibles.length === 0 && mensajes.length > 0 && <span style={{ alignSelf: 'center', color: t.color.textMuted, fontSize: t.font.size.sm }}>Nada con “{qChat}” en la charla.</span>}
                {visibles.map((m) => {
                    const dia = m.fecha.slice(0, 10);
                    const sepa = dia !== ultimoDia;
                    ultimoDia = dia;
                    const nuestro = m.de === 'neggo';
                    return (
                        <div key={`${m.chat}-${m.id}`} style={{ display: 'contents' }}>
                            {sepa && (
                                <span style={{ alignSelf: 'center', fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, color: t.color.textMuted, padding: `${t.space[2]}px 0` }}>
                                    {new Date(m.fecha).toLocaleDateString('es-AR', { weekday: 'long', day: '2-digit', month: '2-digit' })}
                                </span>
                            )}
                            <div style={{
                                alignSelf: nuestro ? 'flex-end' : 'flex-start', maxWidth: isMobile ? '86%' : '70%', display: 'flex', flexDirection: 'column', gap: 4,
                                padding: '8px 12px', boxShadow: t.shadow.card, background: nuestro ? t.color.primarySoft : t.color.surface,
                                borderRadius: nuestro ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
                            }}>
                                <span style={{ fontSize: t.font.size.sm, lineHeight: 1.45, color: m.texto ? t.color.text : t.color.textMuted, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                                    {m.texto ? <Resaltado texto={m.texto} q={filtro} t={t} /> : `[${m.tipo}]`}
                                </span>
                                <span style={{ display: 'flex', gap: t.space[3], alignItems: 'center', justifyContent: 'flex-end' }}>
                                    {esProspecto && !nuestro && m.texto && (anotados.has(m.id)
                                        ? <span style={{ fontSize: 11, color: t.color.success, fontWeight: t.font.weight.semibold }}>Anotado</span>
                                        : (
                                            <button type="button" onClick={() => anotar(m)} style={{
                                                fontSize: 11, fontWeight: t.font.weight.semibold, color: t.color.accent, cursor: 'pointer', background: 'transparent',
                                                border: `1px solid ${t.color.accent}`, borderRadius: t.radius.full, padding: '2px 8px', fontFamily: t.font.family,
                                            }}>+ Anotar pedido</button>
                                        ))}
                                    <span style={{ fontSize: 11, color: t.color.textMuted, fontVariantNumeric: 'tabular-nums' }}>{nuestro ? 'Neggo · ' : ''}{m.fecha.slice(11, 16)}</span>
                                </span>
                            </div>
                        </div>
                    );
                })}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[2], padding: `${t.space[3]}px ${t.space[4]}px`, background: t.color.surface, borderTop: `1px solid ${t.color.border}` }}>
                {faqs.length > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflowX: 'auto' }}>
                        <span style={{ flex: 'none', fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, color: t.color.textMuted }}>Copiar respuesta:</span>
                        {faqs.map((r) => (
                            <button key={r.id} type="button" onClick={() => copiarRespuesta(r)} title={r.respuesta} style={{
                                flex: 'none', height: 30, padding: '0 10px', borderRadius: t.radius.full, cursor: 'pointer', fontFamily: t.font.family,
                                fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, border: `1px solid ${t.color.borderStrong}`, background: t.color.surface, color: t.color.primary,
                            }}>{r.pregunta.replace(/^¿|\?$/g, '')}</button>
                        ))}
                    </div>
                )}
                <span style={{ fontSize: 11, color: t.color.textMuted }}>La app no manda mensajes por el WhatsApp del negocio: copiás la respuesta y la pegás en WhatsApp Web.</span>
            </div>
        </section>
    );
}

function botonIcono(t) {
    return {
        flex: 'none', width: 36, height: 36, borderRadius: t.radius.md, border: `1px solid ${t.color.border}`, background: t.color.surface,
        color: t.color.textMuted, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
    };
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

// ── Ficha del contacto (panel de la derecha) ───────────────────────────────────────────────

// Nombre del prospecto con lápiz para cambiarlo (nota 230). Arranca con el que se ve, que por
// defecto es el de WhatsApp; vacío = vuelve al de WhatsApp. Los clientes no: su nombre es el de Odoo.
function NombreEditable({ t, showToast, contacto, onRenombrado }) {
    const [editando, setEditando] = useState(false);
    const [valor, setValor] = useState('');
    const [guardando, setGuardando] = useState(false);
    const deWhatsapp = contacto.nombre_whatsapp || null;

    const empezar = () => { setValor(contacto.nombre || deWhatsapp || ''); setEditando(true); };
    const guardar = async () => {
        const limpio = valor.replace(/\s+/g, ' ').trim();
        if (limpio === (contacto.nombre || '')) { setEditando(false); return; }
        setGuardando(true);
        const res = await api.put(`/clientes/leads/${contacto.id}/nombre`, { nombre: limpio });
        setGuardando(false);
        if (!res.success) { showToast(res.error || 'No se pudo cambiar el nombre', 'error'); return; }
        setEditando(false);
        onRenombrado?.(res.data);
        showToast(limpio ? 'Nombre cambiado' : 'Vuelve a mostrarse el nombre de WhatsApp', 'success');
    };

    if (!editando) {
        return (
            <span style={{ display: 'flex', alignItems: 'center', gap: t.space[2], maxWidth: '100%' }}>
                <span style={{ fontWeight: t.font.weight.bold, fontSize: t.font.size.lg, overflowWrap: 'anywhere' }}>{contacto.nombre || 'Sin nombre'}</span>
                <button type="button" onClick={empezar} aria-label="Cambiar el nombre" title="Cambiar el nombre"
                    style={{ ...botonIcono(t), width: 30, height: 30 }}><Icon.Edit2 size={14} /></button>
            </span>
        );
    }
    return (
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: t.space[2], width: '100%' }}>
            <input type="text" value={valor} autoFocus maxLength={200} aria-label="Nombre del contacto" placeholder={deWhatsapp || 'Nombre'}
                onChange={(e) => setValor(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') guardar(); if (e.key === 'Escape') setEditando(false); }}
                style={{
                    height: 36, padding: '0 10px', borderRadius: t.radius.md, border: `1px solid ${t.color.borderStrong}`,
                    background: t.color.surface, color: t.color.text, fontFamily: t.font.family, fontSize: t.font.size.base, textAlign: 'center',
                }} />
            {deWhatsapp && valor.trim() !== deWhatsapp && (
                <button type="button" onClick={() => setValor(deWhatsapp)} style={{
                    border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: t.color.primary, fontSize: t.font.size.xs, fontFamily: t.font.family,
                }}>Usar el de WhatsApp: {deWhatsapp}</button>
            )}
            <span style={{ display: 'flex', gap: t.space[2], justifyContent: 'center' }}>
                <Button variant="primary" size="sm" onClick={guardar} disabled={guardando}>{guardando ? 'Guardando…' : 'Guardar'}</Button>
                <Button variant="ghost" size="sm" onClick={() => setEditando(false)} disabled={guardando}>Cancelar</Button>
            </span>
        </span>
    );
}

function PanelFicha({ t, showToast, isMobile, encima, contacto, version, onCerrar, onCompleta, onCambio, onRenombrado }) {
    const esProspecto = contacto.tipo === 'prospecto';
    const clave = useMemo(() => `${contacto.clave}-${version}`, [contacto.clave, version]);
    return (
        <aside aria-label="Ficha del contacto" style={{
            flex: isMobile ? '1 1 auto' : '0 0 400px', minWidth: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column',
            borderLeft: isMobile ? 'none' : `1px solid ${t.color.border}`, background: t.color.surface,
            ...(encima ? { position: 'absolute', top: 0, right: 0, bottom: 0, width: 'min(400px, 100%)', boxShadow: t.shadow.pop, zIndex: 2 } : null),
        }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: t.space[2], padding: `${t.space[4]}px ${t.space[6]}px`, borderBottom: `1px solid ${t.color.border}` }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: t.space[2] }}>
                    {isMobile && <button type="button" onClick={onCerrar} aria-label="Volver a la conversación" style={botonIcono(t)}><Icon.ArrowLeft size={18} /></button>}
                    <span style={{ fontWeight: t.font.weight.semibold }}>Ficha del contacto</span>
                </span>
                {!isMobile && <button type="button" onClick={onCerrar} aria-label="Cerrar la ficha" style={botonIcono(t)}><Icon.X size={16} /></button>}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: t.space[2], padding: t.space[8], borderBottom: `1px solid ${t.color.border}`, textAlign: 'center' }}>
                <Avatar t={t} c={contacto} tam={72} />
                {esProspecto
                    ? <NombreEditable key={contacto.clave} t={t} showToast={showToast} contacto={contacto} onRenombrado={onRenombrado} />
                    : <span style={{ fontWeight: t.font.weight.bold, fontSize: t.font.size.lg }}>{contacto.nombre || 'Sin nombre'}</span>}
                <span style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textMuted }}>{contacto.numero || codigoLid(contacto) || contacto.chat}</span>
                {codigoLid(contacto) && (
                    <button type="button" onClick={async () => {
                        try { await navigator.clipboard.writeText(codigoLid(contacto)); showToast?.('Copiado: pegalo en la lupa de WhatsApp Web', 'success'); } catch { /* sin portapapeles */ }
                    }} style={{ border: `1px solid ${t.color.border}`, background: t.color.surface, color: t.color.primary, borderRadius: t.radius.md, padding: '4px 10px', fontSize: t.font.size.xs, fontFamily: t.font.family, cursor: 'pointer' }}>
                        Sin número · copiar para buscar en WhatsApp
                    </button>
                )}
                <Etiquetas t={t} c={contacto} />
                {textoGrupoAvisos(contacto.grupo_avisos) && (
                    <span style={{ fontSize: t.font.size.xs, color: contacto.grupo_avisos.estado === 'salio' ? t.color.danger : t.color.textMuted }}>
                        {textoGrupoAvisos(contacto.grupo_avisos)}
                    </span>
                )}
                {contacto.etapa?.objetivo && <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>Objetivo de la etapa: {contacto.etapa.objetivo}</span>}
            </div>
            <div style={{ padding: t.space[6], display: 'flex', flexDirection: 'column', gap: t.space[6] }}>
                {esProspecto
                    ? <FichaComercial key={clave} leadId={contacto.id} telefono={contacto.numero || null} t={t} onCambio={onCambio} sinCharla />
                    : (
                        <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, lineHeight: 1.5 }}>
                            Es cliente de Odoo: en su ficha están las compras, el ritmo, las cotizaciones abiertas y el seguimiento.
                        </span>
                    )}
                <Button variant="secondary" onClick={onCompleta}>{esProspecto ? 'Abrir la ficha completa (seguimiento, vincular, chats)' : 'Abrir la ficha del cliente'}</Button>
            </div>
        </aside>
    );
}
