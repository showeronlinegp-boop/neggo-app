import { useCallback, useEffect, useState } from 'react';
import api from '../../api/client';
import { useTheme } from '../../theme/ThemeContext';
import { useToast } from '../../context/ToastContext';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Input from '../../components/common/Input';
import Select from '../../components/common/Select';
import * as Icon from '../../components/common/icons';
import {
    STAGE_META, MANUAL_STAGES, ACTION_META, ACTION_ORDER, EVENT_META,
    hoyAr, fmtProxima, fmtFecha, fmtFechaHora,
} from './clientesUi';

// Seguimiento de un cliente o posible cliente (fase 2): etapa del funnel, próxima acción
// e historial. tipo = 'cliente' | 'lead'. onCambio avisa para refrescar el listado.

const TIPOS_ACCION = ACTION_ORDER.map((k) => ({ value: k, label: ACTION_META[k].label }));
const TIPOS_CONTACTO = [{ value: 'nota', label: 'Nota' }, ...ACTION_ORDER.map((k) => ({ value: k, label: ACTION_META[k].verbo }))];

function Titulo({ children, t }) {
    return (
        <h3 style={{
            margin: 0, fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, color: t.color.textMuted,
            textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>
            {children}
        </h3>
    );
}

function AreaTexto({ value, onChange, placeholder, t, filas = 2 }) {
    return (
        <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            rows={filas}
            style={{
                width: '100%', boxSizing: 'border-box', resize: 'vertical', padding: '8px 12px',
                border: `1px solid ${t.color.borderStrong}`, borderRadius: t.radius.sm,
                background: t.color.surface, color: t.color.text,
                fontFamily: t.font.family, fontSize: t.font.size.base, lineHeight: 1.4,
            }}
        />
    );
}

function Fecha({ value, onChange, t, ariaLabel }) {
    return (
        <input
            type="date"
            value={value}
            min={hoyAr()}
            onChange={(e) => onChange(e.target.value)}
            aria-label={ariaLabel}
            style={{
                height: t.layout.inputHeight, padding: '0 10px', boxSizing: 'border-box',
                border: `1px solid ${t.color.borderStrong}`, borderRadius: t.radius.sm,
                background: t.color.surface, color: t.color.text,
                fontFamily: t.font.family, fontSize: t.font.size.base, ...t.numericStyle,
            }}
        />
    );
}

function TextoEvento({ e }) {
    if (e.kind === 'etapa') {
        const de = STAGE_META[e.meta?.from]?.label || e.meta?.from;
        const a = STAGE_META[e.meta?.to]?.label || e.meta?.to;
        return <>{`${de} → ${a}`}{e.text ? ` · ${e.text}` : ''}</>;
    }
    return <>{e.text}</>;
}

export default function Seguimiento({ tipo, id, onCambio }) {
    const { tokens: t } = useTheme();
    const { showToast } = useToast();
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [guardando, setGuardando] = useState(false);

    // Descartar pide motivo
    const [descartando, setDescartando] = useState(false);
    const [motivo, setMotivo] = useState('');
    // Próxima acción
    const [tipoAccion, setTipoAccion] = useState('llamar');
    const [fechaAccion, setFechaAccion] = useState(hoyAr(1));
    const [notaAccion, setNotaAccion] = useState('');
    // Acción que se está cerrando o moviendo
    const [cerrando, setCerrando] = useState(null);
    const [resultado, setResultado] = useState('');
    const [moviendo, setMoviendo] = useState(null);
    const [nuevaFecha, setNuevaFecha] = useState('');
    // Contacto suelto
    const [tipoContacto, setTipoContacto] = useState('llamar');
    const [textoContacto, setTextoContacto] = useState('');

    const base = `/clientes/seguimiento/${tipo}/${id}`;

    const cargar = useCallback(async () => {
        const res = await api.get(base);
        if (!res.success) { setError(res.error || 'No se pudo cargar el seguimiento'); return; }
        setError(null);
        setData(res.data);
    }, [base]);

    useEffect(() => {
        setData(null);
        setDescartando(false);
        setCerrando(null);
        setMoviendo(null);
        if (id) cargar();
    }, [id, cargar]);

    // Ejecuta un pedido, avisa si falla y recarga
    const enviar = async (fn, okMsg) => {
        setGuardando(true);
        const res = await fn();
        setGuardando(false);
        if (!res.success) { showToast(res.error || 'No se pudo guardar', 'error'); return false; }
        if (okMsg) showToast(okMsg, 'success');
        await cargar();
        onCambio?.();
        return true;
    };

    const cambiarEtapa = (stage) => {
        if (stage === 'descartado') { setDescartando(true); return; }
        enviar(() => api.put(`${base}/etapa`, { stage }), `Pasó a ${STAGE_META[stage].label}`);
    };

    const confirmarDescarte = async () => {
        const ok = await enviar(() => api.put(`${base}/etapa`, { stage: 'descartado', reason: motivo }), 'Descartado');
        if (ok) { setDescartando(false); setMotivo(''); }
    };

    const programar = async () => {
        const ok = await enviar(
            () => api.post(`${base}/acciones`, { type: tipoAccion, due_date: fechaAccion, note: notaAccion }),
            'Acción programada');
        if (ok) { setNotaAccion(''); setFechaAccion(hoyAr(1)); }
    };

    const cerrarAccion = async (accion) => {
        const ok = await enviar(() => api.post(`/clientes/acciones/${accion.id}/hecha`, { result: resultado }), 'Listo. Programá la próxima.');
        if (ok) {
            setCerrando(null);
            setResultado('');
            // Deja el formulario listo para la próxima acción del mismo tipo
            setTipoAccion(accion.action_type);
            setFechaAccion(hoyAr(1));
        }
    };

    const moverAccion = async (accion) => {
        const ok = await enviar(() => api.put(`/clientes/acciones/${accion.id}`, { due_date: nuevaFecha }), 'Acción movida');
        if (ok) setMoviendo(null);
    };

    const registrarContacto = async () => {
        const ok = await enviar(() => api.post(`${base}/eventos`, { kind: tipoContacto, text: textoContacto }), 'Contacto registrado');
        if (ok) setTextoContacto('');
    };

    if (error) return <div style={{ fontSize: t.font.size.sm, color: t.color.danger }}>{error}</div>;
    if (!data) return <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>Cargando el seguimiento…</div>;

    const etapa = STAGE_META[data.stage] || STAGE_META.frio;
    const caja = { background: t.color.surface2, borderRadius: t.radius.md, padding: 12, display: 'flex', flexDirection: 'column', gap: t.space[3] };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[10] }}>
            <section style={{ display: 'flex', flexDirection: 'column', gap: t.space[3] }}>
                <Titulo t={t}>Etapa</Titulo>
                <div role="group" aria-label="Etapa del seguimiento" style={{ display: 'flex', flexWrap: 'wrap', gap: t.space[2] }}>
                    {MANUAL_STAGES.map((s) => {
                        const activa = data.stage === s;
                        return (
                            <button key={s} type="button" disabled={guardando || (activa && s !== 'descartado')}
                                aria-pressed={activa} title={STAGE_META[s].hint}
                                onClick={() => cambiarEtapa(s)}
                                style={{
                                    padding: '6px 12px', borderRadius: t.radius.full, cursor: activa ? 'default' : 'pointer',
                                    fontFamily: t.font.family, fontSize: t.font.size.sm, fontWeight: t.font.weight.medium,
                                    border: `1px solid ${activa ? t.color.primary : t.color.border}`,
                                    background: activa ? t.color.primarySoft : t.color.surface,
                                    color: activa ? t.color.primary : t.color.text,
                                }}>
                                {STAGE_META[s].label}
                            </button>
                        );
                    })}
                    {data.stage === 'ganado' && <Badge tone="success" dot>Ganado</Badge>}
                </div>
                <div style={{ fontSize: t.font.size.xs, color: t.color.textMuted }}>
                    {etapa.hint}
                    {data.stage_changed_at && ` · desde el ${fmtFecha(String(data.stage_changed_at).slice(0, 10))}`}
                    {data.stage_changed_by_name && ` (${data.stage_changed_by_name})`}
                    {data.stage === 'descartado' && data.discard_reason && ` · ${data.discard_reason}`}
                </div>
                {descartando && (
                    <div style={caja}>
                        <Input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="¿Por qué lo descartás?" aria-label="Motivo del descarte" />
                        <div style={{ display: 'flex', gap: t.space[2], justifyContent: 'flex-end' }}>
                            <Button variant="ghost" size="sm" onClick={() => { setDescartando(false); setMotivo(''); }}>Cancelar</Button>
                            <Button variant="danger" size="sm" disabled={guardando || !motivo.trim()} onClick={confirmarDescarte}>Descartar</Button>
                        </div>
                    </div>
                )}
            </section>

            <section style={{ display: 'flex', flexDirection: 'column', gap: t.space[3] }}>
                <Titulo t={t}>Próxima acción</Titulo>
                {data.actions.map((a) => {
                    const vencida = a.due_date < hoyAr();
                    return (
                        <div key={a.id} style={{ ...caja, background: vencida ? t.color.dangerSoft : t.color.surface2 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: t.space[3], alignItems: 'flex-start' }}>
                                <div style={{ minWidth: 0 }}>
                                    <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.text }}>
                                        {ACTION_META[a.action_type]?.label || a.action_type}
                                        <span style={{ fontWeight: t.font.weight.regular, color: vencida ? t.color.danger : t.color.textMuted, marginLeft: 8, ...t.numericStyle }}>
                                            {fmtProxima(a.due_date)} · {fmtFecha(a.due_date)}
                                        </span>
                                    </div>
                                    {a.note && <div style={{ fontSize: t.font.size.sm, color: t.color.text, marginTop: 2 }}>{a.note}</div>}
                                    {a.created_by_name && <div style={{ fontSize: t.font.size.xs, color: t.color.textFaint, marginTop: 2 }}>La programó {a.created_by_name}</div>}
                                </div>
                                {cerrando !== a.id && moviendo !== a.id && (
                                    <div style={{ display: 'flex', gap: t.space[2], flexShrink: 0 }}>
                                        <Button size="sm" variant="ghost" onClick={() => { setMoviendo(a.id); setNuevaFecha(a.due_date < hoyAr() ? hoyAr() : a.due_date); }}>Mover</Button>
                                        <Button size="sm" variant="primary" leftIcon={<Icon.Check size={14} />} onClick={() => { setCerrando(a.id); setResultado(''); }}>Hecha</Button>
                                    </div>
                                )}
                            </div>
                            {cerrando === a.id && (
                                <>
                                    <AreaTexto t={t} value={resultado} onChange={setResultado} placeholder="¿Cómo te fue? Por ejemplo: «Pidió la lista de útiles, la paso el lunes»" />
                                    <div style={{ display: 'flex', gap: t.space[2], justifyContent: 'flex-end' }}>
                                        <Button variant="ghost" size="sm" onClick={() => setCerrando(null)}>Cancelar</Button>
                                        <Button variant="primary" size="sm" disabled={guardando || !resultado.trim()} onClick={() => cerrarAccion(a)}>Guardar</Button>
                                    </div>
                                </>
                            )}
                            {moviendo === a.id && (
                                <div style={{ display: 'flex', gap: t.space[2], justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                                    <Fecha t={t} value={nuevaFecha} onChange={setNuevaFecha} ariaLabel="Nueva fecha" />
                                    <Button variant="ghost" size="sm" onClick={() => setMoviendo(null)}>Cancelar</Button>
                                    <Button variant="primary" size="sm" disabled={guardando || !nuevaFecha} onClick={() => moverAccion(a)}>Mover</Button>
                                </div>
                            )}
                        </div>
                    );
                })}
                <div style={caja}>
                    {data.actions.length === 0 && (
                        <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>No tiene nada programado. ¿Qué es lo próximo?</div>
                    )}
                    <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap' }}>
                        <Select value={tipoAccion} onChange={setTipoAccion} options={TIPOS_ACCION} style={{ flex: '1 1 140px' }} />
                        <Fecha t={t} value={fechaAccion} onChange={setFechaAccion} ariaLabel="Fecha de la acción" />
                    </div>
                    <Input value={notaAccion} onChange={(e) => setNotaAccion(e.target.value)} placeholder="Nota (opcional): qué le vas a decir" aria-label="Nota de la acción" />
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <Button variant="secondary" size="sm" leftIcon={<Icon.Plus size={14} />} disabled={guardando || !fechaAccion} onClick={programar}>Programar</Button>
                    </div>
                </div>
            </section>

            <section style={{ display: 'flex', flexDirection: 'column', gap: t.space[3] }}>
                <Titulo t={t}>Registrar un contacto</Titulo>
                <div style={caja}>
                    <Select value={tipoContacto} onChange={setTipoContacto} options={TIPOS_CONTACTO} />
                    <AreaTexto t={t} value={textoContacto} onChange={setTextoContacto} placeholder="Qué hablaron o qué anotar" />
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <Button variant="secondary" size="sm" disabled={guardando || !textoContacto.trim()} onClick={registrarContacto}>Guardar</Button>
                    </div>
                </div>
            </section>

            <section style={{ display: 'flex', flexDirection: 'column', gap: t.space[3] }}>
                <Titulo t={t}>Historial</Titulo>
                {data.events.length === 0 ? (
                    <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>Todavía no hay contactos registrados.</div>
                ) : (
                    <div>
                        {data.events.map((e) => (
                            <div key={e.id} style={{ padding: '8px 0', borderTop: `1px solid ${t.color.border}` }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: t.space[3], fontSize: t.font.size.xs, color: t.color.textMuted }}>
                                    <span style={{ fontWeight: t.font.weight.semibold, color: t.color.text }}>{EVENT_META[e.kind]?.label || e.kind}</span>
                                    <span style={t.numericStyle}>{fmtFechaHora(e.created_at)}{e.user_name ? ` · ${e.user_name}` : ''}</span>
                                </div>
                                <div style={{ fontSize: t.font.size.sm, color: t.color.text, marginTop: 2, whiteSpace: 'pre-wrap' }}>
                                    <TextoEvento e={e} />
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}
