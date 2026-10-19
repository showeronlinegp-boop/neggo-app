# Plan de arreglos críticos — 4 flujos

Análisis del 19 de octubre de 2026. No implementa nada. El objetivo es la lista mínima para que estos cuatro flujos funcionen, en el orden que pidió el dueño. Queda afuera todo lo que no bloquea enviar un catálogo, armar una compra con datos de Odoo, separar un ingreso, o publicar en WhatsApp.

El detalle de estado general sigue en `docs/estado-implementacion.md`. Acá solo entra lo que rompe o vuelve frágil a estos flujos, con archivo y línea.

Tamaño: **chico** es un cambio local, testeable en el mismo flujo. **Mediano** toca más de un archivo o cambia cómo se clasifica un ítem. Riesgo es de regresión sobre datos que ya están en uso.

## Prerrequisito compartido

Estos flujos leen columnas que `backend/sql/schema.sql` no crea y que `backend/initDatabase.js` tampoco agrega. En una base que ya corrió `backend/sql/migrations/` a mano, el síntoma no aparece. En una base nueva, Docker ejecuta solo `schema.sql`: el índice de la línea 700 referencia `preventa_client_orders.pricelist_id` y esa columna no existe en el `CREATE TABLE` (líneas 231-246). El entrypoint de Postgres corta el script ahí.

| Columna que falta | Qué flujo se cae | Dónde se usa |
|---|---|---|
| `suppliers.markup_neggo`, `suppliers.markup_preventas` | Catálogo e ingreso | `catalogService.js:228-229`, `ingresoService.js:645-646` |
| `supplier_category_rules.markup_neggo_override`, `markup_preventas_override` | Catálogo | `catalogService.js:232-233` |
| `odoo_products_cache.template_id`, `has_image` | Pedidos (el sync completo falla y no refresca proveedor ni costo) | `odooSync.js:295-312` |
| `preventa_client_orders.pricelist_id` | Pedido nuevo, aunque la lista vaya en null | `preventas.js:101` |
| `ingreso_items.match_level` | No se puede guardar el preview del ingreso | `ingresoService.js:524` |
| `ingreso_items.preventa_qty_confirmed` | No se puede persistir el reparto Preventas / Neggo | `ingreso.js:590`, `ingresoService.js:730` |
| `ingreso_mercaderia.odoo_purchase_order_id_preventas` | El confirm hace `UPDATE` de una columna inexistente después de haber creado la OC en Odoo | `ingresoService.js:891` |

`initDatabase.js` sí agrega otras columnas del ingreso (`supplier_match_level`, `preventas_product_id`, `preventa_links`, `pack_size`) al arrancar el backend. Esas no entran en este arreglo.

**Arreglo P0.** Una sola migración idempotente (`ADD COLUMN IF NOT EXISTS`) aplicada al arrancar, y las mismas columnas en `schema.sql`, incluido `pricelist_id` antes del índice de la línea 700. Tamaño chico. Riesgo bajo: solo agrega columnas con default.

Sin P0, los arreglos de código de los flujos 1 a 3 fallan igual en una base vacía.

## 1. Generador de catálogos PDF

### Estado

El camino está cerrado y genera un PDF descargable, si la base tiene las columnas de markup y hay reglas de categoría.

1. `frontend/src/pages/preventas/Catalogs.jsx` elige tipo y categoría y llama `POST /api/catalogs/generate`.
2. `backend/routes/catalogs.js:35` exige rol admin o vendedor.
3. `backend/services/catalogService.js:217` junta `supplier_products` cuya categoría de origen coincide con una regla activa, proveedor activo y `is_published`, con precio y stock disponible.
4. Calcula el precio con `rulesEngine.calculatePrices` (línea 289), baja las fotos y escribe el PDF con PDFKit.
5. Guarda el archivo en `backend/storage/catalogs` (en Docker, `/app/storage/catalogs`, que es el volumen) y la fila en `catalogs`.
6. La descarga es `GET /api/catalogs/:id/download` (`catalogs.js:96`). Nginx le da 600 s (`nginx.conf:59`).

Si el desplegable dice "Sin categorías configuradas", el generador no está roto: no hay filas en `supplier_category_rules` para ese destino. Eso se carga en Proveedores → reglas, no en este flujo.

