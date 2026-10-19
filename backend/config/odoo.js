// Cliente JSON-RPC para Odoo 19
// Implementado en el Agente 03

// =============================================
// Cache de company IDs y uid en memoria
// =============================================

let _companyIds = null;
let _uid = null; // Cache del uid numérico (obtenido via authenticate si ODOO_USER_ID es email)

// =============================================
// Función genérica JSON-RPC con retry y backoff
// =============================================

/**
 * Realiza una llamada JSON-RPC al endpoint de Odoo.
 * Reintenta hasta 3 veces con backoff exponencial (1s → 2s → 4s).
 *
 * @param {string} method — método RPC (casi siempre 'call')
 * @param {object} params — parámetros del request
 * @returns {Promise<any>} resultado de data.result
 */
async function jsonRpc(method, params) {
    const url = `${process.env.ODOO_URL}/jsonrpc`;
    const body = JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        id: Date.now()
    });

    let lastError;
    const delays = [1000, 2000, 4000];

    for (let attempt = 0; attempt <= delays.length; attempt++) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();

            if (data.error) {
                // Errores de Odoo no son retriables (son errores de negocio o permisos)
                const msg = data.error.data?.message || data.error.message || 'Error desconocido de Odoo';
                throw new Error(msg);
            }

            return data.result;

        } catch (err) {
            lastError = err;

            // Si es un error de Odoo (no de red), no reintentamos
            if (err.message && !err.message.startsWith('HTTP') && !err.code) {
                // Podría ser error de negocio — verificar si parece un error de Odoo
                const isOdooBusinessError = err.message.includes('AccessError')
                    || err.message.includes('ValidationError')
                    || err.message.includes('UserError')
                    || err.message.includes('MissingError');

                if (isOdooBusinessError) {
                    throw err;
                }
            }

            if (attempt < delays.length) {
                const delay = delays[attempt];
                console.warn(`⚠️ Odoo jsonRpc intento ${attempt + 1} fallido: ${err.message}. Reintentando en ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    console.error(`❌ Odoo jsonRpc falló después de ${delays.length + 1} intentos:`, lastError.message);
    throw lastError;
}

// =============================================
// Wrapper execute_kw
// =============================================

/**
 * Llama a un método de modelo Odoo via execute_kw.
 *
 * @param {string} model — nombre del modelo Odoo (ej: 'product.product')
 * @param {string} method — método a ejecutar (ej: 'search_read', 'write', 'create')
 * @param {Array} args — argumentos posicionales
 * @param {object} [kwargs={}] — argumentos nombrados (fields, limit, offset, domain, context, etc.)
 * @returns {Promise<any>}
 */
/**
 * Resuelve el uid numérico de Odoo.
 * Si ODOO_USER_ID es un número, lo usa directamente.
 * Si es un email, hace authenticate para obtener el uid y lo cachea.
 */
async function resolveUid() {
    if (_uid) return _uid;

    const raw = process.env.ODOO_USER_ID || '';
    const asInt = parseInt(raw, 10);

    if (!isNaN(asInt) && String(asInt) === raw.trim()) {
        // Es un número entero directo
        _uid = asInt;
        return _uid;
    }

    // Es un email — autenticar para obtener uid
    console.log(`📦 Odoo: resolviendo uid para ${raw}...`);
    const uid = await jsonRpc('call', {
        service: 'common',
        method: 'authenticate',
        args: [
            process.env.ODOO_DB,
            raw,
            process.env.ODOO_API_KEY,
            {}
        ]
    });

    if (!uid || typeof uid !== 'number') {
        throw new Error(`Odoo authenticate falló para ${raw} — verificar credenciales`);
    }

    _uid = uid;
    console.log(`✅ Odoo uid resuelto: ${_uid}`);
    return _uid;
}

async function callOdoo(model, method, args, kwargs = {}) {
    const uid = await resolveUid();
    return jsonRpc('call', {
        service: 'object',
        method: 'execute_kw',
        args: [
            process.env.ODOO_DB,
            uid,
            process.env.ODOO_API_KEY,
            model,
            method,
            args,
            kwargs
        ]
    });
}

// =============================================
// Company IDs — cache en memoria
// =============================================

/**
 * Obtiene y cachea los IDs de Neggo y Preventas.
 * Solo consulta Odoo la primera vez; luego devuelve el cache.
 *
 * @returns {Promise<{ neggo: number|null, preventas: number|null }>}
 */
async function getCompanyIds() {
    if (_companyIds) return _companyIds;

    const companies = await callOdoo(
        'res.company',
        'search_read',
        [[]],
        { fields: ['id', 'name'] }
    );

    // La empresa de preventas en Odoo se llama "Precompras" (antes "Preventas")
    const esPreventas = c => /preventa|precompra/i.test(c.name);
    const idPorEnv = v => (parseInt(v, 10) || null);

    _companyIds = {
        neggo: idPorEnv(process.env.ODOO_NEGGO_COMPANY_ID) ?? companies.find(
            c => c.name.toLowerCase().includes('neggo') && !esPreventas(c)
        )?.id ?? null,
        preventas: idPorEnv(process.env.ODOO_PREVENTAS_COMPANY_ID) ?? companies.find(esPreventas)?.id ?? null
    };

    console.log('📦 Company IDs cargados:', _companyIds);
    return _companyIds;
}

/**
 * Invalida el cache de company IDs.
 * Útil en tests o si se agregan empresas a Odoo en runtime.
 */
function clearCompanyCache() {
    _companyIds = null;
}

module.exports = { jsonRpc, callOdoo, getCompanyIds, clearCompanyCache };
