// Cruce de productos revisado por Claude (plan de reposición automática, punto 5).
// Lo usa una sesión de Claude Code (skill cruce-productos). Nada se confirma solo: lo elegido queda
// como sugerido para Vincular. No toca Odoo ni precios.
//
//   node scripts/cruceClaude.js lote [--limite 40]          → arma y guarda una tanda; imprime el texto a revisar
//   node scripts/cruceClaude.js ver <lote>                   → vuelve a imprimir una tanda guardada
//   node scripts/cruceClaude.js registrar <lote> [--aplicar] → lee las respuestas por stdin; sin --aplicar es prueba
//   node scripts/cruceClaude.js cobertura                    → top con 1 y 2+ proveedores, y acierto de Claude

const pool = require('../config/database');
const cruce = require('../services/cruceClaudeService');

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
        const lote = await cruce.nuevoLote({ limite: opcion(args, '--limite', cruce.LOTE_DEFECTO) });
        if (!lote.productos.length) { console.log('✅ No hay productos para revisar: el top ya tiene 2 proveedores o se revisó hace poco.'); return; }
        console.log(cruce.formatearLote(lote));
        return;
    }
    if (comando === 'ver') {
        const { rows: [l] } = await pool.query(`SELECT id, productos FROM cruce_lotes WHERE id = $1`, [args[1]]);
        if (!l) throw new Error(`No existe la tanda ${args[1]}`);
        console.log(cruce.formatearLote(l));
        return;
    }
    if (comando === 'registrar') {
        if (!args[1]) throw new Error('Uso: registrar <lote> [--aplicar] < respuestas.txt');
        const resumen = await cruce.registrar(args[1], await leerStdin(), { aplicar: args.includes('--aplicar') });
        if (resumen.errores) {
            console.log('❌ No se registró nada. Corregí estas líneas:');
            for (const e of resumen.errores) console.log(`   ${e}`);
            process.exitCode = 1;
            return;
        }
        console.log(`📦 ${resumen.aplicado ? 'Registrado' : 'Prueba (no se guardó nada)'}:`);
        console.log(JSON.stringify(resumen, null, 2));
        if (resumen.faltan.length) console.log(`⚠️ Sin respuesta (vuelven en la próxima tanda): ${resumen.faltan.join(', ')}`);
        return;
    }
    if (comando === 'cobertura') {
        console.log(JSON.stringify(await cruce.cobertura(), null, 2));
        return;
    }
    console.log('Uso: lote [--limite N] | ver <lote> | registrar <lote> [--aplicar] | cobertura');
    process.exitCode = 1;
}

main()
    .catch(err => { console.error('❌', err.message); process.exitCode = 1; })
    .finally(() => pool.end());