### Qué está roto o es frágil

| Problema | Evidencia | Efecto al enviar el PDF |
|---|---|---|
| El precio usa el locale del sistema | `catalogService.js:49-51` (`toLocaleString('es-AR')`). La imagen es `node:20-alpine` (`backend/Dockerfile:1`), cuyo ICU chico no trae `es-AR` | El cliente ve `$1,234` en lugar de `$1.234` |
| El logo no se encuentra dentro del contenedor | `catalogService.js:44` apunta a `../../volumes/storage/neggo_logo.png`. Desde `/app/services` eso es `/volumes/storage/...`. El archivo del repo está en `volumes/storage/neggo_logo.png` y el compose lo monta en `/app/storage` | El PDF sale con el texto "neggo" (`catalogService.js:112-116`) |
| Cambiar el tipo a Neggo no recarga categorías | `Catalogs.jsx:33-36` pide `/catalogs/categories` una sola vez, sin `type`. El backend defaultea a Preventas (`catalogs.js:14`) | Una categoría de Preventas se manda con `type: 'neggo'` y el PDF sale vacío o es el de la otra empresa |
| Una regla ignorada igual entra al catálogo | El `JOIN` de `catalogService.js:239-243` no exige `scr.ignored = false` | Se publican categorías que el operador marcó para descartar |

### Arreglos mínimos

1. Formatear el entero a mano (`$` + miles con punto). Chico, riesgo bajo.
2. Leer el logo desde `STORAGE_PATH` (`/app/storage/neggo_logo.png`), con el fallback de texto que ya existe. Chico, riesgo bajo.
3. Volver a pedir `/catalogs/categories?type=` cuando cambia el tipo, y limpiar la categoría elegida. Chico, riesgo bajo.
4. Excluir `ignored = true` en la query del catálogo y en el listado de categorías (`catalogs.js:18`). Chico, riesgo bajo.

Queda afuera: templates nuevos, otro diseño, y regenerar catálogos viejos ya guardados.

## 2. Pedidos de preventa, para comprar

Hay dos pantallas. Las dos tienen que coincidir con lo que el dueño usa para comprar. El código de "traer Odoo y armar la compra" es la segunda.

### Camino A — cotizaciones de Odoo agrupadas por proveedor

Es la pantalla "Pedidos x Proveedor" (`/preventas/ordenes-odoo`).

1. `OdooSupplierBreakdown.jsx:70` llama `GET /api/preventas/odoo-quotations/by-supplier`.
2. `preventas.js:773` pide otra vez todas las cotizaciones.
3. `odooService.getPreventasQuotations` (`odooService.js:765`) lee `sale.order` en estado `draft` o `sent` de la empresa Preventas, hasta 200, y después las líneas y el `default_code`.
4. El agrupado no usa `product_mappings`. Usa `odoo_products_cache.vendor_name` (`preventas.js:789-821`). Sin vendor, la línea cae en "Sin proveedor asignado".
5. El costo es `standard_price` del cache. La foto es `image_url`, que el sync arma como `/api/products/odoo-image/{empresa}/{templateId}` solo si `has_image` y `template_id` existen (`odooSync.js:264-266`).
6. El PDF del pedido al proveedor (`preventas.js:884`) necesita `CHROME_WS_ENDPOINT` y el contenedor `chrome`. El servicio `backend` del compose no depende de `chrome`.

### Camino B — pedido cargado en la app y pasado a una orden de compra

Es "Pedidos" (`ClientOrders.jsx`) y después "Órdenes a proveedores".

1. El alta busca en el cache: `GET /api/products/odoo?company=` (`ClientOrders.jsx:368`). El default es empresa Neggo (`ClientOrders.jsx:345`).
2. El ítem se guarda con `source = 'odoo'` y sin `supplier_product_id` (`preventasService.js:214-220`).
3. "Generar órdenes" tira esos ítems. `generateSupplierOrders` hace `JOIN supplier_products` y exige `supplier_product_id IS NOT NULL` (`preventasService.js:248-264`). Si el pedido se armó desde Odoo, la respuesta es "Los pedidos seleccionados no tienen ítems".

### Qué está roto o es frágil

