const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail } = require('../utils/response');
const pool = require('../config/database');
const evolution = require('../services/evolutionClient');
const { listFilters, findPublishable } = require('../services/whatsappProducts');
const { listCategories, pickRandom, findByIds } = require('../services/whatsappRandom');
const queue = require('../services/whatsappQueue');

const router = express.Router();
router.use(authenticate, requireRole('admin'));

function maxAttempts() {
    const n = parseInt(process.env.WHATSAPP_MAX_ATTEMPTS || '3', 10);
    if (!Number.isInteger(n) || n < 1) return 3;
    return Math.min(n, 5);
}

async function describeInstance(which) {
    let instance = which === 'estado' ? 'neggo-estados' : 'neggo';
    try {
        instance = evolution.instanceName(which);
    } catch (err) {
        return { reachable: false, state: null, instance, destino: which, error: err.message };
    }
    try {
        return {
            reachable: true,
            state: await evolution.connectionState(which),
            instance,
            destino: which,
            error: null,
        };
    } catch (err) {
        return { reachable: false, state: null, instance, destino: which, error: err.message };
    }
}

router.get('/status', async (req, res) => {
    try {
        const settings = await queue.getSettings(pool);
        const [evolutionState, evolutionStatus] = await Promise.all([
            describeInstance('grupo'),
            describeInstance('estado'),
        ]);
        return ok(res, {
            settings,
            evolution: evolutionState,
            evolution_status: evolutionStatus,
        });
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

router.post('/connect', async (req, res) => {
    try {
        const which = req.body?.destino === 'estado' ? 'estado' : 'grupo';
        const qr = await evolution.connectQr(which);
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

function pickView(p) {
    return {
        odoo_id: p.odoo_id,
        company: p.company,
        name: p.name,
        categ_name: p.categ_name,
        template_id: p.template_id,
        price_label: p.price_label,
        url: p.url || null,
    };
}

router.get('/random-categories', async (req, res) => {
    try {
        const company = req.query.company === 'neggo' ? 'neggo' : 'preventas';
        return ok(res, await listCategories(pool, company));
    } catch (err) {
        return fail(res, err.message, 500);
    }
});

// Sorteo: N productos al azar por categoría. exclude_ids evita repetir lo que ya está en pantalla.
router.post('/random-pick', async (req, res) => {
    try {
        const company = req.body.company === 'neggo' ? 'neggo' : 'preventas';
        const categories = Array.isArray(req.body.categories) ? req.body.categories.filter(Boolean) : [];
        if (!categories.length) return fail(res, 'Elegí al menos una categoría', 400);
        if (categories.length > 30) return fail(res, 'Elegí hasta 30 categorías', 400);
        const count = req.body.count == null ? 20 : Number(req.body.count);
        const excludeIds = Array.isArray(req.body.exclude_ids) ? req.body.exclude_ids : [];
        const result = [];
        for (const category of categories) {
            const products = await pickRandom(pool, { company, category, count, excludeIds });
            result.push({ category, products: products.map(pickView) });
        }
        return ok(res, result);
    } catch (err) {
        return fail(res, err.message, 400);
    }
});

// Programa las tandas sorteadas, una por categoría, una atrás de la otra.
router.post('/batches/random', async (req, res) => {
    try {
        const company = req.body.company === 'neggo' ? 'neggo' : 'preventas';
        const settings = await queue.getSettings(pool);
        const groupJid = req.body.group_jid || settings.group_jid;
        const groupSubject = req.body.group_subject || settings.group_subject;
        const interval = queue.clampInterval(req.body.interval_seconds || settings.interval_seconds, 90);
        queue.assertGroupJid(groupJid);
        queue.assertSchedule(req.body.scheduled_at);
        const groups = Array.isArray(req.body.groups) ? req.body.groups : [];
        // Validamos todo antes de crear nada.
        const prepared = [];
        for (const g of groups) {
            const products = await findByIds(pool, company, g.odoo_ids);
            if (products.length) prepared.push({ category: g.category || null, products });
        }
        if (!prepared.length) return fail(res, 'No quedó ningún producto para programar', 400);
        const created = [];
        let offset = 0;
        for (const g of prepared) {
            const { batch, total, durationSeconds } = await queue.createBatch(pool, {
                company,
                category: g.category,
                products: g.products,
                groupJid,
                groupSubject,
                intervalSeconds: interval,
                scheduledAt: req.body.scheduled_at,
                offsetSeconds: offset,
                maxAttempts: maxAttempts(),
                createdBy: req.user.id,
            });
            created.push({ id: batch.id, category: g.category, total, scheduled_at: batch.scheduled_at });
            // Las esperas varían al azar: la tanda siguiente arranca cuando termina esta.
            offset += durationSeconds;
        }
        return ok(res, created, 201);
    } catch (err) {
        return fail(res, err.message, 400);
    }
});

// Una sola foto, ya. Entra a la cola como tanda de 1 para respetar el intervalo y los reintentos.
router.post('/send-now', async (req, res) => {
    try {
        const company = req.body.company === 'neggo' ? 'neggo' : 'preventas';
        const settings = await queue.getSettings(pool);
        const [product] = await findByIds(pool, company, [req.body.odoo_id]);
        if (!product) return fail(res, 'El producto no tiene foto o precio de catálogo', 400);
        const { batch } = await queue.createBatch(pool, {
            company,
            category: product.categ_name || null,
            products: [product],
            groupJid: req.body.group_jid || settings.group_jid,
            groupSubject: req.body.group_subject || settings.group_subject,
            intervalSeconds: 10,
            sendNow: true,
            maxAttempts: maxAttempts(),
            createdBy: req.user.id,
        });
        return ok(res, { id: batch.id, name: product.name }, 201);
    } catch (err) {
        return fail(res, err.message, 400);
    }
});

router.get('/queue', async (req, res) => {
    try {
        return ok(res, { now: new Date().toISOString(), messages: await queue.listQueue(pool) });
    } catch (err) {
        return fail(res, err.message, 500);
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
            destino: req.body.destino,
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
