// Mock data — productos, proveedores, alertas, pedidos. Tono argentino.

const SUPPLIERS = [
  { id: 1, name: 'Cast', prefix: 'CAST', schedule: 'diario 06:00', lastRun: 'hace 2h', products: 1842, status: 'ok' },
  { id: 2, name: 'Mali', prefix: 'MALI', schedule: 'diario 06:30', lastRun: 'hace 2h', products: 967, status: 'ok' },
  { id: 3, name: 'Impotekno', prefix: 'IMP', schedule: 'lun-mié-vie', lastRun: 'hace 1d', products: 2104, status: 'warn' },
  { id: 4, name: 'El Rey', prefix: 'REY', schedule: 'diario 07:00', lastRun: 'hace 2h', products: 543, status: 'ok' },
  { id: 5, name: 'Neggo Odoo', prefix: 'NEG', schedule: 'cada 4h', lastRun: 'hace 30m', products: 4521, status: 'ok' },
];

const CATEGORIES = ['Almacén', 'Bebidas', 'Limpieza', 'Perfumería', 'Lácteos', 'Snacks', 'Bazar', 'Electro'];

const PRODUCTS = [
  { id: 101, sku: 'CAST-44721', supplier: 'Cast', name: 'Aceite girasol Natura 1.5L', cat: 'Almacén', raw: 2890, cost: 2456.5, neggo: 3070, preventas: 3380, available: true, change: 4.2, image: '🛢️' },
  { id: 102, sku: 'CAST-44830', supplier: 'Cast', name: 'Arroz Gallo largo fino 1kg', cat: 'Almacén', raw: 1450, cost: 1232.5, neggo: 1541, preventas: 1697, available: true, change: 0, image: '🍚' },
  { id: 103, sku: 'MALI-2210', supplier: 'Mali', name: 'Coca Cola 2.25L retornable', cat: 'Bebidas', raw: 2100, cost: 1890, neggo: 2363, preventas: 2520, available: true, change: -1.8, image: '🥤' },
  { id: 104, sku: 'MALI-2244', supplier: 'Mali', name: 'Cerveza Quilmes 1L', cat: 'Bebidas', raw: 1680, cost: 1512, neggo: 1890, preventas: 2016, available: true, change: 5.1, image: '🍺' },
  { id: 105, sku: 'IMP-9920', supplier: 'Impotekno', name: 'Detergente Magistral 750ml', cat: 'Limpieza', raw: 1980, cost: 1683, neggo: 2104, preventas: 2376, available: true, change: 2.3, image: '🧴' },
  { id: 106, sku: 'IMP-9933', supplier: 'Impotekno', name: 'Lavandina Ayudín 1L', cat: 'Limpieza', raw: 890, cost: 756.5, neggo: 945, preventas: 1068, available: false, change: 0, image: '🧴' },
  { id: 107, sku: 'REY-7741', supplier: 'El Rey', name: 'Yerba Taragüi suave 1kg', cat: 'Almacén', raw: 3450, cost: 2932.5, neggo: 3666, preventas: 4140, available: true, change: 8.6, image: '🌿' },
  { id: 108, sku: 'CAST-44900', supplier: 'Cast', name: 'Galletitas Oreo original 118g', cat: 'Snacks', raw: 580, cost: 493, neggo: 616, preventas: 696, available: true, change: 0, image: '🍪' },
  { id: 109, sku: 'MALI-2301', supplier: 'Mali', name: 'Vino Toro tinto 1L', cat: 'Bebidas', raw: 1890, cost: 1701, neggo: 2126, preventas: 2268, available: true, change: -3.2, image: '🍷' },
  { id: 110, sku: 'IMP-9950', supplier: 'Impotekno', name: 'Shampoo Sedal hidratación 340ml', cat: 'Perfumería', raw: 2340, cost: 1989, neggo: 2486, preventas: 2808, available: true, change: 12.4, image: '🧴' },
  { id: 111, sku: 'CAST-45012', supplier: 'Cast', name: 'Leche La Serenísima entera 1L', cat: 'Lácteos', raw: 1320, cost: 1122, neggo: 1402, preventas: 1584, available: true, change: 1.5, image: '🥛' },
  { id: 112, sku: 'REY-7780', supplier: 'El Rey', name: 'Mate de cerámica con bombilla', cat: 'Bazar', raw: 4500, cost: 3825, neggo: 4781, preventas: 5400, available: true, change: 0, image: '🧉' },
];