| Problema | Evidencia | Efecto |
|---|---|---|
| Tope de 200 cotizaciones, sin paginar | `odooService.js:775` | Pedidos abiertos de más no entran a la compra |
| Esas rutas caen en el proxy de 30 s | `nginx.conf:102`. No hay `location` propio, a diferencia de catálogos (600 s) y del sync (300 s) | Con muchas líneas Odoo, la pantalla falla por timeout |
| Líneas de sección o nota cuentan como producto | `odooService.js:827-835` copia toda `sale.order.line`. No mira si `product_id` es null | Aparecen renglones sin código en "Sin proveedor" |
| El proveedor de la compra es el primer `supplierinfo` de Odoo | `odooSync.js:200-204` guarda el primer seller. `preventas.js:819` agrupa por ese nombre | Si Preventas no tiene proveedor cargado, o el nombre no es de quien se le compra, todo queda sin asignar. El comentario de `preventas.js:771` dice que usa `product_mappings`; el código no lo hace |
| El sync no llega a escribir `vendor_name` si faltan `template_id` y `has_image` | `odooSync.js:295` inserta las 21 columnas juntas. Esas dos no están en el schema ni en `initDatabase.js` | El agrupado se queda con el cache viejo o vacío |
| Ítems cargados desde Odoo no generan OC | `preventasService.js:261-264` | El botón de "Órdenes a proveedores" no compra lo que se cargó en Pedidos |
| El PDF del proveedor formatea con `Intl` `es-AR` | `preventas.js:899-901` | Mismo problema de miles que el catálogo, sobre Alpine |
| Si Chrome no responde, el botón no avisa | `OdooSupplierBreakdown.jsx:27` hace `if (!res.ok) return` | El operador cree que no se generó y no ve el error |
| El backend no espera a Chrome | `docker-compose.yml:35-38` solo espera a Postgres | El PDF de compra falla con `CHROME_WS_ENDPOINT` aunque el catálogo (PDFKit) sí salga |

### Arreglos mínimos

1. P0, para que el sync pueda guardar `vendor_name`, `template_id` y `has_image`.
2. Paginar `getPreventasQuotations` hasta agotar `draft`/`sent`, y subir el `proxy_read_timeout` de `/api/preventas/odoo-quotations` y de `/api/ingreso/` (el flujo 3 usa la misma lectura). Chico, riesgo bajo.
3. Saltear líneas sin `product_id`. Chico, riesgo bajo.
4. Agrupar por el proveedor local del mapping (`product_mappings` → `suppliers`) y usar `vendor_name` solo cuando no hay mapping. "Sin proveedor" queda para el resto. Mediano, riesgo medio: cambia el corte de la lista de compra. Depende de la respuesta del dueño.
5. En `generateSupplierOrders`, si el ítem es de Odoo, resolver el proveedor por el mismo mapping y no descartarlo. Mediano, riesgo medio. Solo hace falta si la compra sale del camino B.
6. Formato de miles a mano en el PDF de `preventas.js:899`, y mostrar el error si Chrome o el PDF fallan. Chico, riesgo bajo.
7. `depends_on: chrome` en el servicio backend. Chico, riesgo bajo.

Queda afuera: Kanban, recomendaciones, y reescribir el sync para que sea incremental.

## 3. Ingreso de mercadería — separar y clasificar

### Estado

El camino para clasificar lo que llega ya existe. No hay que construir el módulo.

1. `IngresoUpload.jsx` manda un CSV a `POST /api/ingreso/upload`.
2. `ingresoService.matchItems` (`ingresoService.js:171`) cruza cada renglón solo contra Odoo Neggo: mapping del proveedor, código de factura ya aprendido, referencia con prefijo, barcode, descripción de compra y fuzzy de nombre. Después busca el producto scrapeado del mismo proveedor (triangulación).
3. `createIngresoPreview` guarda el ítem con `estado_item` `matched` o `pending` (`ingresoService.js:516`).
4. En `IngresoPreview.jsx` el operador reparte cantidad: lo confirmado a Preventas (`preventa_qty_confirmed`) y el resto queda para Neggo (`IngresoPreview.jsx:2210-2216`). La pestaña Preventa llama `GET /api/ingreso/:id/preventa-odoo-match` (`ingreso.js:1989`), que vuelve a leer las cotizaciones abiertas y propone a qué pedido de cliente corresponde cada renglón.
5. Al confirmar, `confirmIngreso` arma dos listas: `neggoQty = cantidad - preventa_qty_confirmed` y el resto a la OC de Preventas (`ingresoService.js:730-800`), y crea un `purchase.order` por empresa.

