const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const BaseScraper = require('./baseScraper');
const scrapingLogs = require('../services/scrapingLogs');

const PYTHON_DIR = path.join(__dirname, 'python');

// Registry de procesos Python activos: runId → ChildProcess
const _activeProcesses = new Map();

/**
 * Mata el proceso Python de un run activo.
 * @param {number} runId
 * @returns {boolean} true si había un proceso activo y fue terminado
 */
function killProcess(runId) {
    const proc = _activeProcesses.get(runId);
    if (!proc) return false;
    proc.kill('SIGTERM');
    _activeProcesses.delete(runId);
    return true;
}

/**
 * Mata TODOS los procesos Python activos.
 * @returns {number} cantidad de procesos terminados
 */
function killAllProcesses() {
    let killed = 0;
    for (const [runId, proc] of _activeProcesses.entries()) {
        proc.kill('SIGTERM');
        _activeProcesses.delete(runId);
        killed++;
    }
    return killed;
}

/**
 * Retorna los runIds de todos los procesos activos.
 */
function getActiveRunIds() {
    return [..._activeProcesses.keys()];
}

/**
 * PythonScraper — clase base para scrapers que delegan en un script Python.
 *
 * Los scripts Python emiten NDJSON por stdout:
 *   {"type":"product", sku, name, raw_price, ...}  — por cada producto
 *   {"type":"category_done", "name":"...", "count":N} — al finalizar una categoría
 *
 * Los productos se upsertean en DB a medida que llegan (sin esperar al final).
 * Los category_done generan checkpoints en scraping_runs.completed_categories.
 */
class PythonScraper extends BaseScraper {

    // Subclases DEBEN implementar:
    get pythonScript() {
        throw new Error(`${this.constructor.name} debe definir pythonScript`);
    }

    // Subclases pueden sobreescribir para pasar env vars al script Python
    get pythonEnv() {
        return {};
    }

    async run(triggeredBy) {
        await this.createRun(triggeredBy);

        try {
            const scriptPath = path.join(PYTHON_DIR, this.pythonScript);
            const env = {
                ...process.env,
                PYTHONUNBUFFERED: '1',
                ...this.pythonEnv
            };

            const msg = `📦 Iniciando ${this.pythonScript} para "${this.supplier.name}"`;
            console.log(msg);
            scrapingLogs.appendLog(this.runId, msg);

            // Capturar timestamp ANTES de iniciar upserts para luego marcar no disponibles
            const runStartedAt = new Date();

            let result;
            try {
                result = await this._runPython(scriptPath, env);
            } catch (err) {
                scrapingLogs.appendLog(this.runId, `❌ Error en script Python: ${err.message}`);
                throw err;
            }

            const { stats, signal } = result;

            // Modo dry-run: no persistir, solo retornar (los onProduct ya fueron llamados)
            if (this.dryRun) {
                return {
                    runId: null,
                    status: 'preview',
                    found: stats.found,
                    newProducts: 0,
                    updated: 0,
                    priceChanges: 0,
                    products: [],
                    errors: this.errors
                };
            }

            // Determinar status final
            let finalStatus;
            if (signal) {
                finalStatus = 'paused';
            } else if (stats.found === 0) {
                // 0 productos = algo falló: nunca 'completed', así no borra los productos guardados
                finalStatus = 'failed';
            } else if (this.errors.length > 0) {
                finalStatus = 'partial';
            } else {
                finalStatus = 'completed';
            }

            // Eliminar los que no aparecieron SOLO si el run recorrió todo el catálogo:
            // un run pausado, con errores o reanudado (salteó categorías) no vio todos los productos.
            const esReanudado = 'SKIP_CATEGORIES' in this.pythonEnv;
            stats.unavailable = (finalStatus === 'completed' && !esReanudado)
                ? await this.markUnavailableSince(runStartedAt)
                : 0;

            await this.updateRun(finalStatus, stats);

            scrapingLogs.appendLog(this.runId,
                `📊 Resumen: ${stats.found} encontrados, ${stats.newProducts} nuevos, ` +
                `${stats.updated} actualizados, ${stats.priceChanges} cambios de precio`
            );
            scrapingLogs.markDone(this.runId, finalStatus);

            return {
                runId: this.runId,
                status: finalStatus,
                ...stats,
                errors: this.errors
            };

        } catch (err) {
            console.error(`❌ [${this.supplier.name}] Error fatal: ${err.message}`);
            this.errors.push({ phase: 'run', error: err.message });

            scrapingLogs.appendLog(this.runId, `❌ Error fatal: ${err.message}`);
            scrapingLogs.markDone(this.runId, 'failed');

            await this.updateRun('failed', {
                found: 0, newProducts: 0, updated: 0, priceChanges: 0
            }).catch(() => {});

            throw err;
        }
    }

