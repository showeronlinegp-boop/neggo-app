// Fotos de productos Odoo (Ingreso, Reposición, WhatsApp).
// La fuente de verdad es Odoo. En disco queda una copia (volumes/storage/photos/odoo)
// para no pedir el binario en cada carga; si Odoo cambió (checksum/write_date) se
// refresca y se pisa el archivo local. No vive solo en RAM.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const pool = require('../config/database');
const { callOdoo, getCompanyIds } = require('../config/odoo');
const { detectMime } = require('./whatsappMessage');

const TAMANIOS = ['128', '256', '512', '1024', '1920'];
const KINDS = { product: 'product.product', template: 'product.template' };

function defaultStorageRoot() {
    return process.env.STORAGE_PATH || path.join(__dirname, '..', 'storage');
}

function depsWith(overrides = {}) {
    return {
        callOdoo: overrides.callOdoo || callOdoo,
        getCompanyIds: overrides.getCompanyIds || getCompanyIds,
        pool: overrides.pool || pool,
        fsp: overrides.fsp || fsp,
        fs: overrides.fs || fs,
        storageRoot: overrides.storageRoot || defaultStorageRoot(),
    };
}

function hashBuffer(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function extFor(contentType) {
    if (contentType === 'image/jpeg') return 'jpg';
    if (contentType === 'image/png') return 'png';
    if (contentType === 'image/gif') return 'gif';
    if (contentType === 'image/webp') return 'webp';
    return 'bin';
}

function detectContentType(buf) {
    return detectMime(buf) || 'image/png';
}

function etagMatches(header, hash) {
    if (!header || !hash) return false;
    return String(header).split(',').some((part) => {
        const token = part.trim().replace(/^W\//i, '').replace(/"/g, '');
        return token === hash;
    });
}

function shouldUseLocal(meta, fingerprint) {
    if (!meta || !fingerprint) return false;
    return String(meta.fingerprint) === String(fingerprint);
}

function photosDir(storageRoot) {
    return path.join(storageRoot, 'photos', 'odoo');
}

function cacheStem(company, kind, id, size) {
    return `${company}-${kind}-${id}-${size}`;
}

function cachePaths(storageRoot, company, kind, id, size) {
    const dir = path.join(photosDir(storageRoot), company);
    const stem = cacheStem(company, kind, id, size);
    return {
        dir,
        stem,
        meta: path.join(dir, `${stem}.json`),
    };
}

async function readMeta(d, metaPath) {
    try {
        const raw = await d.fsp.readFile(metaPath, 'utf8');
        const meta = JSON.parse(raw);
        if (!meta || !meta.file || !meta.hash || !meta.fingerprint) return null;
        return meta;
    } catch {
        return null;
    }
}

async function loadLocal(d, company, kind, id, size) {
    const paths = cachePaths(d.storageRoot, company, kind, id, size);
    const meta = await readMeta(d, paths.meta);
    if (!meta) return null;
    const filePath = path.join(paths.dir, meta.file);
    try {
        const buffer = await d.fsp.readFile(filePath);
        if (!buffer.length) return null;
        return {
            buffer,
            contentType: meta.contentType || detectContentType(buffer),
            hash: meta.hash,
            fingerprint: meta.fingerprint,
            writeDate: meta.write_date || null,
            fromCache: true,
        };
    } catch {
        return null;
    }
}

async function removeLocal(d, company, kind, id, size) {
    const paths = cachePaths(d.storageRoot, company, kind, id, size);
    const meta = await readMeta(d, paths.meta);
    try { await d.fsp.unlink(paths.meta); } catch { /* no estaba */ }
    if (meta?.file) {
        try { await d.fsp.unlink(path.join(paths.dir, meta.file)); } catch { /* no estaba */ }
    }
    for (const ext of ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bin']) {
        try { await d.fsp.unlink(path.join(paths.dir, `${paths.stem}.${ext}`)); } catch { /* ok */ }
    }
}

async function saveLocal(d, { company, kind, id, size, buffer, contentType, fingerprint, writeDate }) {
    const paths = cachePaths(d.storageRoot, company, kind, id, size);
    await d.fsp.mkdir(paths.dir, { recursive: true });
    const hash = hashBuffer(buffer);
    const ext = extFor(contentType);
    const file = `${paths.stem}.${ext}`;
    const prev = await readMeta(d, paths.meta);
    if (prev?.file && prev.file !== file) {
        try { await d.fsp.unlink(path.join(paths.dir, prev.file)); } catch { /* ok */ }
    }
    await d.fsp.writeFile(path.join(paths.dir, file), buffer);
    const meta = {
        fingerprint: String(fingerprint),
        hash,
        contentType,
        file,
        write_date: writeDate || null,
        saved_at: new Date().toISOString(),
    };
    await d.fsp.writeFile(paths.meta, JSON.stringify(meta));
    return {
        buffer,
        contentType,
        hash,
        fingerprint: meta.fingerprint,
        writeDate: meta.write_date,
        fromCache: false,
    };
}

async function fingerprintFromOdoo(d, model, id, companyId) {
    const ctx = { allowed_company_ids: [companyId] };
    const fields = model === 'product.product' ? ['write_date', 'product_tmpl_id'] : ['write_date'];
    const [row] = await d.callOdoo(model, 'read', [[id], fields], { context: ctx });
    if (!row) return null;

    let writeDate = row.write_date || '';
    // La foto a veces vive en el template: si ese se tocó después, hay que refrescar.
    if (model === 'product.product' && row.product_tmpl_id?.[0]) {
        try {
            const [tmpl] = await d.callOdoo(
                'product.template',
                'read',
                [[row.product_tmpl_id[0]], ['write_date']],
                { context: ctx }
            );
            if (tmpl?.write_date && String(tmpl.write_date) > String(writeDate)) {
                writeDate = tmpl.write_date;
            }
        } catch { /* el template no es obligatorio para el fallback */ }
    }
    if (!writeDate) return { fingerprint: `id:${model}:${id}`, write_date: null, source: 'id' };
    return { fingerprint: `wd:${writeDate}`, write_date: writeDate, source: 'write_date' };
}

async function fetchImageFromOdoo(d, { model, id, companyId, size }) {
    const campo = `image_${size}`;
    const ctx = { allowed_company_ids: [companyId] };
    // product_tmpl_id solo existe en product.product: pedirlo al template hace fallar el read.
    const fields = model === 'product.product' ? [campo, 'write_date', 'product_tmpl_id'] : [campo, 'write_date'];
    const [row] = await d.callOdoo(model, 'read', [[id], fields], { context: ctx });
    const b64 = row?.[campo];
    if (!b64 || b64 === false) return null;
    const buffer = Buffer.from(b64, 'base64');
    if (!buffer.length) return null;
    return {
        buffer,
        contentType: detectContentType(buffer),
        writeDate: row.write_date || null,
        templateId: row.product_tmpl_id?.[0] || null,
        hash: hashBuffer(buffer),
    };
}

async function companyIdFor(d, company) {
    const ids = await d.getCompanyIds();
    const companyId = ids?.[company];
    if (!companyId) {
        const err = new Error(`Company ${company} no encontrada`);
        err.statusCode = 503;
        throw err;
    }
    return companyId;
}

/**
 * Trae la foto vigente de Odoo. Si la copia local tiene el mismo fingerprint,
 * se sirve el archivo de disco. Si Odoo cambió, se baja de nuevo y se pisa.
 * Si Odoo no responde y hay copia local, se sirve esa (no se pierde al reiniciar).
 */
async function getOdooImage(opts, overrides) {
    const d = depsWith(overrides);
    const company = opts.company === 'preventas' ? 'preventas' : 'neggo';
    const kind = opts.kind === 'template' ? 'template' : 'product';
    const id = parseInt(opts.id, 10);
    const size = TAMANIOS.includes(String(opts.size)) ? String(opts.size) : '128';
    if (!Number.isInteger(id) || id <= 0) return null;

    const model = KINDS[kind];
    const local = await loadLocal(d, company, kind, id, size);

    let companyId;
    try {
        companyId = await companyIdFor(d, company);
    } catch (err) {
        if (local) {
            console.warn(`⚠️ ${err.message}; sirvo foto local de ${kind} ${id}`);
            return local;
        }
        throw err;
    }

    let fp;
    try {
        fp = await fingerprintFromOdoo(d, model, id, companyId);
    } catch (err) {
        if (local) {
            console.warn(`⚠️ Odoo no disponible (${err.message}); sirvo foto local de ${kind} ${id}`);
            return local;
        }
        throw err;
    }

    if (local && fp && shouldUseLocal(local, fp.fingerprint)) {
        return local;
    }

    let fetched;
    try {
        fetched = await fetchImageFromOdoo(d, { model, id, companyId, size });
    } catch (err) {
        if (local) {
            console.warn(`⚠️ No pude refrescar la foto de Odoo (${err.message}); sirvo la local de ${kind} ${id}`);
            return local;
        }
        throw err;
    }

    if (!fetched) {
        await removeLocal(d, company, kind, id, size);
        return null;
    }

    const fingerprint = (fp && fp.fingerprint) || fetched.hash;
    if (local && local.hash === fetched.hash) {
        const saved = await saveLocal(d, {
            company, kind, id, size,
            buffer: local.buffer,
            contentType: local.contentType,
            fingerprint,
            writeDate: (fp && fp.write_date) || fetched.writeDate,
        });
        return { ...saved, fromCache: true, buffer: local.buffer };
    }

    return saveLocal(d, {
        company, kind, id, size,
        buffer: fetched.buffer,
        contentType: fetched.contentType,
        fingerprint,
        writeDate: (fp && fp.write_date) || fetched.writeDate,
    });
}

function applyImageHeaders(res, img) {
    res.set('Content-Type', img.contentType);
    res.set('Cache-Control', 'private, no-cache, must-revalidate');
    res.set('ETag', `"${img.hash}"`);
    if (img.writeDate) {
        const d = new Date(img.writeDate.includes('T') ? img.writeDate : `${img.writeDate.replace(' ', 'T')}Z`);
        if (!Number.isNaN(d.getTime())) res.set('Last-Modified', d.toUTCString());
    }
}

async function pipeOdooImage(req, res, opts, overrides) {
    try {
        const img = await getOdooImage(opts, overrides);
        if (!img) return res.status(404).end();
        applyImageHeaders(res, img);
        if (etagMatches(req.headers['if-none-match'], img.hash)) return res.status(304).end();
        return res.send(img.buffer);
    } catch (err) {
        console.error('❌ Error fetching Odoo image:', err.message);
        if (err.statusCode === 503) return res.status(503).end();
        return res.status(404).end();
    }
}

async function persistFetchedSizes(d, { company, kind, id, companyId, fingerprint, writeDate, sizes }) {
    for (const size of sizes) {
        try {
            const fetched = await fetchImageFromOdoo(d, { model: KINDS[kind], id, companyId, size });
            if (!fetched) continue;
            await saveLocal(d, {
                company, kind, id, size,
                buffer: fetched.buffer,
                contentType: fetched.contentType,
                fingerprint: fingerprint || fetched.hash,
                writeDate: writeDate || fetched.writeDate,
            });
        } catch (err) {
            console.warn(`⚠️ No pude guardar miniatura ${size} de ${kind} ${id}:`, err.message);
        }
    }
}

/**
 * Sube la foto a un producto de Odoo Neggo (image_1920: Odoo arma las miniaturas),
 * actualiza el cache SQL y deja la foto en disco para que se vea al toque.
 */
async function writeOdooImage(odooProductId, base64, overrides) {
    const d = depsWith(overrides);
    const companyIds = await d.getCompanyIds();
    const companyId = companyIds.neggo;
    if (!companyId) {
        const err = new Error('Company Neggo no encontrada');
        err.statusCode = 503;
        throw err;
    }
    const ctx = { context: { allowed_company_ids: [companyId] } };

    await d.callOdoo('product.product', 'write', [[odooProductId], { image_1920: base64 }], ctx);
    const [product] = await d.callOdoo('product.product', 'read', [[odooProductId], ['product_tmpl_id']], ctx);
    const templateId = product?.product_tmpl_id?.[0] || null;

    const { rows } = await d.pool.query(
        `UPDATE odoo_products_cache
         SET has_image   = true,
             template_id = COALESCE($2, template_id),
             image_url   = CASE WHEN COALESCE($2, template_id) IS NOT NULL
                                THEN '/api/products/odoo-image/neggo/' || COALESCE($2, template_id)
                                ELSE image_url END
         WHERE odoo_id = $1 AND company = 'neggo'
         RETURNING image_url`,
        [odooProductId, templateId]
    );

    let fingerprint = null;
    let writeDate = null;
    try {
        const fp = await fingerprintFromOdoo(d, 'product.product', odooProductId, companyId);
        fingerprint = fp?.fingerprint || null;
        writeDate = fp?.write_date || null;
    } catch (err) {
        console.warn('⚠️ No pude leer fingerprint post-upload:', err.message);
    }

    if (!fingerprint && base64) {
        try {
            fingerprint = hashBuffer(Buffer.from(base64, 'base64'));
        } catch { /* el original no es obligatorio para el cache */ }
    }

    await persistFetchedSizes(d, {
        company: 'neggo',
        kind: 'product',
        id: odooProductId,
        companyId,
        fingerprint,
        writeDate,
        sizes: ['128', '512'],
    });
    if (templateId) {
        await persistFetchedSizes(d, {
            company: 'neggo',
            kind: 'template',
            id: templateId,
            companyId,
            fingerprint,
            writeDate,
            sizes: ['128', '512', '1024'],
        });
    }

    return { template_id: templateId, image_url: rows[0]?.image_url || null };
}

module.exports = {
    writeOdooImage,
    getOdooImage,
    pipeOdooImage,
    hashBuffer,
    detectContentType,
    etagMatches,
    shouldUseLocal,
    TAMANIOS,
};
