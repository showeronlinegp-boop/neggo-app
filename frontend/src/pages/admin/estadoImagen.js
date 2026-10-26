// Armado de imágenes para estados (nota #91) con canvas, en el navegador.
// Fondo blanco, logo arriba, foto, nombre en negrita (máx. 2 renglones) y precio.
// Los colores son los del tema claro siempre: la imagen no cambia con el modo oscuro.
import { palette, font } from '../../theme/tokens';

const color = palette.light;
export const LOGO_URL = '/neggo-logo.png';
export const FRASE = 'Respondé este estado y te lo reservamos';
const ANCHO_TEXTO = 920;

// Historia: WhatsApp tapa ~210 px arriba (nombre y hora) y ~230 px abajo (barra "Responder").
export const FORMATOS = {
    historia: {
        label: 'Historia (1080×1920)',
        w: 1080, h: 1920,
        logo: { w: 380, y: 250 },
        foto: { s: 860, y: 400 },
        nombre: { size: 64, lh: 78, gap: 44 },
        precio: { size: 130, gap: 18 },
        frase: { size: 40, gap: 26 },
    },
    cuadrada: {
        label: 'Cuadrada (1080×1080)',
        w: 1080, h: 1080,
        logo: { w: 260, y: 48 },
        foto: { s: 600, y: 140 },
        nombre: { size: 50, lh: 62, gap: 32 },
        precio: { size: 100, gap: 12 },
        frase: null,
    },
};

// Saca códigos internos del nombre: [CY003], {WD931}, (HAT11), (218194), "Art. CT30CM" al final,
// asteriscos. Los paréntesis con texto normal, como "(22 cm)" o "(Set Diamante)", quedan.
export function limpiarNombre(nombre) {
    return String(nombre || '')
        .replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ')
        .replace(/\(\s*[A-Z0-9-]*\d[A-Z0-9-]*\s*\)/g, ' ')
        .replace(/\bArt\.?\s*\S+\s*$/i, ' ')
        .replace(/\*+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Parte el texto en renglones que entran en `ancho`. Si sobran, corta el último con "…".
// medir(texto) → ancho en px (ctx.measureText en el navegador).
export function partirRenglones(medir, texto, ancho, max = 2) {
    const palabras = String(texto || '').split(' ').filter(Boolean);
    const lineas = [];
    let actual = '';
    for (const palabra of palabras) {
        const prueba = actual ? `${actual} ${palabra}` : palabra;
        if (!actual || medir(prueba) <= ancho) actual = prueba;
        else { lineas.push(actual); actual = palabra; }
    }
    if (actual) lineas.push(actual);
    if (lineas.length <= max) return lineas;

    const out = lineas.slice(0, max);
    let ultima = out[max - 1];
    while (ultima.includes(' ') && medir(`${ultima}…`) > ancho) ultima = ultima.replace(/\s*\S+$/, '');
    // Una sola palabra larguísima: se recorta por letras.
    while (ultima.length > 1 && medir(`${ultima}…`) > ancho) ultima = ultima.slice(0, -1);
    out[max - 1] = `${ultima.replace(/[\s,.;:-]+$/, '')}…`;
    return out;
}

// Achica la letra hasta que el texto entre en una línea (para precios muy largos).
function tamanioQueEntra(ctx, texto, peso, size, ancho) {
    let s = size;
    ctx.font = `${peso} ${s}px ${font.family}`;
    while (s > 20 && ctx.measureText(texto).width > ancho) {
        s -= 4;
        ctx.font = `${peso} ${s}px ${font.family}`;
    }
    return s;
}

const imagenes = new Map();

// Carga (y recuerda) una imagen del mismo origen, así el canvas se puede exportar.
export function cargarImagen(src) {
    if (!imagenes.has(src)) {
        const p = new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('No se pudo cargar la foto'));
            img.src = src;
        });
        p.catch(() => imagenes.delete(src));
        imagenes.set(src, p);
    }
    return imagenes.get(src);
}

// Espera la tipografía: si se dibuja antes, el canvas usa otra letra.
export async function prepararFuentes() {
    if (!document.fonts?.load) return;
    await Promise.all([
        document.fonts.load(`${font.weight.bold} 64px Inter`),
        document.fonts.load(`${font.weight.medium} 40px Inter`),
    ]);
}

// Dibuja la imagen completa en `canvas` (se le fija el tamaño del formato).
export function dibujarEstado(canvas, { formato = 'historia', logo, foto, nombre, precio }) {
    const f = FORMATOS[formato] || FORMATOS.historia;
    canvas.width = f.w;
    canvas.height = f.h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color.surface;
    ctx.fillRect(0, 0, f.w, f.h);

    if (logo) {
        const lh = f.logo.w * logo.height / logo.width;
        ctx.drawImage(logo, (f.w - f.logo.w) / 2, f.logo.y, f.logo.w, lh);
    }

    // Foto entera dentro del cuadrado, centrada.
    const box = { x: (f.w - f.foto.s) / 2, y: f.foto.y, s: f.foto.s };
    if (foto) {
        const k = Math.min(box.s / foto.width, box.s / foto.height);
        const fw = foto.width * k;
        const fh = foto.height * k;
        ctx.drawImage(foto, box.x + (box.s - fw) / 2, box.y + (box.s - fh) / 2, fw, fh);
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    // Nombre: hasta 2 renglones; el precio va siempre debajo del último, nunca encima.
    let y = box.y + box.s + f.nombre.gap;
    ctx.fillStyle = color.text;
    ctx.font = `${font.weight.bold} ${f.nombre.size}px ${font.family}`;
    const lineas = partirRenglones((t) => ctx.measureText(t).width, limpiarNombre(nombre), ANCHO_TEXTO, 2);
    lineas.forEach((linea, i) => ctx.fillText(linea, f.w / 2, y + i * f.nombre.lh));
    y += lineas.length * f.nombre.lh + f.precio.gap;

    ctx.fillStyle = color.accent;
    const sizePrecio = tamanioQueEntra(ctx, precio || '', font.weight.bold, f.precio.size, ANCHO_TEXTO);
    ctx.fillText(precio || '', f.w / 2, y);
    y += sizePrecio * 1.15;

    if (f.frase) {
        ctx.fillStyle = color.textMuted;
        ctx.font = `${font.weight.medium} ${f.frase.size}px ${font.family}`;
        ctx.fillText(FRASE, f.w / 2, y + f.frase.gap);
    }
    return canvas;
}

export function canvasABlob(canvas) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('No se pudo generar la imagen'))), 'image/png');
    });
}

// "Mochila Peluche Stitch" → "mochila-peluche-stitch"
export function nombreArchivo(texto, max = 60) {
    const slug = limpiarNombre(texto)
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, max)
        .replace(/-+$/, '');
    return slug || 'producto';
}

export function guardarArchivo(blob, nombre) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
