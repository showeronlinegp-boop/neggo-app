// Notas de prueba: marcar en pantalla lo que hay que cambiar y mandarlo a Claude Code.
// Solo admins y solo si el backend tiene TEST_NOTES_ENABLED=1 (si /api/test-notes da 404 no se muestra).
import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTheme } from '../../theme/ThemeContext';
import api from '../../api/client';
import { snapshotContext } from './testNotesCapture';
import {
    OWN_UI_ATTR, isOwnUi, buildSelector, describeElement, relativePosition, pinPosition, findBySelector,
} from './testNotesMark';

const TIPOS = [
    { key: 'error',  label: 'Error' },
    { key: 'mejora', label: 'Mejora' },
    { key: 'duda',   label: 'Duda' },
];

const MODOS = [
    { key: 'debatir',    label: 'Debatir',    ayuda: 'Que proponga opciones y lo charlemos antes de tocar nada' },
    { key: 'investigar', label: 'Investigar', ayuda: 'Que mire código y datos y me cuente qué pasa' },
    { key: 'consultas',  label: 'Consultas',  ayuda: 'Que me pregunte lo que necesite saber' },
];

const ESTADO_LABEL = {
    abierta: 'Abierta', en_curso: 'En curso', consulta: 'Consulta', para_revisar: 'Para revisar',
    corregida: 'Corregida', descartada: 'Descartada',
};

const FILTROS = [
    { key: 'vivas',    label: 'Pendientes', estados: ['abierta', 'en_curso', 'consulta'] },
    { key: 'revisar',  label: 'Para revisar', estados: ['para_revisar'] },
    { key: 'cerradas', label: 'Cerradas', estados: ['corregida', 'descartada'] },
    { key: 'todas',    label: 'Todas', estados: null },
];

const VIVAS = ['abierta', 'en_curso', 'consulta', 'para_revisar'];
const POLL_MS = 60000;
const Z = 2100; // por encima de la terminal de scraping

function tonoEstado(t, estado) {
    switch (estado) {
        case 'abierta':      return { fg: t.color.danger,  bg: t.color.dangerSoft };
        case 'en_curso':     return { fg: t.color.primary, bg: t.color.primarySoft };
        case 'consulta':     return { fg: t.color.warn,    bg: t.color.warnSoft };
        case 'para_revisar': return { fg: t.color.accent,  bg: t.color.accentSoft };
        case 'corregida':    return { fg: t.color.success, bg: t.color.successSoft };
        default:             return { fg: t.color.textMuted, bg: t.color.surface2 };
    }
}

