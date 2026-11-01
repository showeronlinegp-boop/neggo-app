// Categorías pendientes de los proveedores revisadas por Claude (nota 131).
// Lo usa una sesión de Claude Code (skill categorias-claude). Lo que se registra queda como propuesta
// precargada en Proveedores → Categorías pendientes; la regla la crea una persona. No toca Odoo.
//
//   node scripts/categoriasClaude.js lote [--limite 100] [--proveedor <id>] → arma una tanda e imprime el texto a revisar
//   node scripts/categoriasClaude.js registrar [--aplicar]                 → lee las respuestas por stdin; sin --aplicar es prueba
//   node scripts/categoriasClaude.js avance                                → cuántas pendientes tienen propuesta

const pool = require('../config/database');
const svc = require('../services/categoriasClaudeService');

function leerStdin() {
    return new Promise((resolve, reject) => {
        let datos = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', c => { datos += c; });
        process.stdin.on('end', () => resolve(datos));
        process.stdin.on('error', reject);
    });
}

function opcion(args, nombre, defecto) {
    const i = args.indexOf(nombre);
    return i >= 0 && args[i + 1] ? args[i + 1] : defecto;
}

async function main() {
    const args = process.argv.slice(2);
    const comando = args[0];

    if (comando === 'lote') {
        const lote = await svc.nuevoLote({
            limite: opcion(args, '--limite', svc.LOTE_DEFECTO),
            proveedor: opcion(args, '--proveedor', null),
        });
        if (!lote.filas.length) { console.log('✅ No quedan categorías pendientes sin revisar.'); return; }
        console.log(svc.formatearLote(lote));
        return;
    }
    if (comando === 'registrar') {
        const aplicar = args.includes('--aplicar');
        const { respuestas, errores, aplicado } = await svc.registrar(await leerStdin(), { aplicar });
        for (const e of errores) console.log(`❌ ${e}`);
        const cuenta = c => respuestas.filter(r => r.confianza === c).length;
        console.log(`📦 ${respuestas.length} respuestas: alta ${cuenta('alta')}, media ${cuenta('media')}, baja ${cuenta('baja')}, sin categoría ${cuenta(null)}`);
        if (errores.length) console.log('⚠️ Corregí los errores: no se guardó nada.');
        else if (aplicado) console.log('✅ Guardadas como propuestas.');
        else console.log('⚠️ Prueba: no se guardó nada. Repetí con --aplicar.');
        return;
    }
    if (comando === 'avance') {
        const a = await svc.avance();
        console.log(`📦 Pendientes ${a.pendientes} · con propuesta ${a.propuestas} · sin categoría ${a.sin_categoria} · sin revisar ${a.sin_revisar}`);
        return;
    }
    console.log('Uso: node scripts/categoriasClaude.js lote [--limite N] [--proveedor id] | registrar [--aplicar] | avance');
    process.exitCode = 1;
}

main()
    .catch(e => { console.error(`❌ ${e.message}`); process.exitCode = 1; })
    .finally(() => pool.end());
