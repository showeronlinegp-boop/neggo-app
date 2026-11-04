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
// Ojo: `npm run start:prod` es `node dist/main`, que carga dist/main.js (CommonJS).
// dist/main.mjs es otra copia del mismo código. Se parchean las dos y main.js es obligatorio.
//
// Si la imagen cambia y el texto no aparece, el contenedor NO arranca: preferimos
// Evolution caído antes que mensajes vacíos al grupo.

const fs = require('fs');
const path = require('path');

const DIST = process.argv[2] || '/evolution/dist';
const ORIGINAL = 'catch{return{conversation:""}}}async defineAuthState(';
const PARCHEADO = 'catch{return void 0}}async defineAuthState(';
// main.js es el que corre: tiene que quedar parcheado sí o sí.
const ARCHIVOS = [
    { nombre: 'main.js', obligatorio: true },
    { nombre: 'main.mjs', obligatorio: false },
];

function parchear(file) {
    const src = fs.readFileSync(file, 'utf8');
    if (src.includes(PARCHEADO) && !src.includes(ORIGINAL)) return 'ya';
    const apariciones = src.split(ORIGINAL).length - 1;
    if (apariciones !== 1) {
        throw new Error(`se esperaba 1 aparición en ${file} y hay ${apariciones}`);
    }
    fs.writeFileSync(file, src.replace(ORIGINAL, PARCHEADO));
    return 'aplicado';
}

let error = false;
for (const { nombre, obligatorio } of ARCHIVOS) {
    const file = path.join(DIST, nombre);
    if (!fs.existsSync(file)) {
        if (obligatorio) {
            console.error(`❌ Parche getMessage: no existe ${file}`);
            error = true;
        }
        continue;
    }
    try {
        const r = parchear(file);
        console.log(`✅ Parche getMessage ${r === 'ya' ? 'ya aplicado' : 'aplicado'} en ${nombre}`);
    } catch (err) {
        console.error(`❌ Parche getMessage: ${err.message}. ¿Cambió la versión de Evolution?`);
        error = true;
    }
}

if (error) {
    console.error('❌ Evolution no arranca sin el parche: revisar evolution/parcheGetMessage.js');
    process.exit(1);
}
