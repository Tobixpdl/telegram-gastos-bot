const express = require("express");

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const TASK_STATUSES = new Set(["pending", "in_progress", "completed"]);
const PRIORITIES = new Set(["low", "medium", "high"]);
const REMINDER_STATUSES = new Set(["pending", "shown", "dismissed"]);

function timestampToIso(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return null;
}

function isValidDate(value) {
  return DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

function isValidDateTime(value) {
  return typeof value === "string" && ISO_DATE_TIME_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function assertObject(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new ApiError(400, "VALIDATION_ERROR", "El body debe ser un objeto JSON.");
}

function rejectUnknown(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new ApiError(400, "VALIDATION_ERROR", `El campo '${key}' no está permitido.`);
  }
}

function requiredString(value, name, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new ApiError(400, "VALIDATION_ERROR", `El campo '${name}' es obligatorio y no puede superar ${max} caracteres.`);
  return value.trim();
}

function optionalString(value, name, max = 2000) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length > max) throw new ApiError(400, "VALIDATION_ERROR", `El campo '${name}' debe ser texto de hasta ${max} caracteres.`);
  return value.trim() || null;
}

function limitOf(value) {
  if (value === undefined) return 100;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ApiError(400, "VALIDATION_ERROR", "limit debe ser un entero entre 1 y 500.");
  return limit;
}

function documentJson(doc) {
  const data = doc.data();
  return { id: doc.id, ...data };
}

