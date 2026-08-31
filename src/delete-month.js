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

function normalizeCommand(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDeleteMonthCommand(text, currentYear = new Date().getFullYear()) {
  const normalized = normalizeCommand(text);
  if (!/^borrar (?:todo|todos)(?:\s|$)/.test(normalized)) return null;

  const monthEntry = Object.entries(MONTHS).find(([name]) =>
    new RegExp(`\\b${name}\\b`).test(normalized)
  );
  if (!monthEntry) return { valid: false };

  const yearMatch = normalized.match(/\b(20\d{2})\b/);
  const year = yearMatch ? Number(yearMatch[1]) : currentYear;
  const month = monthEntry[1];

  return {
    valid: true,
    year,
    month,
    yearMonth: `${year}-${String(month).padStart(2, "0")}`,
    includeInstallments: /\b(?:incluyendo|con) cuotas\b/.test(normalized),
  };
}

function partitionMonthlyExpenses(rows, includeInstallments) {
  const deletable = [];
  const preservedInstallments = [];

  for (const row of rows) {
    if (row.installmentPlanId && !includeInstallments) {
      preservedInstallments.push(row);
    } else {
      deletable.push(row);
    }
  }

  return { deletable, preservedInstallments };
}

module.exports = { parseDeleteMonthCommand, partitionMonthlyExpenses };
