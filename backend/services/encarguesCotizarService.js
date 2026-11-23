// Encargues a cotizar (nota 248): mercadería que no está en el catálogo y un contacto de Chats
// pidió que averigüemos. Se carga en el botón «Pedidos» de la conversación y se ve en
// Reposición › A cotizar. Solo la base de la app: no toca Odoo. Validación en encarguesCotizar.js.

const fs = require('fs');
const path = require('path');
const pool = require('../config/database');
const { contacto, validarAlta, validarEdicion, validarEstado } = require('./encarguesCotizar');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'sql', 'migrations', '069_encargues_cotizar.sql'), 'utf8');

let schemaReady = null;
function ensureSchema(db = pool) {
    if (!schemaReady) {
        schemaReady = db.query(SCHEMA).catch((err) => {
            schemaReady = null;
            throw err;
        });
    }
    return schemaReady;
}

class EncargueError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

const SELECT = `
    SELECT e.*, uc.username AS creado_por, ur.username AS resuelto_por
      FROM encargues_cotizar e
      LEFT JOIN users uc ON uc.id = e.created_by
      LEFT JOIN users ur ON ur.id = e.resolved_by`;

function formatear(r) {
    return {
        id: r.id,
        contacto: { tipo: r.contacto_tipo, id: r.contacto_id, nombre: r.contacto_nombre },
        texto: r.texto,
        cantidad: r.cantidad === null ? null : Number(r.cantidad),
        nota: r.nota,
        estado: r.estado,
        precio: r.precio === null ? null : Number(r.precio),
        proveedor: r.proveedor,
        creado_por: r.creado_por || null,
        resuelto_por: r.resuelto_por || null,
        created_at: r.created_at,
        resolved_at: r.resolved_at,
    };
}

// Grupos de la pestaña: abiertos = pendiente + cotizado (falta avisar); cerrados = el resto
const GRUPOS = { abiertos: ['pendiente', 'cotizado'], pendiente: ['pendiente'], cotizado: ['cotizado'], cerrados: ['avisado', 'no_se_consigue'] };

/** Lista para Reposición. grupo = abiertos | pendiente | cotizado | cerrados */
async function listar({ grupo = 'abiertos' } = {}, db = pool) {
    await ensureSchema(db);
    const estados = GRUPOS[grupo] || GRUPOS.abiertos;
    const cerrados = grupo === 'cerrados';
    const { rows } = await db.query(
        `${SELECT} WHERE e.estado = ANY($1::text[])
          ORDER BY ${cerrados ? 'e.resolved_at DESC NULLS LAST, e.id DESC' : 'e.created_at, e.id'}
          LIMIT 300`, [estados]);
    return rows.map(formatear);
}

/** Cuántos hay por estado (para las etiquetas y el aviso de Pendientes). */
async function contar(db = pool) {
    await ensureSchema(db);
    const { rows } = await db.query(`SELECT estado, COUNT(*)::int AS n FROM encargues_cotizar GROUP BY estado`);
    const out = { pendiente: 0, cotizado: 0, avisado: 0, no_se_consigue: 0 };
    for (const r of rows) out[r.estado] = r.n;
    return out;
}

/** Los de un contacto (botón «Pedidos»): abiertos primero y los cerrados de los últimos 30 días. */
async function deContacto(tipo, id, db = pool) {
    const c = contacto(tipo, id);
    if (!c) throw new EncargueError('Contacto inválido', 422);
    await ensureSchema(db);
    const { rows } = await db.query(
        `${SELECT} WHERE e.contacto_tipo = $1 AND e.contacto_id = $2
            AND (e.estado IN ('pendiente', 'cotizado') OR e.resolved_at >= NOW() - INTERVAL '30 days')
          ORDER BY (e.estado IN ('pendiente', 'cotizado')) DESC, e.created_at DESC`, [c.tipo, c.id]);
    return rows.map(formatear);
}

async function uno(id, db) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw new EncargueError('Encargue inválido', 422);
    const { rows: [r] } = await db.query(`${SELECT} WHERE e.id = $1`, [n]);
    if (!r) throw new EncargueError('No existe ese encargue', 404);
    return r;
}

async function crear(tipo, id, body, userId, db = pool) {
    const c = contacto(tipo, id);
    if (!c) throw new EncargueError('Contacto inválido', 422);
    const { value, error } = validarAlta(body);
    if (error) throw new EncargueError(error, 422);
    await ensureSchema(db);
    const { rows: [r] } = await db.query(
        `INSERT INTO encargues_cotizar (contacto_tipo, contacto_id, contacto_nombre, texto, cantidad, nota, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [c.tipo, c.id, value.contacto_nombre, value.texto, value.cantidad, value.nota, userId || null]);
    console.log(`📦 Encargue a cotizar #${r.id} para ${c.tipo}:${c.id}: ${value.texto}`);
    return formatear(await uno(r.id, db));
}

async function editar(id, body, db = pool) {
    await ensureSchema(db);
    const actual = await uno(id, db);
    const { value, error } = validarEdicion(body);
    if (error) throw new EncargueError(error, 422);
    const campos = Object.keys(value);
    await db.query(
        `UPDATE encargues_cotizar SET ${campos.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = NOW() WHERE id = $1`,
        [actual.id, ...campos.map((k) => value[k])]);
    return formatear(await uno(actual.id, db));
}

async function cambiarEstado(id, body, userId, db = pool) {
    await ensureSchema(db);
    const actual = await uno(id, db);
    const { value, error } = validarEstado(actual.estado, body);
    if (error) throw new EncargueError(error, 422);
    const cerrado = value.estado === 'avisado' || value.estado === 'no_se_consigue';
    // Volver a pendiente borra el precio; avisado conserva el precio y proveedor que se cotizó
    const precio = value.estado === 'cotizado' ? value.precio : value.estado === 'pendiente' ? null : actual.precio;
    const proveedor = value.estado === 'cotizado' ? value.proveedor : value.estado === 'pendiente' ? null : actual.proveedor;
    await db.query(
        `UPDATE encargues_cotizar
            SET estado = $2::varchar, precio = $3, proveedor = $4, updated_at = NOW(),
                resolved_at = CASE WHEN $5::boolean THEN NOW() ELSE NULL END,
                resolved_by = CASE WHEN $5::boolean OR $2::varchar = 'cotizado' THEN $6::int ELSE NULL END
          WHERE id = $1`,
        [actual.id, value.estado, precio, proveedor, cerrado, userId || null]);
    console.log(`✅ Encargue a cotizar #${actual.id}: ${actual.estado} → ${value.estado}`);
    return formatear(await uno(actual.id, db));
}

async function borrar(id, db = pool) {
    await ensureSchema(db);
    const actual = await uno(id, db);
    await db.query('DELETE FROM encargues_cotizar WHERE id = $1', [actual.id]);
    return { id: actual.id };
}

module.exports = { ensureSchema, listar, contar, deContacto, crear, editar, cambiarEstado, borrar, EncargueError };
