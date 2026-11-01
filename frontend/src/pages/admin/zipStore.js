// ZIP sin compresión (método "store"): alcanza para PNG, que ya vienen comprimidos.
// Evita sumar una librería solo para "Descargar todas".

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

// Fecha y hora en el formato de MS-DOS que usa ZIP.
function dosDateTime(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
}

// files: [{ name: 'carpeta/archivo.png', data: Uint8Array }] → Uint8Array del .zip
export function buildZip(files, date = new Date()) {
    const encoder = new TextEncoder();
    const { time, day } = dosDateTime(date);
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const file of files) {
        const name = encoder.encode(file.name);
        const data = file.data;
        const crc = crc32(data);

        const local = new Uint8Array(30 + name.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);          // versión necesaria
        lv.setUint16(6, 0x0800, true);      // nombres en UTF-8
        lv.setUint16(8, 0, true);           // sin compresión
        lv.setUint16(10, time, true);
        lv.setUint16(12, day, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, data.length, true);
        lv.setUint32(22, data.length, true);
        lv.setUint16(26, name.length, true);
        local.set(name, 30);

        const central = new Uint8Array(46 + name.length);
        const cv = new DataView(central.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0x0800, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, time, true);
        cv.setUint16(14, day, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, data.length, true);
        cv.setUint32(24, data.length, true);
        cv.setUint16(28, name.length, true);
        cv.setUint32(42, offset, true);
        central.set(name, 46);

        locals.push(local, data);
        centrals.push(central);
        offset += local.length + data.length;
    }

    const centralSize = centrals.reduce((acc, c) => acc + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    const parts = [...locals, ...centrals, end];
    const out = new Uint8Array(parts.reduce((acc, p) => acc + p.length, 0));
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    return out;
}