export default function TestNotes({ pantalla }) {
    const { tokens: t } = useTheme();
    const location = useLocation();
    const navigate = useNavigate();

    const [habilitado, setHabilitado] = useState(false);
    const [notas, setNotas] = useState([]);
    const [panelAbierto, setPanelAbierto] = useState(false);
    const [marcando, setMarcando] = useState(false);
    const [hover, setHover] = useState(null);          // rect del elemento bajo el cursor
    const [borrador, setBorrador] = useState(null);    // { selector, elemento, pos_x, pos_y, rect }
    const [filtro, setFiltro] = useState('vivas');
    const [soloPantalla, setSoloPantalla] = useState(false);
    const [enfocada, setEnfocada] = useState(null);    // id de la nota resaltada
    const [, setTick] = useState(0);                   // fuerza recálculo de pines

    const cargar = useCallback(async () => {
        const res = await api.get('/test-notes');
        if (res.success) {
            setHabilitado(true);
            setNotas(res.data);
        } else {
            setHabilitado(false);
        }
    }, []);

    useEffect(() => {
        cargar();
        const id = setInterval(cargar, POLL_MS);
        return () => clearInterval(id);
    }, [cargar]);

    // Pines: recalcular con scroll (en captura, porque scrollea el <main>), resize y cada segundo
    useEffect(() => {
        if (!habilitado) return;
        const re = () => setTick(n => n + 1);
        window.addEventListener('scroll', re, true);
        window.addEventListener('resize', re);
        const id = setInterval(re, 1000);
        return () => {
            window.removeEventListener('scroll', re, true);
            window.removeEventListener('resize', re);
            clearInterval(id);
        };
    }, [habilitado]);

    // Esc cancela el marcado / el borrador
    useEffect(() => {
        const onKey = e => {
            if (e.key !== 'Escape') return;
            setMarcando(false);
            setHover(null);
            setBorrador(null);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    const elementoEn = (x, y) => document.elementsFromPoint(x, y).find(el => !isOwnUi(el) && el !== document.body && el !== document.documentElement);

    const onMove = e => {
        const el = elementoEn(e.clientX, e.clientY);
        setHover(el ? el.getBoundingClientRect() : null);
    };

    const onClickMarcado = e => {
        e.preventDefault();
        e.stopPropagation();
        const el = elementoEn(e.clientX, e.clientY);
        if (!el) return;
        setBorrador({
            selector: buildSelector(el),
            elemento: describeElement(el),
            ...relativePosition(e.clientX, e.clientY),
            rect: el.getBoundingClientRect(),
            tipo: 'error', texto: '', modo: [],
        });
        setMarcando(false);
        setHover(null);
        setPanelAbierto(true);
    };

    async function guardarBorrador() {
        if (!borrador?.texto.trim()) return;
        const { rect, ...datos } = borrador;
        const res = await api.post('/test-notes', {
            ...datos,
            ruta: location.pathname + location.search,
            pantalla,
            contexto: snapshotContext(),
        });
        if (res.success) {
            setBorrador(null);
            setNotas(prev => [res.data, ...prev]);
            setEnfocada(res.data.id);
        }
    }

    async function cambiar(nota, cambios) {
        const res = await api.patch(`/test-notes/${nota.id}`, cambios);
        if (res.success) setNotas(prev => prev.map(n => n.id === nota.id ? res.data : n));
    }

    async function borrar(nota) {
        const res = await api.del(`/test-notes/${nota.id}`);
        if (res.success) setNotas(prev => prev.filter(n => n.id !== nota.id));
    }

    function irANota(nota) {
        setEnfocada(nota.id);
        if (nota.ruta && nota.ruta !== location.pathname + location.search) navigate(nota.ruta);
        // Esperar el render de la pantalla y llevar el elemento a la vista
        setTimeout(() => findBySelector(nota.selector)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 400);
    }

    function enviarAClaude(nota) {
        // Lo atiende tools/claude-link/abrir-nota.ps1 (solo acepta nota/<número>)
        window.location.href = `neggo-claude://nota/${nota.id}`;
        if (nota.estado === 'abierta') cambiar(nota, { estado: 'en_curso' });
    }

    if (!habilitado) return null;

    const rutaActual = location.pathname + location.search;
    const vivas = notas.filter(n => VIVAS.includes(n.estado));
    const pinesPantalla = notas.filter(n => n.ruta === rutaActual && (VIVAS.includes(n.estado) || n.id === enfocada));
    const filtroDef = FILTROS.find(f => f.key === filtro);
    const listadas = notas
        .filter(n => !filtroDef.estados || filtroDef.estados.includes(n.estado))
        .filter(n => !soloPantalla || n.ruta === rutaActual);

    const own = { [OWN_UI_ATTR]: '' };
    const boton = (activo = false) => ({
        border: `1px solid ${activo ? t.color.primary : t.color.border}`,
        background: activo ? t.color.primarySoft : t.color.surface,
        color: activo ? t.color.primary : t.color.text,
        borderRadius: t.radius.sm, padding: '5px 10px', fontSize: t.font.size.xs,
        fontFamily: t.font.family, cursor: 'pointer', fontWeight: t.font.weight.medium,
    });

    return createPortal(
        <>
            {/* Pines numerados sobre la pantalla actual */}
            {pinesPantalla.map(n => {
                const p = pinPosition(n);
                if (!p || p.y < -20 || p.y > window.innerHeight + 20) return null;
                const tono = tonoEstado(t, n.estado);
                const foco = enfocada === n.id;
                return (
                    <button
                        key={n.id} {...own}
                        title={`#${n.id} ${n.texto.slice(0, 120)}`}
                        onClick={() => { setEnfocada(n.id); setPanelAbierto(true); setFiltro(n.estado === 'para_revisar' ? 'revisar' : VIVAS.includes(n.estado) ? 'vivas' : 'todas'); }}
                        style={{
                            position: 'fixed', left: p.x, top: p.y, zIndex: Z,
                            minWidth: 22, height: 22, borderRadius: t.radius.full, padding: '0 6px',
                            background: tono.fg, color: t.color.surface, border: `2px solid ${t.color.surface}`,
                            fontSize: 11, fontWeight: t.font.weight.bold, fontFamily: t.font.family, cursor: 'pointer',
                            boxShadow: foco ? `0 0 0 3px ${tono.bg}, ${t.shadow.pop}` : t.shadow.pop,
                            opacity: p.exacto ? 1 : 0.7, ...t.numericStyle,
                        }}
                    >
                        {n.id}
                    </button>
                );
            })}

            {/* Contorno de la nota enfocada */}
            {(() => {
                const n = notas.find(x => x.id === enfocada && x.ruta === rutaActual);
                const el = n && findBySelector(n.selector);
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return <div {...own} style={{ position: 'fixed', left: r.left - 3, top: r.top - 3, width: r.width + 6, height: r.height + 6, border: `2px dashed ${t.color.accent}`, borderRadius: t.radius.sm, pointerEvents: 'none', zIndex: Z - 1 }} />;
            })()}

            {/* Contorno del borrador */}
            {borrador?.rect && (
                <div {...own} style={{ position: 'fixed', left: borrador.rect.left - 3, top: borrador.rect.top - 3, width: borrador.rect.width + 6, height: borrador.rect.height + 6, border: `2px solid ${t.color.accent}`, borderRadius: t.radius.sm, pointerEvents: 'none', zIndex: Z - 1 }} />
            )}

            {/* Capa de marcado */}
            {marcando && (
                <div {...own} onPointerMove={onMove} onClick={onClickMarcado} style={{ position: 'fixed', inset: 0, zIndex: Z + 1, cursor: 'crosshair' }}>
                    {hover && (
                        <div style={{ position: 'fixed', left: hover.left, top: hover.top, width: hover.width, height: hover.height, background: `${t.color.accent}22`, outline: `2px solid ${t.color.accent}`, pointerEvents: 'none' }} />
                    )}
                    <div style={{ position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)', background: t.color.text, color: t.color.surface, padding: '6px 14px', borderRadius: t.radius.full, fontSize: t.font.size.sm, fontFamily: t.font.family, pointerEvents: 'none' }}>
                        Tocá lo que querés cambiar · Esc para cancelar
                    </div>
                </div>
            )}

            {/* Botones flotantes */}
            <div {...own} style={{ position: 'fixed', right: 20, bottom: 20, zIndex: Z, display: 'flex', gap: t.space[2] }}>
                <button {...own} onClick={() => { setMarcando(m => !m); setBorrador(null); }} style={{ ...boton(marcando), padding: '8px 14px', fontSize: t.font.size.sm, boxShadow: t.shadow.pop, background: marcando ? t.color.primarySoft : t.color.accent, color: marcando ? t.color.primary : t.color.surface, border: 'none' }}>
                    {marcando ? 'Cancelar' : 'Marcar'}
                </button>
                <button {...own} onClick={() => setPanelAbierto(p => !p)} style={{ ...boton(panelAbierto), padding: '8px 14px', fontSize: t.font.size.sm, boxShadow: t.shadow.pop }}>
                    Notas ({vivas.length})
                </button>
            </div>

            {/* Panel lateral */}
            {panelAbierto && (
                <aside {...own} style={{
                    position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(400px, 100vw)', zIndex: Z,
                    background: t.color.surface, borderLeft: `1px solid ${t.color.border}`, boxShadow: t.shadow.pop,
                    display: 'flex', flexDirection: 'column', fontFamily: t.font.family, color: t.color.text,
                }}>
                    <div style={{ padding: t.space[6], borderBottom: `1px solid ${t.color.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <strong style={{ fontSize: t.font.size.lg }}>Notas de prueba</strong>
                        <button {...own} onClick={() => setPanelAbierto(false)} style={boton()}>Cerrar</button>
                    </div>

                    {borrador && (
                        <div style={{ padding: t.space[6], borderBottom: `1px solid ${t.color.border}`, background: t.color.surface2, display: 'flex', flexDirection: 'column', gap: t.space[3] }}>
                            <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>
                                {pantalla} · <span style={{ fontFamily: t.font.mono }}>{borrador.elemento}</span>
                            </div>
                            <div style={{ display: 'flex', gap: t.space[2] }}>
                                {TIPOS.map(x => (
                                    <button key={x.key} {...own} onClick={() => setBorrador(b => ({ ...b, tipo: x.key }))} style={boton(borrador.tipo === x.key)}>{x.label}</button>
                                ))}
                            </div>
                            <textarea
                                autoFocus value={borrador.texto} rows={4}
                                placeholder="¿Qué está mal o qué querés cambiar?"
                                onChange={e => setBorrador(b => ({ ...b, texto: e.target.value }))}
                                style={{ width: '100%', boxSizing: 'border-box', padding: t.space[3], border: `1px solid ${t.color.border}`, borderRadius: t.radius.sm, fontFamily: t.font.family, fontSize: t.font.size.sm, background: t.color.surface, color: t.color.text, resize: 'vertical' }}
                            />
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>Sin tildar nada, Claude lo resuelve directo. Si querés otra cosa:</span>
                                {MODOS.map(m => (
                                    <label key={m.key} title={m.ayuda} style={{ display: 'flex', gap: t.space[2], alignItems: 'center', fontSize: t.font.size.sm, cursor: 'pointer' }}>
                                        <input type="checkbox" checked={borrador.modo.includes(m.key)}
                                            onChange={e => setBorrador(b => ({ ...b, modo: e.target.checked ? [...b.modo, m.key] : b.modo.filter(x => x !== m.key) }))} />
                                        {m.label} <span style={{ color: t.color.textFaint, fontSize: t.font.size.xs }}>— {m.ayuda}</span>
                                    </label>
                                ))}
                            </div>
                            <div style={{ display: 'flex', gap: t.space[2], justifyContent: 'flex-end' }}>
                                <button {...own} onClick={() => setBorrador(null)} style={boton()}>Cancelar</button>
                                <button {...own} disabled={!borrador.texto.trim()} onClick={guardarBorrador} style={{ ...boton(true), opacity: borrador.texto.trim() ? 1 : 0.5 }}>Guardar nota</button>
                            </div>
                        </div>
                    )}

                    <div style={{ padding: `${t.space[4]}px ${t.space[6]}px`, display: 'flex', gap: t.space[2], flexWrap: 'wrap', alignItems: 'center', borderBottom: `1px solid ${t.color.border}` }}>
                        {FILTROS.map(f => {
                            const n = f.estados ? notas.filter(x => f.estados.includes(x.estado)).length : notas.length;
                            return <button key={f.key} {...own} onClick={() => setFiltro(f.key)} style={boton(filtro === f.key)}>{f.label} ({n})</button>;
                        })}
                        <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: t.font.size.xs, color: t.color.textMuted, cursor: 'pointer' }}>
                            <input type="checkbox" checked={soloPantalla} onChange={e => setSoloPantalla(e.target.checked)} /> Solo esta pantalla
                        </label>
                    </div>

                    <div style={{ flex: 1, overflowY: 'auto', padding: t.space[6], display: 'flex', flexDirection: 'column', gap: t.space[4] }}>
                        {listadas.length === 0 && <span style={{ color: t.color.textFaint, fontSize: t.font.size.sm }}>No hay notas acá.</span>}
                        {listadas.map(n => (
                            <TarjetaNota
                                key={n.id} nota={n} tokens={t} enfocada={enfocada === n.id} own={own} boton={boton}
                                onIr={() => irANota(n)} onEnviar={() => enviarAClaude(n)}
                                onEstado={estado => cambiar(n, { estado })} onBorrar={() => borrar(n)}
                            />
                        ))}
                    </div>
                </aside>
            )}
        </>,
        document.body
    );
}

function TarjetaNota({ nota: n, tokens: t, enfocada, own, boton, onIr, onEnviar, onEstado, onBorrar }) {
    const [confirmarBorrado, setConfirmarBorrado] = useState(false);
    const tono = tonoEstado(t, n.estado);
    const modo = n.modo?.length ? n.modo.join(' + ') : 'directo';

    return (
        <div style={{ border: `1px solid ${enfocada ? t.color.accent : t.color.border}`, borderRadius: t.radius.md, padding: t.space[4], display: 'flex', flexDirection: 'column', gap: t.space[2], background: t.color.surface }}>
            <div style={{ display: 'flex', gap: t.space[2], alignItems: 'center', flexWrap: 'wrap' }}>
                <strong style={{ ...t.numericStyle }}>#{n.id}</strong>
                <span style={{ fontSize: 11, padding: '1px 8px', borderRadius: t.radius.full, background: tono.bg, color: tono.fg, fontWeight: t.font.weight.semibold }}>{ESTADO_LABEL[n.estado]}</span>
                <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>{n.tipo} · {modo}</span>
            </div>
            <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>{n.pantalla || n.ruta || 'Sin pantalla'}{n.autor ? ` · ${n.autor}` : ''}</div>
            <div style={{ fontSize: t.font.size.sm, whiteSpace: 'pre-wrap' }}>{n.texto}</div>
            {n.respuesta && (
                <div style={{ fontSize: t.font.size.sm, whiteSpace: 'pre-wrap', background: t.color.surface2, borderLeft: `3px solid ${t.color.primary}`, padding: t.space[3], borderRadius: t.radius.sm }}>
                    <div style={{ fontSize: 11, color: t.color.textMuted, marginBottom: 4 }}>Respuesta de Claude</div>
                    {n.respuesta}
                </div>
            )}
            <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap', marginTop: t.space[1] }}>
                {n.ruta && <button {...own} onClick={onIr} style={boton()}>Ir a la nota</button>}
                {['abierta', 'en_curso', 'consulta'].includes(n.estado) && (
                    <button {...own} onClick={onEnviar} style={{ ...boton(true) }}>Enviar a Claude</button>
                )}
                {n.estado === 'para_revisar' && <button {...own} onClick={() => onEstado('corregida')} style={boton(true)}>Confirmar</button>}
                {n.estado === 'para_revisar' && <button {...own} onClick={() => onEstado('abierta')} style={boton()}>Sigue mal</button>}
                {VIVAS.includes(n.estado) && <button {...own} onClick={() => onEstado('descartada')} style={boton()}>Descartar</button>}
                {!VIVAS.includes(n.estado) && <button {...own} onClick={() => onEstado('abierta')} style={boton()}>Reabrir</button>}
                {confirmarBorrado
                    ? <button {...own} onClick={onBorrar} style={{ ...boton(), color: t.color.danger, borderColor: t.color.danger }}>¿Borrar? Sí</button>
                    : <button {...own} onClick={() => setConfirmarBorrado(true)} style={{ ...boton(), color: t.color.danger }}>Borrar</button>}
            </div>
        </div>
    );
}
