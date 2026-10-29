// Tabla maestra (nota 107): PRIMER PASO. Carga semillas, candidatos y packs en product_mappings.
// Todo queda inactivo: no cambia ningún precio ni escribe en Odoo.
//
//   node scripts/tablaMaestra.js                   → prueba: hace todo y lo deshace, muestra el resumen
//   node scripts/tablaMaestra.js --aplicar         → lo guarda
//   node scripts/tablaMaestra.js --detalle         → además lista packs dudosos y sospechosos por código (JSON)

const pool = require('../config/database');
const { primerPaso } = require('../services/tablaMaestraService');

async function main() {
    const flags = process.argv.slice(2);
    const aplicar = flags.includes('--aplicar');
    const { resumen, detalle } = await primerPaso({ aplicar });
    console.log(`📦 ${aplicar ? 'Primer paso aplicado' : 'Prueba (no se guardó nada)'}:`);
    console.log(JSON.stringify(resumen, null, 2));
    if (flags.includes('--detalle')) {
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