### Qué está roto o es frágil

| Problema | Evidencia | Efecto al clasificar |
|---|---|---|
| Sin `match_level` no se guarda el preview | `ingresoService.js:524` | No hay ingreso para clasificar (base sin esa migración) |
| Sin `preventa_qty_confirmed` el reparto no se guarda | `ingreso.js:588-591` | Toda la cantidad sigue el camino Neggo (`ingresoService.js:730-732` con qty 0) |
| Sin `odoo_purchase_order_id_preventas` el confirm revienta después de crear la OC | `ingresoService.js:859-894`. El `UPDATE` está en la transacción; la llamada a Odoo no se deshace | Queda una OC en Odoo y el ingreso sigue pendiente. Reintentar duplica la OC |
| El código de factura matchea por substring | `ingresoService.js:218-220`: `UPPER(sp.sku) LIKE UPPER('%codigo%')` | `100` puede clasificarse como el producto `1001` y marcarse `matched` con confianza 1 |
| Un fuzzy de 0,72 queda clasificado como el producto | `ingresoService.js:316-320` pone `estado_item = 'matched'`. La pantalla trata todo `matched` como identificado (`IngresoPreview.jsx:448`) | Un parecido de nombre se separa como si fuera el artículo correcto |
| La misma factura con el código repetido se confirma en un solo renglón | `ingreso.js:2018-2032` suma cantidades para mostrar, y devuelve solo el primer `id`. El operador guarda `preventa_qty_confirmed` en ese id (`IngresoPreview.jsx:2063`) | El otro renglón, con la misma mercadería, entra entero a Neggo |
| El parecido de nombre también ata el renglón a una cotización ajena | `ingreso.js:2142-2147`, umbral 0,72 | La pestaña Preventa propone un pedido de otro cliente |
| Esa pestaña vuelve a bajar todas las cotizaciones bajo el timeout de 30 s | `ingreso.js:2036` llama `getPreventasQuotations` | La clasificación contra pedidos abiertos falla por tiempo, el mismo corte del flujo 2 |

### Arreglos mínimos

1. P0, para poder guardar preview, reparto y el id de la OC Preventas.
2. Sacar el `LIKE '%codigo%'`. Dejar igualdad de SKU normalizado (el nivel de referencia que ya está en las líneas 274-289). Chico, riesgo bajo.
3. Un `match_level` `fuzzy_name` no pasa a `matched`. Queda pendiente, con el candidato visible para que el operador lo acepte. Mediano, riesgo medio: hay más ítems para confirmar a mano. El umbral lo define el dueño.
4. Al guardar la cantidad de Preventas de un código, repartirla en todos los `ingreso_items` de ese código del mismo ingreso (o fusionar los duplicados antes de confirmar; el endpoint `merge-duplicate-items` ya existe en `ingreso.js:2199` y hoy es manual). Mediano, riesgo medio.
5. En `preventa-odoo-match`, proponer por código y no auto-vincular por nombre fuzzy. Chico, riesgo bajo. El timeout se resuelve con el arreglo 2 del flujo 2.
6. Crear las OC de Odoo recién cuando el `UPDATE` local de los ids puede ejecutarse (la columna ya existe por P0). Si Odoo responde y el `UPDATE` falla, no reintentar a ciegas: guardar el id que Odoo devolvió. Chico, riesgo medio porque toca el confirm.

Queda afuera: OCR, cámara, `account.move`, y partir `IngresoPreview.jsx` en componentes.

## 4. Bot de WhatsApp con Evolution API

**Ese código no está en el repo.**

La búsqueda de `evolution`, `baileys` y `whatsapp` en código solo encuentra la palabra "whatsapp" como canal futuro en `docs/agents/13-marketing.md:23` y en el comentario de `marketing_calendar` dentro de `backend/sql/schema.sql`. No hay cliente HTTP, webhook, token, instancia ni lista de grupos. No hay un flujo que arreglar: hay que agregarlo.

