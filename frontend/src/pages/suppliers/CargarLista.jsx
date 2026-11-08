import { useState, useEffect, useRef } from 'react';
import api from '../../api/client';
import Button from '../../components/common/Button';
import * as Icon from '../../components/common/icons';

// Carga de una lista de precios en Excel (nota 175).
// 1. Elegís el .xlsx → el backend lo lee y cuenta qué pasaría (no cambia nada todavía).
// 2. "Cargar lista" → queda como lista vigente y corre igual que un scrapeo (se ve en Scraping).
// La lista vale hasta que llegue la próxima: no se vence por tiempo.

function fecha(iso) {
    if (!iso) return '—';
    try {
        return new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso));
    } catch { return '—'; }
}

const precio = n => (n == null ? '—' : `$ ${Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 })}`);

export default function CargarLista({ supplier, tokens: t, onCargada }) {
    const inputRef = useRef(null);
    const [archivo, setArchivo] = useState(null);
    const [leyendo, setLeyendo] = useState(false);
    const [resumen, setResumen] = useState(null);
    const [error, setError] = useState(null);
    const [run, setRun] = useState(null); // { runId, status, ... }
    const vigente = supplier?.scrape_config?.lista || null;

    // Seguir la carga hasta que termine
    useEffect(() => {
        if (!run?.runId || !['queued', 'running'].includes(run.status)) return undefined;
        const timer = setTimeout(async () => {
            const res = await api.get(`/scraping/runs/${run.runId}`);
            if (!res.success) return;
            setRun(prev => ({ ...prev, ...res.data, runId: prev.runId }));
            if (!['queued', 'running'].includes(res.data.status)) onCargada?.(res.data);
        }, 2000);
        return () => clearTimeout(timer);
    }, [run, onCargada]);

    async function elegir(e) {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        setArchivo(file);
        setResumen(null);
        setError(null);
        setRun(null);
        setLeyendo(true);
        const fd = new FormData();
        fd.append('archivo', file);
        const res = await api.post(`/suppliers/${supplier.id}/lista/previsualizar`, fd);
        setLeyendo(false);
        if (res.success) setResumen(res.data);
        else setError(res.error || 'No se pudo leer la lista');
    }

    async function confirmar() {
        setError(null);
        const res = await api.post(`/suppliers/${supplier.id}/lista/confirmar`, { nombre: archivo?.name || resumen?.nombre });
        if (res.success) {
            setRun({ runId: res.data.runId, status: 'queued' });
            setResumen(null);
        } else {
            setError(res.error || 'No se pudo cargar la lista');
        }
    }

    const text = { fontSize: t.font.size.sm, color: t.color.text, fontFamily: t.font.family, lineHeight: 1.5 };
    const hint = { fontSize: t.font.size.xs, color: t.color.textMuted, fontFamily: t.font.family, lineHeight: 1.5 };
    const num = { ...t.numericStyle, fontWeight: t.font.weight.semibold };
    const caja = tone => ({
        ...text,
        background: tone === 'danger' ? t.color.dangerSoft : tone === 'warn' ? t.color.warnSoft : t.color.surface2,
        color: tone === 'danger' ? t.color.danger : tone === 'warn' ? t.color.warn : t.color.text,
        border: `1px solid ${tone === 'danger' ? `${t.color.danger}33` : tone === 'warn' ? `${t.color.warn}33` : t.color.border}`,
        padding: '10px 14px', borderRadius: t.radius.sm,
    });

    const filaResumen = (label, valor, color) => (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: t.space[3] }}>
            <span style={{ ...text, color: t.color.textMuted }}>{label}</span>
            <span style={{ ...num, ...text, color: color || t.color.text }}>{valor}</span>
        </div>
    );

    const enCurso = run && ['queued', 'running'].includes(run.status);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[3] }}>
            <div style={hint}>
                {vigente
                    ? <>Lista vigente: <b style={{ color: t.color.text }}>{vigente.nombre || 'sin nombre'}</b>, subida el {fecha(vigente.subida_at)}. Vale hasta que cargues la próxima.</>
                    : 'Todavía no se cargó ninguna lista desde acá.'}
            </div>

            <input ref={inputRef} type="file" accept=".xlsx" onChange={elegir} style={{ display: 'none' }} />
            <div>
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    leftIcon={<Icon.FileText size={14} />}
                    disabled={leyendo || enCurso}
                    onClick={() => inputRef.current?.click()}
                >
                    {leyendo ? 'Leyendo la lista…' : 'Subir lista nueva (.xlsx)'}
                </Button>
            </div>

            {error && <div style={caja('danger')}>{error}</div>}

            {resumen && (
                <div style={{ ...caja(), display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ fontWeight: t.font.weight.semibold }}>
                        {resumen.nombre} · <span style={num}>{resumen.filas}</span> productos
                    </div>
                    {filaResumen('Nuevos', resumen.nuevos, resumen.nuevos ? t.color.primary : undefined)}
                    {filaResumen('Suben de precio', resumen.suben, resumen.suben ? t.color.danger : undefined)}
                    {filaResumen('Bajan de precio', resumen.bajan, resumen.bajan ? t.color.success : undefined)}
                    {filaResumen('Sin cambios', resumen.iguales)}
                    {resumen.reaparecen > 0 && filaResumen('Vuelven (estaban archivados)', resumen.reaparecen)}
                    {filaResumen('No vinieron (se archivan)', resumen.se_archivan, resumen.se_archivan ? t.color.warn : undefined)}
                    {filaResumen('Sin foto', resumen.sin_foto)}
                    {resumen.salteadas?.length > 0 && (
                        <div style={hint}>
                            Filas salteadas: {resumen.salteadas.slice(0, 4).map(s => `${s.fila} (${s.motivo})`).join(' · ')}
                            {resumen.salteadas.length > 4 && ` y ${resumen.salteadas.length - 4} más`}
                        </div>
                    )}
                    {resumen.ejemplos?.se_archivan?.length > 0 && (
                        <div style={hint}>
                            No vinieron, por ejemplo: {resumen.ejemplos.se_archivan.slice(0, 5).map(e => e.nombre).join(' · ')}
                        </div>
                    )}
                    {[...(resumen.ejemplos?.suben || []), ...(resumen.ejemplos?.bajan || [])].slice(0, 4).map(e => (
                        <div key={`${e.nombre}-${e.antes}`} style={hint}>
                            {e.nombre}: <span style={t.numericStyle}>{precio(e.antes)} → {precio(e.ahora)}</span>
                        </div>
                    ))}
                    <div style={{ ...hint, marginTop: 4 }}>
                        Lo que no vino queda archivado en la app (no se borra) y Sync Preventas propone archivarlo en Odoo.
                        Si vuelve en otra lista, se reactiva.
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: t.space[2], marginTop: 4 }}>
                        <Button type="button" variant="ghost" size="sm" onClick={() => { setResumen(null); setArchivo(null); }}>
                            Cancelar
                        </Button>
                        <Button type="button" variant="primary" size="sm" onClick={confirmar}>
                            Cargar lista
                        </Button>
                    </div>
                </div>
            )}

            {run && (
                <div style={caja(run.status === 'failed' ? 'danger' : run.status === 'partial' ? 'warn' : undefined)}>
                    {enCurso && <>Cargando la lista… (run {run.runId}). Podés seguirla en Scraping.</>}
                    {run.status === 'completed' && (
                        <>
                            Lista cargada: <span style={num}>{run.products_found}</span> productos,{' '}
                            <span style={num}>{run.products_new}</span> nuevos,{' '}
                            <span style={num}>{run.price_changes}</span> cambios de precio.
                            Revisá Sync Preventas para pasarlo a Precompras.
                        </>
                    )}
                    {run.status === 'partial' && <>La lista se cargó con errores (run {run.runId}): mirá el detalle en Scraping.</>}
                    {run.status === 'failed' && <>No se pudo cargar la lista (run {run.runId}): mirá el detalle en Scraping.</>}
                </div>
            )}
        </div>
    );
}
