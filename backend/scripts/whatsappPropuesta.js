// Propuesta de publicaciones de WhatsApp por temporada, armada por Claude (nota 204).
// Lo usa una sesión de Claude Code (skill publicaciones-temporada). Solo Neggo. No programa ni manda
// nada: la propuesta se carga en /admin/whatsapp → "Generar imágenes" y la programa una persona.
//
//   node scripts/whatsappPropuesta.js datos [--fecha AAAA-MM-DD] [--limite 200] [--rubro "Jugueteria"] [--buscar "pileta,navidad"]
//   node scripts/whatsappPropuesta.js registrar [--aplicar]   → lee el listado por stdin; sin --aplicar es prueba

const pool = require('../config/database');
const svc = require('../services/whatsappPropuestas');

function leerStdin() {
    return new Promise((resolve, reject) => {
        let datos = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (c) => { datos += c; });
        process.stdin.on('end', () => resolve(datos));
        process.stdin.on('error', reject);
    });
}

function opcion(args, nombre, defecto = null) {
    const i = args.indexOf(nombre);
    return i >= 0 && args[i + 1] ? args[i + 1] : defecto;
}

async function main() {
    const args = process.argv.slice(2);
    const comando = args[0];

    if (comando === 'datos') {
        const d = await svc.datos(pool, {
            fecha: opcion(args, '--fecha'),
            limite: opcion(args, '--limite'),
            rubro: opcion(args, '--rubro'),
            buscar: opcion(args, '--buscar'),
        });
        console.log(svc.formatearDatos(d));
        return;
    }
    if (comando === 'registrar') {
        const aplicar = args.includes('--aplicar');
        const r = await svc.registrar(pool, await leerStdin(), { aplicar });
        for (const e of r.errores) console.log(`❌ ${e}`);
        console.log(`📦 «${r.titulo || 'sin título'}»: ${r.items.length} productos`);
        if (r.errores.length) console.log('⚠️ Corregí los errores: no se guardó nada.');
        else if (r.id) console.log(`✅ Propuesta #${r.id} guardada. Ya aparece en /admin/whatsapp (Generar imágenes) y /admin/estados (Imágenes para estados).`);
        else console.log('⚠️ Prueba: no se guardó nada. Repetí con --aplicar.');
        return;
    }
    console.log('Uso: node scripts/whatsappPropuesta.js datos [--fecha AAAA-MM-DD] [--limite N] [--rubro R] [--buscar a,b] | registrar [--aplicar]');
    process.exitCode = 1;
}

main()
    .catch((e) => { console.error(`❌ ${e.message}`); process.exitCode = 1; })
    .finally(() => pool.end());
