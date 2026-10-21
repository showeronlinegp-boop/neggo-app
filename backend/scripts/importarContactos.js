// Importa posibles clientes desde un CSV de Google Contacts (D11).
// Limpia los nombres, normaliza teléfonos y saltea los que ya están en Odoo o en la app.
//
//   node scripts/importarContactos.js /ruta/contacts.csv            → solo muestra el resumen
//   node scripts/importarContactos.js /ruta/contacts.csv --cargar   → carga los nuevos

const fs = require('fs');
const pool = require('../config/database');
const leads = require('../services/crmLeadService');

async function main() {
    const [file, flag] = process.argv.slice(2);
    if (!file) {
        console.error('❌ Uso: node scripts/importarContactos.js <contacts.csv> [--cargar]');
        process.exit(1);
    }
    const csv = fs.readFileSync(file, 'utf8');
    const dryRun = flag !== '--cargar';
    const resumen = await leads.importGoogleContacts(csv, { dryRun });
    console.log(`📦 ${dryRun ? 'Prueba (no se cargó nada)' : 'Importación'}:`);
    console.log(JSON.stringify(resumen, null, 2));
}

main()
    .catch((err) => {
        console.error('❌ Error importando contactos:', err.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
