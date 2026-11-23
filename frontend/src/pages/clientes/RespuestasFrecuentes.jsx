import { useCallback, useEffect, useState } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { useToast } from '../../context/ToastContext';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Toggle from '../../components/common/Toggle';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import * as Icon from '../../components/common/icons';

// Preguntas frecuentes y el mensaje que va como respuesta (066). Las usa el equipo para copiar y
// mandar por WhatsApp, y Grok las lee por la API (GET /api/agente/respuestas): así dicen lo mismo.
// "Contárselo a todos" = objetivo de nutrición Informar: va a cada prospecto aunque no pregunte.

const VACIA = { pregunta: '', respuesta: '', informar_a_todos: false, activa: true };

export default function RespuestasFrecuentes() {
    const { tokens: t } = useTheme();
    const { showToast } = useToast();
    const [lista, setLista] = useState(null);
    const [error, setError] = useState(null);
    // id de la que se edita, o 'nueva'
    const [editando, setEditando] = useState(null);
    const [borrador, setBorrador] = useState(VACIA);
    const [guardando, setGuardando] = useState(false);
    const [aBorrar, setABorrar] = useState(null);

    const cargar = useCallback(async () => {
        const res = await api.get('/clientes/respuestas');
        if (!res.success) { setError(res.error || 'No se pudieron cargar las preguntas'); return; }
        setError(null);
        setLista(res.data || []);
    }, []);
    useEffect(() => { cargar(); }, [cargar]);

    const abrir = (r) => {
        setEditando(r ? r.id : 'nueva');
        setBorrador(r ? { pregunta: r.pregunta, respuesta: r.respuesta, informar_a_todos: r.informar_a_todos, activa: r.activa } : VACIA);
    };
    const cerrar = () => { setEditando(null); setBorrador(VACIA); };

    const guardar = async () => {
        if (!borrador.pregunta.trim()) { showToast('Escribí la pregunta', 'error'); return; }
        setGuardando(true);
        const res = editando === 'nueva'
            ? await api.post('/clientes/respuestas', borrador)
            : await api.put(`/clientes/respuestas/${editando}`, borrador);
        setGuardando(false);
        if (!res.success) { showToast(res.error || 'No se pudo guardar', 'error'); return; }
        showToast('Guardada', 'success');
        cerrar();
        cargar();
    };

    const cambiar = async (r, campos) => {
        const res = await api.put(`/clientes/respuestas/${r.id}`, campos);
        if (!res.success) { showToast(res.error || 'No se pudo guardar', 'error'); return; }
        setLista((prev) => prev.map((x) => (x.id === r.id ? res.data : x)));
    };

    const mover = async (r, direccion) => {
        const res = await api.post(`/clientes/respuestas/${r.id}/mover`, { direccion });
        if (!res.success) { showToast(res.error || 'No se pudo mover', 'error'); return; }
        setLista(res.data || []);
    };

    const borrar = async () => {
        const r = aBorrar;
        setABorrar(null);
        const res = await api.del(`/clientes/respuestas/${r.id}`);
        if (!res.success) { showToast(res.error || 'No se pudo borrar', 'error'); return; }
        showToast('Borrada', 'success');
        setLista((prev) => prev.filter((x) => x.id !== r.id));
    };

    const copiar = async (r) => {
        try {
            await navigator.clipboard.writeText(r.respuesta);
            showToast('Respuesta copiada: pegala en WhatsApp', 'success');
        } catch {
            showToast('No se pudo copiar: seleccioná el texto a mano', 'error');
        }
    };

    const formulario = (
        <Card style={{ display: 'flex', flexDirection: 'column', gap: t.space[4], border: `2px solid ${t.color.primary}` }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: t.space[2] }}>
                <span style={etiqueta(t)}>Pregunta</span>
                <Input value={borrador.pregunta} maxLength={200} autoFocus placeholder="¿Hacen envíos al interior?"
                    onChange={(e) => setBorrador((b) => ({ ...b, pregunta: e.target.value }))} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: t.space[2] }}>
                <span style={etiqueta(t)}>Mensaje que va como respuesta</span>
                <textarea value={borrador.respuesta} rows={5} maxLength={4000}
                    placeholder="Tal cual se manda por WhatsApp. Los renglones se respetan."
                    onChange={(e) => setBorrador((b) => ({ ...b, respuesta: e.target.value }))}
                    style={{
                        width: '100%', boxSizing: 'border-box', resize: 'vertical', padding: '10px 12px',
                        border: `1px solid ${t.color.borderStrong}`, borderRadius: t.radius.sm,
                        background: t.color.surface, color: t.color.text,
                        fontFamily: t.font.family, fontSize: t.font.size.base, lineHeight: 1.45,
                    }} />
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: t.space[8] }}>
                <Interruptor t={t} checked={borrador.informar_a_todos} onChange={(v) => setBorrador((b) => ({ ...b, informar_a_todos: v }))}
                    titulo="Contárselo a todos" ayuda="Va a cada prospecto aunque no pregunte (objetivo de nutrición)" />
                <Interruptor t={t} checked={borrador.activa} onChange={(v) => setBorrador((b) => ({ ...b, activa: v }))}
                    titulo="Activa" ayuda="Pausada no la ve Grok ni aparece para mandar" />
            </div>
            <div style={{ display: 'flex', gap: t.space[2], justifyContent: 'flex-end' }}>
                <Button variant="ghost" onClick={cerrar}>Cancelar</Button>
                <Button variant="primary" disabled={guardando} onClick={guardar}>{guardando ? 'Guardando…' : 'Guardar'}</Button>
            </div>
        </Card>
    );

    const sinTexto = (lista || []).filter((r) => r.activa && !r.respuesta.trim()).length;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[6], fontFamily: t.font.family, maxWidth: 880 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: t.space[4], flexWrap: 'wrap' }}>
                <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, maxWidth: 600, lineHeight: 1.5 }}>
                    Las preguntas que más te hacen y el mensaje que va como respuesta. Grok usa estos mismos textos,
                    así el bot y el equipo dicen lo mismo. Las marcadas <strong style={{ color: t.color.text }}>Contárselo a todos</strong> se
                    le mandan a cada prospecto aunque no pregunte.
                </div>
                {editando !== 'nueva' && (
                    <Button variant="primary" leftIcon={<Icon.Plus size={16} />} onClick={() => abrir(null)}>Nueva pregunta</Button>
                )}
            </div>

            {error && <Card style={{ color: t.color.danger }}>{error}</Card>}
            {sinTexto > 0 && (
                <div style={{ background: t.color.warnSoft, color: t.color.text, borderRadius: t.radius.md, padding: `${t.space[4]}px ${t.space[6]}px`, fontSize: t.font.size.sm }}>
                    {sinTexto === 1 ? 'Hay 1 pregunta sin respuesta' : `Hay ${sinTexto} preguntas sin respuesta`}: hasta que tengan texto, Grok no las ve.
                </div>
            )}
            {editando === 'nueva' && formulario}
            {lista === null && !error && <div style={{ color: t.color.textMuted }}>Cargando…</div>}
            {lista && lista.length === 0 && editando !== 'nueva' && (
                <Card style={{ color: t.color.textMuted }}>Todavía no hay preguntas. Cargá la primera con “Nueva pregunta”.</Card>
            )}

            {(lista || []).map((r, i) => (editando === r.id ? <div key={r.id}>{formulario}</div> : (
                <Card key={r.id} style={{ display: 'flex', flexDirection: 'column', gap: t.space[4], opacity: r.activa ? 1 : 0.65 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: t.space[4], flexWrap: 'wrap' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[2], minWidth: 0, flex: '1 1 320px' }}>
                            <span style={{ fontWeight: t.font.weight.semibold, fontSize: t.font.size.lg, color: t.color.text }}>{r.pregunta}</span>
                            <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap' }}>
                                {r.informar_a_todos && <Badge tone="primary">Contárselo a todos</Badge>}
                                {!r.activa && <Badge tone="muted">Pausada</Badge>}
                                {r.activa && !r.respuesta.trim() && <Badge tone="warn">Sin respuesta</Badge>}
                            </div>
                        </div>
                        <div style={{ display: 'flex', gap: t.space[1], alignItems: 'center' }}>
                            <Button size="sm" variant="ghost" aria-label="Subir" disabled={i === 0} onClick={() => mover(r, -1)}>↑</Button>
                            <Button size="sm" variant="ghost" aria-label="Bajar" disabled={i === lista.length - 1} onClick={() => mover(r, 1)}>↓</Button>
                            <Button size="sm" variant="ghost" aria-label="Editar" leftIcon={<Icon.Edit2 size={14} />} onClick={() => abrir(r)}>Editar</Button>
                            <Button size="sm" variant="ghost" aria-label="Borrar" onClick={() => setABorrar(r)}><Icon.Trash2 size={14} /></Button>
                        </div>
                    </div>
                    {r.respuesta.trim() ? (
                        <div style={{
                            whiteSpace: 'pre-wrap', background: t.color.surface2, borderRadius: t.radius.md,
                            padding: `${t.space[4]}px ${t.space[6]}px`, fontSize: t.font.size.base, lineHeight: 1.5, color: t.color.text,
                        }}>
                            {r.respuesta}
                        </div>
                    ) : (
                        <button type="button" onClick={() => abrir(r)} style={{
                            textAlign: 'left', cursor: 'pointer', border: `1px dashed ${t.color.borderStrong}`, background: 'transparent',
                            borderRadius: t.radius.md, padding: `${t.space[4]}px ${t.space[6]}px`, color: t.color.textMuted,
                            fontFamily: t.font.family, fontSize: t.font.size.base,
                        }}>
                            Escribí la respuesta
                        </button>
                    )}
                    <div style={{ display: 'flex', gap: t.space[6], alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                        <div style={{ display: 'flex', gap: t.space[6], flexWrap: 'wrap' }}>
                            <Interruptor t={t} chico checked={r.informar_a_todos} onChange={(v) => cambiar(r, { informar_a_todos: v })} titulo="Contárselo a todos" />
                            <Interruptor t={t} chico checked={r.activa} onChange={(v) => cambiar(r, { activa: v })} titulo="Activa" />
                        </div>
                        {r.respuesta.trim() && (
                            <Button size="sm" variant="secondary" leftIcon={<Icon.ClipboardList size={14} />} onClick={() => copiar(r)}>Copiar respuesta</Button>
                        )}
                    </div>
                </Card>
            )))}

            <ConfirmDialog
                isOpen={!!aBorrar}
                onClose={() => setABorrar(null)}
                onConfirm={borrar}
                title="Borrar pregunta"
                message={aBorrar ? `¿Borrar “${aBorrar.pregunta}”? Grok deja de verla. Si solo querés dejar de usarla un tiempo, pausala.` : ''}
                confirmLabel="Borrar"
                danger
            />
        </div>
    );
}

function etiqueta(t) {
    return { fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, color: t.color.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' };
}

function Interruptor({ t, checked, onChange, titulo, ayuda, chico }) {
    return (
        <label style={{ display: 'flex', gap: t.space[3], alignItems: 'flex-start', cursor: 'pointer' }}>
            <Toggle checked={checked} onChange={onChange} size={chico ? 'sm' : 'md'} />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.text }}>{titulo}</span>
                {ayuda && <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>{ayuda}</span>}
            </span>
        </label>
    );
}
