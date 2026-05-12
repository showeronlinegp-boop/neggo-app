// Helpers para respuestas consistentes en toda la API

function ok(res, data, status = 200) {
    return res.status(status).json({ success: true, data });
}

function fail(res, error, status = 400) {
    return res.status(status).json({ success: false, error });
}

function paginated(res, data, total, limit, offset) {
    return res.json({
        success: true,
        data,
        pagination: {
            total: parseInt(total, 10),
            limit: parseInt(limit, 10),
            offset: parseInt(offset, 10),
            pages: Math.ceil(total / limit)
        }
    });
}

module.exports = { ok, fail, paginated };
