// Parche de Evolution API v2.3.7 que se aplica al arrancar el contenedor.
//
// Problema: cuando un teléfono del grupo no pudo descifrar un mensaje nuestro, manda un
// "retry receipt" y Baileys le pide el mensaje original a Evolution con getMessage().
// Como no guardamos mensajes (DATABASE_SAVE_DATA_NEW_MESSAGE=false), la consulta falla y
// Evolution devuelve { conversation: "" }. Baileys lo toma como un mensaje válido y lo
// reenvía al grupo: al reconectar salen en ráfaga todos los pedidos acumulados, vacíos.
//
// Arreglo: si no lo encuentra, devolver undefined. Baileys entonces no reenvía nada
// (messages-recv.js: `if (msg && ...) relayMessage(...)`). Todos los demás usos de
// getMessage en Evolution ya contemplan undefined.
//
// Si la imagen cambia y el texto no aparece, el contenedor NO arranca: preferimos
// Evolution caído antes que mensajes vacíos al grupo.

const fs = require('fs');

const FILE = process.argv[2] || '/evolution/dist/main.mjs';
const ORIGINAL = 'catch{return{conversation:""}}}async defineAuthState(';
const PARCHEADO = 'catch{return void 0}}async defineAuthState(';

const src = fs.readFileSync(FILE, 'utf8');

if (src.includes(PARCHEADO)) {
    console.log('✅ Parche getMessage ya aplicado: no se reenvían mensajes vacíos');
    process.exit(0);
}

const apariciones = src.split(ORIGINAL).length - 1;
if (apariciones !== 1) {
    console.error(`❌ Parche getMessage: se esperaba 1 aparición y hay ${apariciones}. ` +
        '¿Cambió la versión de Evolution? Revisar evolution/parcheGetMessage.js antes de arrancar.');
    process.exit(1);
}

fs.writeFileSync(FILE, src.replace(ORIGINAL, PARCHEADO));
console.log('✅ Parche getMessage aplicado: los reintentos sin mensaje guardado ya no salen vacíos');
