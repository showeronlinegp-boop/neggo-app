-- Scraping en un contenedor aparte (scraper-worker):
-- - el backend encola runs (status 'queued') y el worker los ejecuta
-- - pausar/detener se pide con scraping_runs.control y el worker corta el proceso
-- - resume_from: run pausado del que se reanuda (categorías ya completadas)
-- - los logs viven en la base para que el backend los transmita aunque vengan de otro contenedor

ALTER TABLE scraping_runs DROP CONSTRAINT IF EXISTS scraping_runs_status_check;
ALTER TABLE scraping_runs ADD CONSTRAINT scraping_runs_status_check
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'partial', 'cancelled', 'paused'));

ALTER TABLE scraping_runs ADD COLUMN IF NOT EXISTS control VARCHAR(10);
ALTER TABLE scraping_runs ADD COLUMN IF NOT EXISTS resume_from INTEGER REFERENCES scraping_runs(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS scraping_run_logs (
    id          BIGSERIAL PRIMARY KEY,
    run_id      INTEGER NOT NULL REFERENCES scraping_runs(id) ON DELETE CASCADE,
    line        TEXT NOT NULL,
    created_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_srl_run ON scraping_run_logs(run_id, id);