    /**
     * Lanza el script Python y procesa NDJSON line by line.
     * Cada {"type":"product"} se upsertea en DB de inmediato.
     * Cada {"type":"category_done"} guarda checkpoint en scraping_runs.
     * Retorna { stats, signal } donde signal es 'SIGTERM' si fue pausado.
     */
    _runPython(scriptPath, env) {
        return new Promise((resolve, reject) => {
            const proc = spawn('python3', [scriptPath], { env });

            if (this.runId && this.runId !== 'preview') {
                _activeProcesses.set(this.runId, proc);
            }

            let stderrBuf = '';
            let signal = null;
            const stats = { found: 0, newProducts: 0, updated: 0, priceChanges: 0 };

            // Cola de upserts serializada para evitar race conditions
            let upsertQueue = Promise.resolve();

            const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });

            rl.on('line', (line) => {
                const trimmed = line.trim();
                if (!trimmed) return;

                upsertQueue = upsertQueue.then(async () => {
                    try {
                        const event = JSON.parse(trimmed);


                        if (event.type === 'product') {
                            const { type, ...product } = event;
                            stats.found++;

                            if (this.dryRun) {
                                if (this.onProduct) this.onProduct(product);
                            } else {
                                try {
                                    const upsertResult = await this.upsertProducts([product]);
                                    stats.newProducts += upsertResult.new || 0;
                                    stats.updated += upsertResult.updated || 0;
                                    stats.priceChanges += upsertResult.priceChanges || 0;
                                } catch (err) {
                                    this.errors.push({ phase: 'upsert', sku: product.sku, error: err.message });
                                    scrapingLogs.appendLog(this.runId, `⚠️ Upsert fallido (${product.sku}): ${err.message}`);
                                }
                            }

                        } else if (event.type === 'category_done') {
                            const logMsg = `✅ Categoría "${event.name}" completada: ${event.count} productos`;
                            scrapingLogs.appendLog(this.runId, logMsg);

                            // Marcar categoría completa y limpiar checkpoint de página
                            if (!this.dryRun && this.runId && this.runId !== 'preview') {
                                await this.pool.query(
                                    `UPDATE scraping_runs
                                     SET completed_categories = completed_categories || $1::jsonb,
                                         checkpoint = NULL
                                     WHERE id = $2`,
                                    [JSON.stringify([event.name]), this.runId]
                                ).catch((err) => {
                                    console.error(`⚠️ Error guardando categoria completa: ${err.message}`);
                                });
                            }

                        } else if (event.type === 'page_checkpoint') {
                            // Guardar checkpoint de página para poder reanudar desde acá
                            if (!this.dryRun && this.runId && this.runId !== 'preview') {
                                await this.pool.query(
                                    `UPDATE scraping_runs SET checkpoint = $1 WHERE id = $2`,
                                    [JSON.stringify({ category: event.category, page: event.page }), this.runId]
                                ).catch((err) => {
                                    console.error(`⚠️ Error guardando checkpoint de página: ${err.message}`);
                                });
                            }
                        }

                    } catch (parseErr) {
                        // Línea no-JSON (logs de debug, etc.) — la mostramos pero no falla
                        if (trimmed.length > 0) {
                            scrapingLogs.appendLog(this.runId, trimmed);
                        }
                    }
                }).catch((err) => {
                    console.error(`⚠️ Error en cola de upserts: ${err.message}`);
                });
            });

            proc.stderr.on('data', (chunk) => {
                const text = chunk.toString();
                stderrBuf += text;
                process.stdout.write(text);
                scrapingLogs.appendLog(this.runId, text);
            });

            proc.on('close', (code, sig) => {
                _activeProcesses.delete(this.runId);
                signal = sig; // 'SIGTERM' si fue pausado, null si terminó normalmente

                // Esperar a que se drene la cola de upserts antes de resolver
                upsertQueue.then(() => {
                    rl.close();
                    if (code !== 0 && code !== null) {
                        // code !== null: terminó con error (no es kill)
                        return reject(new Error(
                            `Script Python terminó con código ${code}:\n${stderrBuf.slice(-800)}`
                        ));
                    }
                    resolve({ stats, signal });
                }).catch(reject);
            });

            proc.on('error', (err) => {
                reject(new Error(`No se pudo iniciar el script Python: ${err.message}`));
            });
        });
    }

    // Los métodos de Puppeteer no aplican
    async getCategories() {
        throw new Error(`${this.constructor.name} usa PythonScraper — no implementa getCategories()`);
    }

    async scrapeCategory() {
        throw new Error(`${this.constructor.name} usa PythonScraper — no implementa scrapeCategory()`);
    }
}

PythonScraper.killProcess = killProcess;
PythonScraper.killAllProcesses = killAllProcesses;
PythonScraper.getActiveRunIds = getActiveRunIds;
module.exports = PythonScraper;
