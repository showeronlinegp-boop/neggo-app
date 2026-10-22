// Sugerencias para vincular un ítem de factura a un producto de Odoo (cache local).
// Junta varias pistas en vez de buscar solo por código:
//   codigo          — el código de la factura aparece en la referencia interna o es el código de barras
//   codigo_parecido — la referencia tiene el mismo código salvo el último dígito (otro color/variante)
//   nombre          — el nombre se parece a la descripción de la factura (trigramas, pg_trgm)
// Con texto escrito (q) busca cada palabra por separado, en cualquier orden.
// Incluye los archivados desde Reposición (locally_archived): son justo los que vuelven a entrar.

const pool = require('../config/database');

// Palabras que no ayudan a encontrar el producto
const STOPWORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'con', 'sin', 'para', 'por', 'y', 'c', 'x', 'art', 'en']);
const MAX_TERMS = 6;
// Códigos más cortos que esto dan demasiados "parecidos"
const MIN_CODE_LEN_FAMILY = 7;
// Parecido mínimo de nombre para sugerir
const MIN_NAME_SIMILARITY = 0.4;

// Sin acentos y en minúscula (mismo criterio que normName() en SQL)
function normText(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// "MG-BR 800" → "MGBR800"
function normalizeCode(s) {
    return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Plural → singular simple ("coladores" → "colador", "vasos" → "vaso").
// Solo recorta el final: la palabra original sigue conteniendo al término
function singular(w) {
    if (w.length < 5) return w;
    if (/[rlndjy]es$/.test(w)) return w.slice(0, -2);
    if (/[aeiou]s$/.test(w)) return w.slice(0, -1);
    return w;
}

// Palabras útiles del texto, en singular y sin repetidas
function searchTerms(text) {
    const words = normText(text).split(/[^a-z0-9ñ]+/)
        .filter(w => w.length >= 2 && !STOPWORDS.has(w))
        .map(singular);
    return [...new Set(words)].slice(0, MAX_TERMS);
}

// Código sin el último dígito, para encontrar variantes: "CL2274982" → "CL227498"
function codeFamily(code) {
    const c = normalizeCode(code);
    if (c.length < MIN_CODE_LEN_FAMILY || !/[0-9]$/.test(c)) return null;
    return c.slice(0, -1);
}

// Expresiones SQL reutilizadas
const REF_NORM  = `regexp_replace(UPPER(COALESCE(opc.internal_ref, '')), '[^A-Z0-9]', '', 'g')`;
const BAR_NORM  = `regexp_replace(UPPER(COALESCE(opc.barcode, '')), '[^A-Z0-9]', '', 'g')`;
const NAME_NORM = `translate(LOWER(opc.name), 'áéíóúüàèìòù', 'aeiouuaeiou')`;

const SELECT_COLS = `opc.id, opc.odoo_id, opc.company, opc.name, opc.internal_ref, opc.barcode,
    opc.list_price, opc.standard_price, opc.categ_name, opc.image_url,
    opc.qty_available, opc.active`;

// Sugerencias a partir del código y la descripción del ítem
async function suggestForItem({ company, codigo, descripcion, limit }) {
    const code = normalizeCode(codigo);
    const family = codeFamily(codigo);
    const desc = searchTerms(descripcion).join(' ');
    if (!code && !desc) return [];

    // $2 código, $3 familia, $4 descripción normalizada
    const { rows } = await pool.query(
        `WITH c AS (
            SELECT ${SELECT_COLS},
                CASE
                    WHEN $2 <> '' AND (${REF_NORM} LIKE '%' || $2 || '%' OR ${BAR_NORM} = $2) THEN 'codigo'
                    WHEN $3 <> '' AND ${REF_NORM} LIKE '%' || $3 || '%' THEN 'codigo_parecido'
                    WHEN $4 <> '' AND word_similarity($4, ${NAME_NORM}) >= $5 THEN 'nombre'
                END AS motivo,
                CASE WHEN $4 <> '' THEN word_similarity($4, ${NAME_NORM}) ELSE 0 END AS sim_palabras,
                CASE WHEN $4 <> '' THEN similarity($4, ${NAME_NORM}) ELSE 0 END AS sim_total
            FROM odoo_products_cache opc
            WHERE opc.company = $1
        )
        SELECT * FROM c
        WHERE motivo IS NOT NULL
        ORDER BY CASE motivo WHEN 'codigo' THEN 0 WHEN 'codigo_parecido' THEN 1 ELSE 2 END,
                 sim_palabras DESC, sim_total DESC, active DESC, name ASC
        LIMIT $6`,
        [company, code, family || '', desc, MIN_NAME_SIMILARITY, limit]
    );
    return rows;
}

// Búsqueda por texto escrito: todas las palabras tienen que estar (en el nombre o en la referencia)
async function searchByText({ company, q, limit }) {
    const terms = searchTerms(q);
    const code = normalizeCode(q);
    if (terms.length === 0 && code.length < 2) return [];

    const params = [company];
    const conds = terms.map(t => {
        params.push(`%${t}%`);
        const byName = `${NAME_NORM} LIKE $${params.length}`;
        const tCode = normalizeCode(t);
        if (!tCode) return byName;
        params.push(`%${tCode}%`);
        return `(${byName} OR ${REF_NORM} LIKE $${params.length})`;
    });
    params.push(code, normText(q), limit);
    const pCode = params.length - 2, pText = params.length - 1, pLimit = params.length;

    // El texto completo como código (ej. "MG-BR800") también cuenta aunque no tenga palabras sueltas
    const byCode = `($${pCode} <> '' AND ${REF_NORM} LIKE '%' || $${pCode} || '%')`;
    const byWords = conds.length ? `(${conds.join(' AND ')}) OR ` : '';

    const { rows } = await pool.query(
        `SELECT ${SELECT_COLS},
            CASE WHEN ${byCode} THEN 'codigo' ELSE 'busqueda' END AS motivo
         FROM odoo_products_cache opc
         WHERE opc.company = $1 AND (${byWords}${byCode})
         ORDER BY CASE WHEN ${byCode} THEN 0 ELSE 1 END,
                  word_similarity($${pText}, ${NAME_NORM}) DESC, opc.active DESC, opc.name ASC
         LIMIT $${pLimit}`,
        params
    );
    return rows;
}

module.exports = { suggestForItem, searchByText, normalizeCode, searchTerms, codeFamily, normText, singular };
