function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function expenseDescription(expense) {
  const original = String(expense.originalText || "").trim();
  if (original) {
    return original.replace(/\s+\$?\s*\d[\d.\s]*(?:,\d{1,2})?\s*$/, "").trim() || original;
  }
  return [expense.place, expense.subtypeKey !== "general" ? expense.subtype : null]
    .filter(Boolean)
    .join(" - ");
}

function expensesToCsv(expenses) {
  const columns = ["id", "date", "description", "amount", "amount_cents", "currency", "category", "source"];
  const lines = [columns.join(",")];

  for (const expense of expenses) {
    const amountCents = Number(expense.amountCents || 0);
    lines.push([
      expense.id,
      expense.expenseDateIso,
      expenseDescription(expense),
      (amountCents / 100).toFixed(2),
      amountCents,
      "ARS",
      expense.categoryName || "",
      expense.source || "telegram",
    ].map(csvCell).join(","));
  }

  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

module.exports = { csvCell, expenseDescription, expensesToCsv };
