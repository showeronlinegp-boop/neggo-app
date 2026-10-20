# Auditoría de bugs — Neggo App

Lectura estática de `master` (`af61429`, 19 de octubre de 2026). No se cambió código de la aplicación y no se llamó a Odoo. Cada ítem trae importancia, consecuencia de negocio y arreglo mínimo.

La revisión que sigue, antes del recorrido módulo por módulo, es la de proveedores, scraping, ingresos, WhatsApp, pedidos por proveedor y reposición. WhatsApp no está en `master`: el código vive solo en el PR #5. Reposición no tiene rutas ni pantallas: solo el schema y `docs/agents/14-smart-purchasing.md`. Los ítems que ya estaban más abajo se repiten acá para leerlos juntos.

Dentro de cada módulo van primero los críticos, después altos, medios y bajos. Si un PR abierto ya lo cubre, está marcado. Esos PR todavía no están en `master`.

| PR | Qué cierra |
|---|---|
| [#2](https://github.com/showeronlinegp-boop/neggo-app/pull/2) | Columnas que el código lee y el schema no crea, y el índice `idx_pco_pricelist` que aborta una base vacía. |
| [#3](https://github.com/showeronlinegp-boop/neggo-app/pull/3) | PDF de catálogos: miles, logo, categorías al cambiar de tipo, reglas ignoradas. Depende del #2. |
| [#4](https://github.com/showeronlinegp-boop/neggo-app/pull/4) | Pedidos x Proveedor: paginado de cotizaciones, timeouts, líneas sin producto, agrupado, PDF y Chrome. Depende del #2. No toca Órdenes a proveedores. |
| [#5](https://github.com/showeronlinegp-boop/neggo-app/pull/5) | WhatsApp nuevo. No corrige bugs de `master`. Trae los de la sección W. |

## Revisión prioritaria

### P. Proveedores

#### Alto — Desactivar borra el catálogo, y la pantalla dice que se puede volver atrás

`suppliers.js:361-386`, `SupplierList.jsx:248-254`, `schema.sql:137`, `149`, `181`, `migrations/009_preventas_sync_state.sql:7`.

**Importancia.** Alta: es el botón de la lista de proveedores. El diálogo dice "Esta acción se puede revertir". El `DELETE` pone `active = false` y además hace `DELETE FROM supplier_products`. La cascada se lleva historial de precios, vínculos con Odoo y el estado de sync de Preventas. El mismo borrado está en "eliminar todos los productos" (`suppliers.js:334-347`, `SupplierRules.jsx:175-176`).

**Consecuencias.** Se pierde el catálogo de ese proveedor. El ingreso deja de matchear por código, Preventas no tiene contra qué comparar y las alertas no vuelven a disparar hasta re-scrapear y re-vincular. Reactivar la fila del proveedor no devuelve los productos. No es una baja lógica.

**Cómo arreglarlo.** Desactivar solo con `active = false` (y, si corresponde, `status = 'inactive'`). El borrado físico de productos, en una acción aparte, con el texto real de lo que se pierde.

#### Alto — El prefijo no es único, y cambiarlo no reescribe los códigos

`schema.sql:43`, `suppliers.js:222`, `baseScraper.js:145-146`, `ingreso.js:1495` y `2118`, `SupplierRules.jsx:157-161`.

**Importancia.** Alta porque el prefijo arma el SKU `PRE` + prefijo + código. Ese SKU es el que usa el scraping para no pisar productos, y el ingreso y Preventas para encontrar el artículo. El nombre del proveedor es único; el prefijo no.

**Consecuencias.** Dos proveedores con el mismo prefijo generan el mismo `PRE…`. El match del ingreso puede agarrar el producto del otro. Si se edita el prefijo en la ficha, los SKU ya scrapeados quedan con el prefijo viejo y las búsquedas nuevas usan el nuevo: la factura deja de identificar la mercadería y Preventas no encuentra el par. Hay que re-scrapear y re-vincular.

**Cómo arreglarlo.** `UNIQUE` en `prefix`. Al cambiarlo, reescribir `supplier_products.sku` en la misma transacción, o bloquear el cambio si ya hay productos.

#### Alto — Un proveedor en staging se ve activo y puede publicarse

`schema.sql:47-55`, `suppliers.js:93-100` y `140-152`, `catalogService.js:237-238` y `394`, `scrapingService.js:37-39`, `scheduler.js:26`, `SupplierList.jsx:110-112`. El cron sí exige `status = 'active'`. El catálogo, el scrape manual, Pedidos x Proveedor (PR #4) y WhatsApp (PR #5) no.

**Importancia.** Alta porque `staging` es el estado de un proveedor que todavía no se quiere usar. El alta lo deja en `staging` con `active = true`. La lista muestra el badge "Activo" mirando `active`, no `status`. El detalle (`GET /:id`) ni siquiera devuelve `status`, así que la pantalla de reglas no puede mostrarlo.

**Consecuencias.** Con `is_published = true` entra al PDF del catálogo antes de promoverlo: el cliente pide algo que no está listo. El scrape manual corre en staging y, si termina mal, dispara el borrado de la sección S. En el PR #4 la compra se puede agrupar contra ese proveedor. En el PR #5 el producto se puede mandar al grupo de WhatsApp.

**Cómo arreglarlo.** Filtrar `status = 'active'` en catálogo, scrape manual, agrupado de pedidos y WhatsApp. Mostrar `status` en la lista y devolverlo en el detalle. Promover sigue siendo el único paso que lo habilita.

#### Medio — La clave del scraper no se edita, y el arranque la vuelve a escribir

`suppliers.js:212-217`, `initDatabase.js:86-106`. El detalle del secreto está en la sección 12.

**Importancia.** Media para operar el día a día, crítica si el repo o la base se leen desde afuera. `PUT` no acepta `scrape_config`. La ficha no tiene campo. Si la config quedó `{}`, cada arranque vuelve a grabar el usuario y la clave de Mali y el token de El Rey.

**Consecuencias.** No se puede rotar la clave desde la app. Quien lee el código entra a la cuenta del proveedor y ve el costo real, que es la base del precio de venta.

**Cómo arreglarlo.** Sacar las cadenas del código (sección 12). Guardar la config por variable de entorno, y un formulario de admin que la escriba sin loguearla.

#### Bajo — Un campo vacío en el alta no se puede borrar después

`suppliers.js:220-233`, `SupplierList.jsx:305-312`.

**Importancia.** Baja. El 0 de markup sí se guarda (a diferencia del ingreso, sección 3). Lo que no se puede es volver un campo opcional a vacío: `COALESCE` conserva el valor anterior cuando el body manda `null`.

**Consecuencias.** Un sitio web, un cron o un `scraper_key` mal cargado quedan pegados. El cron sigue disparando, o el scraper sigue asociado al proveedor equivocado, hasta un arreglo en la base.

**Cómo arreglarlo.** Distinguir "no vino la clave" de "vino null". Solo el segundo limpia la columna.

### S. Scraping

#### Crítico — Pausar, o terminar en cero, borra el catálogo del proveedor

`pythonScraper.js:84-112` y `117-118`, `261-267`, `baseScraper.js:316-322` y `530-532`, `mali_scraper.py:52-54`. El mismo ítem está en la sección 10.

**Importancia.** Crítica. Es el origen de los precios de catálogo, de las alertas y de los vínculos con Odoo. `markUnavailableSince` hace `DELETE` de todo producto del proveedor con `last_scraped_at` anterior al run. La cascada se lleva historial, `product_mappings` y `preventas_sync_state`. Corre también si el proceso fue pausado con `SIGTERM`, si Python sale con código 0 y 0 productos (el login de Mali trata `NoSuchElementException` como sesión ya activa) y, en el camino Puppeteer, cuando el estado es `partial`.

**Consecuencias.** Se vacía el catálogo de Cast, Mali, El Rey o Impotekno. El ingreso deja de matchear, Preventas no compara, las alertas no disparan y los pedidos que apuntaban a esos `supplier_product_id` quedan colgados. No es un precio viejo: es la base de precios borrada.

**Cómo arreglarlo.** No borrar en `paused`, `failed` ni `partial`. En `completed`, no borrar si `found` es 0 o cayó por debajo de la mitad del catálogo anterior. Marcar `available = false`. El delete, si hace falta, como acción aparte.

#### Alto — Sin SKU, todos esos productos pisan la misma fila

`baseScraper.js:145-146` y `223-261`. También en la sección 10.

**Importancia.** Alta en cualquier página que no traiga código. El SKU queda `PRE` + prefijo, vacío el resto. El segundo producto pisa nombre y precio del primero.

**Consecuencias.** Un solo precio para muchos artículos. El delete del ítem anterior borra lo que no se "vio". El catálogo queda con un producto que no corresponde a ninguno.

**Cómo arreglarlo.** Si no hay código, no insertar. No usar esa fila en el delete.

#### Medio — Mali lee un precio argentino como un decimal chico

`mali_scraper.py:59-66`. Cast y El Rey sí separan miles (`cast_scraper.py:76`, `elrey_scraper.py:60`). También en la sección 10.

**Importancia.** Media si Mali manda `$310.00`. Alta si manda `$1.234,56`.

**Consecuencias.** `$1.234,56` queda `1.23456`. Ese costo entra al catálogo y, si está vinculado a Preventas, se escribe solo en Odoo (sección 9). Se vende a pesos en lugar de a miles.

**Cómo arreglarlo.** El parser de Cast: si hay punto y coma, el último separador es el decimal.

#### Medio — Pueden correr más de dos scrapers a la vez

`scrapingService.js:28-71`. También en la sección 10.

**Importancia.** Media. El tope existe para no tumbar Chrome ni el sitio del proveedor. El contador sube después del `await` que lee el proveedor, así que dos pedidos pasan el `if` con el contador viejo.

**Consecuencias.** Un tercer Chromium compite, el sitio puede bloquear la IP y el run termina a medias. Junto con el delete crítico, un run a medias borra el resto del catálogo.

**Cómo arreglarlo.** Subir `runningCount` antes del primer `await`. Bajarlo en el `finally` si el proveedor no se puede scrapear.

#### Bajo — El camino Python no marca categorías pendientes al terminar

`baseScraper.js:554`. Los cuatro scrapers reales extienden `PythonScraper`. También en la sección 10.

**Importancia.** Baja. La pantalla igual lista el faltante con `GET /api/suppliers/:id/unmapped-categories`.

**Consecuencias.** El badge puede no enterarse por este camino. Esas categorías no entran al catálogo hasta que alguien cree la regla. No se pierden productos ya cargados.

**Cómo arreglarlo.** Llamar a `detectPendingCategories()` al final de `PythonScraper.run` cuando el estado es `completed`.

### I. Ingresos

#### Crítico — Sin las columnas nuevas no se guarda el reparto ni la OC de Preventas

`ingresoService.js:524`, `ingreso.js:590`, `ingresoService.js:730` y `891`. **Cubierto por el PR #2.** El mismo ítem está en la sección 6.

**Importancia.** Crítica en una base que no haya corrido las migraciones a mano.

**Consecuencias.** No se guarda el preview, o toda la cantidad sigue a Neggo. En el peor caso Odoo ya creó la OC de Preventas, el `UPDATE` falla, Postgres hace rollback y reintentar crea otra OC.

**Cómo arreglarlo.** El del PR #2, más el arreglo del confirm de abajo.

#### Alto — Confirmar cierra el ingreso aunque la OC no exista, y dos clicks crean dos

`ingresoService.js:643-650` y `859-895`, `ingreso.js:1911-1913`, `IngresoPreview.jsx:2343-2345`. El PR #2 cubre la columna. No cubre este flujo. También en la sección 6.

**Importancia.** Alta en cada factura. El error de `createPurchaseOrder` se traga y el estado pasa a `confirmado`. No hay `SELECT … FOR UPDATE`. Las llamadas a Odoo están dentro del `BEGIN`.

**Consecuencias.** Compra que no existe y no se puede reintentar, o dos OC por la misma factura. Precios ya escritos en Odoo que la base no registra. La OC queda en borrador: confirmar el ingreso no mueve stock (`odooService.js:640-663` no llama a `button_confirm`; sección 5).

**Cómo arreglarlo.** `SELECT … FOR UPDATE`. Pasar a `confirmando` y guardar el id de cada OC en cuanto Odoo lo devuelve. Si el `create` falla, dejar `pending`.

#### Alto — El costo que se escribe en Odoo no es el del catálogo ni el de WhatsApp

`ingresoService.js:742-759`, `rulesEngine.js:9-11` y `37-39`. Ningún PR #2-#5 lo unifica. El markup 0 tratado como "no configurado" está en la sección 3.

**Importancia.** Alta cada vez que se confirma una factura con "aplicar costo" o "aplicar precio". El catálogo, las alertas y el WhatsApp del PR #5 usan `rulesEngine`: costo = lista × (1 − descuento/100 + 0,015) y venta = lista × 1,015 × (1 + markup/100), redondeada hacia arriba. El ingreso hace lista × (1 − descuento/100), suma el flete prorrateado del remito, y el precio de lista solo si el markup es mayor que 0.

**Consecuencias.** El PDF y el mensaje de WhatsApp muestran un precio. Odoo, después del ingreso, tiene otro. Se cobra de menos o de más según desde qué pantalla se vendió. Un markup de 0% no actualiza la lista con la fórmula del catálogo.

**Cómo arreglarlo.** Calcular costo y venta con `rulesEngine` y, encima, sumar el prorrateo del flete del remito. Mostrar en el preview el número que va a quedar en Odoo.

#### Alto — El código `100` se vincula al producto `1001`

`ingresoService.js:218-220`. En el plan, sin PR. También en la sección 6.

**Importancia.** Alta en cada factura. El match es `LIKE '%' || codigo || '%'` y, si pega, la confianza queda en 1.

**Consecuencias.** El costo y el precio de lista se escriben en el producto equivocado. La OC compra un artículo que no vino. El que sí vino no actualiza stock ni precio.

**Cómo arreglarlo.** Igualdad contra el SKU normalizado (`ingresoService.js:274-289`). Sacar el `LIKE`.

#### Alto — Un parecido de nombre de 0,72 se acepta solo

`ingresoService.js:316-320`, `IngresoPreview.jsx:448`. También en la sección 6.

**Importancia.** Alta porque el estado queda `matched`, el mismo que un código exacto.

**Consecuencias.** Precio y OC sobre otro producto. Dos artículos de nombre parecido se mezclan.

**Cómo arreglarlo.** Dejar `fuzzy_name` en `pending` hasta que una persona lo acepte.

#### Alto — La cantidad de Preventas de un código repetido cae en un solo renglón

`ingreso.js:2018-2032`, `IngresoPreview.jsx:2063`. También en la sección 6.

**Importancia.** Alta en facturas con el mismo código en más de una línea.

**Consecuencias.** La pantalla suma las cantidades, pero `preventa_qty_confirmed` se guarda en el primer id. El otro renglón entra entero a Neggo. Preventas queda corta y Neggo compra de más.

**Cómo arreglarlo.** Repartir la cantidad de Preventas en todos los ítems de ese código, o fusionar los duplicados antes de confirmar.

#### Alto — La pestaña Preventa propone un pedido de otro cliente por el nombre

`ingreso.js:2142-2147`. El timeout de esa lectura lo cubre el PR #4. El match, no. También en la sección 6.

**Importancia.** Alta al separar la mercadería contra cotizaciones abiertas.

**Consecuencias.** Se reserva cantidad para el pedido de otro cliente. La OC de Preventas sale con el producto equivocado.

**Cómo arreglarlo.** Proponer solo por código. El nombre queda como pista, sin seleccionar solo.

#### Alto — Tildar "aplicar costo" también cambia el precio de lista, sin ser admin

`ingreso.js:391` y `661-668`, `ingresoService.js:809-813`. También en la sección 6.

**Importancia.** Alta porque escribe en Odoo antes de que un admin confirme, y la ruta solo pide estar logueado.

**Consecuencias.** Si `apply_price` es false y `precio_odoo_lista` viene vacío, se manda el costo calculado como `list_price`. Cambian costo y precio de venta. Un operador pisa el precio que ven los clientes.

**Cómo arreglarlo.** `requireRole('admin')` para escribir precios. Si `apply_price` es false, reenviar el `list_price` actual.

#### Medio — La OC usa la cantidad facturada, no la recibida

`IngresoPreview.jsx:148-213`, `ingresoService.js:731-776`. También en la sección 6.

**Importancia.** Media si el control físico es solo un checklist. Alta si esa cantidad es la que entró.

**Consecuencias.** Llegaron 3 de 10 y la OC carga 10. `received_qty` se edita en pantalla y no entra al cálculo.

**Cómo arreglarlo.** Usar `received_qty` cuando es mayor que 0, o no dejar confirmar si el control no cierra contra la factura.

#### Medio — En el buscador de cotizaciones, todas las filas sin id quedan elegidas

`IngresoPreview.jsx:1396`. También en la sección 11.

**Importancia.** Media, en el modal que vincula un renglón de la factura con una línea de cotización. `??` pierde contra `===`.

**Consecuencias.** Si las líneas no traen `line_id`, todas se marcan. Se confirma la cantidad contra la cotización equivocada.

**Cómo arreglarlo.** Comparar `line_id` solo si no es null, y si no, comparar `id` solo si no es null.

#### Medio — La foto del producto se baja sin login

`ingreso.js:93`, `products.js:476`. También en la sección 6.

**Importancia.** Media en la LAN. Alta si el puerto 80 o el 3000 se publican.

**Consecuencias.** No cambia precios. Cualquiera que adivine el id baja la foto de Odoo con la API key del servidor.

**Cómo arreglarlo.** `authenticate` en las dos rutas.

### W. WhatsApp

No está en `master`. Todo esto es del PR #5 (`cursor/whatsapp-evolution-f7f3`), que además necesita las columnas del PR #2 (`has_image`, `template_id`, markups, `locally_archived`). Las rutas piden admin. El precio es el de catálogo (`whatsappPrice.js:1-2` y `42`), no el `list_price` de Odoo.

#### Alto — Si el proceso muere después de que Evolution aceptó el mensaje, se manda otra vez

`whatsappQueue.js:228-236`, `290` y `364-381`, en el PR #5.

**Importancia.** Alta en una tanda al grupo de clientes. El worker marca `enviando` y suma el intento antes de llamar a Evolution. `markSent` corre después. Si el proceso cae en el medio, `recoverStuck` (a los 2 minutos) vuelve la fila a `pendiente` mientras queden intentos (el default es 3).

**Consecuencias.** El grupo recibe el mismo producto, con el mismo precio, dos veces. No es un reintento de un envío que falló: Evolution ya lo había aceptado. Con tres caídas puede salir tres veces.

**Cómo arreglarlo.** Guardar un id de idempotencia antes de enviar y no reenviar si Evolution ya devolvió id. Si no hay id y el estado es `enviando`, dejar la fila para revisión humana en vez de volverla a `pendiente`.

#### Alto — Publica el proveedor de mayor confianza, aunque esté en staging o sin stock

`whatsappProducts.js:16-27` y `77-90`, en el PR #5.

**Importancia.** Alta porque es el precio que ve el grupo. La query pide `s.active`, producto no archivado, foto y regla de categoría. No pide `s.status = 'active'`, ni `s.is_published`, ni `sp.available`. `DISTINCT ON` se queda con el vínculo de mayor `match_confidence`.

**Consecuencias.** Entra un proveedor que todavía no se promovió, o uno cuyo producto el scrape marcó como no disponible. Si hay dos proveedores, se publica el precio del match más confiado, que puede ser el más caro. El cliente pide a un número que no es el de la lista de Odoo ni el de su lista especial: la lista de cliente, en este PR, solo filtra proveedores y no baja el precio.

**Cómo arreglarlo.** Exigir `status = 'active'`, `is_published` y `sp.available`. Elegir el proveedor por costo, no solo por confianza, y mostrar cuál se usó. Si el grupo es de un cliente con lista, aplicar el descuento de esa lista después de `rulesEngine`.

#### Medio — La foto se manda siempre como JPEG

`whatsappWorker.js:28`, en el PR #5. Odoo devuelve `image_512` o `image_128` sin decir el tipo.

**Importancia.** Media. El mensaje igual sale si Evolution acepta el binario.

**Consecuencias.** Una foto PNG etiquetada como `image/jpeg` puede llegar rota o no llegar. El cliente ve el texto del precio sin la imagen, o una imagen que no abre, y pide por un mensaje que no muestra el producto.

**Cómo arreglarlo.** Detectar el tipo por los primeros bytes del base64 y mandar ese `mimetype` y esa extensión.

### X. Pedidos por proveedor

La pantalla es `/preventas/ordenes-odoo`. En `master` agrupa por `vendor_name` del cache y se corta en 200 cotizaciones. **El PR #4** pagina, saltea líneas sin producto, agrupa por el proveedor local, alarga el timeout y formatea el PDF de esta pantalla. Lo que sigue queda después de ese PR. El PDF de Órdenes a proveedores (`preventas.js:679` en `master`) no lo toca el #4; está en la sección 7.

#### Alto — El costo que se le muestra al proveedor es el costo interno de Odoo

`supplierBreakdown.js:65` y `preventas.js:798-815` en el PR #4. En `master`, el mismo `standard_price` está en `preventas.js` alrededor del armado de `by-supplier`.

**Importancia.** Alta: ese número va al PDF que se le manda al proveedor. `standard_price` es el costo guardado en el cache de Preventas, no la lista actual del proveedor después del descuento.

**Consecuencias.** Se le pide al proveedor un precio que puede ser el de la última carga, con flete o margen adentro. Si el costo interno es más alto que su lista, el PDF le muestra nuestro costo. Si es más bajo, la orden sale barata y el proveedor la rechaza o entrega otra cosa.

**Cómo arreglarlo.** Usar el `raw_price` del `supplier_product` vinculado, pasado por la misma fórmula de costo que el ingreso. Si no hay vínculo, dejar el costo vacío y no inventarlo con `standard_price`.

#### Alto — La cantidad es la de la cotización entera

`supplierBreakdown.js:71-72` en el PR #4.

**Importancia.** Alta en la compra del día. Se suma `line.quantity` de cada cotización abierta. No se resta el stock a mano, ni las OC abiertas, ni lo que ya está en un ingreso sin confirmar.

**Consecuencias.** Se le vuelve a pedir al proveedor mercadería que ya está en depósito o que ya viene en camino. Cuando exista reposición (sección R), el mismo artículo se compra dos veces: una por esta pantalla y otra por la alerta de stock.

**Cómo arreglarlo.** Cantidad a pedir = pedido de clientes − stock a mano − OC abiertas − ingreso en tránsito, con un piso de 0. Mostrar los tres descuentos en la fila.

#### Alto — El vínculo de mayor confianza se queda con toda la cantidad

`preventas.js:821-830` y `839-856` en el PR #4. El fallback es `vendor_name`, y si no hay nada, "Sin proveedor".

**Importancia.** Alta cuando el mismo producto está mapeado a más de un proveedor. `DISTINCT ON` ordena por `match_confidence`. No mira el precio ni `status`.

**Consecuencias.** Toda la cantidad va a un solo proveedor, que puede ser el más caro o uno que sigue en staging (sección P). El otro, que sí lo tiene en stock, no recibe el pedido. Lo que no matchea cae en "Sin proveedor" y el PDF no tiene a quién enviarse.

**Cómo arreglarlo.** Filtrar `status = 'active'`. Si hay más de un proveedor, partir la cantidad o elegir por costo y mostrarlo. No mandar el PDF de "Sin proveedor" como si fuera una orden.

#### Alto — El PDF puede leer un archivo del servidor

`preventas.js:934-940` en `master`, cerca de la línea 927 en el PR #4. También en la sección 7.

**Importancia.** Alta para cualquiera con sesión. `image_url` viene del body. `path.join` con un tramo absoluto sale de la carpeta de storage.

**Consecuencias.** El PDF puede incluir `.env` o la clave de Odoo. Con eso se cambian precios, OC y pedidos.

**Cómo arreglarlo.** `path.resolve` y rechazar si el archivo no queda debajo de `STORAGE`. Buscar la foto por id de producto en el servidor.

### R. Reposición

No hay módulo en ejecución. No hay rutas, servicios ni páginas. Hay tablas en `schema.sql:589-670` y el diseño en `docs/agents/14-smart-purchasing.md`. Estos son los agujeros para cerrar antes de construirlo. Ningún PR #2-#5 los toca.

#### Crítico — La clave del competidor queda en texto plano

`schema.sql:595`, `docs/agents/14-smart-purchasing.md:23`.

**Importancia.** Crítica el día que se cargue el primer competidor. `login_password` es `VARCHAR(200)`, igual que el usuario, sin cifrar. El mismo diseño pide reutilizar el scraper de proveedores, que ya guarda secretos en la base (sección P).

**Consecuencias.** Quien lee la base entra a la cuenta del competidor. Desde ahí ve sus precios. Esos precios iban a decidir si conviene comprar o bajar el nuestro.

**Cómo arreglarlo.** No crear la columna en claro. Guardar el secreto cifrado o en una variable de entorno, y no devolverlo en el `GET`.

#### Alto — El cron diario duplica alertas y sugerencias de compra

`schema.sql:625-653`, `docs/agents/14-smart-purchasing.md:136-149`. `stock_alerts` y `purchase_suggestions` no tienen clave única. El diseño inserta cada mañana.

**Importancia.** Alta: es la lista que va a disparar compras. `sales_seasonality` sí tiene `UNIQUE(category, month)`. Estas dos tablas no.

**Consecuencias.** El mismo producto aparece dos veces como urgente. Se compran dos veces, o se descarta una alerta y la otra sigue pidiendo. Junto con Pedidos x Proveedor (sección X), el mismo SKU sale por las dos pantallas.

**Cómo arreglarlo.** Una fila abierta por producto, empresa y tipo. El cron actualiza esa fila. No inserta otra si ya hay una `pending` o `active`.

#### Alto — Los días de stock se parten por cero, y mezclan Neggo con Preventas

`docs/agents/14-smart-purchasing.md:136-138`, `schema.sql:625-636`.

**Importancia.** Alta en el primer producto que no vendió en la ventana. La fórmula es `days = qty_available / avg_daily_sales`. No hay columna `company`.

**Consecuencias.** Con venta promedio 0 el cálculo es infinito o revienta el insert. Un producto con stock en Neggo y un pedido en Preventas se lee como una sola bolsa: se compra para la empresa que no lo necesita, o no se compra para la que se está quedando sin.

**Cómo arreglarlo.** Si la venta promedio es 0, no dividir: alerta aparte ("sin ventas"). `company` en alertas, sugerencias y estacionalidad. Stock y ventas de esa empresa sola.

#### Alto — El stock que leería no es el que acaba de entrar

`docs/agents/14-smart-purchasing.md:136`, `ingresoService.js:862-875`, `odooService.js:640-663`. El sync de Odoo pisa `qty_available` del cache (sección 4). Confirmar un ingreso crea la OC en borrador y no llama a `button_confirm` ni mueve stock (sección 5).

**Importancia.** Alta porque la alerta de stock bajo es el corazón de reposición. Va a leer un cache que el sync puede borrar o dejar viejo, y no va a ver la mercadería del ingreso de hoy.

**Consecuencias.** Sugiere comprar lo que ya está en el camión o lo que ya se confirmó en la factura. O no sugiere nada porque el cache se borró en el sync y el producto "no existe". Se compra de más, o se pierde la venta por falta de stock que en realidad ya se pidió.

**Cómo arreglarlo.** No construir la alerta sobre `odoo_products_cache` sin una lectura fresca de Odoo. Restar OC abiertas e ingresos confirmados que todavía no movieron stock. Recién después, si el negocio lo quiere, confirmar la OC para que el stock se mueva.

#### Alto — Reusar el scraper actual borra los precios del competidor

`docs/agents/14-smart-purchasing.md:100-103` y `212`. Pide el mismo `BaseScraper` de la sección S.

**Importancia.** Alta el primer scrape que falle o que vuelva con 0 productos. `markUnavailableSince` hace `DELETE`, no una baja lógica.

**Consecuencias.** Se pierde el historial contra el que se iba a detectar "está más barato que hace 30 días". La oportunidad de compra desaparece, o se calcula contra un catálogo vacío y sugiere comprar todo.

**Cómo arreglarlo.** El arreglo de la sección S antes de copiar el scraper. En competidores, `available = false` y un `UNIQUE` que también cubra el producto sin SKU (en Postgres, `UNIQUE(competitor_id, sku)` deja pasar varias filas con `sku` null: `schema.sql:613`).

#### Medio — "Actuar" no compra, y la sugerencia no mira si el proveedor sigue activo

`docs/agents/14-smart-purchasing.md:168` y `191`, `schema.sql:645`.

**Importancia.** Media el día que la pantalla exista. El botón abre la comparativa. No crea una OC ni marca la sugerencia de forma que Pedidos x Proveedor la descuente. `best_supplier_id` no exige `status = 'active'`.

**Consecuencias.** La persona cree que ya pidió. El proveedor está en staging o fue desactivado y el precio sugerido es de un catálogo que no se puede comprar. Vuelve a pedir por la otra pantalla.

**Cómo arreglarlo.** "Actuar" tiene que crear la OC o sumar la cantidad a Pedidos x Proveedor, y pasar la sugerencia a `acted` con el id de esa OC. El proveedor sugerido sale solo si está `active` y publicado.

## 1. Auth y usuarios

### Crítico — El token de admin se puede firmar, y desactivar un usuario no corta la sesión

`docker-compose.yml:25`, `middleware/auth.js:4`, `auth.js:16-22`, `users.js:137-140`.

**Importancia.** Crítica: es la puerta de toda la app. Con el secreto por defecto (`cambiar_en_produccion_abc123`, o `dev_secret` si la variable no llega) cualquiera arma un JWT con `role: admin` válido 24 horas. Aunque el secreto esté bien puesto, `authenticate` no vuelve a leer `users`: bajar de rol o desactivar deja la sesión viva hasta que vence el token.

**Consecuencias.** Quien firme ese token cambia precios, confirma ingresos, crea órdenes de compra en Odoo y da de alta usuarios. Un empleado que ya no debería entrar sigue operando un día entero.

**Cómo arreglarlo.** Si `JWT_SECRET` falta o es uno de los dos defaults, no arrancar. En `authenticate`, leer `active` y `role` de `users` en cada request (o un `token_version` que suba al desactivar o cambiar el rol).

### Alto — Una clave mal escrita se ve como "sesión expirada"

`routes/auth.js:35-36`, `frontend/src/api/client.js:35-38`, `Login.jsx:33-34`.

**Importancia.** Alta para el día a día: es el primer paso de cualquier operador. El login responde 401 con el texto correcto, y el cliente trata todo 401 como sesión vencida, borra el token y recarga `/login`.

**Consecuencias.** La persona no sabe si escribió mal la clave, si el usuario está desactivado o si el servidor falló. Reintenta a ciegas o pide que le reseteen la clave. No pierde pedidos, pero bloquea el turno hasta que alguien mire el log.

**Cómo arreglarlo.** Si la URL es `/auth/login`, leer el JSON y mostrar `error` del backend. No redirigir.

### Alto — El menú esconde pantallas que la URL no esconde

`ProtectedRoute.jsx:16`, `App.jsx:77-87`, `Layout.jsx:298`.

**Importancia.** Alta porque el rol es lo único que separa a un vendedor de confirmar mercadería o administrar usuarios. El menú filtra; el router solo pregunta si hay sesión.

**Consecuencias.** Un vendedor abre `/ingreso` o `/usuarios` y llega a pantallas de admin. Combinado con rutas que no exigen rol (el `PATCH` de ítems de ingreso, el archivo de productos), puede cambiar un precio de lista en Odoo o ver datos que no le corresponden.

**Cómo arreglarlo.** Un guard de ruta que reciba los mismos roles que `requireRole` y redirija al inicio.

### Medio — El admin de fábrica es `admin123` y se imprime en el log

`initDatabase.js:12-19`.

**Importancia.** Media en una red de la oficina, alta si el puerto 80 o el 3000 se ven desde afuera. Solo se crea si el usuario `admin` no existe; no se rota después.

**Consecuencias.** Con esa clave se entra como admin: precios, órdenes y usuarios. La clave queda en los logs del contenedor.

**Cómo arreglarlo.** Crearlo solo si no hay ningún usuario, con `ADMIN_PASSWORD` del entorno, sin loguearla, y obligar a cambiarla en el primer login.

### Bajo — No hay límite de intentos de login

`routes/auth.js:9-54`.

**Importancia.** Baja mientras la clave del admin no sea la de fábrica. Sube junto con el ítem anterior.

**Consecuencias.** Un barrido corto prueba `admin123` y variantes. Si entra, el daño es el del ítem crítico de esta sección.

**Cómo arreglarlo.** Cortar por IP y usuario (por ejemplo 5 intentos en 15 minutos) antes de comparar el hash.

## 2. Activity log

### Bajo — El log no guarda a qué registro se le pegó

`server.js:49`, `middleware/activityLog.js:4-24` y `31`.

**Importancia.** Baja para vender. Importa el día que hay que reconstruir quién cambió un precio o confirmó un ingreso.

**Consecuencias.** El middleware está montado en `/api`, así que `req.path` es `/users/5` y no `/api/users/5`. `extractEntity` no saca el id: `entity_type` queda vacío. Ingreso, listas de precios y preventas-sync caen en el módulo `general`. No se puede filtrar "qué pasó con el ingreso 40".

**Cómo arreglarlo.** Usar `req.originalUrl` sin query para módulo y entidad, y sumar `ingreso`, `pricelists` y `preventas-sync` al mapa.

## 3. Reglas de precio, proveedores y listas

### Medio — Un markup de 0% en el ingreso se reemplaza por el default

`ingreso.js:139-140`, `ingresoService.js:645-646`. El PR #2 crea las columnas `markup_neggo` y `markup_preventas`; no toca este `NULLIF`.

**Importancia.** Media, y alta si algún proveedor se vende al costo. `COALESCE(NULLIF(markup_neggo, 0), default_markup, 0)` trata el 0 como "no configurado". `rulesEngine.js:24-34` sí respeta el 0, así que catálogo y alertas no coinciden con el ingreso.

**Consecuencias.** Precio de venta mal en Odoo al confirmar la mercadería: se aplica el markup default (por ejemplo 35%) a productos que tenían que salir sin recargo. El catálogo PDF, en cambio, muestra el 0%. El cliente ve un precio y la factura de Odoo otro.

**Cómo arreglarlo.** Usar la columna cuando no es `NULL`. Reservar `NULL` para "heredar el default".

### Medio — La lista especial y el catálogo no calculan el mismo precio

`pricelistService.js:42-45`, `preventasService.js:57-60`, `rulesEngine.js:37-39`.

**Importancia.** Media para los clientes con lista propia. El resto no la usa.

**Consecuencias.** La lista hace `raw_price × (1 - descuento/100)`, sin flete del 1,5% ni markup. El catálogo hace `lista × 1,015 × (1 + markup)`. El mismo artículo se cotiza a un número en el PDF y a otro en el pedido del cliente. Se cobra de menos o de más según desde qué pantalla se cargó.

**Cómo arreglarlo.** Una sola fórmula. Si la lista es un descuento sobre el precio de catálogo, aplicarla después de `rulesEngine`, y mostrarlo en la pantalla.

### Bajo — Cambiar el horario de scraping no corre hasta reiniciar

`jobs/scheduler.js:21-27` y `133-141`.

**Importancia.** Baja: el scrape manual desde la pantalla sigue funcionando.

**Consecuencias.** El cron nuevo no dispara. Los precios de ese proveedor quedan viejos hasta el próximo reinicio del backend, y las alertas no saltan. `stopScheduler` tampoco frena el cron horario de Odoo: un segundo `initScheduler` lo duplicaría.

**Cómo arreglarlo.** Al guardar `scrape_schedule`, destruir y volver a registrar solo esa tarea. Guardar los crons globales para poder pararlos.

## 4. Sync de Odoo

### Crítico — El sync completo no puede guardar el producto, porque faltan columnas

`jobs/odooSync.js:295-312`. **Cubierto por el PR #2** (`template_id`, `has_image`, y el resto de columnas de ese PR).

**Importancia.** Crítica para comprar y para el ingreso. El `INSERT` manda las 21 columnas juntas. Si `template_id` o `has_image` no existen, falla todo el lote: no se actualizan nombre, costo, `vendor_name` ni foto.

**Consecuencias.** Pedidos x Proveedor agrupa con el cache viejo o vacío (todo cae en "Sin proveedor"). El costo de la compra no es el de Odoo. La foto del producto no se arma. Un volumen que ya corrió las migraciones a mano no lo ve; una base nueva, o una que solo pasó por `initDatabase.js`, sí.

**Cómo arreglarlo.** El del PR #2: `ADD COLUMN IF NOT EXISTS` al arrancar y las mismas columnas en `schema.sql`.

### Alto — La página del sync no tiene orden, y lo que no volvió se borra

`odooSync.js:50-77` y `352-366`. El PR #4 pagina cotizaciones de venta, no este sync.

**Importancia.** Alta en cuanto el catálogo de Odoo pasa de 200 productos, que es el tamaño de página. `search_read` con `offset` y sin `order` saltea filas o las repite. `cleanupMissing` borra de `odoo_products_cache` todo id que no esté en la lista, y después borra `invoice_code_mappings` de esos ids. El comentario de la línea 453 dice "marcados inactivos"; el SQL los elimina.

**Consecuencias.** Productos que siguen en Odoo desaparecen de la app. El próximo ingreso de esa factura no reconoce el código y el ítem queda sin match. Pedidos y catálogos dejan de ofrecerlos. No es stock mal calculado: es el vínculo local destruido. Si Odoo devolviera siempre 200 filas, el `while` no corta y el sync no termina.

**Cómo arreglarlo.** `order: 'id asc'`. Cortar si un id ya se vio. No borrar si el conteo recibido no cierra con un `search_count` de Odoo; abortar el cleanup como ya se hace cuando la lista viene vacía (`odooSync.js:422-424`).

### Medio — Dos sync pueden correr juntos

`scheduler.js:77` y `118-125`.

**Importancia.** Media. Pasa si el sync de las 200 páginas tarda más de una hora, o si el del arranque sigue cuando dispara el cron.

**Consecuencias.** El cleanup de uno borra filas que el otro acaba de dar por vigentes. Mismo efecto que el ítem anterior: productos y códigos de factura que se pierden del cache, matches de ingreso que fallan.

**Cómo arreglarlo.** `pg_advisory_lock` alrededor de `syncOdooProducts`, el mismo patrón que `preventasMatchService`.

### Medio — Archivar en la app no sobrevive en una base vieja, y el sync revive `active`

`products.js:100` y `200`, `odooSync.js:306`, `migrations/017_locally_archived.sql`. `schema.sql:212` ya tiene la columna; `initDatabase.js` no la agrega.

**Importancia.** Media. Solo duele en un volumen creado antes de esa columna.

**Consecuencias.** La pantalla de productos Odoo responde 500 y no se puede archivar. En una base nueva el flag se guarda, pero el sync pisa `active` con el valor de Odoo: si alguien lo reactiva allá, vuelve a verse como activo en la app aunque `locally_archived` siga en true. Se vuelve a ofrecer en pedidos un producto que el local había escondido.

**Cómo arreglarlo.** `ADD COLUMN IF NOT EXISTS locally_archived` en `initDatabase.js`. En el `UPDATE` del sync, no tocar `active` cuando `locally_archived = true`.

### Bajo — Cada página del sync loguea el producto 54537

`odooSync.js:48` y `66-83`.

**Importancia.** Ninguna para el negocio. Es un resto de depuración.

**Consecuencias.** Logs más largos. No cambia precios ni stock.

**Cómo arreglarlo.** Sacar el `DEBUG_ID`.

## 5. Cliente Odoo

### Alto — Reintentar un `create` duplica la orden en Odoo

`config/odoo.js:35-78`, `odooService.js:651`.

**Importancia.** Alta en cada confirmación de ingreso y en cada pedido que se manda a Odoo. El cliente reintenta hasta 4 veces cualquier error que no sea `AccessError`, `ValidationError`, `UserError` o `MissingError`. Si Odoo ya commiteó y se cortó la respuesta, el mismo `purchase.order.create` o `sale.order.create` sale de nuevo.

**Consecuencias.** Dos (o cuatro) órdenes de compra por la misma factura: el proveedor puede preparar el doble. O dos cotizaciones de venta para el mismo cliente. El stock no se mueve solo (la OC queda en borrador), pero la compra queda duplicada en Odoo.

**Cómo arreglarlo.** No reintentar `create`, `write`, `button_confirm` ni `unlink`. Reintentar solo lecturas. Antes de crear, buscar por una referencia propia (`origin` / `client_order_ref` = id del ingreso o del pedido).

### Alto — Sincronizar líneas borra la orden de venta

`odooService.js:478-486`, `preventas.js:35-41` y `254-255`, `preventasService.js:102-106`.

**Importancia.** Alta desde el momento en que el pedido ya tiene orden en Odoo (`status = cotizacion`). Cada alta, edición o baja de ítem llama a `updateSaleOrderLines`, que manda el comando `[5, 0, 0]` (borrar todas las líneas) y después escribe las nuevas.

**Consecuencias.** Pedidos perdidos en Odoo. Si se agrega un producto de proveedor, ese ítem no tiene `odoo_company` (`preventasService.js:102-106`). El filtro de Neggo da vacío y la orden Neggo queda sin líneas. Esos ítems, más cualquiera sin empresa, se escriben en la orden de Preventas con `product_id` vacío: la cotización del cliente pierde lo que ya tenía y gana renglones que no son productos. El `.catch` solo lo deja en el log; la pantalla puede mostrar éxito.

**Cómo arreglarlo.** No llamar al sync con una lista vacía. No incluir ítems sin `odoo_product_id`. Reemplazar el comando `5` por un diff: borrar las que sobran, actualizar las que siguen, crear las nuevas.

### Medio — Confirmar mercadería no mueve el stock

`odooService.js:173-197`. Nadie llama a `updateProductQty`. `confirmIngreso` crea la OC en borrador y no llama a `button_confirm`.

**Importancia.** Media si el depósito sabe que la OC hay que confirmarla en Odoo. Alta si la pantalla se lee como "ya ingresó".

**Consecuencias.** Stock mal en Odoo: la cantidad sigue en cero (o en el valor anterior) después de confirmar el ingreso. Se vende algo que "ya llegó" y no figura, o se vuelve a comprar. Escribir `qty_available` no serviría: en Odoo es un campo calculado.

**Cómo arreglarlo.** Decir en la UI que la OC queda en borrador. Si el negocio quiere stock al confirmar, validar el picking o ajustar `stock.quant`, no `qty_available`.

### Medio — El árbol de categorías corta en 500

`odooService.js:158`.

**Importancia.** Media, y solo si Odoo tiene más de 500 categorías.

**Consecuencias.** Una categoría que existe en Odoo no aparece en las reglas. Esos productos no entran al catálogo ni al sync de Preventas con la categoría correcta, y se publican en otra o no se publican.

**Cómo arreglarlo.** Paginar con `order: 'id asc'` hasta agotar.

## 6. Ingreso de mercadería

La lectura junta de este módulo está en la sección I. Acá queda el mismo detalle para el recorrido por módulo.

### Crítico — Sin las columnas nuevas no se guarda el reparto ni la OC de Preventas

`ingresoService.js:524` (`match_level`), `ingreso.js:590` y `ingresoService.js:730` (`preventa_qty_confirmed`), `ingresoService.js:891` (`odoo_purchase_order_id_preventas`). **Cubierto por el PR #2.**

**Importancia.** Crítica: sin esto el ingreso no se puede clasificar ni cerrar en una base que no haya corrido las migraciones a mano.

**Consecuencias.** No se guarda el preview, o no se guarda cuánto va a Preventas (toda la cantidad sigue a Neggo: stock y compra de la empresa equivocada). El caso peor es el confirm: Odoo ya creó la OC de Preventas, el `UPDATE` falla porque la columna no existe, Postgres hace rollback y el ingreso sigue pendiente. Reintentar crea otra OC. Compra duplicada al proveedor.

**Cómo arreglarlo.** El del PR #2. Además, el arreglo del ítem siguiente, porque la columna sola no evita la OC duplicada si Odoo falla por otro motivo.

### Alto — Confirmar cierra el ingreso aunque la OC no exista, y dos clicks crean dos

`ingresoService.js:643-650` y `859-895`, `ingreso.js:1911-1913`, `IngresoPreview.jsx:2343-2345`. El PR #2 cubre la columna que falta. No cubre este flujo.

**Importancia.** Alta cada vez que se confirma una factura. El error de `createPurchaseOrder` se traga y el estado pasa a `confirmado`. El `SELECT` no usa `FOR UPDATE`. Las llamadas a Odoo ocurren dentro del `BEGIN`: si el `COMMIT` falla después, Odoo ya tiene precios y OC, y la base vuelve atrás.

**Consecuencias.** Compra que no existe ("Sin OC en Odoo") y no se puede reintentar porque el ingreso ya no está pendiente: la mercadería no se le pide al proveedor. O dos OC por la misma factura si se hace doble click o si el commit falla y se confirma de nuevo. Precios ya escritos en Odoo que la base no registra.

**Cómo arreglarlo.** `SELECT … FOR UPDATE`. Pasar a un estado `confirmando` y commitear el id de cada OC en cuanto Odoo lo devuelve. Si el `create` falla, dejar `pending`. No reintentar un `create` si ese id ya está guardado.

### Alto — El código `100` se vincula al producto `1001`

`ingresoService.js:218-220`. Está en `docs/plan-arreglos-criticos.md`. Ningún PR #2-#5 lo toca.

**Importancia.** Alta en cada factura. El match es `UPPER(sp.sku) LIKE '%' || codigo || '%'` y, si pega, la confianza queda en 1.

**Consecuencias.** El costo y el precio de lista se escriben en el producto equivocado de Odoo. La OC le compra al proveedor un artículo que no vino. El que sí vino no actualiza stock ni precio. El operador lo ve como "identificado" y puede confirmarlo sin mirar.

**Cómo arreglarlo.** Igualdad contra el SKU normalizado (el nivel que ya está en `ingresoService.js:274-289`). Sacar el `LIKE`.

### Alto — Un parecido de nombre de 0,72 se acepta solo

`ingresoService.js:316-320`, `IngresoPreview.jsx:448`. En el plan, sin PR.

**Importancia.** Alta porque el umbral es bajo y el estado resultante es `matched`, el mismo que un código exacto.

**Consecuencias.** Igual que el ítem anterior: precio y OC sobre otro producto. Dos artículos de nombre parecido (distinto talle, distinto color) se mezclan. El stock del que no llegó sube en la OC y el que llegó no se carga.

**Cómo arreglarlo.** Dejar `fuzzy_name` en `pending`, con el candidato a la vista, hasta que una persona lo acepte.

### Alto — La cantidad de Preventas de un código repetido cae en un solo renglón

`ingreso.js:2018-2032`, `IngresoPreview.jsx:2063`. En el plan, sin PR. `merge-duplicate-items` existe (`ingreso.js:2199`) y es manual.

**Importancia.** Alta en facturas con el mismo código en más de una línea (bonificación, segundo remito, color distinto con el mismo código).

**Consecuencias.** La pantalla suma las cantidades, pero `preventa_qty_confirmed` se guarda en el primer id. El otro renglón entra entero a la OC de Neggo. Preventas queda corta (pedido de cliente sin mercadería) y Neggo compra de más. El reparto que el operador vio no es el que se manda a Odoo.

**Cómo arreglarlo.** Al guardar la cantidad de Preventas, repartirla en todos los `ingreso_items` de ese código en el mismo ingreso, o fusionar los duplicados antes de confirmar.

### Alto — La pestaña Preventa propone un pedido de otro cliente por el nombre

`ingreso.js:2142-2147`. En el plan, sin PR. El timeout de esa lectura lo cubre el PR #4.

**Importancia.** Alta al separar la mercadería contra cotizaciones abiertas. El parecido de nombre (0,72) alcanza para proponer el vínculo.

**Consecuencias.** Se reserva cantidad para el pedido de otro cliente. Ese cliente recibe algo que no pidió; el que sí pidió queda sin asignar. La OC de Preventas sale con el producto de Odoo equivocado.

**Cómo arreglarlo.** Proponer solo por código. El nombre queda como pista, sin seleccionar solo.

### Alto — Tildar "aplicar costo" también cambia el precio de lista, sin ser admin

`ingreso.js:391` y `661-668`.

**Importancia.** Alta porque escribe en Odoo Neggo antes de que un admin confirme, y la ruta solo pide estar logueado.

**Consecuencias.** Precio de venta mal en la lista de Odoo. Si `apply_price` es false y `precio_odoo_lista` viene vacío, igual se manda el precio calculado: cambian `standard_price` y `list_price`. Un operador (o un vendedor con la URL) pisa el precio que ven los clientes. El confirm de más tarde vuelve a calcular encima.

**Cómo arreglarlo.** `requireRole('admin')` para escribir precios, igual que el confirm (`ingreso.js:1893`). Si `apply_price` es false, reenviar el `list_price` actual y no el calculado.

### Medio — La OC usa la cantidad facturada, no la recibida

`IngresoPreview.jsx:148-213`, `ingresoService.js:731-776`.

**Importancia.** Media si el control físico es solo un checklist. Alta si esa cantidad es la que "entró".

**Consecuencias.** Llegaron 3 de 10 y la OC carga 10. Stock de más cuando alguien valide el remito en Odoo, y se le paga al proveedor (o se le da entrada) por lo que no vino. `received_qty` se edita en pantalla y no entra al cálculo.

**Cómo arreglarlo.** Usar `received_qty` cuando es mayor que 0, o no dejar confirmar si el control no cierra contra la factura.

### Medio — La foto del producto se baja sin login

`ingreso.js:93`, `products.js:476`.

**Importancia.** Media en la LAN. Alta si el puerto 80 o el 3000 se publican.

**Consecuencias.** No cambia precios ni stock. Cualquiera que adivine el id baja la foto chica de Odoo usando la API key del servidor, y puede enumerar el catálogo.

**Cómo arreglarlo.** `authenticate` en las dos rutas. Para el `<img>`, un token de un solo uso o servir la foto ya guardada bajo un path con sesión.

### Alto — La clasificación contra cotizaciones abiertas corta a los 30 segundos

`nginx.conf:102`, `ingreso.js:2036`. **Cubierto por el PR #4** (timeout de `/api/ingreso/` a 300 s).

**Importancia.** Alta cuando hay muchas cotizaciones abiertas en Preventas. Esa pestaña vuelve a bajarlas todas.

**Consecuencias.** La pantalla de separar falla por tiempo. El operador reparte sin ver los pedidos de los clientes, o no puede guardar el vínculo. La mercadería de preventa entra a Neggo.

**Cómo arreglarlo.** El del PR #4. Sigue dependiendo de que `getPreventasQuotations` pagine (el mismo PR).

## 7. Preventas — pedidos y órdenes

Pedidos x Proveedor, con lo que el PR #4 no cierra, está en la sección X.

### Crítico — Agregar un producto de proveedor guarda la fila y responde 500

`preventasService.js:57-82` y `115-118`, `preventas.js:258-261` y `93`.

**Importancia.** Crítica en Pedidos, cada vez que el ítem sale del catálogo del proveedor y no del cache de Odoo. `const prices` vive dentro del `if` y del `else`. El `return` lo usa afuera: `ReferenceError` en todo alta que llega al final. El `INSERT` ya commiteó; no hay transacción.

**Consecuencias.** El operador ve error y el renglón está en el pedido. Si reintenta, el upsert suma la cantidad: se le vende el doble al cliente y la compra al proveedor sale duplicada. El total del pedido ya se recalculó con la primera cantidad; la pantalla no lo muestra porque la respuesta falló.

**Cómo arreglarlo.** `let prices` antes del `if`, asignarlo en las dos ramas. Envolver insert y recálculo del total en una transacción.

### Alto — "Generar órdenes" tira los ítems cargados desde Odoo

`preventasService.js:248-264`. En el plan, sin PR. El PR #4 arregla Pedidos x Proveedor y no esta pantalla.

**Importancia.** Alta si la compra se arma en Órdenes a proveedores a partir de Pedidos. Baja si la compra sale solo de las cotizaciones de Odoo (eso lo cubre el #4).

**Consecuencias.** El botón responde que los pedidos no tienen ítems. No se genera la orden al proveedor: el pedido del cliente no se compra. Los ítems siguen en la app y no hay OC.

**Cómo arreglarlo.** Si el ítem es de Odoo (`supplier_product_id` null), resolver el proveedor por `product_mappings` y no descartarlo.

### Alto — Pedidos x Proveedor se corta en 200 cotizaciones y a los 30 segundos

`odooService.js:765-835`, `nginx.conf:102`, `preventas.js:771-821`, `OdooSupplierBreakdown.jsx`. **Cubierto por el PR #4**, que también saltea líneas sin producto, agrupa por el proveedor local y muestra el error si Chrome no está. El sync que llena `vendor_name` depende del PR #2.

**Importancia.** Crítica para la compra del día si hay más de 200 cotizaciones abiertas o muchas líneas.

**Consecuencias.** Pedidos de clientes que no entran a la lista de compra: no se le pide al proveedor y el cliente se queda sin la mercadería. Líneas de sección ("Notas") aparecen como productos. Si Odoo no tiene `vendor_name`, todo cae en "Sin proveedor" y se le manda el PDF al contacto equivocado, o no se le manda. El costo es el `standard_price` viejo del cache. El botón de PDF no avisa si Chrome no responde: el operador cree que el pedido se generó.

**Cómo arreglarlo.** El del PR #4, después del #2.

### Alto — El PDF de cotizaciones puede leer un archivo del servidor

`preventas.js:888` y `934-940`. El PR #4 reescribe ese PDF y deja el mismo `path.join` (en esa rama, cerca de la línea 927).

**Importancia.** Alta para cualquiera con sesión (no hace falta ser admin). `image_url` viene del body. `/storage/../../…` más `path.join` con un tramo absoluto sale de la carpeta de storage.

**Consecuencias.** No cambia precios por sí solo. El PDF resultante puede incluir `.env` o la clave de Odoo y de Postgres. Con eso, el daño pasa a ser el de un admin: precios, OC y pedidos.

**Cómo arreglarlo.** `path.resolve` y rechazar si el archivo no queda debajo de `STORAGE`. No aceptar una URL armada por el cliente: buscar la foto por id de producto en el servidor.

### Medio — El PDF de Órdenes a proveedores muestra mal los miles

`preventas.js:679`. El PR #4 formatea el otro PDF (cotizaciones, línea ~899), no este.

**Importancia.** Media. El número es el correcto; el separador no. En Alpine, `Intl` con `es-AR` no tiene el locale y usa coma.

**Consecuencias.** El proveedor lee `$1,234.50` donde el local espera `$1.234,50`. Un pedido de 12.500 unidades puede leerse como 12 unidades y media, o al revés, según quién mire. Riesgo de que entregue otra cantidad.

**Cómo arreglarlo.** El mismo formateo a mano del PR #3: `$` y punto de miles, sin `Intl`.

### Crítico — Crear un pedido con lista de precios revienta en una base nueva

`preventas.js:101`, `schema.sql:231-246` y `700`. **Cubierto por el PR #2.**

**Importancia.** Crítica en una base vacía: el entrypoint de Postgres corta en el índice, la base no termina de crearse y la app no arranca. En una base vieja sin la columna, el `INSERT` del pedido falla aunque la lista vaya en null.

**Consecuencias.** No se carga el pedido del cliente. No hay compra asociada. En el caso del índice, no hay app.

**Cómo arreglarlo.** El del PR #2: crear `pricelist_id` antes del índice, en `schema.sql` y al arrancar.

## 8. Catálogos

Los cuatro los cierra el PR #3, que a su vez necesita las columnas de markup del PR #2. Un PDF ya guardado no se regenera solo: hay que volver a generarlo después de mergear.

### Alto — El precio del PDF usa coma de miles

`catalogService.js:49-51`, `backend/Dockerfile:1`. **Cubierto por el PR #3.**

**Importancia.** Alta: ese PDF es el que se le manda al cliente.

**Consecuencias.** `$14.210` sale como `$14,210`. En una lectura rápida son catorce pesos con centavos, o catorce mil doscientos diez según la convención de quien lee. Se cotiza mal y el pedido entra con otro precio.

**Cómo arreglarlo.** Entero con punto de miles, armado a mano. Es lo que hace el PR #3.

### Alto — Pasar de Preventas a Neggo manda la categoría de la otra empresa

`Catalogs.jsx:33-36`, `catalogs.js:14`. **Cubierto por el PR #3.**

**Importancia.** Alta si se generan los dos tipos. El desplegable pide categorías una sola vez, sin `type`. El backend defaultea a Preventas.

**Consecuencias.** Se genera un PDF vacío, o el de la otra empresa, y se le manda al cliente una lista con precios de Neggo (markup distinto) o sin los productos de Preventas.

**Cómo arreglarlo.** Volver a pedir `/catalogs/categories?type=` al cambiar el tipo y limpiar la categoría elegida.

### Alto — Una categoría marcada como ignorada entra al PDF

`catalogService.js:239-243`, `catalogs.js:18-24`. **Cubierto por el PR #3.** `rulesEngine` sí descarta `ignored`; la query del catálogo no.

**Importancia.** Alta si se usa "ignorar" para no publicar (productos de prueba, categorías que no se venden).

**Consecuencias.** Esos productos salen en el PDF con precio. El cliente los pide. Hay que decir que no está, o comprar algo que no se quería vender.

**Cómo arreglarlo.** `scr.ignored = false` en el listado de categorías y en la query del PDF.

### Medio — El logo no está donde el contenedor lo busca

`catalogService.js:44` y `112-116`. **Cubierto por el PR #3.**

**Importancia.** Media. El PDF igual se genera.

**Consecuencias.** El cliente recibe un catálogo con el texto "neggo" en vez del logo. No cambia el precio. Sí cambia la confianza en que ese PDF es el de la empresa.

**Cómo arreglarlo.** Leer `STORAGE_PATH/neggo_logo.png` (`/app/storage` en Docker) y dejar el texto como respaldo.

### Crítico — Sin `markup_neggo` / `markup_preventas` el catálogo no se arma

`catalogService.js:228-233`. **Cubierto por el PR #2.**

**Importancia.** Crítica en una base que no tenga esas columnas: la query falla entera.

**Consecuencias.** No hay PDF para enviar. No es un precio mal: es ningún catálogo.

**Cómo arreglarlo.** El del PR #2.

## 9. Vínculos y alertas de precio

### Alto — Aprobar una alerta la cierra aunque Odoo no haya tomado el precio

`priceAlertService.js:171-205`.

**Importancia.** Alta: es el único control humano antes de cambiar el precio de Neggo.

**Consecuencias.** La pantalla la saca de pendientes. En Odoo el costo y el precio de venta siguen en el valor viejo. Se sigue vendiendo al precio anterior, con el margen mal, y no hay botón de reintento: hay que tocar la base o esperar otro cambio del proveedor.

**Cómo arreglarlo.** Si algún mapping devolvió error, dejar `pending` y mostrar el detalle. Pasar a `approved` solo cuando todos los `write` salieron bien.

### Alto — Un precio anterior en 0 rompe el cálculo, después de haber escrito Odoo

`priceAlertService.js:30` y `73-76`.

**Importancia.** Alta la primera vez que un producto pasa de 0 a un precio real, o cuando el scrape anterior guardó 0.

**Consecuencias.** `(nuevo - 0) / 0` es infinito. El `INSERT` en `NUMERIC(6,2)` falla. En Preventas el `updateProductPrices` ya corrió: el precio de venta en Odoo cambió y no queda alerta para revisar. En Neggo no se crea la alerta y nadie ve el salto.

**Cómo arreglarlo.** Si `oldPrice` no es un número finito o es 0, no dividir. Guardar `pct_change` null y tratarlo como alta, en `pending` para las dos empresas.

### Medio — Preventas aplica el precio nuevo solo, sin tope

`priceAlertService.js:64-76`. Neggo espera un 2% (`priceAlertService.js:15` y `103`).

**Importancia.** Media en un scrape sano. Alta combinada con el parser de Mali (sección 10): un precio leído mal se publica solo.

**Consecuencias.** `standard_price` y `list_price` de Preventas cambian en Odoo antes de que alguien lo vea. Un salto de 10× por un separador de miles mal leído se cobra en la próxima venta. No hay fila útil si además explotó el porcentaje.

**Cómo arreglarlo.** El mismo umbral mínimo que Neggo, y un techo (por ejemplo no auto-aplicar si la variación pasa del 30%): esa alerta queda `pending`.

## 10. Scraping de proveedores

La lectura junta de este módulo está en la sección S.

### Crítico — Pausar, o terminar en cero, borra el catálogo del proveedor

`pythonScraper.js:84-112` y `20`, `117-118`, `261-267`, `baseScraper.js:316-322` y `530-532`, `mali_scraper.py:52-54`.

**Importancia.** Crítica. Es el origen de los precios de catálogo, de las alertas y de los vínculos con Odoo. `markUnavailableSince` hace `DELETE` de todo producto del proveedor con `last_scraped_at` anterior al run. La cascada se lleva historial, `product_mappings` y `preventas_sync_state`.

El delete corre aunque el proceso haya sido pausado con `SIGTERM`. También corre si Python sale con código 0 y 0 productos (el login de Mali trata `NoSuchElementException` como "sesión ya activa" y la wishlist viene vacía). En el camino Puppeteer también borra cuando el estado es `partial`: una categoría caída elimina los productos de esa categoría.

**Consecuencias.** Se pierde el catálogo de Cast, Mali, El Rey o Impotekno. Desaparecen los vínculos: el ingreso deja de matchear por código de proveedor, el sync de Preventas no tiene contra qué comparar, y las alertas de precio no vuelven a disparar hasta re-scrapear y re-vincular a mano. Los pedidos armados contra esos `supplier_product_id` quedan apuntando a filas que ya no existen. No es un precio desactualizado: es la base de precios del proveedor vaciada.

**Cómo arreglarlo.** No borrar en `paused`, `failed` ni `partial`. En `completed`, no borrar si `found` es 0 o cayó por debajo de la mitad del catálogo anterior. Marcar `available = false` en lugar de `DELETE`, para no cortar mappings. El delete, si hace falta, como acción aparte.

### Alto — Sin SKU, todos esos productos pisan la misma fila

`baseScraper.js:145-146` y `223-261`.

**Importancia.** Alta en cualquier página del scraper que no traiga código.

**Consecuencias.** Todos quedan con SKU `PRE` + prefijo. El segundo pisa nombre y precio del primero: un solo precio para muchos artículos, el resto se pierde. Después el delete del ítem anterior borra lo que no se "vio". El catálogo queda con un producto y un precio que no corresponden a ninguno.

**Cómo arreglarlo.** Si no hay código, no insertar: loguear el error del run. No usar esa fila en el delete.

### Medio — Mali lee un precio argentino como un decimal chico

`mali_scraper.py:59-66`. Cast y El Rey sí separan miles y decimales (`cast_scraper.py:76`, `elrey_scraper.py:60`).

**Importancia.** Media si el sitio de Mali manda `$310.00` (formato US, como dice el comentario del parser). Alta si manda `$1.234,56`.

**Consecuencias.** `$1.234,56` queda `1.23456`. Ese costo entra al catálogo y, si el producto está vinculado a Preventas, se escribe solo en Odoo (sección 9). Se vende a pesos en lugar de a miles. El margen desaparece.

**Cómo arreglarlo.** El parser de Cast: si hay punto y coma, el último separador es el decimal.

### Medio — Pueden correr más de dos scrapers a la vez

`scrapingService.js:28-71`.

**Importancia.** Media. El tope existe para no tumbar Chrome ni el proveedor.

**Consecuencias.** El contador se incrementa después de un `await`. Dos clicks, o el cron más un click, pasan los dos. Un tercer Chromium compite, el sitio del proveedor puede bloquear la IP, y el run termina a medias. Combinado con el delete del ítem crítico, un run a medias borra el resto del catálogo.

**Cómo arreglarlo.** Subir `runningCount` antes del primer `await`. Bajarlo en el `finally` si el proveedor no se puede scrapear.

### Bajo — El camino Python no marca categorías pendientes al terminar

`baseScraper.js:554`. Los cuatro scrapers reales extienden `PythonScraper`.

**Importancia.** Baja. La pantalla de reglas igual lista el faltante con `GET /api/suppliers/:id/unmapped-categories`. Ya está anotado en `docs/estado-implementacion.md`.

**Consecuencias.** El badge de "categorías sin mapear" puede no enterarse por este camino. Esas categorías no entran al catálogo hasta que alguien cree la regla. No se pierden productos ya cargados.

**Cómo arreglarlo.** Llamar a `detectPendingCategories()` al final de `PythonScraper.run` cuando el estado es `completed`.

## 11. Frontend

El login y las rutas sin rol están en la sección 1 (`client.js`, `ProtectedRoute.jsx`, `App.jsx`). Acá queda lo que solo se ve en una pantalla.

### Medio — En el buscador de cotizaciones, todas las filas sin id quedan elegidas

`IngresoPreview.jsx:1396`. El build ya avisa por la precedencia. Está en `docs/estado-implementacion.md`.

**Importancia.** Media, en el modal que vincula un renglón de la factura con una línea de cotización.

**Consecuencias.** `??` pierde contra `===`, así que el segundo comparador (`selected.id`) no corre. Si las líneas no traen `line_id`, `undefined === undefined` es verdadero y todas se marcan. Se confirma la cantidad contra la cotización equivocada: la mercadería se asigna a otro pedido de cliente.

**Cómo arreglarlo.** `(selected?.line_id != null && selected.line_id === l.line_id) || (selected?.id != null && selected.id === l.id)`.

## 12. Docker, Nginx e initDatabase

### Crítico — La clave de Mali y el token de El Rey están en el arranque

`initDatabase.js:86-106`. Ya lo marca `docs/estado-implementacion.md`. Ningún PR #2-#5 lo saca.

**Importancia.** Crítica: están en el git y se copian a `suppliers.scrape_config`. Si la config quedó `{}`, el `UPDATE` las vuelve a escribir en cada arranque.

**Consecuencias.** Quien lea el repo o la base entra a la cuenta de Mali y al catálogo de El Rey. Desde ahí ve los costos reales del proveedor. Esos costos son la base del precio de venta. Hay que asumir que ya salieron y rotarlos en los sitios, no solo borrarlos del archivo.

**Cómo arreglarlo.** Sacar las cadenas del código. Leer `MALI_USER`, `MALI_PASSWORD` y `ELREY_TOKEN` del entorno, y no tocar la fila si la variable no está. Rotar clave y token en Mali y El Rey.

### Crítico — Una base vacía no termina de crearse

`schema.sql:700` contra el `CREATE TABLE` de `preventa_client_orders` (líneas 231-246). **Cubierto por el PR #2.** El detalle de columnas está en las secciones 4, 6, 7 y 8.

**Importancia.** Crítica para un `docker compose` desde cero. El entrypoint de Postgres corre `schema.sql` con `ON_ERROR_STOP`. El índice referencia `pricelist_id` y la columna no existe: el script corta.

**Consecuencias.** No hay base. No hay login, ni precios, ni pedidos, ni ingreso. Un volumen que ya fue migrado a mano no lo ve.

**Cómo arreglarlo.** El del PR #2: la columna antes del índice, y el mismo `ALTER` al arrancar para las bases que ya existen.

### Alto — El puerto 3000 publica la API al lado de Nginx

`docker-compose.yml:21-22`, `server.js:15` y `36-40`.

**Importancia.** Alta en cualquier red donde esa máquina se vea. Nginx es el que pone timeouts y sirve el front. El 3000 habla directo con Express. CORS está abierto (`cors()` sin origen).

**Consecuencias.** Los proxies de fotos sin login (sección 6) y el health, que devuelve el mensaje crudo de Postgres, quedan fuera del filtro. No cambia precios por sí solo. Acorta el camino hasta los bugs de auth y de fotos.

**Cómo arreglarlo.** No publicar el 3000 fuera de la red de Compose. En producción, el health no debe devolver `details`.

### Medio — Tres listas de schema, y un error de migración se traga

`docker-compose.yml` (solo monta `schema.sql` y `seeds.sql`), `initDatabase.js:26`, `35`, `39` y `276`. El hueco de columnas lo cierra el PR #2. Esto queda.

**Importancia.** Media el día que se agrega una columna y el `ALTER` falla por algo distinto de "ya existe".

**Consecuencias.** El log dice "inicializada correctamente". La app arranca y la primera pantalla que usa esa columna responde 500: no se guarda un ingreso, no corre el sync, no se crea un pedido. Parece un bug de esa pantalla.

**Cómo arreglarlo.** Loguear el error del `.catch`. A mediano plazo, una tabla de migraciones aplicadas y una sola lista.

### Medio — `/storage/` se descarga sin sesión

`nginx.conf:106-110`.

**Importancia.** Media. El volumen está montado de solo lectura: no se puede escribir por ahí.

**Consecuencias.** Fotos de productos y, si alguien dejó un PDF en esa carpeta, el catálogo con precios, se bajan sin JWT. Es la lista de precios pública para quien esté en la red.

**Cómo arreglarlo.** Si tiene que ser privado, bajarlo por el backend con `authenticate`, como ya hace `/api/catalogs/:id/download`.

### Bajo — Hay dos handlers de SIGTERM

`server.js:138-142` y `151-155`.

**Importancia.** Baja. El proceso igual termina.

**Consecuencias.** Los dos llaman a `pool.end()`. El segundo puede loguear un pool ya cerrado. Un scrape que estaba corriendo se corta; el riesgo de fondo es el delete de la sección 10 si ese corte se interpreta como fin exitoso. Este handler en sí no borra datos.

**Cómo arreglarlo.** Un solo handler: parar el cron, cerrar el pool, salir.

## Cómo se reparte

En los seis módulos de arriba, sin PR y en este orden: no borrar el catálogo al scrapear, no borrar productos al desactivar un proveedor, unificar el costo del ingreso con el del catálogo, cerrar el confirm para que una falla no deje el ingreso confirmado ni duplique la OC, y sacar el `LIKE` y el fuzzy automático. El prefijo único y el filtro `status = 'active'` en catálogo, scrape manual, pedidos y WhatsApp van juntos.

Antes de escribir reposición: clave de competidor cifrada, una sola alerta abierta por producto y empresa, no dividir por venta cero, restar lo que ya está en camino, y no copiar el `DELETE` del scraper.

Con PR ya abierto: #2 antes que #3 y #4. En el #4 quedan el costo (`standard_price`), la cantidad bruta, el ganador por confianza y el path del PDF. En el #5 quedan el reenvío si el proceso muere y el filtro de staging. El #5 no corrige bugs de `master`.