Lo mínimo para no dejar de vender, sin el módulo de marketing:

1. Un módulo chico en el backend: configuración por entorno (`EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE`, JIDs de grupos) y un endpoint autenticado, solo admin, que manda un texto o un PDF ya generado a esos grupos vía `POST /message/sendText` y `POST /message/sendMedia` de Evolution.
2. En la pantalla de catálogos, un botón "Publicar" al lado de Descargar, que llama a ese endpoint con el `catalogId`. Reusa el PDF que el flujo 1 ya guardó. No genera otro diseño.
3. No hace falta tabla nueva si los grupos viven en el entorno. Un log en `activity_log` alcanza para saber quién publicó.

Tamaño mediano (cliente HTTP, una ruta, un botón). Riesgo medio: un grupo mal configurado publica en el lugar equivocado. Depende de que Evolution ya esté corriendo fuera de este repo y de las respuestas de abajo.

Queda afuera: calendario, captions con IA, Instagram, Facebook, y recibir mensajes.

## Preguntas que el dueño tiene que responder

1. **Catálogos.** ¿Se mandan Preventas, Neggo o los dos? El arreglo 3 del flujo 1 deja los dos tipos bien cargados; si solo se manda uno, igual conviene hacerlo porque el selector ya está.
2. **Catálogos.** ¿`volumes/storage/neggo_logo.png` es el logo que tiene que verse? Si no está en la PC donde corre Docker, hay que copiarlo ahí. El código hoy no lo encuentra dentro del contenedor.
3. **Compras.** ¿La compra se arma desde "Pedidos x Proveedor" (cotizaciones abiertas en Odoo) o desde "Órdenes a proveedores" (pedidos cargados en la app)? El arreglo 4 del flujo 2 es para la primera. El arreglo 5 es para la segunda. Si usan las dos, van los dos.
4. **Compras.** Cuando un producto está vinculado en la app, ¿el grupo de la compra tiene que ser el proveedor local (`suppliers`) o el nombre del proveedor tal como figura en Odoo (`vendor_name`)? Hoy es el de Odoo, y si falta cae en "Sin proveedor asignado".
5. **Ingreso.** ¿Un parecido de nombre puede clasificarse solo, o siempre lo tiene que aceptar una persona? Hoy se acepta solo a partir de 0,72 y eso mezcla artículos.
6. **Ingreso.** Confirmar que el reparto correcto es el de la pantalla: cantidad marcada a Preventas, y el resto a Neggo. El arreglo 4 mantiene esa regla y la aplica a los renglones duplicados del mismo código.
7. **WhatsApp.** URL de Evolution, nombre de instancia, API key, y los JIDs de los grupos. ¿Se publica el PDF del catálogo, un texto, o los dos? ¿Quién puede apretar Publicar: solo admin, o también vendedor?

## Orden de ejecución en PRs chicos

Cada PR se puede mergear solo. El 1 es el que desbloquea a los demás. El 5 no depende de nadie y puede ir en paralelo en cuanto estén las respuestas 7.

| PR | Contenido | Depende de | Tamaño |
|---|---|---|---|
| 1 | P0. Columnas y el índice de `pricelist_id` en `schema.sql` + el mismo `ALTER` al arrancar | — | Chico |
| 2 | Catálogos: miles, logo, recarga por tipo, excluir ignoradas | PR 1 | Chico |
| 3 | Pedidos: paginar cotizaciones, timeout de Nginx, saltear líneas sin producto, formato del PDF, error visible, `depends_on` de Chrome. El agrupado por mapping y el rescate de ítems Odoo entran acá recién con las respuestas 3 y 4 | PR 1 | Chico el timeout y el paginado. Mediano si entra el agrupado |
| 4 | Ingreso: sacar el `LIKE`, fuzzy a revisión (respuesta 5), repartir duplicados, no duplicar OC si el `UPDATE` falla | PR 1 y el timeout del PR 3 | Mediano |
| 5 | Publicar el PDF ya generado en los grupos de Evolution. Código nuevo; hoy no existe | Respuestas de WhatsApp. El botón de catálogo queda mejor después del PR 2 | Mediano |

No hace falta un PR de Kanban, de OCR, ni de marketing para que estos cuatro flujos queden usables.
