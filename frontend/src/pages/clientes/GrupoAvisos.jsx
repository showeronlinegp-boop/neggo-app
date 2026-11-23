import { useCallback, useEffect, useState } from 'react';
import api from '../../api/client';
import { fmtInt } from '../../theme/tokens';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Modal from '../../components/common/Modal';
import Stat from '../../components/common/Stat';

// Grupo de avisos de la comunidad «Neggo Polirrubros» (nota 228): si el contacto está, si se fue
// y los números del grupo. La lista de miembros se saca una vez por día del WhatsApp del negocio
// (solo leyendo) o al tocar Actualizar. WhatsApp no guarda historial: las salidas se ven desde la
// primera foto en adelante.

const QUIEN = {
    cliente: 'Cliente',
    prospecto: 'Prospecto',
    proveedor: 'Proveedor',
    sin_identificar: 'Sin identificar',
};

function fecha(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
}

function fechaHora(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Etiqueta corta para la lista de chats. Solo se muestra si está o si se fue. */
export function BadgeGrupoAvisos({ ga }) {
    if (ga?.estado === 'miembro') return <Badge tone="muted">En avisos</Badge>;
    if (ga?.estado === 'salio') return <Badge tone="danger">Se fue de avisos</Badge>;
    return null;
}

/** Frase para la ficha del contacto. */
export function textoGrupoAvisos(ga) {
    if (!ga) return null;
    if (ga.estado === 'miembro') {
        return ga.desde_foto_inicial
            ? `Está en el grupo de avisos (ya estaba el ${fecha(ga.desde)}, cuando se empezó a registrar).`
            : `Está en el grupo de avisos desde el ${fecha(ga.desde)}.`;
    }
    if (ga.estado === 'salio') return `Se fue del grupo de avisos el ${fecha(ga.salio_at)}.`;
    return 'No está en el grupo de avisos.';
}

export default function GrupoAvisosModal({ t, open, onClose, showToast, onActualizado }) {
    const [datos, setDatos] = useState(null);
    const [error, setError] = useState(null);
    const [actualizando, setActualizando] = useState(false);
    const [verTodos, setVerTodos] = useState(false);

    const cargar = useCallback(async () => {
        const res = await api.get('/clientes/grupo-avisos');
        if (!res.success) { setError(res.error || 'No se pudieron cargar los números del grupo'); return; }
        setError(null);
        setDatos(res.data);
    }, []);
    useEffect(() => { if (open) { setVerTodos(false); cargar(); } }, [open, cargar]);

    const actualizar = async () => {
        setActualizando(true);
        const res = await api.post('/clientes/grupo-avisos/actualizar', {});
        setActualizando(false);
        if (!res.success) { showToast?.(res.error || 'No se pudo actualizar el grupo', 'error'); return; }
        const r = res.data;
        showToast?.(r.inicial
            ? `Listo: ${fmtInt(r.total)} miembros. Desde ahora se registra quién entra y quién se va.`
            : `Listo: ${fmtInt(r.total)} miembros · ${fmtInt(r.entraron)} entraron · ${fmtInt(r.salieron)} se fueron`, 'success');
        await cargar();
        onActualizado?.();
    };

    const comp = datos?.composicion;
    const movs = datos?.movimientos || [];
    const movsVisibles = verTodos ? movs : movs.slice(0, 12);
    const celda = { padding: '6px 8px', borderBottom: `1px solid ${t.color.border}`, textAlign: 'left', fontSize: t.font.size.sm };
    const num = { ...celda, textAlign: 'right', ...t.numericStyle };

    return (
        <Modal isOpen={open} onClose={onClose} width={640}
            title={`Grupo de avisos${datos?.nombre ? ` · ${datos.nombre}` : ''}`}
            subtitle={datos?.ultima ? `Última foto de miembros: ${fechaHora(datos.ultima)} · se registra desde el ${fecha(datos.desde)}` : 'Comunidad Neggo Polirrubros'}
            footer={(
                <>
                    <Button variant="secondary" onClick={onClose}>Cerrar</Button>
                    <Button onClick={actualizar} disabled={actualizando}>{actualizando ? 'Actualizando…' : 'Actualizar ahora'}</Button>
                </>
            )}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[8], fontFamily: t.font.family, color: t.color.text }}>
                {error && <div style={{ color: t.color.danger, fontSize: t.font.size.sm }}>{error}</div>}
                {!error && !datos && <div style={{ color: t.color.textMuted, fontSize: t.font.size.sm }}>Cargando…</div>}
                {datos?.sin_fotos && (
                    <div style={{ color: t.color.textMuted, fontSize: t.font.size.sm, lineHeight: 1.5 }}>
                        Todavía no hay ninguna foto del grupo. Tocá <b>Actualizar ahora</b> para sacar la primera: desde ahí se registra quién entra y quién se va.
                    </div>
                )}
                {datos && !datos.sin_fotos && (
                    <>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: t.space[6] }}>
                            <Stat label="Miembros" value={fmtInt(datos.total)} />
                            <Stat label="Entraron (7 días)" value={fmtInt(datos.entraron_7)} hint={`${fmtInt(datos.entraron_30)} en 30 días`} />
                            <Stat label="Se fueron (7 días)" value={fmtInt(datos.salieron_7)} hint={`${fmtInt(datos.salieron_30)} en 30 días`} />
                        </div>
                        {comp && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[2] }}>
                                <span style={{ fontWeight: t.font.weight.semibold, fontSize: t.font.size.sm }}>Quiénes son</span>
                                <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap' }}>
                                    <Badge tone="success">{fmtInt(comp.cliente)} clientes</Badge>
                                    <Badge tone="primary">{fmtInt(comp.prospecto)} prospectos</Badge>
                                    {comp.proveedor > 0 && <Badge tone="muted">{fmtInt(comp.proveedor)} proveedores</Badge>}
                                    <Badge tone="muted">{fmtInt(comp.sin_identificar)} sin identificar</Badge>
                                </div>
                                {!datos.odoo_ok && <span style={{ fontSize: t.font.size.xs, color: t.color.warn }}>No se pudo consultar Odoo: los clientes pueden figurar como sin identificar.</span>}
                            </div>
                        )}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[2] }}>
                            <span style={{ fontWeight: t.font.weight.semibold, fontSize: t.font.size.sm }}>Entradas y salidas</span>
                            {movs.length === 0 ? (
                                <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted }}>
                                    Nadie entró ni se fue desde el {fecha(datos.desde)}. WhatsApp no guarda el historial de antes.
                                </span>
                            ) : (
                                <div style={{ overflowX: 'auto' }}>
                                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                        <thead>
                                            <tr style={{ color: t.color.textMuted }}>
                                                <th style={celda}>Fecha</th>
                                                <th style={celda}>Quién</th>
                                                <th style={celda}>Movimiento</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {movsVisibles.map((m, i) => (
                                                <tr key={`${m.fecha}-${m.numero}-${i}`}>
                                                    <td style={{ ...celda, whiteSpace: 'nowrap', ...t.numericStyle }}>{fecha(m.fecha)}</td>
                                                    <td style={celda}>
                                                        <div style={{ fontWeight: t.font.weight.medium }}>{m.nombre || QUIEN[m.quien] || 'Sin identificar'}</div>
                                                        <div style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textMuted }}>
                                                            {m.numero || 'sin número'}{m.nombre ? ` · ${QUIEN[m.quien] || ''}` : ''}
                                                        </div>
                                                    </td>
                                                    <td style={celda}>
                                                        {m.tipo === 'salio' ? <Badge tone="danger">Se fue</Badge> : <Badge tone="success">Entró</Badge>}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                    {movs.length > movsVisibles.length && (
                                        <div style={{ paddingTop: t.space[2] }}>
                                            <Button size="sm" variant="secondary" onClick={() => setVerTodos(true)}>Ver las {fmtInt(movs.length)}</Button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                        {datos.por_dia.length > 1 && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[2] }}>
                                <span style={{ fontWeight: t.font.weight.semibold, fontSize: t.font.size.sm }}>Día por día</span>
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead>
                                        <tr style={{ color: t.color.textMuted }}>
                                            <th style={celda}>Día</th>
                                            <th style={{ ...num }}>Miembros</th>
                                            <th style={{ ...num }}>Entraron</th>
                                            <th style={{ ...num }}>Se fueron</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {datos.por_dia.map((d) => (
                                            <tr key={d.dia}>
                                                <td style={{ ...celda, ...t.numericStyle }}>{d.dia.split('-').reverse().slice(0, 2).join('/')}</td>
                                                <td style={num}>{fmtInt(d.total)}</td>
                                                <td style={{ ...num, color: d.altas ? t.color.success : t.color.textMuted }}>{fmtInt(d.altas)}</td>
                                                <td style={{ ...num, color: d.bajas ? t.color.danger : t.color.textMuted }}>{fmtInt(d.bajas)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                        <span style={{ fontSize: t.font.size.xs, color: t.color.textMuted, lineHeight: 1.5 }}>
                            La lista se saca del WhatsApp del negocio una vez por día (8:30) o al tocar Actualizar, sin mandar nada.
                            Si alguien entra y se va el mismo día entre dos fotos, no se ve.
                        </span>
                    </>
                )}
            </div>
        </Modal>
    );
}
