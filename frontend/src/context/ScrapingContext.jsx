import { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react';
import api from '../api/client';

const ScrapingContext = createContext(null);

export function useScrapingContext() {
    return useContext(ScrapingContext);
}

/**
 * ScrapingProvider — contexto global de scraping.
 *
 * Sobrevive a la navegación entre páginas porque vive en main.jsx.
 * El Layout consume el terminal state para renderizarlo globalmente.
 * ScrapingPanel consume las funciones de control.
 * SupplierProducts consume activeRuns para saber si refrescar.
 */
export function ScrapingProvider({ children }) {
    // supplierId → runId  (runs activos en ESTE cliente)
    const [activeRuns, setActiveRuns] = useState({});
    // supplierId → { runId }  (runs pausados según historial)
    const [pausedRuns, setPausedRuns] = useState({});

    // ─── Batch run (scraping secuencial de todos los proveedores) ────────────────
    const batchQueueRef      = useRef([]);          // proveedores pendientes en la cola
    const startNextBatchRef  = useRef(null);        // ref estable para evitar stale closures
    const [batchRunning,  setBatchRunning]  = useState(false);
    const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0, currentSupplierName: null });

    // Estado de la terminal
    const [terminal, setTerminal] = useState({
        open: false,
        supplierId: null,
        supplierName: null,
        runId: null,
        lines: [],
        done: false,
        status: null,
        productCount: 0,
    });

    const esRef = useRef(null);       // AbortController de la SSE activa
    const pollRefs = useRef({});      // timers de polling por supplierId

    // Cleanup al desmontar: cancelar SSE y todos los timers de polling
    useEffect(() => {
        return () => {
            if (esRef.current) { esRef.current.abort(); esRef.current = null; }
            Object.values(pollRefs.current).forEach(t => clearTimeout(t));
            pollRefs.current = {};
        };
    }, []);

    // Actualizar CSS custom property cuando se abre/cierra la terminal
    // Esto evita que Layout se suscriba al context y re-renderice en cada log line
    useEffect(() => {
        document.documentElement.style.setProperty(
            '--scraping-terminal-padding',
            terminal.open ? '260px' : '0px'
        );
    }, [terminal.open]);

    // ─── Helpers ────────────────────────────────────────────────────────────────

    function setActive(supplierId, runId) {
        setActiveRuns(p => ({ ...p, [supplierId]: runId }));
    }

    function clearActive(supplierId) {
        setActiveRuns(p => { const n = { ...p }; delete n[supplierId]; return n; });
    }

    // ─── SSE: conectar al stream de logs de un run ───────────────────────────────

    const openTerminal = useCallback((supplier, runId) => {
        // Cerrar SSE anterior
        if (esRef.current) { esRef.current.abort(); esRef.current = null; }

        setTerminal({
            open: true,
            supplierId: supplier.id,
            supplierName: supplier.name,
            runId,
            lines: [],
            done: false,
            status: null,
            productCount: 0,
        });

        const token = api.getToken();
        const ctrl = new AbortController();
        esRef.current = ctrl;

        (async () => {
            try {
                const resp = await fetch(`/api/scraping/runs/${runId}/logs`, {
                    headers: { 'Authorization': `Bearer ${token}` },
                    signal: ctrl.signal,
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

                const reader = resp.body.getReader();
                const decoder = new TextDecoder();
                let buf = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buf += decoder.decode(value, { stream: true });
                    const parts = buf.split('\n\n');
                    buf = parts.pop();

                    for (const block of parts) {
                        const blockLines = block.split('\n');
                        const dataLine  = blockLines.find(l => l.startsWith('data: '));
                        const eventLine = blockLines.find(l => l.startsWith('event: '));
                        const event = eventLine ? eventLine.slice(7).trim() : 'message';

                        if (!dataLine) continue;
                        try {
                            const payload = JSON.parse(dataLine.slice(6));

                            if (event === 'done') {
                                setTerminal(t => ({ ...t, done: true, status: payload.status || 'done' }));
                            } else if (payload.line) {
                                const line = payload.line.trim();
                                if (!line) continue;

                                setTerminal(t => {
                                    // Contar productos desde logs de categoría completada
                                    let newCount = t.productCount;
                                    const m = line.match(/Categoría .+ completada: (\d+) productos/);
                                    if (m) newCount += parseInt(m[1], 10);

                                    return { ...t, lines: [...t.lines, line], productCount: newCount };
                                });
                            }
                        } catch {}
                    }
                }
            } catch (err) {
                if (err.name !== 'AbortError') {
                    setTerminal(t => ({ ...t, lines: [...t.lines, `❌ Error de conexión: ${err.message}`], done: true }));
                }
            }
        })();
    }, []);

    const closeTerminal = useCallback(() => {
        if (esRef.current) { esRef.current.abort(); esRef.current = null; }
        setTerminal(t => ({ ...t, open: false }));
    }, []);

    // ─── Polling de run activo ───────────────────────────────────────────────────

    const pollRun = useCallback((supplierId, runId, onComplete) => {
        const timer = setTimeout(async () => {
            const res = await api.get(`/scraping/runs/${runId}`);
            if (res.success && res.data?.status === 'running') {
                pollRun(supplierId, runId, onComplete);
            } else {
                clearActive(supplierId);
                if (onComplete) onComplete(res.data);
            }
        }, 5000);
        pollRefs.current[supplierId] = timer;
    }, []);

    // ─── Iniciar scraping ────────────────────────────────────────────────────────

    const startRun = useCallback(async (supplier) => {
        setActive(supplier.id, 'starting');
        const res = await api.post(`/scraping/${supplier.id}/run`);
        if (!res.success) {
            clearActive(supplier.id);
            return { success: false, error: res.error };
        }
        const runId = res.data?.runId || res.data?.id;
        if (runId) {
            setActive(supplier.id, runId);
            pollRun(supplier.id, runId, (runData) => {
                setPausedRuns(p => {
                    const n = { ...p };
                    if (runData?.status === 'paused') n[supplier.id] = { runId };
                    else delete n[supplier.id];
                    return n;
                });
            });
            openTerminal(supplier, runId);
        }
        return { success: true, runId };
    }, [openTerminal, pollRun]);

    // ─── Reanudar scraping pausado ───────────────────────────────────────────────

    const resumeRun = useCallback(async (supplier) => {
        setActive(supplier.id, 'starting');
        setPausedRuns(p => { const n = { ...p }; delete n[supplier.id]; return n; });

        const res = await api.post(`/scraping/${supplier.id}/resume`);
        if (!res.success) {
            clearActive(supplier.id);
            return { success: false, error: res.error };
        }
        const runId = res.data?.runId;
        if (runId) {
            setActive(supplier.id, runId);
            pollRun(supplier.id, runId, (runData) => {
                setPausedRuns(p => {
                    const n = { ...p };
                    if (runData?.status === 'paused') n[supplier.id] = { runId };
                    else delete n[supplier.id];
                    return n;
                });
            });
            openTerminal(supplier, runId);
        }
        return { success: true, runId, skippedCategories: res.data?.skippedCategories || 0 };
    }, [openTerminal, pollRun]);

    // ─── Pausar run activo ───────────────────────────────────────────────────────

    const pauseRun = useCallback(async (supplierId) => {
        const runId = activeRuns[supplierId];
        if (!runId || runId === 'starting') return { success: false };

        // Cancelar el timer de polling para este proveedor
        if (pollRefs.current[supplierId]) {
            clearTimeout(pollRefs.current[supplierId]);
            delete pollRefs.current[supplierId];
        }

        const res = await api.post(`/scraping/runs/${runId}/pause`);
        if (res.success) {
            clearActive(supplierId);
            // El historial se actualizará via fetchRuns en ScrapingPanel
        }
        return res;
    }, [activeRuns]);

    // ─── Cancelar todo (emergencia) ──────────────────────────────────────────────

    const cancelAllRuns = useCallback(async () => {
        // Limpiar timers de polling
        Object.values(pollRefs.current).forEach(t => clearTimeout(t));
        pollRefs.current = {};

        // Abortar SSE activa
        if (esRef.current) { esRef.current.abort(); esRef.current = null; }

        const res = await api.post('/scraping/cancel-all');

        // Limpiar estado local independientemente del resultado
        setActiveRuns({});
        setPausedRuns({});
        setTerminal(t => ({ ...t, done: true, open: false }));

        return res;
    }, []);

    // ─── Batch: avanzar al siguiente proveedor de la cola ────────────────────────

    const startNextBatch = useCallback(async () => {
        if (batchQueueRef.current.length === 0) {
            setBatchRunning(false);
            setBatchProgress({ current: 0, total: 0, currentSupplierName: null });
            return;
        }

        const supplier = batchQueueRef.current.shift();
        setBatchProgress(p => ({
            ...p,
            current: p.total - batchQueueRef.current.length,
            currentSupplierName: supplier.name,
        }));

        setActive(supplier.id, 'starting');
        const res = await api.post(`/scraping/${supplier.id}/run`);

        if (!res.success) {
            console.error(`⚠️ Batch: error iniciando "${supplier.name}", saltando...`);
            startNextBatchRef.current?.();
            return;
        }

        const runId = res.data?.runId || res.data?.id;
        if (!runId) {
            startNextBatchRef.current?.();
            return;
        }

        setActive(supplier.id, runId);
        openTerminal(supplier, runId);

        pollRun(supplier.id, runId, (runData) => {
            setPausedRuns(p => {
                const n = { ...p };
                if (runData?.status === 'paused') n[supplier.id] = { runId };
                else delete n[supplier.id];
                return n;
            });
            // Cuando termina este run, avanzar al siguiente
            startNextBatchRef.current?.();
        });
    }, [openTerminal, pollRun]);

    // Mantener la ref siempre actualizada (evita stale closures en los callbacks de pollRun)
    startNextBatchRef.current = startNextBatch;

    const startBatchRun = useCallback((suppliers) => {
        if (!suppliers || suppliers.length === 0) return;
        batchQueueRef.current = [...suppliers];
        setBatchRunning(true);
        setBatchProgress({ current: 0, total: suppliers.length, currentSupplierName: null });
        startNextBatchRef.current?.();
    }, []);

    const stopBatchRun = useCallback(() => {
        batchQueueRef.current = [];
        setBatchRunning(false);
        setBatchProgress({ current: 0, total: 0, currentSupplierName: null });
    }, []);

    // ─── Cargar runs pausados desde el historial (llamado por ScrapingPanel) ─────

    const syncPausedRuns = useCallback((runs) => {
        const paused = {};
        const seen = new Set();
        for (const run of runs) {
            if (!seen.has(run.supplier_id)) {
                seen.add(run.supplier_id);
                if (run.status === 'paused') {
                    paused[run.supplier_id] = { runId: run.id };
                }
            }
        }
        setPausedRuns(paused);
    }, []);

    return (
        <ScrapingContext.Provider value={{
            activeRuns,
            pausedRuns,
            terminal,
            startRun,
            resumeRun,
            pauseRun,
            cancelAllRuns,
            openTerminal,
            closeTerminal,
            syncPausedRuns,
            // Batch
            batchRunning,
            batchProgress,
            startBatchRun,
            stopBatchRun,
        }}>
            {children}
        </ScrapingContext.Provider>
    );
}
