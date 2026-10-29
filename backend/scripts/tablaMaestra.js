// Tabla maestra (nota 107). Carga y mantenimiento de product_mappings.
// Salvo "activar", todo queda inactivo: no cambia ningún precio ni escribe en Odoo.
//
//   node scripts/tablaMaestra.js                       → PRIMER PASO de prueba: hace todo y lo deshace
//   node scripts/tablaMaestra.js --aplicar             → PRIMER PASO, lo guarda
//   node scripts/tablaMaestra.js --detalle             → además lista packs dudosos y sospechosos por código (JSON)
//   node scripts/tablaMaestra.js corregir [--aplicar]  → corrección de datos (habituales de Precompras, etc.)
//   node scripts/tablaMaestra.js repasar <supplierId>  → vincula los ingresos confirmados de un proveedor
//   node scripts/tablaMaestra.js conflictos            → ofertas confirmadas con dos o más productos de Neggo
//   node scripts/tablaMaestra.js activar [--aplicar]   → PRENDE la tabla: los confirmados de Neggo quedan activos
//                                                        y el habitual pasa a mover precios (alerta de Neggo)
//   node scripts/tablaMaestra.js apagar [--aplicar]    → vuelve atrás: todos los vínculos inactivos

const pool = require('../config/database');
const {
    primerPaso, corregirDatos, vincularDesdeIngresos, listarConflictos, activar
} = require('../services/tablaMaestraService');

async function main() {
    const args = process.argv.slice(2);
    const aplicar = args.includes('--aplicar');
    const comando = args[0] && !args[0].startsWith('--') ? args[0] : 'primer-paso';

    if (comando === 'corregir') {
        const resumen = await corregirDatos({ aplicar });
        console.log(`📦 ${aplicar ? 'Corrección aplicada' : 'Prueba (no se guardó nada)'}:`);
        console.log(JSON.stringify(resumen, null, 2));
        return;
    }
    if (comando === 'repasar') {
        const supplierId = parseInt(args[1], 10);
        if (!supplierId) throw new Error('Uso: repasar <supplierId>');
        console.log('📦 Repaso de ingresos:', JSON.stringify(await vincularDesdeIngresos({ supplierId })));
        return;
    }
    if (comando === 'activar' || comando === 'apagar') {
        const resumen = await activar({ aplicar, prender: comando === 'activar' });
        console.log(`📦 ${aplicar ? 'Aplicado' : 'Prueba (no se guardó nada)'}:`);
        console.log(JSON.stringify(resumen, null, 2));
        return;
    }
    if (comando === 'conflictos') {
        console.log(JSON.stringify(await listarConflictos(), null, 2));
        return;
    }

    const { resumen, detalle } = await primerPaso({ aplicar });
    console.log(`📦 ${aplicar ? 'Primer paso aplicado' : 'Prueba (no se guardó nada)'}:`);
    console.log(JSON.stringify(resumen, null, 2));
    if (args.includes('--detalle')) {
        console.log(JSON.stringify(detalle, null, 2));
    } else {
        console.log(`📦 Packs dudosos: ${detalle.packs_dudosos.length} · sospechosos por código: ${detalle.sospechosos_codigo.length} (ver con --detalle)`);
    }
}

main()
    .catch((err) => {
        console.error('❌ Error en la tabla maestra:', err.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
