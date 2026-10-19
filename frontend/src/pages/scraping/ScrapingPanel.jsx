import { useState, useEffect, useRef } from 'react';
import api from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { useScrapingContext } from '../../context/ScrapingContext';
import { useTheme } from '../../theme/ThemeContext';
import { fmtAR } from '../../theme/tokens';
import Card from '../../components/common/Card';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import DataTable from '../../components/common/DataTable';
import Modal from '../../components/common/Modal';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import * as Icon from '../../components/common/icons';

function statusTone(s) {
    if (!s) return 'muted';
    if (s === 'completed' || s === 'active') return 'success';
    if (s === 'failed') return 'danger';
    if (s === 'running' || s === 'queued' || s === 'in_progress' || s === 'starting') return 'primary';
    if (s === 'paused' || s === 'staging' || s === 'warning') return 'warn';
    return 'muted';
}

export default function ScrapingPanel() {
    const { tokens: t } = useTheme();
    const { showToast } = useToast();
    const { activeRuns, pausedRuns, startRun, resumeRun, pauseRun, cancelAllRuns, syncPausedRuns, batchRunning, batchProgress, startBatchRun, stopBatchRun } = useScrapingContext();

    const [suppliers, setSuppliers] = useState([]);
    const [runs, setRuns] = useState([]);
    const [runsLoading, setRunsLoading] = useState(true);
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [previewOpen, setPreviewOpen] = useState(false);
    const [previewSupplier, setPreviewSupplier] = useState(null);
    const [previewProducts, setPreviewProducts] = useState([]);
    const [previewCount, setPreviewCount] = useState(0);
    const [previewDone, setPreviewDone] = useState(false);
    const [previewError, setPreviewError] = useState(null);
    const [detailRun, setDetailRun] = useState(null);
    const [confirmCancel, setConfirmCancel] = useState(false);
    const previewAbortRef = useRef(null);
    const runsRefreshRef = useRef(null);

    useEffect(() => {
        fetchSuppliers();
        fetchRuns();
        return () => {
            previewAbortRef.current?.abort();
            if (runsRefreshRef.current) clearInterval(runsRefreshRef.current);
        };
    }, []);

    useEffect(() => { fetchRuns(); }, [page]);

    useEffect(() => {
        if (runsRefreshRef.current) { clearInterval(runsRefreshRef.current); runsRefreshRef.current = null; }
        if (Object.keys(activeRuns).length > 0) runsRefreshRef.current = setInterval(fetchRuns, 3000);
        return () => { if (runsRefreshRef.current) clearInterval(runsRefreshRef.current); };
    }, [activeRuns]);

    async function fetchSuppliers() {
        const res = await api.get('/suppliers');
        if (res.success) setSuppliers(res.data || []);
    }

    async function fetchRuns() {
        setRunsLoading(true);
        const res = await api.get('/scraping/runs', { limit: 20, offset: (page - 1) * 20 });
        if (res.success) {
            const data = res.data || [];
            setRuns(data);
            setTotal(res.pagination?.total || data.length);
            syncPausedRuns(data);
        }
        setRunsLoading(false);
    }

    async function handleRun(supplier) {
        const r = await startRun(supplier);
        if (!r.success) showToast(r.error || 'Error al iniciar scraper', 'error');
    }

    async function handleResume(supplier) {
        const r = await resumeRun(supplier);
        if (!r.success) { showToast(r.error || 'Error al reanudar', 'error'); fetchRuns(); }
        else showToast(`Reanudando desde categoría ${(r.skippedCategories || 0) + 1}`, 'success');
    }

    async function handlePause(supplierId) {
        const r = await pauseRun(supplierId);
        if (r?.success) { showToast('Scraper pausado', 'warning'); fetchRuns(); }
        else if (r) showToast(r.error || 'No se pudo pausar', 'error');
    }

    async function handlePreview(supplier) {
        previewAbortRef.current?.abort();
        setPreviewSupplier(supplier);
        setPreviewProducts([]); setPreviewCount(0);
        setPreviewDone(false); setPreviewError(null);
        setPreviewOpen(true);

        const ctrl = new AbortController();
        previewAbortRef.current = ctrl;
        const token = api.getToken();
        try {
            const response = await fetch(`/api/scraping/${supplier.id}/run-preview`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                signal: ctrl.signal,
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    try {
                        const data = JSON.parse(line.slice(6));
                        if (data.index) { setPreviewCount(data.index); setPreviewProducts(prev => [data, ...prev].slice(0, 10)); }
                        else if (data.found !== undefined) setPreviewDone(true);
                        else if (data.message && line.includes('error')) setPreviewError(data.message);
                    } catch {}
                }
            }
        } catch (err) {
            if (err.name !== 'AbortError') setPreviewError(err.message);
        } finally { previewAbortRef.current = null; }
        setPreviewDone(true);
    }

    function handleClosePreview() {
        previewAbortRef.current?.abort();
        setPreviewOpen(false);
    }

    async function handlePromote(supplier) {
        const r = await api.post(`/suppliers/${supplier.id}/promote`);
        if (r.success) { showToast(`${supplier.name} activado`, 'success'); fetchSuppliers(); }
        else showToast(r.error || 'Error', 'error');
    }

    async function handleStage(supplier) {
        const r = await api.post(`/suppliers/${supplier.id}/stage`);
        if (r.success) { showToast(`${supplier.name} movido a staging`, 'success'); fetchSuppliers(); }
        else showToast(r.error || 'Error', 'error');
    }

    async function handleCancelAll() {
        const r = await cancelAllRuns();
        if (r?.success) { showToast(`${r.data?.cancelledRuns ?? 0} scrapers cancelados`, 'warning'); fetchRuns(); }
        else showToast(r?.error || 'Error al cancelar', 'error');
        setConfirmCancel(false);
    }

    const anyRunning = Object.keys(activeRuns).length > 0;
    const activeSuppliers = suppliers.filter(s => s.status === 'active');
    const batchPct = batchProgress.total > 0
        ? Math.round((batchProgress.current / batchProgress.total) * 100)
        : 0;

    const runCols = [
        { key: 'supplier_name', label: 'Proveedor' },
        { key: 'status', label: 'Estado', render: v => <Badge tone={statusTone(v)} dot>{v || '—'}</Badge> },
        { key: 'products_found',   label: 'Encontrados',    render: v => <span style={t.numericStyle}>{v ?? '—'}</span> },
        { key: 'products_new',     label: 'Nuevos',         render: v => <span style={t.numericStyle}>{v ?? '—'}</span> },
        { key: 'products_updated', label: 'Actualizados',   render: v => <span style={t.numericStyle}>{v ?? '—'}</span> },
        { key: 'price_changes',    label: 'Cambios precio', render: v => <span style={t.numericStyle}>{v ?? '—'}</span> },
        { key: 'started_at',       label: 'Inicio',         render: v => v ? new Date(v).toLocaleString('es-AR') : '—' },
    ];

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>

            {/* Cabecera con acciones batch */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: t.space[3], flexWrap: 'wrap' }}>
                {!batchRunning && !anyRunning && (
                    <Button
                        variant="success"
                        leftIcon={<Icon.Activity size={15} />}
                        disabled={activeSuppliers.length === 0}
                        onClick={() => startBatchRun(activeSuppliers)}
                    >
                        Ejecutar todos ({activeSuppliers.length})
                    </Button>
                )}

                {batchRunning && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: t.space[5] }}>
                        <div style={{ fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                            <span style={{ fontWeight: t.font.weight.semibold, color: t.color.text, ...t.numericStyle }}>
                                {batchProgress.current}/{batchProgress.total}
                            </span>
                            {batchProgress.currentSupplierName && ` — ${batchProgress.currentSupplierName}`}
                        </div>
                        <div style={{ width: 120, height: 6, background: t.color.surface2, borderRadius: t.radius.full, overflow: 'hidden' }}>
                            <div style={{ width: `${batchPct}%`, height: '100%', background: t.color.success, borderRadius: t.radius.full, transition: 'width 0.4s ease' }} />
                        </div>
                        <Button size="sm" variant="danger" onClick={stopBatchRun}>Detener</Button>
                    </div>
                )}

                {anyRunning && (
                    <Button variant="danger" leftIcon={<Icon.X size={14} />} onClick={() => setConfirmCancel(true)}>
                        Cancelar todo
                    </Button>
                )}
            </div>

            {/* Tabla de proveedores */}
            <Card padding={false}>
                <div style={{ padding: `16px ${t.layout.cardPadX}px`, borderBottom: `1px solid ${t.color.border}` }}>
                    <span style={{ fontSize: 15, fontWeight: t.font.weight.semibold, color: t.color.text, fontFamily: t.font.family }}>
                        Proveedores
                    </span>
                </div>
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: t.font.size.sm }}>
                        <thead>
                            <tr style={{ background: t.color.surface2 }}>
                                {['Nombre', 'Prefijo', 'Estado', 'Último scraping', 'Acciones'].map(h => (
                                    <th key={h} style={{
                                        padding: '10px 16px', textAlign: 'left',
                                        fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold,
                                        color: t.color.textMuted, textTransform: 'uppercase',
                                        letterSpacing: '0.04em', whiteSpace: 'nowrap',
                                        fontFamily: t.font.family,
                                    }}>
                                        {h}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {suppliers.map(sup => {
                                const rid = activeRuns[sup.id];
                                const isRunning = !!rid;
                                const isPaused = !!pausedRuns[sup.id];
                                return (
                                    <tr key={sup.id} style={{ borderTop: `1px solid ${t.color.border}` }}>
                                        <td style={{ padding: '12px 16px', fontWeight: t.font.weight.medium, color: t.color.text, fontFamily: t.font.family }}>
                                            {sup.name}
                                        </td>
                                        <td style={{ padding: '12px 16px' }}>
                                            <span style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textFaint }}>
                                                {sup.prefix}
                                            </span>
                                        </td>
                                        <td style={{ padding: '12px 16px' }}>
                                            <Badge tone={statusTone(sup.status)} dot>{sup.status || '—'}</Badge>
                                        </td>
                                        <td style={{ padding: '12px 16px', fontSize: t.font.size.sm, color: t.color.textMuted, fontFamily: t.font.family }}>
                                            {sup.last_scraped_at ? new Date(sup.last_scraped_at).toLocaleString('es-AR') : '—'}
                                        </td>
                                        <td style={{ padding: '12px 16px' }}>
                                            <div style={{ display: 'flex', gap: t.space[2], flexWrap: 'wrap' }}>
                                                {!isRunning && !isPaused && (
                                                    <Button size="sm" variant="primary" leftIcon={<Icon.Activity size={13} />} onClick={() => handleRun(sup)}>
                                                        Ejecutar
                                                    </Button>
                                                )}
                                                {isRunning && (
                                                    <>
                                                        <Button size="sm" variant="primary" disabled>
                                                            Ejecutando…
                                                        </Button>
                                                        {rid !== 'starting' && (
                                                            <Button size="sm" variant="secondary" onClick={() => handlePause(sup.id)}>
                                                                Pausar
                                                            </Button>
                                                        )}
                                                    </>
                                                )}
                                                {!isRunning && isPaused && (
                                                    <>
                                                        <Button size="sm" variant="success" onClick={() => handleResume(sup)}>
                                                            Continuar
                                                        </Button>
                                                        <Button size="sm" variant="ghost" onClick={() => handleRun(sup)}>
                                                            Reiniciar
                                                        </Button>
                                                    </>
                                                )}
                                                {!isRunning && (
                                                    <Button size="sm" variant="ghost" leftIcon={<Icon.Search size={13} />} onClick={() => handlePreview(sup)}>
                                                        Preview
                                                    </Button>
                                                )}
                                                {sup.status === 'staging' && (
                                                    <Button size="sm" variant="success" leftIcon={<Icon.Check size={13} />} onClick={() => handlePromote(sup)}>
                                                        Activar
                                                    </Button>
                                                )}
                                                {sup.status === 'active' && (
                                                    <Button size="sm" variant="ghost" onClick={() => handleStage(sup)}>
                                                        Staging
                                                    </Button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </Card>

            {/* Historial */}
            <Card padding={false}>
                <div style={{ padding: `16px ${t.layout.cardPadX}px`, borderBottom: `1px solid ${t.color.border}` }}>
                    <span style={{ fontSize: 15, fontWeight: t.font.weight.semibold, color: t.color.text, fontFamily: t.font.family }}>
                        Historial de ejecuciones
                    </span>
                </div>
                <div style={{ padding: t.space[5] }}>
                    <DataTable
                        columns={runCols}
                        data={runs}
                        loading={runsLoading}
                        onRowClick={row => setDetailRun(row)}
                        pagination={{ page, pageSize: 20, total }}
                        onPageChange={setPage}
                    />
                </div>
            </Card>

            {/* Confirm cancelar todo */}
            <ConfirmDialog
                isOpen={confirmCancel}
                onClose={() => setConfirmCancel(false)}
                onConfirm={handleCancelAll}
                title="Cancelar todos los scrapers"
                message="¿Cancelás TODOS los scrapers activos? Esta acción no se puede deshacer."
                confirmLabel="Cancelar todo"
                danger
            />

            {/* Modal preview SSE */}
            <Modal
                isOpen={previewOpen}
                onClose={handleClosePreview}
                title={`Preview — ${previewSupplier?.name}`}
                size="lg"
            >
                <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[5] }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: t.space[5] }}>
                        <div>
                            <span style={{ fontSize: t.font.size['2xl'], fontWeight: t.font.weight.semibold, color: t.color.text, ...t.numericStyle }}>
                                {previewCount}
                            </span>
                            <span style={{ fontSize: t.font.size.sm, color: t.color.textMuted, marginLeft: t.space[2], fontFamily: t.font.family }}>
                                productos encontrados
                            </span>
                        </div>
                        {!previewDone && <Badge tone="primary" dot>Scrapeando…</Badge>}
                        {previewDone && !previewError && <Badge tone="success" dot>Completado</Badge>}
                        {previewError && <Badge tone="danger">Error: {previewError}</Badge>}
                    </div>

                    {previewProducts.length > 0 && (
                        <div style={{ border: `1px solid ${t.color.border}`, borderRadius: t.radius.sm, overflow: 'hidden' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: t.font.size.sm }}>
                                <thead>
                                    <tr style={{ background: t.color.surface2 }}>
                                        {['#', 'Nombre', 'SKU', 'Precio', 'Categoría'].map(h => (
                                            <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: t.font.size.xs, fontWeight: t.font.weight.semibold, color: t.color.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em', fontFamily: t.font.family }}>
                                                {h}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {previewProducts.map((p, i) => (
                                        <tr key={i} style={{ borderTop: `1px solid ${t.color.border}` }}>
                                            <td style={{ padding: '8px 12px', color: t.color.textFaint, ...t.numericStyle }}>{p.index}</td>
                                            <td style={{ padding: '8px 12px', color: t.color.text, fontFamily: t.font.family }}>{p.name}</td>
                                            <td style={{ padding: '8px 12px' }}>
                                                <span style={{ fontFamily: t.font.mono, fontSize: t.font.size.xs, color: t.color.textFaint }}>{p.sku}</span>
                                            </td>
                                            <td style={{ padding: '8px 12px', ...t.numericStyle, color: t.color.text }}>
                                                {p.raw_price ? fmtAR(p.raw_price) : '—'}
                                            </td>
                                            <td style={{ padding: '8px 12px', color: t.color.textMuted, fontFamily: t.font.family }}>{p.source_category || '—'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </Modal>

            {/* Modal detalle de run */}
            <Modal
                isOpen={!!detailRun}
                onClose={() => setDetailRun(null)}
                title="Detalle de ejecución"
                subtitle={detailRun?.supplier_name}
                size="md"
            >
                {detailRun && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: t.space[6] }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: `${t.space[3]}px ${t.space[5]}px`, alignItems: 'center' }}>
                            {[
                                ['Estado',        <Badge tone={statusTone(detailRun.status)} dot>{detailRun.status}</Badge>],
                                ['Inicio',        detailRun.started_at  ? new Date(detailRun.started_at).toLocaleString('es-AR')  : '—'],
                                ['Fin',           detailRun.finished_at ? new Date(detailRun.finished_at).toLocaleString('es-AR') : '—'],
                                ['Encontrados',   <span style={t.numericStyle}>{detailRun.products_found   ?? '—'}</span>],
                                ['Nuevos',        <span style={t.numericStyle}>{detailRun.products_new     ?? '—'}</span>],
                                ['Actualizados',  <span style={t.numericStyle}>{detailRun.products_updated ?? '—'}</span>],
                                ['Cambios precio',<span style={t.numericStyle}>{detailRun.price_changes    ?? '—'}</span>],
                            ].map(([label, value]) => (
                                <>
                                    <span style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.medium, color: t.color.textMuted, fontFamily: t.font.family }}>
                                        {label}
                                    </span>
                                    <span style={{ fontSize: t.font.size.sm, color: t.color.text, fontFamily: t.font.family }}>
                                        {value}
                                    </span>
                                </>
                            ))}
                        </div>

                        {detailRun.errors?.length > 0 && (
                            <div>
                                <div style={{ fontSize: t.font.size.sm, fontWeight: t.font.weight.semibold, color: t.color.danger, marginBottom: t.space[2], fontFamily: t.font.family }}>
                                    Errores ({detailRun.errors.length})
                                </div>
                                <div style={{
                                    background: t.color.dangerSoft,
                                    border: `1px solid ${t.color.danger}33`,
                                    borderRadius: t.radius.sm,
                                    padding: t.space[5],
                                    maxHeight: 200, overflowY: 'auto',
                                }}>
                                    {detailRun.errors.map((e, i) => (
                                        <div key={i} style={{ marginBottom: t.space[2], fontSize: t.font.size.sm, fontFamily: t.font.family, color: t.color.danger }}>
                                            <span style={{ fontWeight: t.font.weight.semibold }}>{e.category || e.phase || e.product || 'Error'}</span>
                                            {': '}{e.error}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </Modal>
        </div>
    );
}
