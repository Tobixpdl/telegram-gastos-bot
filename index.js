const express = require("express");
const admin = require("firebase-admin");
const { createApiRouter, requireApiKey, apiCors, errorHandler } = require("./src/api");

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const DESKTOP_API_KEY = process.env.DESKTOP_API_KEY;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

for (const name of ["TELEGRAM_TOKEN", "FIREBASE_SERVICE_ACCOUNT", "DESKTOP_API_KEY", "OWNER_CHAT_ID"]) {
  if (!process.env[name]) throw new Error(`Falta ${name} en variables de entorno`);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch {
  throw new Error("FIREBASE_SERVICE_ACCOUNT debe contener JSON válido");
}

if (serviceAccount.private_key) {
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const ARGENTINA_OFFSET_MS = -3 * 60 * 60 * 1000;

const MONTHS = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

const MONTH_NAMES = [
  "",
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

const PLACE_ALIASES = [
  {
    canonical: "mercado libre",
    aliases: ["mercado libre", "mercadolibre", "meli", "ml"],
  },
  {
    canonical: "pedidos ya",
    aliases: [
      "pedidos ya",
      "pedido ya",
      "pedidoya",
      "pedidoya",
      "pedidosya",
      "pedidoa ya",
      "pedido yaa",
    ],
  },
  {
    canonical: "rappi",
    aliases: ["rappi", "rapi", "rappii"],
  },
  {
    canonical: "carrefour",
    aliases: ["carrefour", "carrefur", "carref"],
  },
  {
    canonical: "coto",
    aliases: ["coto"],
  },
  {
    canonical: "uber",
    aliases: ["uber"],
  },
  {
    canonical: "cabify",
    aliases: ["cabify"],
  },
];

const FILLER_WORDS = new Set([
  "gasto",
  "gastos",
  "gaste",
  "gasté",
  "compre",
  "compré",
  "compra",
  "en",
  "de",
  "del",
  "la",
  "el",
  "los",
  "las",
  "un",
  "una",
  "por",
  "para",
]);

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s.,$-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCase(text) {
  return String(text || "")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function singularizeWord(word) {
  if (!word) return word;

  if (word.endsWith("ces") && word.length > 4) {
    return word.slice(0, -3) + "z";
  }

  if (word.endsWith("es") && word.length > 4) {
    return word.slice(0, -2);
  }

  if (word.endsWith("s") && word.length > 3) {
    return word.slice(0, -1);
  }

  return word;
}

function normalizeSubtype(text) {
  const words = normalizeText(text)
    .split(" ")
    .filter((word) => word && !FILLER_WORDS.has(word))
    .map(singularizeWord);

  return words.join(" ").trim() || "general";
}

function formatMoneyFromCents(cents) {
  const amount = Number(cents || 0) / 100;

  return amount.toLocaleString("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function getArgentinaDateParts(date = new Date()) {
  const local = new Date(date.getTime() + ARGENTINA_OFFSET_MS);

  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
  };
}

function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function nextMonthKey(yearMonth) {
  const [yearRaw, monthRaw] = yearMonth.split("-").map(Number);

  if (monthRaw === 12) {
    return `${yearRaw + 1}-01`;
  }

  return monthKey(yearRaw, monthRaw + 1);
}

function parseMonthYear(text) {
  const normalized = normalizeText(text);
  const now = getArgentinaDateParts();

  let foundMonth = null;

  for (const [monthName, monthNumber] of Object.entries(MONTHS)) {
    const regex = new RegExp(`\\b${monthName}\\b`, "i");
    if (regex.test(normalized)) {
      foundMonth = monthNumber;
      break;
    }
  }

  const yearMatch = normalized.match(/\b(20\d{2})\b/);
  const year = yearMatch ? Number(yearMatch[1]) : now.year;

  if (!foundMonth) {
    return {
      year: now.year,
      month: now.month,
      yearMonth: monthKey(now.year, now.month),
      explicitMonth: false,
    };
  }

  return {
    year,
    month: foundMonth,
    yearMonth: monthKey(year, foundMonth),
    explicitMonth: true,
  };
}

function hasMonthName(text) {
  const normalized = normalizeText(text);

  return Object.keys(MONTHS).some((monthName) => {
    const regex = new RegExp(`\\b${monthName}\\b`, "i");
    return regex.test(normalized);
  });
}

function parseAmountAtEnd(text) {
  const original = String(text || "").trim();

  if (!original) return null;

  // Evita interpretar "rappi mayo 2026" como gasto de $2026.
  if (hasMonthName(original) && /\b20\d{2}\s*$/.test(original)) {
    return null;
  }

  const match = original.match(
    /(?:^|\s)(\$?\s*\d{1,3}(?:[.\s]\d{3})*(?:,\d{1,2})?|\$?\s*\d+(?:[.,]\d{1,2})?)\s*$/
  );

  if (!match) return null;

  const rawAmount = match[1];
  let clean = rawAmount.replace(/\$/g, "").replace(/\s/g, "").trim();

  if (!clean) return null;

  let normalizedNumber;

  if (clean.includes(",")) {
    normalizedNumber = clean.replace(/\./g, "").replace(",", ".");
  } else if (clean.includes(".")) {
    const parts = clean.split(".");
    const lastPart = parts[parts.length - 1];

    if (lastPart.length === 3) {
      normalizedNumber = clean.replace(/\./g, "");
    } else {
      normalizedNumber = clean;
    }
  } else {
    normalizedNumber = clean;
  }

  const number = Number(normalizedNumber);

  if (!Number.isFinite(number)) return null;

  const cents = Math.round(number * 100);
  const textWithoutAmount = original.slice(0, match.index).trim();

  return {
    rawAmount,
    amount: number,
    cents,
    textWithoutAmount,
  };
}

function getBuiltInAliases() {
  const aliases = [];

  for (const item of PLACE_ALIASES) {
    for (const alias of item.aliases) {
      aliases.push({
        alias: normalizeText(alias),
        canonical: item.canonical,
      });
    }
  }

  return aliases.sort((a, b) => b.alias.length - a.alias.length);
}

async function getUserAliases(chatId) {
  const snap = await db
    .collection("telegram_settings")
    .doc(String(chatId))
    .collection("aliases")
    .get();

  const aliases = [];

  snap.forEach((doc) => {
    const data = doc.data();

    if (data.alias && data.canonical) {
      aliases.push({
        alias: normalizeText(data.alias),
        canonical: normalizeText(data.canonical),
      });
    }
  });

  return aliases.sort((a, b) => b.alias.length - a.alias.length);
}

async function detectPlaceAndSubtype(chatId, text) {
  const normalized = normalizeText(text);

  const allAliases = [
    ...(await getUserAliases(chatId)),
    ...getBuiltInAliases(),
  ].sort((a, b) => b.alias.length - a.alias.length);

  for (const item of allAliases) {
    if (
      normalized === item.alias ||
      normalized.startsWith(`${item.alias} `)
    ) {
      const rest = normalized.slice(item.alias.length).trim();
      const subtype = normalizeSubtype(rest);

      return {
        place: item.canonical,
        placeKey: normalizeText(item.canonical),
        placeRaw: item.canonical,
        subtype,
        subtypeKey: normalizeSubtype(subtype),
        wasKnownPlace: true,
      };
    }
  }

  const words = normalized.split(" ").filter(Boolean);
  const firstWord = words[0] || "sin categoria";
  const rest = words.slice(1).join(" ");

  return {
    place: firstWord,
    placeKey: normalizeText(firstWord),
    placeRaw: firstWord,
    subtype: normalizeSubtype(rest),
    subtypeKey: normalizeSubtype(rest),
    wasKnownPlace: false,
  };
}

async function getClosingDay(chatId, yearMonth) {
  const doc = await db
    .collection("telegram_settings")
    .doc(String(chatId))
    .collection("closing_days")
    .doc(yearMonth)
    .get();

  if (!doc.exists) return 31;

  const value = Number(doc.data().day);

  if (!Number.isInteger(value) || value < 1 || value > 31) {
    return 31;
  }

  return value;
}

async function calculateBillingMonth(chatId, date) {
  const parts = getArgentinaDateParts(date);
  const expenseMonth = monthKey(parts.year, parts.month);
  const closingDay = await getClosingDay(chatId, expenseMonth);

  if (parts.day <= closingDay) {
    return expenseMonth;
  }

  return nextMonthKey(expenseMonth);
}

async function createExpense({ chatId, parsed, amountCents, originalText, expenseDate = new Date(), source }) {
  const parts = getArgentinaDateParts(expenseDate);
  const expenseMonth = monthKey(parts.year, parts.month);
  return db.collection("telegram_expenses").add({
    chatId: String(chatId), place: parsed.place, placeKey: parsed.placeKey, placeRaw: parsed.placeRaw,
    subtype: parsed.subtype, subtypeKey: parsed.subtypeKey, amountCents, amount: amountCents / 100,
    originalText, expenseDate: admin.firestore.Timestamp.fromDate(expenseDate),
    expenseDateIso: `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`,
    expenseMonth, billingMonth: await calculateBillingMonth(chatId, expenseDate), source,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function setClosingDayAndRecalculate(chatId, yearMonth, day) {
  await db
    .collection("telegram_settings")
    .doc(String(chatId))
    .collection("closing_days")
    .doc(yearMonth)
    .set({ day, yearMonth, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

  const snap = await db
    .collection("telegram_expenses")
    .where("chatId", "==", String(chatId))
    .where("expenseMonth", "==", yearMonth)
    .get();

  const batch = db.batch();
  let updatedCount = 0;
  snap.forEach((doc) => {
    const expenseDate = doc.data().expenseDate?.toDate?.();
    if (!expenseDate) return;
    const parts = getArgentinaDateParts(expenseDate);
    const expenseMonth = monthKey(parts.year, parts.month);
    batch.update(doc.ref, {
      billingMonth: parts.day <= day ? expenseMonth : nextMonthKey(expenseMonth),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    updatedCount += 1;
  });
  if (updatedCount > 0) await batch.commit();
  return updatedCount;
}

async function sendTelegramMessage(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });
}

async function handleStart(token, chatId) {
  const text = [
    "🤖 BOT DE GASTOS - AYUDA",
    "",
    "1) Cargar gastos:",
    "rappi 10000",
    "pedidos ya 3.450,12",
    "meli taza 230",
    "mercado libre lavarropas 34500,75",
    "",
    "2) Buscar gastos:",
    "rappi mayo",
    "tazas mayo",
    "resumen mayo",
    "",
    "3) Configurar cierre de tarjeta:",
    "cierre mayo 26",
    "",
    "4) Corregir categorías o tipos:",
    "cambiar pedidoia yi a pedidos ya",
    "cambiar prueba a rappi",
    "",
    "5) Ver últimos gastos:",
    "ultimos",
    "últimos",
    "todo",
    "",
    "6) Borrar último gasto:",
    "borrar ultimo",
    "",
    "7) Borrar un gasto específico:",
    "borrar prueba 10",
    "borrar rappi 10000",
    "borrar meli taza 230",
    "",
    "8) Ayuda:",
    "/help",
    "ayuda",
  ].join("\n");

  await sendTelegramMessage(token, chatId, text);
}

async function handleAddExpense(token, chatId, messageText, amountInfo) {
  const parsed = await detectPlaceAndSubtype(chatId, amountInfo.textWithoutAmount);

  const now = new Date();
  const billingMonth = await calculateBillingMonth(chatId, now);

  const docRef = await createExpense({ chatId, parsed, amountCents: amountInfo.cents, originalText: messageText, expenseDate: now, source: "telegram" });

  const samePlaceSnap = await db
    .collection("telegram_expenses")
    .where("chatId", "==", String(chatId))
    .where("billingMonth", "==", billingMonth)
    .get();

  let totalPlace = 0;
  let totalSubtype = 0;

  samePlaceSnap.forEach((doc) => {
    const data = doc.data();

    if (data.placeKey === parsed.placeKey) {
      totalPlace += Number(data.amountCents || 0);
    }

    if (data.subtypeKey === parsed.subtypeKey && parsed.subtypeKey !== "general") {
      totalSubtype += Number(data.amountCents || 0);
    }
  });

  const [yearRaw, monthRaw] = billingMonth.split("-").map(Number);
  const monthLabel = `${MONTH_NAMES[monthRaw]} ${yearRaw}`;

  const lines = [];

  lines.push(`✅ Guardado: ${formatMoneyFromCents(amountInfo.cents)}`);
  lines.push(`Lugar: ${titleCase(parsed.place)}`);

  if (parsed.subtypeKey !== "general") {
    lines.push(`Tipo: ${titleCase(parsed.subtype)}`);
  }

  lines.push(`Resumen asignado a: ${monthLabel}`);
  lines.push("");
  lines.push(`Total en ${titleCase(parsed.place)}: ${formatMoneyFromCents(totalPlace)}`);

  if (parsed.subtypeKey !== "general") {
    lines.push(`Total en ${titleCase(parsed.subtype)}: ${formatMoneyFromCents(totalSubtype)}`);
  }

  if (!parsed.wasKnownPlace) {
    lines.push("");
    lines.push(`No reconocí ese lugar como categoría conocida.`);
    lines.push(`Si está mal, podés corregirlo con:`);
    lines.push(`cambiar ${amountInfo.textWithoutAmount} a pedidos ya`);
  }

  await sendTelegramMessage(token, chatId, lines.join("\n"));

  return docRef.id;
}

function cleanQueryText(text) {
  let normalized = normalizeText(text);

  normalized = normalized
    .replace(/\bresumen\b/g, " ")
    .replace(/\bcuanto\b/g, " ")
    .replace(/\bcuanta\b/g, " ")
    .replace(/\bcuanto gaste\b/g, " ")
    .replace(/\bgaste\b/g, " ")
    .replace(/\bgasté\b/g, " ")
    .replace(/\ben\b/g, " ")
    .replace(/\bde\b/g, " ")
    .replace(/\bdel\b/g, " ");

  for (const monthName of Object.keys(MONTHS)) {
    normalized = normalized.replace(new RegExp(`\\b${monthName}\\b`, "g"), " ");
  }

  normalized = normalized.replace(/\b20\d{2}\b/g, " ");
  normalized = normalized.replace(/\s+/g, " ").trim();

  return normalized;
}

async function detectSearchFilter(chatId, queryText) {
  const cleaned = cleanQueryText(queryText);

  if (!cleaned) {
    return {
      type: "all",
      value: null,
      label: "todos los gastos",
    };
  }

  const parsed = await detectPlaceAndSubtype(chatId, cleaned);

  const builtInAndUserAliases = [
    ...(await getUserAliases(chatId)),
    ...getBuiltInAliases(),
  ];

  const normalizedCleaned = normalizeText(cleaned);

  const isKnownPlace = builtInAndUserAliases.some(
    (item) => normalizeText(item.alias) === normalizedCleaned
  );

  if (isKnownPlace || parsed.wasKnownPlace) {
    return {
      type: "place",
      value: parsed.placeKey,
      label: titleCase(parsed.place),
    };
  }

  return {
    type: "subtype",
    value: normalizeSubtype(cleaned),
    label: titleCase(cleaned),
  };
}

async function handleSearch(token, chatId, messageText) {
  const monthInfo = parseMonthYear(messageText);
  const filter = await detectSearchFilter(chatId, messageText);

  const snap = await db
    .collection("telegram_expenses")
    .where("chatId", "==", String(chatId))
    .where("billingMonth", "==", monthInfo.yearMonth)
    .get();

  const rows = [];

  snap.forEach((doc) => {
    const data = doc.data();

    let matches = false;

    if (filter.type === "all") {
      matches = true;
    }

    if (filter.type === "place" && data.placeKey === filter.value) {
      matches = true;
    }

    if (filter.type === "subtype" && data.subtypeKey === filter.value) {
      matches = true;
    }

    if (matches) {
      rows.push({
        id: doc.id,
        ...data,
      });
    }
  });

  rows.sort((a, b) => {
    const dateA = a.expenseDate?.toMillis?.() || 0;
    const dateB = b.expenseDate?.toMillis?.() || 0;
    return dateA - dateB;
  });

  const monthLabel = `${MONTH_NAMES[monthInfo.month]} ${monthInfo.year}`;
  const closingDay = await getClosingDay(chatId, monthInfo.yearMonth);

  if (rows.length === 0) {
    await sendTelegramMessage(
      token,
      chatId,
      `No encontré gastos de ${filter.label} en ${monthLabel}.`
    );
    return;
  }

  let total = 0;
  const groupByPlace = {};

  const lines = [];
  lines.push(`📌 ${filter.label} — ${monthLabel}`);
  lines.push(`Cierre de tarjeta: día ${closingDay}`);
  lines.push("");

  rows.forEach((row, index) => {
    const amount = Number(row.amountCents || 0);
    total += amount;

    if (!groupByPlace[row.place]) {
      groupByPlace[row.place] = 0;
    }

    groupByPlace[row.place] += amount;

    const subtypePart =
      row.subtypeKey && row.subtypeKey !== "general"
        ? ` / ${titleCase(row.subtype)}`
        : "";

    lines.push(
      `${index + 1}. ${row.expenseDateIso} — ${titleCase(row.place)}${subtypePart}: ${formatMoneyFromCents(amount)}`
    );
  });

  lines.push("");
  lines.push("Por lugar:");

  Object.entries(groupByPlace)
    .sort((a, b) => b[1] - a[1])
    .forEach(([place, amount]) => {
      lines.push(`- ${titleCase(place)}: ${formatMoneyFromCents(amount)}`);
    });

  lines.push("");
  lines.push(`TOTAL: ${formatMoneyFromCents(total)}`);

  await sendTelegramMessage(token, chatId, lines.join("\n"));
}

async function handleClosingDay(token, chatId, messageText) {
  const monthInfo = parseMonthYear(messageText);
  const normalized = normalizeText(messageText);

  const numbers = normalized.match(/\b\d{1,4}\b/g) || [];
  const possibleDays = numbers
    .map(Number)
    .filter((num) => num >= 1 && num <= 31);

  const day = possibleDays[possibleDays.length - 1];

  if (!day) {
    await sendTelegramMessage(
      token,
      chatId,
      "No encontré el día de cierre. Ejemplo: cierre mayo 26"
    );
    return;
  }

  const updatedCount = await setClosingDayAndRecalculate(chatId, monthInfo.yearMonth, day);

  const monthLabel = `${MONTH_NAMES[monthInfo.month]} ${monthInfo.year}`;

  await sendTelegramMessage(
    token,
    chatId,
    [
      `✅ Cierre configurado.`,
      `Mes: ${monthLabel}`,
      `Día de cierre: ${day}`,
      "",
      `Las compras de ${monthLabel} hasta el día ${day} inclusive quedan en ${monthLabel}.`,
      `Las compras desde el día ${day + 1} pasan al resumen del mes siguiente.`,
      "",
      `Gastos recalculados: ${updatedCount}`,
    ].join("\n")
  );
}

function parseRenameMessage(text) {
  const normalized = normalizeText(text);

  const match = normalized.match(
    /^(cambiar|corregir|renombrar)\s+(.+?)\s+a\s+(.+)$/
  );

  if (!match) return null;

  return {
    oldText: match[2].trim(),
    newText: match[3].trim(),
  };
}

function aliasDocId(alias) {
  return normalizeText(alias).replace(/\//g, "_");
}

async function handleRename(token, chatId, messageText) {
  const parsedRename = parseRenameMessage(messageText);

  if (!parsedRename) {
    await sendTelegramMessage(
      token,
      chatId,
      "Para corregir usá este formato: cambiar pedidoia yi a pedidos ya"
    );
    return;
  }

  const oldKey = normalizeText(parsedRename.oldText);
  const oldSubtypeKey = normalizeSubtype(parsedRename.oldText);

  const newParsed = await detectPlaceAndSubtype(chatId, parsedRename.newText);

  const newTextAsPlace = newParsed.wasKnownPlace && newParsed.subtypeKey === "general";

  const snap = await db
    .collection("telegram_expenses")
    .where("chatId", "==", String(chatId))
    .get();

  const batch = db.batch();
  let updatedCount = 0;

  snap.forEach((doc) => {
    const data = doc.data();

    const combinedPlaceSubtype = normalizeText(
      `${data.place || ""} ${data.subtypeKey === "general" ? "" : data.subtype || ""}`
    );

    const matchesPlace =
      data.placeKey === oldKey ||
      normalizeText(data.placeRaw) === oldKey ||
      combinedPlaceSubtype === oldKey;

    const matchesSubtype =
      data.subtypeKey === oldSubtypeKey ||
      normalizeText(data.subtype) === oldKey;

    if (!matchesPlace && !matchesSubtype) {
      return;
    }

    const updateData = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (newTextAsPlace || matchesPlace) {
      updateData.place = newParsed.place;
      updateData.placeKey = newParsed.placeKey;
      updateData.placeRaw = newParsed.placeRaw;

      if (newParsed.subtypeKey !== "general") {
        updateData.subtype = newParsed.subtype;
        updateData.subtypeKey = newParsed.subtypeKey;
      }
    } else {
      updateData.subtype = normalizeSubtype(parsedRename.newText);
      updateData.subtypeKey = normalizeSubtype(parsedRename.newText);
    }

    batch.update(doc.ref, updateData);
    updatedCount++;
  });

  if (updatedCount > 0) {
    await batch.commit();
  }

  if (newTextAsPlace) {
    await db
      .collection("telegram_settings")
      .doc(String(chatId))
      .collection("aliases")
      .doc(aliasDocId(parsedRename.oldText))
      .set(
        {
          alias: parsedRename.oldText,
          canonical: newParsed.place,
          type: "place",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  }

  await sendTelegramMessage(
    token,
    chatId,
    [
      `✅ Corrección hecha.`,
      `Antes: ${parsedRename.oldText}`,
      `Ahora: ${newTextAsPlace ? titleCase(newParsed.place) : titleCase(parsedRename.newText)}`,
      `Gastos actualizados: ${updatedCount}`,
      "",
      newTextAsPlace
        ? `También guardé "${parsedRename.oldText}" como alias de "${newParsed.place}" para futuras cargas.`
        : "",
    ]
      .filter(Boolean)
      .join("\n")
  );
}

async function handleDeleteLast(token, chatId) {
  const snap = await db
    .collection("telegram_expenses")
    .where("chatId", "==", String(chatId))
    .get();

  const rows = [];

  snap.forEach((doc) => {
    const data = doc.data();
    rows.push({
      id: doc.id,
      ref: doc.ref,
      ...data,
    });
  });

  rows.sort((a, b) => {
    const dateA = a.expenseDate?.toMillis?.() || 0;
    const dateB = b.expenseDate?.toMillis?.() || 0;
    return dateB - dateA;
  });

  const last = rows[0];

  if (!last) {
    await sendTelegramMessage(token, chatId, "No hay gastos para borrar.");
    return;
  }

  await last.ref.delete();

  await sendTelegramMessage(
    token,
    chatId,
    [
      "🗑️ Borré el último gasto:",
      `${last.expenseDateIso} — ${titleCase(last.place)}: ${formatMoneyFromCents(last.amountCents)}`,
    ].join("\n")
  );
}

async function handleListExpenses(token, chatId) {
  const snap = await db
    .collection("telegram_expenses")
    .where("chatId", "==", String(chatId))
    .get();

  const rows = [];

  snap.forEach((doc) => {
    rows.push({
      id: doc.id,
      ref: doc.ref,
      ...doc.data(),
    });
  });

  rows.sort((a, b) => {
    const dateA = a.expenseDate?.toMillis?.() || 0;
    const dateB = b.expenseDate?.toMillis?.() || 0;
    return dateB - dateA;
  });

  if (rows.length === 0) {
    await sendTelegramMessage(token, chatId, "No tenés gastos cargados.");
    return;
  }

  const lines = ["📋 Últimos gastos:", ""];

  rows.slice(0, 20).forEach((row, index) => {
    const subtypePart =
      row.subtypeKey && row.subtypeKey !== "general"
        ? ` / ${titleCase(row.subtype)}`
        : "";

    lines.push(
      `${index + 1}. ${row.expenseDateIso} — ${titleCase(row.place)}${subtypePart}: ${formatMoneyFromCents(row.amountCents)}`
    );
  });

  lines.push("");
  lines.push("Para borrar uno:");
  lines.push("borrar rappi 10000");
  lines.push("borrar meli taza 230");

  await sendTelegramMessage(token, chatId, lines.join("\n"));
}

async function handleAllExpenses(token, chatId, messageText) {
  const monthInfo = parseMonthYear(messageText);
  const closingDay = await getClosingDay(chatId, monthInfo.yearMonth);

  const snap = await db
    .collection("telegram_expenses")
    .where("chatId", "==", String(chatId))
    .where("billingMonth", "==", monthInfo.yearMonth)
    .get();

  const rows = [];

  snap.forEach((doc) => {
    rows.push({
      id: doc.id,
      ref: doc.ref,
      ...doc.data(),
    });
  });

  rows.sort((a, b) => {
    const dateA = a.expenseDate?.toMillis?.() || 0;
    const dateB = b.expenseDate?.toMillis?.() || 0;
    return dateB - dateA;
  });

  const monthLabel = `${MONTH_NAMES[monthInfo.month]} ${monthInfo.year}`;

  if (rows.length === 0) {
    await sendTelegramMessage(
      token,
      chatId,
      [
        `📋 Todo — ${monthLabel}`,
        "",
        `Cierre de tarjeta: día ${closingDay}`,
        "",
        "No tenés gastos cargados para este resumen.",
      ].join("\n")
    );
    return;
  }

  let total = 0;
  const groupByPlace = {};

  rows.forEach((row) => {
    const amount = Number(row.amountCents || 0);
    total += amount;

    if (!groupByPlace[row.place]) {
      groupByPlace[row.place] = 0;
    }

    groupByPlace[row.place] += amount;
  });

  const lines = [];

  lines.push(`📋 Todo — ${monthLabel}`);
  lines.push(`Cierre de tarjeta: día ${closingDay}`);
  lines.push(`Total del resumen: ${formatMoneyFromCents(total)}`);
  lines.push("");
  lines.push("Por lugar:");

  Object.entries(groupByPlace)
    .sort((a, b) => b[1] - a[1])
    .forEach(([place, amount]) => {
      lines.push(`- ${titleCase(place)}: ${formatMoneyFromCents(amount)}`);
    });

  lines.push("");
  lines.push("Gastos:");

  rows.slice(0, 50).forEach((row, index) => {
    const subtypePart =
      row.subtypeKey && row.subtypeKey !== "general"
        ? ` / ${titleCase(row.subtype)}`
        : "";

    lines.push(
      `${index + 1}. ${row.expenseDateIso} — ${titleCase(row.place)}${subtypePart}: ${formatMoneyFromCents(row.amountCents)}`
    );
  });

  if (rows.length > 50) {
    lines.push("");
    lines.push(`Mostrando 50 de ${rows.length} gastos.`);
  }

  await sendTelegramMessage(token, chatId, lines.join("\n"));
}

function parseDeleteSpecificMessage(text) {
  const normalized = normalizeText(text);

  if (!normalized.startsWith("borrar ")) {
    return null;
  }

  const withoutCommand = text.replace(/^borrar\s+/i, "").trim();

  if (
    normalizeText(withoutCommand) === "ultimo" ||
    normalizeText(withoutCommand) === "último"
  ) {
    return null;
  }

  const amountInfo = parseAmountAtEnd(withoutCommand);

  if (!amountInfo) {
    return null;
  }

  return {
    originalQuery: withoutCommand,
    queryText: amountInfo.textWithoutAmount,
    amountCents: amountInfo.cents,
  };
}

async function handleDeleteSpecific(token, chatId, messageText) {
  const parsedDelete = parseDeleteSpecificMessage(messageText);

  if (!parsedDelete) {
    await sendTelegramMessage(
      token,
      chatId,
      [
        "No entendí qué querés borrar.",
        "",
        "Usá algo así:",
        "borrar prueba 10",
        "borrar rappi 10000",
        "borrar meli taza 230",
      ].join("\n")
    );
    return;
  }

  const parsed = await detectPlaceAndSubtype(chatId, parsedDelete.queryText);

  const snap = await db
    .collection("telegram_expenses")
    .where("chatId", "==", String(chatId))
    .where("amountCents", "==", parsedDelete.amountCents)
    .get();

  const matches = [];

  snap.forEach((doc) => {
    const data = doc.data();

    const samePlace = data.placeKey === parsed.placeKey;
    const sameSubtype =
      parsed.subtypeKey === "general" ||
      data.subtypeKey === parsed.subtypeKey;

    const originalIncludesQuery = normalizeText(data.originalText || "").includes(
      normalizeText(parsedDelete.queryText)
    );

    if ((samePlace && sameSubtype) || originalIncludesQuery) {
      matches.push({
        id: doc.id,
        ref: doc.ref,
        ...data,
      });
    }
  });

  if (matches.length === 0) {
    await sendTelegramMessage(
      token,
      chatId,
      `No encontré ningún gasto que coincida con: ${parsedDelete.originalQuery}`
    );
    return;
  }

  matches.sort((a, b) => {
    const dateA = a.expenseDate?.toMillis?.() || 0;
    const dateB = b.expenseDate?.toMillis?.() || 0;
    return dateB - dateA;
  });

  const selected = matches[0];

  await selected.ref.delete();

  await sendTelegramMessage(
    token,
    chatId,
    [
      "🗑️ Gasto borrado:",
      `${selected.expenseDateIso} — ${titleCase(selected.place)}${
        selected.subtypeKey !== "general" ? ` / ${titleCase(selected.subtype)}` : ""
      }: ${formatMoneyFromCents(selected.amountCents)}`,
      "",
      matches.length > 1
        ? `Había ${matches.length} coincidencias. Borré la más reciente.`
        : "",
    ]
      .filter(Boolean)
      .join("\n")
  );
}

async function processMessage(token, chatId, text) {
  const normalized = normalizeText(text);

  if (
    !normalized ||
    normalized === "/start" ||
    normalized === "/help" ||
    normalized === "help" ||
    normalized === "ayuda"
  ) {
    await handleStart(token, chatId);
    return;
  }

if (
  normalized === "ultimos" ||
  normalized === "últimos" ||
  normalized === "listar" ||
  normalized === "ver gastos"
) {
  await handleListExpenses(token, chatId);
  return;
}

if (normalized === "todo" || normalized.startsWith("todo ")) {
  await handleAllExpenses(token, chatId, text);
  return;
}

  if (normalized === "borrar ultimo" || normalized === "borrar último") {
    await handleDeleteLast(token, chatId);
    return;
  }

  if (normalized.startsWith("borrar ")) {
    await handleDeleteSpecific(token, chatId, text);
    return;
  }

  if (normalized.startsWith("cierre ")) {
    await handleClosingDay(token, chatId, text);
    return;
  }

  if (
    normalized.startsWith("cambiar ") ||
    normalized.startsWith("corregir ") ||
    normalized.startsWith("renombrar ")
  ) {
    await handleRename(token, chatId, text);
    return;
  }

  const amountInfo = parseAmountAtEnd(text);

  if (amountInfo) {
    await handleAddExpense(token, chatId, text, amountInfo);
    return;
  }

  await handleSearch(token, chatId, text);
}

app.get("/", (req, res) => {
  res.send("Telegram expense bot is running.");
});

app.get("/health", (req, res) => {
  res.json({ success: true, data: { status: "ok", service: "telegram-gastos-bot" } });
});

app.use(
  "/api",
  apiCors(ALLOWED_ORIGINS),
  requireApiKey(DESKTOP_API_KEY),
  createApiRouter({
    db,
    admin,
    ownerId: String(OWNER_CHAT_ID),
    detectPlaceAndSubtype,
    getArgentinaDateParts,
    monthKey,
    nextMonthKey,
    calculateBillingMonth,
    getClosingDay,
    setClosingDayAndRecalculate,
    createExpense,
  })
);

app.post("/telegram", async (req, res) => {
  try {
    const update = req.body;

    const message = update.message || update.edited_message;

    if (!message || !message.chat || !message.text) {
      res.sendStatus(200);
      return;
    }

    const chatId = message.chat.id;
    const text = message.text;

    await processMessage(TELEGRAM_TOKEN, chatId, text);

    res.sendStatus(200);
  } catch (error) {
    console.error("telegram webhook error:", error);
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;

app.use(errorHandler);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Bot escuchando en puerto ${PORT}`);
  });
}

module.exports = app;
