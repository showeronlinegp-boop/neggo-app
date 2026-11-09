// Subir fotos que faltan en Odoo Preventas con Odoo y base simulados (nota 182).
// node backend/services/preventasFotos.test.js

const assert = require('assert');
const { subirFotosFaltantes } = require('./preventasFotosService');

// PNG mínimo (detectMime lo reconoce por la firma)
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
const TEXTO = Buffer.from('<html>no es foto</html>').toString('base64');

function armar({ filas, conFoto = [], fotos = {}, fallaLectura = false, frenarDespues = Infinity }) {
    const escritos = [];
    const marcados = [];
    const pool = {
        async query(sql, params) {
            if (/^\s*SELECT/.test(sql)) return { rows: filas.map(f => ({ ...f })) };
            marcados.push(...params[0]);
            return { rows: [] };
        },
    };
    async function callOdoo(model, method, args) {
        if (model === 'product.template' && method === 'read') {
            if (fallaLectura) throw new Error('HTTP 429');
            return args[0].map(id => ({ id, image_128: conFoto.includes(id) ? 'abc' : false }));
        }
        if (model === 'product.template' && method === 'write') {
            escritos.push(args[0][0]);
            return true;
        }
        throw new Error(`llamada inesperada ${model}.${method}`);
    }
    const deps = {
        pool, callOdoo,
        getCompanyIds: async () => ({ neggo: 1, preventas: 50 }),
        getImageBase64: async url => (url in fotos ? fotos[url] : PNG),
        olvidarFotoOdoo: () => {},
        pausa: async () => {},
        debeFrenar: () => escritos.length >= frenarDespues,
    };
    return { deps, escritos, marcados };
}

const fila = (template_id, extra = {}) => ({ template_id, odoo_product_id: template_id + 1000, image_url: `u${template_id}`, sku: `PRE${template_id}`, name: `P ${template_id}`, ...extra });

(async () => {
    // 1. Sube solo a los que Odoo confirma sin foto; los que ya tienen se marcan en el cache
    {
        const { deps, escritos, marcados } = armar({ filas: [fila(1), fila(2), fila(3)], conFoto: [2] });
        const r = await subirFotosFaltantes({}, deps);
        assert.deepStrictEqual(escritos, [1, 3]);
        assert.strictEqual(r.subidas, 2);
        assert.strictEqual(r.ya_tenian, 1);
        assert.strictEqual(r.errores, 0);
        assert.ok(marcados.includes(2) && marcados.includes(1) && marcados.includes(3));
    }
    // 2. Foto que no se descarga o que no es imagen: no se escribe y queda en fallidos
    {
        const { deps, escritos } = armar({ filas: [fila(1), fila(2), fila(3)], fotos: { u1: null, u2: TEXTO } });
        const r = await subirFotosFaltantes({}, deps);
        assert.deepStrictEqual(escritos, [3]);
        assert.strictEqual(r.errores, 2);
        assert.deepStrictEqual(r.fallidos.map(f => f.sku), ['PRE1', 'PRE2']);
    }
    // 3. Si no se puede consultar Odoo, no se escribe nada (no se arriesga a pisar una foto)
    {
        const { deps, escritos } = armar({ filas: [fila(1), fila(2)], fallaLectura: true });
        const r = await subirFotosFaltantes({}, deps);
        assert.deepStrictEqual(escritos, []);
        assert.strictEqual(r.errores, 2);
    }
    // 4. Frenar corta después de la foto en curso
    {
        const { deps, escritos } = armar({ filas: [fila(1), fila(2), fila(3)], frenarDespues: 1 });
        const r = await subirFotosFaltantes({}, deps);
        assert.deepStrictEqual(escritos, [1]);
        assert.strictEqual(r.frenado, true);
    }
    // 5. Muchos productos: se lee Odoo de a lotes y se suben todos
    {
        const filas = Array.from({ length: 120 }, (_, i) => fila(i + 1));
        const { deps, escritos } = armar({ filas });
        const r = await subirFotosFaltantes({}, deps);
        assert.strictEqual(escritos.length, 120);
        assert.strictEqual(r.total, 120);
    }
    console.log('✅ preventasFotos: 5 casos ok');
})().catch(err => { console.error('❌', err); process.exit(1); });
