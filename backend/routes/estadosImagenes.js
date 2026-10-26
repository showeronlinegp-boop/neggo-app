const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const { ok, fail } = require('../utils/response');
const pool = require('../config/database');
const { listCategories } = require('../services/whatsappRandom');
const { sortear, registrarDescargas } = require('../services/estadoImagenes');

// Imágenes para estados (nota #91): sorteo y registro de descargas. Las fotos salen de
// /api/products/odoo-image y la imagen se arma en el navegador.
const router = express.Router();
router.use(authenticate, requireRole('admin'));

function companyOf(value) {
    return value === 'neggo' ? 'neggo' : 'preventas';
}

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

// GET /api/estados-imagenes/categorias?company=preventas
router.get('/categorias', async (req, res) => {
    try {
        return ok(res, await listCategories(pool, companyOf(req.query.company)));
    } catch (err) {
        console.error('❌ Error listando categorías para estados:', err.message);
        return fail(res, err.message, 500);
    }
});

// POST /api/estados-imagenes/sorteo { company, categories, count, exclude_ids }
// No repite lo que está en cola de WhatsApp, lo publicado ni lo descargado en los últimos 7 días.
router.post('/sorteo', async (req, res) => {
    try {
        const company = companyOf(req.body.company);
        const categories = Array.isArray(req.body.categories) ? req.body.categories.filter(Boolean) : [];
        if (!categories.length) return fail(res, 'Elegí al menos una categoría', 400);
        if (categories.length > 30) return fail(res, 'Elegí hasta 30 categorías', 400);
        const count = req.body.count == null ? 20 : Number(req.body.count);
        const excludeIds = Array.isArray(req.body.exclude_ids) ? req.body.exclude_ids : [];
        const result = [];
        for (const category of categories) {
            const products = await sortear(pool, { company, category, count, excludeIds });
            result.push({ category, products: products.map(pickView) });
        }
        return ok(res, result);
    } catch (err) {
        return fail(res, err.message, 400);
    }
});

// POST /api/estados-imagenes/descargas { company, odoo_ids, formato }
router.post('/descargas', async (req, res) => {
    try {
        const data = await registrarDescargas(pool, {
            company: req.body.company,
            odooIds: req.body.odoo_ids,
            formato: req.body.formato,
            userId: req.user?.id || null,
        });
        console.log(`📦 Estados: ${data.anotadas} imágenes descargadas (${req.body.company}, ${req.body.formato})`);
        return ok(res, data);
    } catch (err) {
        return fail(res, err.message, 400);
    }
});

module.exports = router;
