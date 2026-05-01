const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

if (!TELEGRAM_TOKEN) {
  throw new Error("Falta TELEGRAM_TOKEN en variables de entorno");
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

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
    "Hola, Mica. Ya estoy listo para registrar gastos.",
    "",
    "Ejemplos para sumar:",
    "rappi 10000",
    "pedidos ya 3.450,12",
    "meli taza 230",
    "mercado libre gastos lavarropas 34500,75",
    "",
    "Ejemplos para buscar:",
    "rappi mayo",
    "tazas mayo",
    "resumen mayo",
    "",
    "Configurar cierre:",
    "cierre mayo 26",
    "",
    "Corregir categoría:",
    "cambiar pedidoia yi a pedidos ya",
    "",
    "Borrar último gasto:",
    "borrar ultimo",
  ].join("\n");

  await sendTelegramMessage(token, chatId, text);
}

async function handleAddExpense(token, chatId, messageText, amountInfo) {
  const parsed = await detectPlaceAndSubtype(chatId, amountInfo.textWithoutAmount);

  const now = new Date();
  const parts = getArgentinaDateParts(now);
  const expenseMonth = monthKey(parts.year, parts.month);
  const billingMonth = await calculateBillingMonth(chatId, now);

  const docRef = await db.collection("telegram_expenses").add({
    chatId: String(chatId),

    place: parsed.place,
    placeKey: parsed.placeKey,
    placeRaw: parsed.placeRaw,

    subtype: parsed.subtype,
    subtypeKey: parsed.subtypeKey,

    amountCents: amountInfo.cents,
    amount: amountInfo.amount,

    originalText: messageText,

    expenseDate: admin.firestore.Timestamp.fromDate(now),
    expenseDateIso: `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`,
    expenseMonth,
    billingMonth,

    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

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

  await db
    .collection("telegram_settings")
    .doc(String(chatId))
    .collection("closing_days")
    .doc(monthInfo.yearMonth)
    .set(
      {
        day,
        yearMonth: monthInfo.yearMonth,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

  const snap = await db
    .collection("telegram_expenses")
    .where("chatId", "==", String(chatId))
    .where("expenseMonth", "==", monthInfo.yearMonth)
    .get();

  const batch = db.batch();
  let updatedCount = 0;

  snap.forEach((doc) => {
    const data = doc.data();
    const expenseDate = data.expenseDate?.toDate?.();

    if (!expenseDate) return;

    const parts = getArgentinaDateParts(expenseDate);
    const expenseMonth = monthKey(parts.year, parts.month);
    const newBillingMonth =
      parts.day <= day ? expenseMonth : nextMonthKey(expenseMonth);

    batch.update(doc.ref, {
      billingMonth: newBillingMonth,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    updatedCount++;
  });

  if (updatedCount > 0) {
    await batch.commit();
  }

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

async function processMessage(token, chatId, text) {
  const normalized = normalizeText(text);

  if (!normalized || normalized === "/start" || normalized === "ayuda") {
    await handleStart(token, chatId);
    return;
  }

  if (normalized === "borrar ultimo" || normalized === "borrar último") {
    await handleDeleteLast(token, chatId);
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

app.listen(PORT, () => {
  console.log(`Bot escuchando en puerto ${PORT}`);
});