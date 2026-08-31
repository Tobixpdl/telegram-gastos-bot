const YEAR_MONTH_RE = /^20\d{2}-(0[1-9]|1[0-2])$/;

function isMonthSelectionCommand(normalizedText) {
  return normalizedText === "mes" || normalizedText.startsWith("mes ");
}

function isValidYearMonth(value) {
  return YEAR_MONTH_RE.test(String(value || ""));
}

module.exports = { isMonthSelectionCommand, isValidYearMonth };
