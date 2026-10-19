const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail } = require('../utils/response');
const pool = require('../config/database');
const evolution = require('../services/evolutionClient');
const { listFilters, findPublishable } = require('../services/whatsappProducts');
const queue = require('../services/whatsappQueue');

const router = express.Router();
router.use(authenticate, requireRole('admin'));

function maxAttempts() {
    const n = parseInt(process.env.WHATSAPP_MAX_ATTEMPTS || '3', 10);
    if (!Number.isInteger(n) || n < 1) return 3;
    return Math.min(n, 5);
}

router.get('/status', async (req, res) => {
    try {
        const settings = await queue.getSettings(pool);
        let evolutionState = { reachable: false, state: null, error: null };
        try {
            evolutionState = {
                reachable: true,
                state: await evolution.connectionState(),
                instance: evolution.config().instance,
                error: null,
            };
        } catch (err) {
            evolutionState = {
                reachable: false,
                state: null,
                instance: process.env.EVOLUTION_INSTANCE || 'neggo',
                error: err.message,
            };
        }
        return ok(res, { settings, evolution: evolutionState });
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

router.post('/connect', async (req, res) => {
    try {
        const qr = await evolution.connectQr();
        return ok(res, qr);
    } catch (err) {
        return fail(res, err.message, 502);
    }
});

router.get('/groups', async (req, res) => {
    try {
        const groups = await evolution.fetchGroups();
        return ok(res, groups);
    } catch (err) {
        return fail(res, err.message, 502);
    }
});

router.put('/settings', async (req, res) => {
    try {
        const settings = await queue.saveSettings(pool, {
            groupJid: req.body.group_jid,
            groupSubject: req.body.group_subject,
            intervalSeconds: req.body.interval_seconds,
        });
        return ok(res, settings);
    } catch (err) {
        return fail(res, err.message, 400);
    }
});

router.get('/filters', async (req, res) => {
    try {
        const company = req.query.company === 'neggo' ? 'neggo' : 'preventas';
        return ok(res, await listFilters(pool, company));
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

router.post('/preview', async (req, res) => {
    try {
        const products = await findPublishable(pool, {
            company: req.body.company,
            category: req.body.category || null,
            destCategory: req.body.dest_category || null,
            pricelistId: req.body.pricelist_id || null,
        });
        return ok(res, {
            count: products.length,
            sample: products.slice(0, 8).map((p) => ({
                name: p.name,
                price_label: p.price_label,
                categ_name: p.categ_name,
            })),
        });
    } catch (err) {
        const status = /más de|filtro|lista tiene/.test(err.message) ? 400 : 500;
        return fail(res, err.message, status);
    }
});

router.get('/batches', async (req, res) => {
    try {
        return ok(res, await queue.listBatches(pool));
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

router.post('/batches', async (req, res) => {
    try {
        const settings = await queue.getSettings(pool);
        const created = await queue.createBatch(pool, {
            company: req.body.company,
            category: req.body.category || null,
            destCategory: req.body.dest_category || null,
            pricelistId: req.body.pricelist_id || null,
            groupJid: req.body.group_jid || settings.group_jid,
            groupSubject: req.body.group_subject || settings.group_subject,
            intervalSeconds: req.body.interval_seconds || settings.interval_seconds,
            scheduledAt: req.body.scheduled_at,
            maxAttempts: maxAttempts(),
            createdBy: req.user.id,
        });
        return ok(res, {
            id: created.batch.id,
            total: created.total,
            scheduled_at: created.batch.scheduled_at,
            sample: created.sample,
        }, 201);
    } catch (err) {
        return fail(res, err.message, 400);
    }
});

router.get('/batches/:id', async (req, res) => {
    try {
        const batch = await queue.getBatch(pool, req.params.id);
        if (!batch) return fail(res, 'Tanda no encontrada', 404);
        return ok(res, batch);
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

async function action(req, res, fn) {
    try {
        await fn(pool, req.params.id);
        return ok(res, await queue.getBatch(pool, req.params.id));
    } catch (err) {
        return fail(res, err.message, 400);
    }
}

router.post('/batches/:id/pause', (req, res) => action(req, res, queue.pauseBatch));
router.post('/batches/:id/resume', (req, res) => action(req, res, queue.resumeBatch));
router.post('/batches/:id/cancel', (req, res) => action(req, res, queue.cancelBatch));

module.exports = router;
