# WhatsApp con Evolution API

Publica, en un grupo de WhatsApp, la foto, el nombre y el precio de catálogo de productos de Odoo. Cada tanda manda un mensaje cada 90 segundos (se puede cambiar). La cola queda en Postgres: un reinicio sigue desde el último mensaje pendiente.

## 1. Preparar la PC

Hace falta Docker y Docker Compose. En la carpeta del proyecto:

```bash
cp .env.example .env
```

Si el `.env` ya existe, agregá estas líneas. La clave tiene que ser la misma para Evolution y para el backend. No la subas al repositorio.

```bash
openssl rand -hex 16
```

```bash
EVOLUTION_API_URL=http://evolution:8080
EVOLUTION_API_KEY=la_clave_que_generaste
EVOLUTION_INSTANCE=neggo
EVOLUTION_STATUS_INSTANCE=neggo-estados
EVOLUTION_SERVER_URL=http://localhost:8080
WHATSAPP_MAX_ATTEMPTS=3
```

`POSTGRES_PASSWORD` no debe llevar `@`, `:` ni `/`: esa clave también entra en la URL de Evolution.

## 2. Levantar

```bash
docker compose up -d --build
```

Eso inicia Postgres, el backend, nginx, Chrome y Evolution API (`evoapicloud/evolution-api:v2.3.7`). En ese servidor hay dos instancias: `neggo` para los grupos y `neggo-estados` para los estados. Cada una es otro número de WhatsApp. Las sesiones se guardan en el volumen `evolution_instances`. La cola de mensajes se guarda en Postgres.

La app queda en http://localhost . Evolution escucha solo en esta PC, en http://localhost:8080 . No hace falta abrir ese puerto: el QR se ve dentro de Neggo.

## 3. Vincular los dos números

1. Entrá a http://localhost con el usuario admin.
2. En el menú de administración, abrí **WhatsApp**.
3. En **Instancia de grupos**, tocá **Mostrar QR** y escanealo con el teléfono que publica en los grupos: WhatsApp → **Dispositivos vinculados** → **Vincular dispositivo**.
4. Cuando diga **Conectado**, tocá **Listar grupos**, elegí el grupo y **Guardar**.
5. En **Instancia de estados**, tocá **Mostrar QR** y escanealo con el otro teléfono, el que publica los estados. No uses el mismo número: WhatsApp no deja dos sesiones iguales y los estados tienen que salir por ese otro número.

Si un QR se vence, volvé a pedirlo en esa misma tarjeta. Si borrás el volumen de Evolution, hay que escanear las dos instancias otra vez. Reiniciar los contenedores no desvincula los números ni borra la cola.

## 4. Programar una tanda

1. Elegí la lista **Preventas** o **Neggo**. El precio es el del catálogo de esa empresa: precio de lista del proveedor × 1,015 × markup. No se usa el precio de lista de Odoo ni el descuento de una lista de cliente.
2. Opcional: filtrá por categoría de Odoo, categoría del catálogo o lista de cliente. La lista de cliente solo deja productos de los proveedores que tienen una regla en esa lista.
3. Entran nada más los productos con foto en Odoo, vínculo al producto del proveedor, regla de categoría activa y precio de lista del proveedor. Sin eso no se inventa un precio.
4. Elegí fecha y hora (hora de Argentina) y **Programar tanda**.
5. En la misma pantalla ves enviados, pendientes y errores. **Pausar** frena la cola; **Reanudar** la sigue; **Cancelar** no manda lo que falta. Cada mensaje se reintenta hasta 3 veces y después queda en error, con el motivo en el log.

## 5. Publicar en estados

La cola es la misma, la instancia no. En **Armar tanda**, elegí **Estados**. Cada producto se publica como estado de la instancia `neggo-estados` (foto, nombre y precio de catálogo), uno cada intervalo, y lo ven los contactos de ese otro WhatsApp. No se usa el número de los grupos. Pausar, reanudar y cancelar funcionan igual. Un envío a un grupo y un estado no salen juntos: entre cualquier publicación hay al menos el intervalo de la tanda.

El estado se manda a los contactos que Evolution tiene guardados en la base de esa instancia (`DATABASE_SAVE_DATA_CONTACTS=true` en el compose). Recién vinculado el número, la lista puede estar vacía hasta que WhatsApp sincroniza la agenda. En ese caso el envío falla con "Contacts not found": esperá a que aparezcan los contactos y reintentá la tanda.

## 6. Después de actualizar el código

```bash
docker compose up -d --build backend
cd frontend && npm install && npm run build
docker compose up -d nginx evolution
```

El backend crea las tablas de la cola al arrancar, también si Postgres ya tenía datos.