function createApiRouter({ db, admin, ownerId, detectPlaceAndSubtype, getArgentinaDateParts, monthKey, calculateBillingMonth, getClosingDay, setClosingDayAndRecalculate, createExpense: persistExpense }) {
  const router = express.Router();
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    const original = router[method].bind(router);
    router[method] = (path, ...handlers) => original(path, ...handlers.map((handler) => async (req, res, next) => {
      try { await handler(req, res, next); } catch (error) { next(error); }
    }));
  }
  const fieldValue = admin.firestore.FieldValue;

  function expenseJson(row) {
    return {
      id: row.id,
      place: row.place || null, placeKey: row.placeKey || null, placeRaw: row.placeRaw || null,
      subtype: row.subtype || null, subtypeKey: row.subtypeKey || null,
      amountCents: Number(row.amountCents || 0), amount: Number(row.amountCents || 0) / 100,
      originalText: row.originalText || null,
      expenseDate: timestampToIso(row.expenseDate), expenseDateIso: row.expenseDateIso || null,
      expenseMonth: row.expenseMonth || null, billingMonth: row.billingMonth || null,
      source: row.source || null, createdAt: timestampToIso(row.createdAt), updatedAt: timestampToIso(row.updatedAt),
    };
  }
  function taskJson(row) {
    return { id: row.id, title: row.title, description: row.description || null, status: row.status, priority: row.priority, project: row.project || null, dueAt: timestampToIso(row.dueAt), completedAt: timestampToIso(row.completedAt), createdAt: timestampToIso(row.createdAt), updatedAt: timestampToIso(row.updatedAt) };
  }
  function reminderJson(row) {
    return { id: row.id, title: row.title, message: row.message || null, scheduledAt: timestampToIso(row.scheduledAt), status: row.status, taskId: row.taskId || null, shownAt: timestampToIso(row.shownAt), dismissedAt: timestampToIso(row.dismissedAt), createdAt: timestampToIso(row.createdAt), updatedAt: timestampToIso(row.updatedAt) };
  }
  async function getOwned(collection, id) {
    const doc = await db.collection(collection).doc(id).get();
    if (!doc.exists || String(doc.data().ownerId || doc.data().chatId) !== ownerId) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
    return doc;
  }
  async function createExpense(input) {
    const date = input.expenseDate ? new Date(`${input.expenseDate}T12:00:00-03:00`) : new Date();
    const parsed = input.description ? await detectPlaceAndSubtype(ownerId, input.description) : await detectPlaceAndSubtype(ownerId, `${input.place} ${input.subtype || ""}`);
    const amountCents = Math.round(input.amount * 100);
    return persistExpense({ chatId: ownerId, parsed, amountCents, originalText: input.description || `${input.place}${input.subtype ? ` ${input.subtype}` : ""} ${input.amount}`, expenseDate: date, source: "desktop" });
  }
  router.get("/expenses/summary", async (req, res) => {
    const { billingMonth } = req.query;
    if (!MONTH_RE.test(billingMonth || "")) throw new ApiError(400, "VALIDATION_ERROR", "billingMonth debe tener el formato YYYY-MM.");
    const snap = await db.collection("telegram_expenses").where("chatId", "==", ownerId).where("billingMonth", "==", billingMonth).get();
    const places = new Map(), subtypes = new Map(); let totalCents = 0;
    snap.forEach((doc) => { const d = doc.data(), cents = Number(d.amountCents || 0); totalCents += cents; for (const [map, key, label] of [[places, d.place || "sin categoría", "place"], [subtypes, d.subtype || "general", "subtype"]]) { const current = map.get(key) || { [label]: key, totalCents: 0, count: 0 }; current.totalCents += cents; current.count += 1; map.set(key, current); } });
    const groups = (map) => [...map.values()].map((x) => ({ ...x, total: x.totalCents / 100 })).sort((a, b) => b.totalCents - a.totalCents);
    res.json({ success: true, data: { billingMonth, closingDay: await getClosingDay(ownerId, billingMonth), totalCents, total: totalCents / 100, expenseCount: snap.size, byPlace: groups(places), bySubtype: groups(subtypes) } });
  });
  router.get("/expenses", async (req, res) => {
    const { billingMonth, expenseMonth, place, subtype, dateFrom, dateTo } = req.query;
    for (const month of [billingMonth, expenseMonth]) if (month && !MONTH_RE.test(month)) throw new ApiError(400, "VALIDATION_ERROR", "Los meses deben tener el formato YYYY-MM.");
    for (const date of [dateFrom, dateTo]) if (date && !isValidDate(date)) throw new ApiError(400, "VALIDATION_ERROR", "Las fechas deben tener el formato YYYY-MM-DD.");
    const snap = await db.collection("telegram_expenses").where("chatId", "==", ownerId).get();
    const rows = []; snap.forEach((doc) => { const d = documentJson(doc); if ((!billingMonth || d.billingMonth === billingMonth) && (!expenseMonth || d.expenseMonth === expenseMonth) && (!place || d.placeKey === String(place).toLowerCase()) && (!subtype || d.subtypeKey === String(subtype).toLowerCase()) && (!dateFrom || d.expenseDateIso >= dateFrom) && (!dateTo || d.expenseDateIso <= dateTo)) rows.push(expenseJson(d)); });
    rows.sort((a, b) => (b.expenseDate || "").localeCompare(a.expenseDate || "")); res.json({ success: true, data: rows.slice(0, limitOf(req.query.limit)) });
  });
  router.get("/expenses/:id", async (req, res) => res.json({ success: true, data: expenseJson(documentJson(await getOwned("telegram_expenses", req.params.id))) }));
  router.post("/expenses", async (req, res) => { assertObject(req.body); rejectUnknown(req.body, new Set(["description", "place", "subtype", "amount", "expenseDate"])); const hasDescription = typeof req.body.description === "string" && req.body.description.trim(); if (!hasDescription) { requiredString(req.body.place, "place", 150); } if (hasDescription) requiredString(req.body.description, "description", 500); if (req.body.subtype !== undefined) optionalString(req.body.subtype, "subtype", 150); if (typeof req.body.amount !== "number" || !Number.isFinite(req.body.amount) || req.body.amount <= 0) throw new ApiError(400, "VALIDATION_ERROR", "amount debe ser un número positivo."); if (req.body.expenseDate && !isValidDate(req.body.expenseDate)) throw new ApiError(400, "VALIDATION_ERROR", "expenseDate debe tener el formato YYYY-MM-DD."); const ref = await createExpense(req.body); const doc = await ref.get(); res.status(201).json({ success: true, data: expenseJson(documentJson(doc)) }); });
  router.patch("/expenses/:id", async (req, res) => { assertObject(req.body); rejectUnknown(req.body, new Set(["place", "subtype", "amount", "expenseDate"])); if (!Object.keys(req.body).length) throw new ApiError(400, "VALIDATION_ERROR", "Indica al menos un campo para actualizar."); const doc = await getOwned("telegram_expenses", req.params.id), old = doc.data(), update = { updatedAt: fieldValue.serverTimestamp() }; let date = old.expenseDate?.toDate?.(); if (req.body.amount !== undefined) { if (typeof req.body.amount !== "number" || !Number.isFinite(req.body.amount) || req.body.amount <= 0) throw new ApiError(400, "VALIDATION_ERROR", "amount debe ser un número positivo."); update.amountCents = Math.round(req.body.amount * 100); update.amount = update.amountCents / 100; } if (req.body.expenseDate !== undefined) { if (!isValidDate(req.body.expenseDate)) throw new ApiError(400, "VALIDATION_ERROR", "expenseDate debe tener el formato YYYY-MM-DD."); date = new Date(`${req.body.expenseDate}T12:00:00-03:00`); const parts = getArgentinaDateParts(date); update.expenseDate = admin.firestore.Timestamp.fromDate(date); update.expenseDateIso = req.body.expenseDate; update.expenseMonth = monthKey(parts.year, parts.month); } if (req.body.place !== undefined || req.body.subtype !== undefined) { const place = req.body.place === undefined ? old.place : requiredString(req.body.place, "place", 150); const subtype = req.body.subtype === undefined ? old.subtype : optionalString(req.body.subtype, "subtype", 150) || "general"; const parsed = await detectPlaceAndSubtype(ownerId, `${place} ${subtype}`); Object.assign(update, { place: parsed.place, placeKey: parsed.placeKey, placeRaw: parsed.placeRaw, subtype: parsed.subtype, subtypeKey: parsed.subtypeKey }); } update.billingMonth = await calculateBillingMonth(ownerId, date); await doc.ref.update(update); res.json({ success: true, data: expenseJson(documentJson(await doc.ref.get())) }); });
  router.delete("/expenses/:id", async (req, res) => { const doc = await getOwned("telegram_expenses", req.params.id); await doc.ref.delete(); res.status(204).end(); });
  router.get("/settings/closing-days/:yearMonth", async (req, res) => { if (!MONTH_RE.test(req.params.yearMonth)) throw new ApiError(400, "VALIDATION_ERROR", "yearMonth debe tener el formato YYYY-MM."); res.json({ success: true, data: { yearMonth: req.params.yearMonth, day: await getClosingDay(ownerId, req.params.yearMonth) } }); });
  router.put("/settings/closing-days/:yearMonth", async (req, res) => { if (!MONTH_RE.test(req.params.yearMonth)) throw new ApiError(400, "VALIDATION_ERROR", "yearMonth debe tener el formato YYYY-MM."); assertObject(req.body); rejectUnknown(req.body, new Set(["day"])); if (!Number.isInteger(req.body.day) || req.body.day < 1 || req.body.day > 31) throw new ApiError(400, "VALIDATION_ERROR", "day debe ser un entero entre 1 y 31."); const recalculatedCount = await setClosingDayAndRecalculate(ownerId, req.params.yearMonth, req.body.day); res.json({ success: true, data: { yearMonth: req.params.yearMonth, day: req.body.day, recalculatedCount } }); });

  function collectionRoutes(collection, toJson, allowed, buildCreate, buildUpdate) {
    router.get(`/${collection}`, async (req, res) => { const snap = await db.collection(collection).where("ownerId", "==", ownerId).get(); const data = []; snap.forEach((doc) => data.push(toJson(documentJson(doc)))); res.json({ success: true, data: data.filter((item) => (!req.query.status || item.status === req.query.status) && (!req.query.priority || item.priority === req.query.priority) && (!req.query.project || item.project === req.query.project) && (!req.query.dueBefore || (item.dueAt && item.dueAt <= req.query.dueBefore)) && (!req.query.dueAfter || (item.dueAt && item.dueAt >= req.query.dueAfter))).sort((a, b) => (a.dueAt || "9999").localeCompare(b.dueAt || "9999")).slice(0, limitOf(req.query.limit)) }); });
    router.get(`/${collection}/:id`, async (req, res) => res.json({ success: true, data: toJson(documentJson(await getOwned(collection, req.params.id))) }));
    router.post(`/${collection}`, async (req, res) => { assertObject(req.body); rejectUnknown(req.body, allowed); const ref = await db.collection(collection).add(buildCreate(req.body)); const doc = await ref.get(); res.status(201).json({ success: true, data: toJson(documentJson(doc)) }); });
    router.patch(`/${collection}/:id`, async (req, res) => { assertObject(req.body); rejectUnknown(req.body, allowed); const doc = await getOwned(collection, req.params.id); const update = buildUpdate(req.body, doc.data()); if (!Object.keys(update).length) throw new ApiError(400, "VALIDATION_ERROR", "Indica al menos un campo para actualizar."); update.updatedAt = fieldValue.serverTimestamp(); await doc.ref.update(update); res.json({ success: true, data: toJson(documentJson(await doc.ref.get())) }); });
    router.delete(`/${collection}/:id`, async (req, res) => { const doc = await getOwned(collection, req.params.id); await doc.ref.delete(); res.status(204).end(); });
  }
  collectionRoutes("tasks", taskJson, new Set(["title", "description", "status", "priority", "project", "dueAt"]), (b) => { const status = b.status || "pending", priority = b.priority || "medium"; if (!TASK_STATUSES.has(status) || !PRIORITIES.has(priority)) throw new ApiError(400, "VALIDATION_ERROR", "status o priority inválido."); if (b.dueAt && !isValidDateTime(b.dueAt)) throw new ApiError(400, "VALIDATION_ERROR", "dueAt debe ser ISO 8601 UTC."); return { ownerId, title: requiredString(b.title, "title", 250), description: optionalString(b.description, "description"), status, priority, project: optionalString(b.project, "project", 250), dueAt: b.dueAt ? admin.firestore.Timestamp.fromDate(new Date(b.dueAt)) : null, completedAt: status === "completed" ? fieldValue.serverTimestamp() : null, createdAt: fieldValue.serverTimestamp(), updatedAt: fieldValue.serverTimestamp() }; }, (b, old) => { const u = {}; if (b.title !== undefined) u.title = requiredString(b.title, "title", 250); if (b.description !== undefined) u.description = optionalString(b.description, "description"); if (b.priority !== undefined) { if (!PRIORITIES.has(b.priority)) throw new ApiError(400, "VALIDATION_ERROR", "priority inválido."); u.priority = b.priority; } if (b.project !== undefined) u.project = optionalString(b.project, "project", 250); if (b.dueAt !== undefined) { if (b.dueAt !== null && !isValidDateTime(b.dueAt)) throw new ApiError(400, "VALIDATION_ERROR", "dueAt debe ser ISO 8601 UTC."); u.dueAt = b.dueAt ? admin.firestore.Timestamp.fromDate(new Date(b.dueAt)) : null; } if (b.status !== undefined) { if (!TASK_STATUSES.has(b.status)) throw new ApiError(400, "VALIDATION_ERROR", "status inválido."); u.status = b.status; if (b.status === "completed" && old.status !== "completed") u.completedAt = fieldValue.serverTimestamp(); if (b.status !== "completed") u.completedAt = null; } return u; });
  router.get("/reminders/pending", async (req, res) => { const before = req.query.before || new Date().toISOString(); if (!isValidDateTime(before)) throw new ApiError(400, "VALIDATION_ERROR", "before debe ser ISO 8601 UTC."); const snap = await db.collection("reminders").where("ownerId", "==", ownerId).where("status", "==", "pending").get(); const data = []; snap.forEach((doc) => { const reminder = reminderJson(documentJson(doc)); if (reminder.scheduledAt <= before) data.push(reminder); }); data.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)); res.json({ success: true, data: data.slice(0, limitOf(req.query.limit)) }); });
  collectionRoutes("reminders", reminderJson, new Set(["title", "message", "scheduledAt", "status", "taskId"]), (b) => { const status = b.status || "pending"; if (!REMINDER_STATUSES.has(status)) throw new ApiError(400, "VALIDATION_ERROR", "status inválido."); if (!isValidDateTime(b.scheduledAt)) throw new ApiError(400, "VALIDATION_ERROR", "scheduledAt debe ser ISO 8601 UTC."); return { ownerId, title: requiredString(b.title, "title", 250), message: optionalString(b.message, "message"), scheduledAt: admin.firestore.Timestamp.fromDate(new Date(b.scheduledAt)), status, taskId: optionalString(b.taskId, "taskId", 200), shownAt: null, dismissedAt: null, createdAt: fieldValue.serverTimestamp(), updatedAt: fieldValue.serverTimestamp() }; }, (b) => { const u = {}; if (b.title !== undefined) u.title = requiredString(b.title, "title", 250); if (b.message !== undefined) u.message = optionalString(b.message, "message"); if (b.taskId !== undefined) u.taskId = optionalString(b.taskId, "taskId", 200); if (b.scheduledAt !== undefined) { if (!isValidDateTime(b.scheduledAt)) throw new ApiError(400, "VALIDATION_ERROR", "scheduledAt debe ser ISO 8601 UTC."); u.scheduledAt = admin.firestore.Timestamp.fromDate(new Date(b.scheduledAt)); } if (b.status !== undefined) { if (!REMINDER_STATUSES.has(b.status)) throw new ApiError(400, "VALIDATION_ERROR", "status inválido."); u.status = b.status; } return u; });
  router.post("/reminders/:id/mark-shown", async (req, res) => { const doc = await getOwned("reminders", req.params.id); await doc.ref.update({ status: "shown", shownAt: fieldValue.serverTimestamp(), updatedAt: fieldValue.serverTimestamp() }); res.json({ success: true, data: reminderJson(documentJson(await doc.ref.get())) }); });
  router.post("/reminders/:id/dismiss", async (req, res) => { const doc = await getOwned("reminders", req.params.id); await doc.ref.update({ status: "dismissed", dismissedAt: fieldValue.serverTimestamp(), updatedAt: fieldValue.serverTimestamp() }); res.json({ success: true, data: reminderJson(documentJson(await doc.ref.get())) }); });
  return router;
}

function requireApiKey(expectedKey) {
  return (req, res, next) => {
    const value = req.get("authorization");
    if (!value || !value.startsWith("Bearer ") || value.slice(7) !== expectedKey) return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Credenciales de API inválidas o ausentes." } });
    next();
  };
}
function apiCors(allowedOrigins) {
  return (req, res, next) => { const origin = req.get("origin"); if (origin && allowedOrigins.includes(origin)) { res.set("Access-Control-Allow-Origin", origin); res.set("Vary", "Origin"); res.set("Access-Control-Allow-Headers", "Authorization, Content-Type"); res.set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS"); } if (req.method === "OPTIONS") return res.sendStatus(origin && allowedOrigins.includes(origin) ? 204 : 403); next(); };
}
function errorHandler(error, req, res, next) { const status = error instanceof ApiError ? error.status : 500; if (status === 500) console.error("API error", { method: req.method, path: req.path, message: error.message }); res.status(status).json({ success: false, error: { code: error.code || "INTERNAL_ERROR", message: status === 500 ? "Ocurrió un error interno." : error.message } }); }
module.exports = { ApiError, createApiRouter, requireApiKey, apiCors, errorHandler };
