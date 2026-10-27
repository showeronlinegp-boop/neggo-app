// Notas de prueba — lógica compartida entre la API (routes/testNotes.js) y el CLI (scripts/notaPrueba.js)

const TIPOS = ['error', 'mejora', 'duda'];
const ESTADOS = ['abierta', 'en_curso', 'consulta', 'para_revisar', 'corregida', 'descartada'];
const ESTADOS_VIVOS = ['abierta', 'en_curso', 'consulta', 'para_revisar'];
// Orden fijo del modo de trabajo; vacío = DIRECTO
const MODOS = ['debatir', 'investigar', 'consultas'];

// Recortes para que un pegado enorme no rompa nada
const LIMITES = { texto: 5000, respuesta: 10000, ruta: 500, pantalla: 200, selector: 2000, elemento: 300 };
const MAX_CONTEXTO_CHARS = 50000;

function recortar(valor, max) {
    if (valor === undefined || valor === null) return null;
    return String(valor).slice(0, max);
}

function normalizarModo(modo) {
    if (!Array.isArray(modo)) return [];
    return MODOS.filter(m => modo.includes(m));
}

function normalizarContexto(contexto) {
    if (!contexto || typeof contexto !== 'object') return {};
    const json = JSON.stringify(contexto);
    if (json.length <= MAX_CONTEXTO_CHARS) return contexto;
    // Demasiado grande: quedarse con lo último de cada buffer
    const reducido = { ...contexto };
    for (const k of ['consola', 'api']) {
        if (Array.isArray(reducido[k])) reducido[k] = reducido[k].slice(-5);
    }
    const json2 = JSON.stringify(reducido);
    return json2.length <= MAX_CONTEXTO_CHARS ? reducido : { recortado: true };
}

// Las notas que deja un bot (feedback de la API del agente) no tienen usuario: el autor va en el contexto
const SELECT = `
    SELECT n.*, COALESCE(u.username, n.contexto->>'autor') AS autor
    FROM test_notes n
    LEFT JOIN users u ON u.id = n.user_id`;

async function listar(pool, { estado, ruta, vivas } = {}) {
    const where = [];
    const params = [];
    if (estado && ESTADOS.includes(estado)) {
        params.push(estado);
        where.push(`n.estado = $${params.length}`);
    }
    if (vivas) {
        params.push(ESTADOS_VIVOS);
        where.push(`n.estado = ANY($${params.length}::text[])`);
    }
    if (ruta) {
        params.push(ruta);
        where.push(`n.ruta = $${params.length}`);
    }
    const { rows } = await pool.query(`
        ${SELECT}
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY (n.estado = ANY('{abierta,en_curso,consulta,para_revisar}'::text[])) DESC, n.id DESC
        LIMIT 500`, params);
    return rows;
}

async function obtener(pool, id) {
    const { rows } = await pool.query(`${SELECT} WHERE n.id = $1`, [id]);
    return rows[0] || null;
}

async function crear(pool, datos, userId) {
    const tipo = TIPOS.includes(datos.tipo) ? datos.tipo : 'error';
    const texto = recortar(datos.texto, LIMITES.texto);
    if (!texto || !texto.trim()) {
        const err = new Error('La nota necesita un texto');
        err.statusCode = 400;
        throw err;
    }
    const { rows } = await pool.query(`
        INSERT INTO test_notes
            (tipo, texto, modo, ruta, pantalla, selector, elemento, pos_x, pos_y, contexto, user_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id`, [
        tipo, texto.trim(), normalizarModo(datos.modo),
        recortar(datos.ruta, LIMITES.ruta), recortar(datos.pantalla, LIMITES.pantalla),
        recortar(datos.selector, LIMITES.selector), recortar(datos.elemento, LIMITES.elemento),
        Number.isFinite(Number(datos.pos_x)) && datos.pos_x !== null ? Number(datos.pos_x) : null,
        Number.isFinite(Number(datos.pos_y)) && datos.pos_y !== null ? Number(datos.pos_y) : null,
        JSON.stringify(normalizarContexto(datos.contexto)), userId || null,
    ]);
    return obtener(pool, rows[0].id);
}

async function actualizar(pool, id, cambios) {
    const sets = [];
    const params = [];
    const set = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    if (cambios.estado !== undefined) {
        if (!ESTADOS.includes(cambios.estado)) {
            const err = new Error(`Estado inválido: ${cambios.estado}. Opciones: ${ESTADOS.join(', ')}`);
            err.statusCode = 400;
            throw err;
        }
        set('estado', cambios.estado);
        sets.push(['corregida', 'descartada'].includes(cambios.estado) ? 'resuelta_at = NOW()' : 'resuelta_at = NULL');
    }
    if (cambios.tipo !== undefined && TIPOS.includes(cambios.tipo)) set('tipo', cambios.tipo);
    if (cambios.texto !== undefined && String(cambios.texto).trim()) set('texto', recortar(cambios.texto, LIMITES.texto).trim());
    if (cambios.respuesta !== undefined) set('respuesta', recortar(cambios.respuesta, LIMITES.respuesta));
    if (cambios.modo !== undefined) set('modo', normalizarModo(cambios.modo));

    if (sets.length === 0) return obtener(pool, id);
    params.push(id);
    const { rowCount } = await pool.query(
        `UPDATE test_notes SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`, params);
    return rowCount ? obtener(pool, id) : null;
}

async function borrar(pool, id) {
    const { rowCount } = await pool.query('DELETE FROM test_notes WHERE id = $1', [id]);
    return rowCount > 0;
}

module.exports = {
    TIPOS, ESTADOS, ESTADOS_VIVOS, MODOS,
    listar, obtener, crear, actualizar, borrar,
};
