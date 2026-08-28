# Bot de gastos de Telegram

Telegram funciona como una libreta rápida: se envía una descripción seguida del importe y el gasto queda guardado sin categoría. La aplicación de historial puede mantenerse separada e importar los CSV que genera el bot.

## Comandos simples

- `café 2500`: guarda un gasto nuevo del día.
- `total`: muestra el total del mes actual de gastos propios o sin categoría.
- `total agosto` o `total agosto 2025`: muestra el total de ese mes calendario.
- `meses`: muestra los meses disponibles, sus cantidades de gastos y sus totales.
- `agosto`, `gastos agosto` o `gastos agosto 2025`: abre y lista los gastos del mes.
- `exportar agosto` o `exportar agosto 2025`: envía un archivo `gastos-YYYY-MM.csv` listo para importar.
- `ultimos`: muestra los últimos 20 gastos.
- `borrar ultimo`: elimina el último gasto.

El CSV usa columnas estables: `id`, `date`, `description`, `amount`, `amount_cents`, `currency`, `category` y `source`. La aplicación importadora debería usar `id` para evitar duplicados si se importa dos veces el mismo archivo.

Las consultas simples y la exportación usan el mes calendario (`expenseMonth`), no el mes de cierre de tarjeta (`billingMonth`). No requieren un índice compuesto adicional de Firestore.

# API para la aplicación

Backend Node/Express para el bot existente de Telegram y una futura aplicación de escritorio. Los gastos siguen viviendo en `telegram_expenses`; las configuraciones y cierres siguen en `telegram_settings`. La API agrega las colecciones `tasks` y `reminders`.

## Arquitectura

`index.js` conserva el webhook `POST /telegram` y las reglas ya existentes del bot (alias, normalización y cierre de tarjeta). `src/api.js` contiene el router autenticado, validaciones, CORS y serialización segura de Firestore.

La API nunca acepta un `chatId` del cliente: usa siempre `OWNER_CHAT_ID` del entorno. Las fechas se devuelven en ISO 8601 y los gastos anteriores continúan siendo legibles aunque no tengan `source`.

## Instalación y arranque local

1. Copiá `.env.example` a `.env` y completá los valores.
2. Instalá dependencias con `npm install`.
3. Ejecutá `npm start`.

Variables necesarias:

```env
PORT=3000
TELEGRAM_TOKEN=
FIREBASE_SERVICE_ACCOUNT=
DESKTOP_API_KEY=
OWNER_CHAT_ID=
ALLOWED_ORIGINS=http://localhost:1420,http://localhost:5173
```

`FIREBASE_SERVICE_ACCOUNT` debe ser el JSON completo de la cuenta de servicio en una sola variable. No subas `.env` ni la clave de servicio: ambos están ignorados por Git.

## Endpoints

Públicos: `GET /`, `GET /health` y `POST /telegram`.

Todas las rutas `/api/*` requieren `Authorization: Bearer <DESKTOP_API_KEY>`:

- Gastos: `GET/POST /api/expenses`, `GET/PATCH/DELETE /api/expenses/:id`, `GET /api/expenses/summary?billingMonth=YYYY-MM`.
- Cierres: `GET/PUT /api/settings/closing-days/:yearMonth`.
- Tareas: `GET/POST /api/tasks`, `GET/PATCH/DELETE /api/tasks/:id`.
- Recordatorios: `GET/POST /api/reminders`, `GET /api/reminders/pending`, `GET/PATCH/DELETE /api/reminders/:id`, `POST /api/reminders/:id/mark-shown`, `POST /api/reminders/:id/dismiss`.

Gastos acepta filtros `billingMonth`, `expenseMonth`, `place`, `subtype`, `dateFrom`, `dateTo` y `limit` (máximo 500). Tareas acepta `status`, `priority`, `project`, `dueBefore`, `dueAfter` y `limit`. Recordatorios pendientes acepta `before` y `limit`.

## Ejemplos

```bash
curl http://localhost:3000/health

curl -H "Authorization: Bearer $DESKTOP_API_KEY" \
  "http://localhost:3000/api/expenses?billingMonth=2026-08"

curl -X POST http://localhost:3000/api/tasks \
  -H "Authorization: Bearer $DESKTOP_API_KEY" -H "Content-Type: application/json" \
  -d '{"title":"Corregir endpoint","priority":"high"}'

curl -H "Authorization: Bearer $DESKTOP_API_KEY" \
  "http://localhost:3000/api/reminders/pending?before=2026-08-07T14:31:00.000Z"
```

Para probar el webhook sin afectar Telegram, usá un servidor local con variables de prueba y enviá un `POST /telegram` con un `chat.id` de prueba; no cambies la URL del webhook productivo. El webhook responde 200 incluso si encuentra un error, como hacía antes.

## Firestore e índices

La API consulta el mes o rango solicitado directamente en Firestore; no descarga el historial completo para filtrarlo en memoria. Creá estos índices compuestos para la pantalla de Gastos:

- `telegram_expenses(chatId ASC, billingMonth ASC)`
- `telegram_expenses(chatId ASC, expenseMonth ASC)`

## Render y checklist posterior al deploy

Conservá `TELEGRAM_TOKEN` y `FIREBASE_SERVICE_ACCOUNT` sin cambios. Agregá en Render:

- `DESKTOP_API_KEY`: clave larga y aleatoria usada por la aplicación de escritorio.
- `OWNER_CHAT_ID`: el ID numérico del chat propietario.
- `ALLOWED_ORIGINS`: orígenes separados por coma, por ejemplo `http://localhost:1420,http://localhost:5173`.

Después del deploy verificá `GET /health`, una consulta autenticada de gastos, el resumen mensual, creación de una tarea y `/api/reminders/pending`. Confirmá también que el bot responda a `/help` y que `POST /telegram` siga configurado en Telegram/Render.
