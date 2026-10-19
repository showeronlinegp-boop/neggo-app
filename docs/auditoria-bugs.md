# Auditoría de bugs — Neggo App

Lectura estática de `master` (código en `af61429`, 19 de octubre de 2026). No se modificó lógica de la aplicación. No se levantó Docker ni se llamó a Odoo: cada ítem sale de leer el archivo y seguir el flujo.

Severidad:

| Nivel | Cuándo |
|---|---|
| Crítico | Pierde datos, escribe mal en Odoo, o permite entrar como admin |
| Alto | El flujo principal da un resultado equivocado o no se puede reintentar |
| Medio | Falla en un caso concreto, o el operador no ve el error |
| Bajo | Deuda, log o borde poco frecuente |

## Qué ya cubren los PRs abiertos

No hace falta reabrir estos temas. El detalle de los cuatro flujos está en `docs/plan-arreglos-criticos.md`.

| PR | Rama | Qué cierra en `master` |
|---|---|---|
| [#2](https://github.com/showeronlinegp-boop/neggo-app/pull/2) | `cursor/schema-columnas-criticas-f7f3` | `schema.sql:700` crea `idx_pco_pricelist` sobre `preventa_client_orders(pricelist_id)` y el `CREATE TABLE` (líneas 231-246) no tiene esa columna: un Postgres vacío aborta el entrypoint. El mismo PR agrega en `schema.sql` y en `initDatabase.js` las columnas que el código ya lee y las migraciones `003`, `004`, `005`, `011`, `016` y `018` declaran: `markup_neggo` / `markup_preventas`, overrides de markup, `template_id` y `has_image`, `preventa_qty_confirmed`, `match_level`, `odoo_purchase_order_id_preventas`, `pricelist_id`. |
| [#3](https://github.com/showeronlinegp-boop/neggo-app/pull/3) | `cursor/catalogos-pdf-f7f3` (encima del #2) | Precio del PDF con `toLocaleString('es-AR')` en Alpine (`catalogService.js:49-51`). Logo buscado en `../../volumes/storage` en vez de `STORAGE_PATH` (`catalogService.js:44`). `Catalogs.jsx:33-36` pide categorías una sola vez, sin `type`. El `JOIN` del catálogo no excluye `ignored = true` (`catalogService.js:239-243`, `catalogs.js:18-24`). |
| [#4](https://github.com/showeronlinegp-boop/neggo-app/pull/4) | `cursor/preventas-pedidos-proveedor-f7f3` (encima del #2) | `getPreventasQuotations` corta en 200 (`odooService.js:775`) y las líneas pueden volver truncadas. Nginx deja `/api/preventas/odoo-quotations` y `/api/ingreso/` en 30 s (`nginx.conf:91-102`). Líneas de sección sin `product_id` entran a la compra (`odooService.js:821-835`). El agrupado usa `vendor_name` y no `product_mappings` (`preventas.js:771-821`). El PDF de ese pedido formatea con `Intl` `es-AR` (`preventas.js:899-901` y `1005`) y, si Chrome no conecta, la pantalla traga el error (`OdooSupplierBreakdown.jsx`). El servicio `backend` no espera a `chrome` (`docker-compose.yml:35-38`). |
| [#5](https://github.com/showeronlinegp-boop/neggo-app/pull/5) | `cursor/whatsapp-evolution-f7f3` (encima del #2) | Feature nueva (Evolution API). No corrige bugs de `master`. `docs/plan-arreglos-criticos.md` dice que WhatsApp no está en el repo: eso sigue siendo cierto en `master`; el código vive solo en ese PR. |

Los PR #3, #4 y #5 no entran a `master` hasta que el #2 esté mergeado y se les cambie la base.

## Ya escrito en el plan, todavía sin PR de código

`docs/plan-arreglos-criticos.md` los describe y ningún PR #2-#5 los toca. Se listan acá para no abrir un tercer documento con el mismo arreglo.

| Sev. | Dónde | Qué pasa | Arreglo mínimo |
|---|---|---|---|
| Alto | `ingresoService.js:218-220` | El match de factura hace `UPPER(sp.sku) LIKE '%' \|\| codigo \|\| '%'`. El código `100` matchea el SKU que contiene `1001` y queda `matched` con confianza 1. | Igualdad sobre el SKU normalizado (el nivel de las líneas 274-289). Sacar el `LIKE`. |
| Alto | `ingresoService.js:316-320`, `IngresoPreview.jsx:448` | Un fuzzy de nombre ≥ 0,72 se guarda como `matched`. La pantalla lo trata como identificado. | Dejar `fuzzy_name` en `pending` y mostrar el candidato para que alguien lo acepte. |
| Alto | `ingreso.js:2018-2032`, `IngresoPreview.jsx:2063` | Dos renglones de la misma factura con el mismo código se muestran sumados, pero la cantidad de Preventas se guarda solo en el primer `id`. El otro renglón entra entero a Neggo. | Repartir `preventa_qty_confirmed` en todos los ítems de ese código, o fusionar antes de confirmar (`merge-duplicate-items` ya existe en `ingreso.js:2199`). |
| Alto | `ingreso.js:2142-2147` | La pestaña Preventa propone una cotización por parecido de nombre (0,72), no solo por código. | Proponer por código. El timeout de esa lectura lo cubre el PR #4. |
| Alto | `preventasService.js:248-264` | `generateSupplierOrders` exige `supplier_product_id`. Un pedido armado desde el cache de Odoo responde "no tienen ítems". El PR #4 no toca Órdenes a proveedores: arregla Pedidos x Proveedor. | Si el ítem es de Odoo, resolver el proveedor por `product_mappings`. Solo hace falta si la compra sale de esa pantalla. |

## 1. Auth y usuarios

### Crítico — JWT por defecto y el token no se revalida

`docker-compose.yml:25` publica `JWT_SECRET=${JWT_SECRET:-cambiar_en_produccion_abc123}`. `middleware/auth.js:4` usa `process.env.JWT_SECRET || 'dev_secret'` si la variable no llega. Con ese secreto cualquiera firma un token `{ role: 'admin' }` válido 24 h (`auth.js:46-51`).

`authenticate` (`auth.js:16-22`) copia `id` y `role` del token y no lee `users`. Desactivar un usuario (`users.js:137-140`) o bajarle el rol no corta la sesión: el login sí mira `active` (`routes/auth.js:29-31`), el resto de la API no.

**Reproducción.** Dejar el compose sin `JWT_SECRET` en el `.env`. Firmar un JWT con el default, header `Authorization: Bearer …`, y llamar `GET /api/users`. Responde 200. Desactivar a ese usuario en la base y repetir la llamada: sigue 200 hasta que vence el token.

**Arreglo.** Exigir `JWT_SECRET` al arrancar (salir si falta o si es el default). En `authenticate`, leer `active` y `role` de `users` (o un `token_version` que se incremente al desactivar o cambiar el rol).

### Alto — contraseña incorrecta se muestra como sesión vencida

`routes/auth.js:35-36` responde 401 si la clave no coincide. `frontend/src/api/client.js:35-38` trata todo 401 igual: borra el token, pone `window.location.href = '/login'` y devuelve `'Sesión expirada'` sin leer el cuerpo. `Login.jsx:33-34` nunca llega a mostrar "Usuario o contraseña incorrectos" porque la página se recarga.

**Arreglo.** En `request()`, si la URL es `/auth/login`, parsear el JSON y devolver `error` del backend. No redirigir.

### Alto — cualquier sesión llega a pantallas de admin

`ProtectedRoute.jsx:16` solo pregunta si hay usuario. El menú filtra por rol (`Layout.jsx:298`), las rutas de `App.jsx:77-87` no. Un vendedor abre `/usuarios`, `/admin` o `/ingreso` por URL. Varias de esas APIs además no exigen rol (ver ingreso y productos).

**Arreglo.** Un wrapper que reciba `roles` y redirija, alineado con `requireRole` de cada ruta.

### Medio — admin inicial `admin123`

`initDatabase.js:12-19` crea `admin` / `admin123` si no existe y lo imprime en el log. No lo rota en arranques siguientes.

**Arreglo.** Crear el usuario solo si no hay ninguno, con clave tomada de `ADMIN_PASSWORD`, y no loguearla. Forzar cambio en el primer login.

### Bajo — sin límite de intentos de login

`routes/auth.js:9-54` no cuenta fallos. Con el admin por defecto, un barrido corto entra.

**Arreglo.** Ventana corta por IP + usuario (por ejemplo 5 intentos / 15 min) antes de hashear.

## 2. Activity log

### Bajo — el middleware está montado en `/api` y lee `req.path` como si fuera la URL completa

`server.js:49` hace `app.use('/api', activityLog)`. Dentro del middleware, `req.path` es `/users/5`, no `/api/users/5`.

- `activityLog.js:31` compara con `'/api/health'` y nunca excluye el health (igual no se guarda, porque no hay `req.user`).
- `extractEntity` (`activityLog.js:20-24`) hace `path.replace('/api/', '')`. Con `/users/5` el split deja `['', 'users', '5']`. `parts[1]` no es numérico, así que `entity_type` queda `''` y `entity_id` null. El log no apunta al registro tocado.
- El mapa (`activityLog.js:4-14`) no nombra ingreso, pricelists ni preventas-sync: caen en `general`. Ya está anotado en `docs/estado-implementacion.md`.

**Arreglo.** Usar `req.originalUrl` (sin query) para módulo y entidad.

## 3. rulesEngine, proveedores y listas de precios

### Medio — markup 0 se trata como "no configurado"

`ingreso.js:139-140` y `ingresoService.js:645-646` usan `COALESCE(NULLIF(s.markup_neggo, 0), s.default_markup, 0)`. Un markup de Neggo puesto en 0 a propósito vuelve a `default_markup`. El precio de venta del ingreso no es el que se configuró. El PR #2 agrega la columna; no cambia este `NULLIF`.

`rulesEngine.js:24-34` sí respeta el 0 (`??`), así que catálogo y alertas no coinciden con el ingreso.

**Arreglo.** Sacar el `NULLIF(..., 0)`. Usar la columna si no es `NULL`.

### Medio — la lista especial no usa la misma fórmula que el catálogo

`pricelistService.js:42-45`: `raw_price × (1 - descuento/100)`, sin flete 1,5% ni markup. `addItemToOrder` (`preventasService.js:57-60`) usa ese precio cuando el pedido tiene lista. El catálogo usa `lista × 1,015 × (1 + markup)` (`rulesEngine.js:37-39`). El mismo producto sale con dos precios según la pantalla.

**Arreglo.** Definir una sola fórmula (la de `rulesEngine` o la de la lista) y usarla en los dos caminos. Es decisión de negocio; el bug es que hoy conviven sin decirlo en la UI.

### Bajo — el scheduler no se entera de un cron nuevo

`jobs/scheduler.js:21-27` lee `scrape_schedule` solo al boot. `PUT /api/suppliers/:id` puede guardar otra expresión y no llama a `initScheduler`. Hasta reiniciar el backend, corre el horario viejo. `stopScheduler` (`scheduler.js:133-141`) no guarda el cron de Odoo ni el de las 9:00, así que un segundo `initScheduler` duplicaría esos dos.

**Arreglo.** Re-registrar la tarea de ese proveedor al guardar el schedule. Guardar los crons globales y destruirlos en `stopScheduler`.

## 4. Sync de Odoo

El fallo por columnas `template_id` / `has_image` lo cierra el PR #2. Esto queda afuera de ese PR.

### Alto — la página no tiene `order`, y lo que no volvió se borra

`odooSync.js:50-77` pagina `search_read` de a 200 sin `order`. En Odoo, offset sin orden estable saltea filas o las repite entre páginas. Al terminar, `cleanupMissing` (`odooSync.js:352-357`) hace `DELETE` de todo `odoo_id` de esa empresa que no esté en la lista, y después borra `invoice_code_mappings` de esos ids (`odooSync.js:363-366`). Un producto que el paginado se saltó desaparece del cache y pierde el código de factura aprendido. El comentario de la línea 453 dice "marcados inactivos"; el SQL los elimina.

No hay tope de páginas. Si Odoo devolviera siempre 200 filas, el `while` no corta.

El PR #4 pagina las cotizaciones de venta. No toca este sync.

**Reproducción.** Catálogo más grande que 200. Correr dos sync seguidos y comparar `COUNT(*)` de `odoo_products_cache` contra `search_count` de `product.product` en Odoo. Los ids que faltan en el cache y siguen en Odoo son los salteados.

**Arreglo.** `order: 'id asc'` en el `search_read`. Cortar también si el offset no avanza (ids ya vistos). Borrar solo si el conteo recibido está a menos de un umbral del `search_count`. Si no, abortar el cleanup como ya se hace cuando `products.length === 0` (`odooSync.js:422-424`).

### Medio — dos sync a la vez

`scheduler.js:118-125` dispara un sync al arrancar y `scheduler.js:77` otro cada hora. No hay lock. Si el primero sigue corriendo, el cleanup de uno puede borrar filas que el otro acaba de considerar vigentes, o al revés.

**Arreglo.** `pg_advisory_lock` alrededor de `syncOdooProducts`, el mismo patrón que `preventasMatchService` (`LOCK_KEY`).

### Medio — `locally_archived` no lo agrega el arranque

`schema.sql:212` crea la columna en una base nueva. `initDatabase.js` no hace el `ADD COLUMN` de `migrations/017_locally_archived.sql`. Una base vieja, anterior a esa columna, rompe `GET /api/products/odoo` (`products.js:100`) y el archivo (`products.js:200`). El `ON CONFLICT` del sync no pisa `locally_archived` (bien) pero sí pisa `active` (`odooSync.js:306`), así que archivar en Odoo y "desarchivar" allá en el próximo sync revive `active` aunque el flag local siga.

**Arreglo.** `ADD COLUMN IF NOT EXISTS locally_archived` en `initDatabase.js`. No actualizar `active` cuando `locally_archived = true`.

### Bajo — id de depuración fijo

`odooSync.js:48` y `66-83` loguean el producto `54537` en cada página. Ruido, no cambia datos.

**Arreglo.** Sacarlo.

## 5. Cliente Odoo (`config/odoo.js`, `odooService.js`)

### Alto — un create que se reintenta duplica la orden

`jsonRpc` (`odoo.js:35-78`) reintenta hasta 4 veces todo error que no diga `AccessError`, `ValidationError`, `UserError` o `MissingError`. Un corte de red después de que Odoo ya commiteó `purchase.order.create` o `sale.order.create` se vuelve a ejecutar. `createPurchaseOrder` (`odooService.js:651`) y `createSaleOrder` pasan por ahí.

**Arreglo.** No reintentar `create`, `write`, `button_confirm` ni `unlink`. Reintentar solo `search_read` / `read`, o mandar un `client_order_ref` idempotente y buscar la orden antes de crear otra.

### Alto — reemplazar líneas borra la orden de venta

`updateSaleOrderLines` (`odooService.js:478-486`) manda `[5, 0, 0]` (borrar todas las líneas) y después las nuevas, en un solo `write`. `syncLinesToOdoo` (`preventas.js:35-41`) lo llama así:

- Ítems con `odoo_company === 'neggo'` van a la orden Neggo. Si esa orden existe y el filtro da `[]` (el pedido solo tiene ítems de proveedor, que no guardan `odoo_company`: `preventasService.js:102-106`), el `write` deja la orden de Odoo sin líneas.
- El resto, incluido `odoo_company` null, va a la orden de Preventas (`preventas.js:40`). Un ítem cargado desde el catálogo del proveedor se escribe en Preventas con `product_id: false`.

Se dispara al agregar, editar o borrar un ítem si el pedido está en `cotizacion` (`preventas.js:254-255`), y el `.catch` solo loguea.

**Reproducción.** Pedido ya enviado a Odoo (tiene `neggo_sale_order_id`). Agregar un producto de proveedor (no de Odoo). La orden Neggo en Odoo queda vacía.

**Arreglo.** No llamar a `updateSaleOrderLines` con una lista vacía. No usar el comando `5` si el write no es atómico desde el punto de vista del operador: armar el diff (unlink de las que sobran, write de las que siguen, create de las nuevas). Los ítems sin `odoo_product_id` no entran a ninguna orden hasta tener producto.

### Medio — `qty_available` no se puede escribir, y confirmar un ingreso no mueve stock

`updateProductQty` (`odooService.js:173-197`) hace `write` de `qty_available`. En Odoo ese campo es calculado; el write falla o se ignora. Nadie llama a la función. `confirmIngreso` crea la OC en borrador y no llama a `button_confirm`. El stock no cambia hasta que alguien confirme y valide el remito en Odoo. Si la pantalla da a entender que "confirmar" ingresa la mercadería, el depósito no se entera.

**Arreglo.** Documentar en la UI que la OC queda en borrador. Si hay que sumar stock, usar `stock.quant` o validar el picking, no `qty_available`.

### Medio — categorías de producto cortadas en 500

`getProductCategories` (`odooService.js:158`) pide `limit: 500` sin paginar. Un árbol más largo no llega al selector de reglas.

**Arreglo.** El mismo paginado con `order: 'id asc'` que hace falta en el sync.

## 6. Ingreso de mercadería

Columnas faltantes, `LIKE`, fuzzy y renglones duplicados: PR #2 y la tabla de arriba. Lo que sigue no está en esos PRs.

### Alto — confirmar deja el ingreso cerrado aunque la OC no exista

`confirmIngreso` (`ingresoService.js:859-895`) traga el error de `createPurchaseOrder` y después hace `UPDATE … estado = 'confirmado'`. El `catch` de la ruta (`ingreso.js:1911-1913`) solo rechaza si el estado ya no es `pending`, así que no hay segundo intento. La UI ya muestra el síntoma: "Sin OC en Odoo" (`IngresoPreview.jsx:2343-2345`).

El PR #2 evita el caso en que el `UPDATE` revienta porque falta `odoo_purchase_order_id_preventas` (ahí la transacción hace rollback y la OC de Odoo queda huérfana, y reintentar duplica). Con la columna presente, el otro caso sigue: Odoo falla, el ingreso igual pasa a confirmado, y no se puede repetir.

Además el `SELECT` del ingreso (`ingresoService.js:643-650`) no usa `FOR UPDATE`. Dos clicks en Confirmar pasan los dos el chequeo de `pending` (`ingreso.js:1911`) y crean dos OC antes de que alguno commitee.

Las llamadas a Odoo corren dentro del `BEGIN`. Si el `COMMIT` falla después, Odoo ya tiene precios y OC, y Postgres vuelve atrás.

**Arreglo.** `SELECT … FOR UPDATE` al leer el ingreso. Si `createPurchaseOrder` tira, hacer `ROLLBACK` y dejar `pending` (o guardar el id de la OC que sí se creó y no crear otra). Crear la OC después de reservar el estado (`confirmando`) y commitear el id enseguida, fuera del mismo timeout que el write de precios.

### Alto — tildar "aplicar costo" también pisa el precio de lista, y no hace falta ser admin

`PATCH /:ingresoId/items/:itemId` (`ingreso.js:391`) solo pide `authenticate`. Un operador, o un vendedor con token, llega. Al poner `apply_cost` o `apply_price` en true, las líneas 661-668 escriben en Odoo Neggo:

```text
priceForOdoo = apply_price ? newListPrice : (precio_odoo_lista || newListPrice)
```

Si `apply_price` es false y `precio_odoo_lista` viene null, se manda `newListPrice` igual. El costo nuevo y un precio de lista calculado pisan el de Odoo antes de que un admin confirme.

**Reproducción.** Ítem matcheado, `precio_odoo_lista` vacío, tildar solo "aplicar costo". En Odoo cambian `standard_price` y `list_price`.

**Arreglo.** Exigir `requireRole('admin')` para escribir precios (el confirm ya lo exige, `ingreso.js:1893`). Si `apply_price` es false, mandar el `list_price` actual y no el calculado.

### Medio — la OC usa la cantidad de la factura, no la recibida

`received_qty` se edita en el control físico (`IngresoPreview.jsx:148-213`) y no entra a `confirmIngreso`. La cantidad de la OC es `item.cantidad` (`ingresoService.js:731-776`). Recibir 3 de 10 carga 10 en la orden.

**Arreglo.** Usar `received_qty` cuando es mayor a 0, o bloquear el confirm si el control no cierra.

### Medio — el proxy de la foto no pide login

`GET /api/ingreso/odoo-image/:odooId` (`ingreso.js:93`) y `GET /api/products/odoo-image/:company/:templateId` (`products.js:476`) no usan `authenticate`. Cualquiera que llegue al puerto 80 o al 3000 (el compose publica los dos, `docker-compose.yml:7` y `21`) baja `image_128` de Odoo usando la API key del servidor. Sirve para enumerar ids.

**Arreglo.** `authenticate` en las dos rutas. El `<img>` puede ir con el token en query de un solo uso, o las fotos ya cacheadas bajo `/storage/` con la sesión de nginx.

## 7. Preventas — pedidos y órdenes

Paginado, agrupado, PDF de cotizaciones y Chrome: PR #4. `generateSupplierOrders` y los ítems de Odoo: tabla de arriba. El wipe de líneas de Odoo está en la sección 5.

### Crítico — agregar un producto de proveedor tira después de guardarlo

`addItemToOrder` (`preventasService.js:57-82`) declara `const prices` dentro del `if` y del `else`. El `return` de la línea 115-118 usa `prices` fuera de esos bloques. En JavaScript eso es `ReferenceError` en todo alta que llega al final.

El `INSERT`/`UPDATE` y el recálculo del total (`preventasService.js:91-111`) ya commitearon: no hay transacción. La ruta (`preventas.js:258-261`) responde 500. Si el operador reintenta, el `UPSERT` suma la cantidad otra vez (`preventasService.js:93`).

**Reproducción.** `POST /api/preventas/client-orders/:id/items` con un `supplier_product_id` válido. La fila existe en `preventa_client_order_items` y la respuesta es 500 `prices is not defined`. Un segundo POST duplica `quantity`.

**Arreglo.** `let prices` antes del `if`, asignar en las dos ramas, y devolverlo. Envolver insert + total en una transacción para que un throw no deje el ítem a medias.

### Medio — el PDF de "Órdenes a proveedores" sigue con `Intl` `es-AR`

`preventas.js:679` formatea la orden al proveedor con `Intl.NumberFormat('es-AR')`. El PR #4 cambia el otro PDF (cotizaciones, ~899) y no este. En `node:20-alpine` el monto sale con coma de miles (`$1,234.00`).

**Arreglo.** El mismo formateo manual del PR #3 (`$` + punto de miles).

### Medio — leer un archivo del disco desde el PDF de cotizaciones

`preventas.js:934-940` arma la imagen así: si `image_url` empieza con `/storage`, hace `path.join(STORAGE, imageUrl.replace('/storage', ''))`. El body lo manda el cliente (`preventas.js:888`). `/storage/../../etc/passwd` queda, después del `join` con un segmento absoluto, en `/etc/passwd`, y el contenido se embebe en el PDF. Cualquier usuario logueado (la ruta solo tiene `authenticate`) puede leer archivos que el proceso del backend pueda abrir.

El PR #4 reescribe ese PDF y deja el mismo `path.join` (en esa rama, alrededor de la línea 927). No lo da por cerrado.

**Arreglo.** `path.resolve` y rechazar si el resultado no empieza por `STORAGE` real. No aceptar `image_url` arbitrario: resolver la foto por id de producto en el servidor.

## 8. Catálogos

Los cuatro fallos del flujo (miles, logo, categorías al cambiar de tipo, reglas ignoradas) los cierra el PR #3. No hay un quinto bug de generación en `master` fuera de ese PR.

El PDF viejo ya guardado en `catalogs.file_path` no se regenera solo. Después de mergear el #3 hay que volver a generar los que se van a enviar.

## 9. Mappings y alertas de precio

### Alto — aprobar una alerta la cierra aunque Odoo no haya tomado el precio

`approveAlert` (`priceAlertService.js:171-205`) mete el error de cada mapping en `odooUpdates` y igual hace `UPDATE … status = 'approved'`. La pantalla la saca de pendientes. El precio en Odoo puede haber quedado en el valor viejo. No hay forma de reintentar sin tocar la base.

**Arreglo.** Si algún mapping devolvió error, dejar `pending` y responder el detalle. Pasar a `approved` solo cuando todos los `write` salieron bien.

### Alto — precio anterior 0 revienta el cálculo

`processPriceChange` (`priceAlertService.js:30`) hace `(newPrice - oldPrice) / oldPrice * 100`. Con `oldPrice === 0` el resultado es `Infinity`. El `INSERT` en `NUMERIC(6,2)` falla y Preventas puede haber escrito el precio en Odoo una línea antes (`priceAlertService.js:73-76`), sin fila de alerta.

**Arreglo.** Si `oldPrice` no es finito o es 0, no dividir: tratarlo como alta de precio y guardar `pct_change` null.

### Medio — Preventas escribe el precio nuevo en el acto, sin tope

El mismo `processPriceChange` (`priceAlertService.js:64-76`) llama a `updateProductPrices` para cada mapping de Preventas, sin umbral. Neggo espera 2% (`priceAlertService.js:15` y `103`). Un scrape que lee mal un precio (ver Mali, sección 10) pisa `standard_price` y `list_price` en Odoo antes de que alguien lo vea.

**Arreglo.** Mismo umbral, o un tope (por ejemplo no auto-aplicar si `|pct| > 30`) que deje la alerta en `pending` para las dos empresas.

## 10. Scraping de proveedores

### Crítico — pausar, o terminar en cero, borra el catálogo del proveedor

`PythonScraper.run` (`pythonScraper.js:84-112`) guarda `runStartedAt` antes del script y, si el proceso sale con código 0, llama a `markUnavailableSince`. Esa función (`baseScraper.js:316-322`) hace:

```sql
DELETE FROM supplier_products
WHERE supplier_id = $1 AND last_scraped_at < $2
```

`ON DELETE CASCADE` se lleva `price_history`, `product_mappings` y `preventas_sync_state`.

El delete corre antes de mirar si el proceso fue pausado (`pythonScraper.js:112` vs `117-118`). Pausar manda `SIGTERM` (`pythonScraper.js:20`). El `close` con señal resuelve la promesa (`pythonScraper.js:261-267`) y recién ahí borra todo lo que este run todavía no upsertió. El checkpoint de página (`pythonScraper.js:224-230`) queda apuntando a productos que ya no existen.

Lo mismo si el script sale 0 sin productos: login de Mali que se da por bueno (`mali_scraper.py:52-54`, `NoSuchElementException` → "sesión ya activa") y wishlist vacía. El run "termina bien" y vacía la tabla.

`BaseScraper.run` (`baseScraper.js:530-532`) borra también cuando el estado final es `partial` (alguna categoría falló y otras no). Los productos de la categoría caída tienen `last_scraped_at` viejo y se van.

**Reproducción.** Proveedor con productos cargados. Pausar a mitad de categorías. `SELECT COUNT(*) FROM supplier_products WHERE supplier_id = …` baja a lo scrapeado en esa tanda. Los mappings de esos ids desaparecen.

**Arreglo.** No borrar en `paused`, `failed` ni `partial`. En un `completed`, exigir un mínimo (por ejemplo no borrar si `found` es 0 o es menor al 50% del catálogo anterior) y marcar `available = false` en lugar de `DELETE`, para no cortar mappings. El delete, si hace falta, que sea un paso explícito.

### Alto — SKU vacío colapsa todos esos productos en una fila

`baseScraper.js:145-146` arma `PRE${prefix}${cleanCode}`. Si `sku` viene vacío, `cleanCode` es `''` y todos comparten `PRE` + prefijo. El segundo pisa nombre y precio del primero (`baseScraper.js:223-261`). Al final, `markUnavailableSince` borra el resto del catálogo porque no se "vieron".

**Arreglo.** Si no hay código, no insertar (log + error del run) o usar una clave que incluya el nombre y la URL, y no participar del delete.

### Medio — Mali interpreta un precio argentino como decimal chico

`mali_scraper.py:59-66` saca `$` y comas, y hace `float`. El comentario asume `$310.00` o `$1,234.56` (formato US). Un texto `$1.234,56` queda `1.23456`. Cast y El Rey sí pasan el punto de miles a formato con punto decimal (`cast_scraper.py:76`, `elrey_scraper.py:60`). Ese precio, si el producto ya estaba mapeado a Preventas, lo escribe Odoo solo (sección 9).

**Arreglo.** Usar el mismo parser que Cast: si hay coma y punto, el último separador es el decimal.

### Medio — el semáforo deja pasar más de dos scrapers

`scrapingService.js:28-71` lee `runningCount` y recién lo incrementa después de un `await pool.query`. Dos requests simultáneos ven `0` y los dos entran. El tope `MAX_CONCURRENT = 2` no se cumple. En un solo proceso de Node es una carrera corta; alcanza para lanzar un tercer Chromium.

**Arreglo.** Incrementar el contador en el mismo turno, antes del primer `await`, y bajarlo en el `finally` si el chequeo de proveedor falla.

### Bajo — categorías pendientes no se recalculan en el camino Python

`detectPendingCategories` solo lo llama `BaseScraper.run` (`baseScraper.js:554`). Los cuatro scrapers reales extienden `PythonScraper` y no lo llaman. Ya está en `docs/estado-implementacion.md`: la pantalla de reglas usa `unmapped-categories` y por eso igual lista el faltante. No es un agujero de datos.

## 11. Frontend

### Alto — el login (sección 1) y las rutas sin rol

Ver auth. El cliente HTTP es el que convierte el 401.

### Medio — la fila elegida en el buscador de cotizaciones no usa el segundo comparador

`IngresoPreview.jsx:1396`:

```jsx
const isSel = selected?.line_id === l.line_id ?? selected?.id === l.id;
```

`??` tiene menos precedencia que `===`, así que es `(selected?.line_id === l.line_id) ?? …`. El lado izquierdo es siempre `true` o `false`, nunca null. El `id` no se usa. Si las dos líneas no traen `line_id`, `undefined === undefined` es verdadero y todas quedan marcadas. Ya lo señala `docs/estado-implementacion.md` (el build avisa). El efecto en la pantalla es este.

**Arreglo.** Paréntesis: `(selected?.line_id != null && selected.line_id === l.line_id) || (selected?.id != null && selected.id === l.id)`.

### Bajo — `toLocaleString('es-AR')` en el browser

Las pantallas (Dashboard, ingreso, pedidos, alertas) formatean en el cliente. Ahí el locale es el del navegador, no el de Alpine. No es el bug del PDF. El PDF del backend sí: secciones 7 y 8, este último cubierto por el PR #3.

## 12. Docker, Nginx e initDatabase

### Crítico — secretos de proveedores escritos al arrancar

`initDatabase.js:86-106` inserta en `scrape_config` el usuario y la clave de Mali, y el token de El Rey, cuando la tabla está vacía. Si la config quedó `{}`, el `UPDATE` de las líneas 94-106 los vuelve a escribir. Están en el repo, en texto plano, y terminan en `suppliers.scrape_config`. Cualquiera con lectura de la base o del git entra a esas cuentas.

`docs/estado-implementacion.md` (riesgo 2) ya lo marca. Ningún PR #2-#5 lo saca.

**Arreglo.** Borrar esas cadenas del archivo. Leer `MALI_USER`, `MALI_PASSWORD` y `ELREY_TOKEN` del entorno, y no actualizar la fila si la variable no está. Rotar la clave y el token en los sitios de los proveedores: hay que asumir que ya salieron del repo.

### Alto — el puerto 3000 publica la API al lado de Nginx

`docker-compose.yml:21-22` mapea `3000:3000`. Nginx es el único que pone timeouts, corta el body de algunas rutas y sirve el front. El 3000 habla directo con Express: los proxies de imagen sin auth (sección 6) y el health que devuelve `error.message` (`server.js:36-40`) quedan en la red local sin el filtro de Nginx. CORS está abierto (`server.js:15`, `cors()` sin origen).

**Arreglo.** No publicar 3000 fuera de la red de Compose. En el health de producción, no devolver `details`.

### Medio — el schema de arranque y las migraciones siguen siendo tres listas

Lo cierra en lo crítico el PR #2 (la tabla de columnas de `docs/estado-implementacion.md`). Sigue siendo cierto que `docker-compose.yml` solo monta `schema.sql` + `seeds.sql`, que `seeds.sql` está vacío, y que `migrations/001`–`018` no corren solas. `initDatabase.js` parcha otra lista y traga errores con `.catch(() => {})` (por ejemplo líneas 26, 35, 39). Un `ALTER` que falle por un motivo distinto a "ya existe" se pierde y el log dice "inicializada correctamente" (`initDatabase.js:276`).

**Arreglo.** Después del PR #2, loguear el error del `catch` en lugar de vaciarlo. A mediano plazo, una sola lista de migraciones aplicadas en una tabla.

### Medio — `/storage/` se sirve sin sesión

`nginx.conf:106-110` alias de `/var/www/storage/` con cache de 7 días. Fotos de productos y PDFs de catálogo que hayan quedado ahí se bajan sin JWT. El volumen está montado de solo lectura, así que no es escritura.

**Arreglo.** Si el almacenamiento tiene que ser privado, pasar la descarga por el backend con `authenticate` (los catálogos ya lo hacen en `/api/catalogs/:id/download`).

### Bajo — dos handlers de `SIGTERM`

`server.js:138-142` y `151-155` registran los dos `SIGTERM`. Los dos llaman a `pool.end()` y `process.exit`. El primero también para el scheduler. En la práctica el proceso muere; el segundo `pool.end()` puede loguear un error de pool ya cerrado.

**Arreglo.** Un solo handler: parar cron, cerrar pool, salir.

## Top 10

Ordenado por daño si se sigue operando `master` sin estos arreglos. Los que ya tienen PR no entran.

| # | Sev. | Módulo | Bug | Arreglo mínimo |
|---|---|---|---|---|
| 1 | Crítico | Scraping | Pausar, un run parcial o un script que sale con 0 productos hace `DELETE` del catálogo del proveedor y, en cascada, mappings e historial (`pythonScraper.js:112`, `baseScraper.js:316-322`). | No borrar salvo `completed` con un volumen razonable de productos. Marcar `available = false`. |
| 2 | Crítico | Preventas | `addItemToOrder` referencia `prices` fuera de alcance (`preventasService.js:117`). El ítem se guarda, la API responde 500 y el reintento duplica la cantidad. | Declarar `prices` en la función, antes del `if`. |
| 3 | Crítico | Auth / arranque | Clave de Mali y token de El Rey en `initDatabase.js:86-106`. `JWT_SECRET` con default conocido (`docker-compose.yml:25`, `auth.js:4`) y el middleware no mira si el usuario sigue activo. | Secretos solo por entorno, rotar los que ya están en git, y revalidar `active` + `role` en cada request. |
| 4 | Alto | Odoo / pedidos | `updateSaleOrderLines` manda comando `5` (`odooService.js:481`). Un ítem de proveedor, sin `odoo_company`, vacía la orden Neggo o se escribe en Preventas (`preventas.js:35-41`). | No sincronizar listas vacías. No incluir ítems sin `odoo_product_id`. |
| 5 | Alto | Ingreso | Confirmar traga el error de la OC y deja `confirmado` (`ingresoService.js:859-895`). Dos clicks crean dos OC. El caso "falta la columna" lo tapa el PR #2; este no. | `FOR UPDATE`, no pasar a confirmado si Odoo no devolvió id, no reintentar el `create`. |
| 6 | Alto | Sync Odoo | Paginado sin `order` (`odooSync.js:50-60`) y `DELETE` de lo que no volvió (`odooSync.js:352-357`). El PR #4 pagina cotizaciones, no este sync. | `order: 'id asc'` y no limpiar si el conteo no cierra con Odoo. |
| 7 | Alto | Ingreso | `PATCH` del ítem, sin rol admin, escribe precios en Odoo y, si no hay lista previa, pisa `list_price` aunque solo se haya pedido el costo (`ingreso.js:391`, `661-668`). | `requireRole('admin')`. No mandar precio de lista si `apply_price` es false. |
| 8 | Alto | Alertas | Aprobar marca `approved` aunque el `write` haya fallado (`priceAlertService.js:201-205`). Precio viejo 0 produce `Infinity` (`priceAlertService.js:30`). Preventas aplica solo, sin tope. | Quedar en `pending` si falló Odoo. No dividir por cero. Tope de variación para el auto-apply. |
| 9 | Alto | Ingreso | Match por `LIKE '%codigo%'` y fuzzy 0,72 que se acepta solo (`ingresoService.js:218-220` y `316-320`). Renglones duplicados de la factura: la cantidad de Preventas cae en un solo id (`ingreso.js:2018-2032`). Descripto en el plan, sin PR. | Igualdad de código, fuzzy a revisión humana, repartir la cantidad en todos los ítems del código. |
| 10 | Alto | Frontend / auth | Clave mal escrita recarga `/login` y el mensaje es "Sesión expirada" (`client.js:35-38`). Un vendedor abre por URL rutas que el menú esconde, y varias APIs no exigen el rol. | No tratar el 401 del login como sesión vencida. Guard de rol en el router, igual que `requireRole`. |

Debajo del corte, y conviene no perderlo: lectura de archivos vía `image_url` en el PDF de cotizaciones (`preventas.js:934-940`, el PR #4 lo conserva), PDF de órdenes a proveedores con miles en formato Alpine (`preventas.js:679`), y markup 0 ignorado en el ingreso (`ingresoService.js:645-646`).