const ALERTS = [
  {
    id: 'a1', type: 'price_increase', supplier: 'Impotekno', product: 'Shampoo Sedal hidratación 340ml',
    sku: 'IMP-9950', oldPrice: 2080, newPrice: 2340, pct: 12.4, when: 'hace 2 horas',
    image: '🧴',
    linked: [
      { company: 'neggo', name: 'Shampoo Sedal hidratación', currentCost: 1768, currentPrice: 2210 },
      { company: 'preventas', name: 'Sedal Hidrat. 340ml', currentCost: 1768, currentPrice: 2496 },
    ],
  },
  {
    id: 'a2', type: 'price_increase', supplier: 'El Rey', product: 'Yerba Taragüi suave 1kg',
    sku: 'REY-7741', oldPrice: 3175, newPrice: 3450, pct: 8.6, when: 'hace 3 horas',
    image: '🌿',
    linked: [
      { company: 'neggo', name: 'Yerba Taragüi 1kg', currentCost: 2698, currentPrice: 3372 },
    ],
  },
  {
    id: 'a3', type: 'price_decrease', supplier: 'Mali', product: 'Vino Toro tinto 1L',
    sku: 'MALI-2301', oldPrice: 1953, newPrice: 1890, pct: -3.2, when: 'hace 5 horas',
    image: '🍷',
    linked: [
      { company: 'neggo', name: 'Vino Toro 1L', currentCost: 1757, currentPrice: 2196 },
      { company: 'preventas', name: 'Toro Tinto 1L', currentCost: 1757, currentPrice: 2343 },
    ],
  },
  {
    id: 'a4', type: 'out_of_stock', supplier: 'Impotekno', product: 'Lavandina Ayudín 1L',
    sku: 'IMP-9933', oldPrice: 890, newPrice: null, pct: 0, when: 'hace 6 horas',
    image: '🧴', linked: [],
  },
  {
    id: 'a5', type: 'price_increase', supplier: 'Mali', product: 'Cerveza Quilmes 1L',
    sku: 'MALI-2244', oldPrice: 1599, newPrice: 1680, pct: 5.1, when: 'ayer',
    image: '🍺',
    linked: [
      { company: 'neggo', name: 'Quilmes 1L', currentCost: 1439, currentPrice: 1799 },
    ],
  },
  {
    id: 'a6', type: 'price_increase', supplier: 'Cast', product: 'Aceite girasol Natura 1.5L',
    sku: 'CAST-44721', oldPrice: 2772, newPrice: 2890, pct: 4.2, when: 'ayer',
    image: '🛢️',
    linked: [
      { company: 'neggo', name: 'Aceite Natura 1.5L', currentCost: 2356, currentPrice: 2945 },
      { company: 'preventas', name: 'Aceite Natura 1.5L', currentCost: 2356, currentPrice: 3140 },
    ],
  },
];

const CLIENT_ORDERS = [
  { id: 'P-2418', client: 'Almacén Don Pepe', phone: '11 5544 2211', items: 12, total: 48650, status: 'pendiente', when: 'hoy 09:42' },
  { id: 'P-2417', client: 'Kiosco La Esquina', phone: '11 4422 8899', items: 8, total: 21340, status: 'procesando', when: 'hoy 08:15' },
  { id: 'P-2416', client: 'Supermercado Norte', phone: '2477 33 4455', items: 24, total: 112580, status: 'comprado', when: 'ayer' },
  { id: 'P-2415', client: 'Despensa Familia García', phone: '11 6677 1122', items: 6, total: 18900, status: 'recibido', when: 'ayer' },
  { id: 'P-2414', client: 'Almacén Don Pepe', phone: '11 5544 2211', items: 18, total: 67230, status: 'entregado', when: 'lun 14/04' },
  { id: 'P-2413', client: 'Mini Market Centro', phone: '2477 22 8866', items: 4, total: 9450, status: 'cancelado', when: 'lun 14/04' },
];

const STATUS_LABELS = {
  pendiente: { label: 'Pendiente', tone: 'warn' },
  procesando: { label: 'Procesando', tone: 'primary' },
  comprado: { label: 'Comprado', tone: 'primary' },
  recibido: { label: 'Recibido', tone: 'success' },
  entregado: { label: 'Entregado', tone: 'muted' },
  cancelado: { label: 'Cancelado', tone: 'danger' },
};

const ACTIVITY = [
  { user: 'Juan', action: 'aprobó alerta de precio', detail: 'IMP-9950 +12.4%', when: 'hace 5 min' },
  { user: 'María', action: 'creó pedido', detail: 'P-2418 — Almacén Don Pepe', when: 'hace 18 min' },
  { user: 'Sistema', action: 'corrió scraping', detail: 'Cast — 1842 productos', when: 'hace 2h' },
  { user: 'Juan', action: 'vinculó producto', detail: 'CAST-44721 ↔ Odoo Neggo', when: 'hace 3h' },
  { user: 'María', action: 'envió OC a Odoo', detail: 'OC-1102 — Mali', when: 'hace 4h' },
];

// Format helpers
const fmtAR = (n) => '$' + Math.round(n).toLocaleString('es-AR');
const fmtPct = (n) => (n > 0 ? '+' : '') + n.toFixed(1) + '%';

Object.assign(window, {
  SUPPLIERS, CATEGORIES, PRODUCTS, ALERTS, CLIENT_ORDERS, STATUS_LABELS, ACTIVITY,
  fmtAR, fmtPct,
});
