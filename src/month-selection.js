const YEAR_MONTH_RE = /^20\d{2}-(0[1-9]|1[0-2])$/;

function isMonthSelectionCommand(normalizedText) {
  return normalizedText === "mes" || normalizedText.startsWith("mes ");
}

function isValidYearMonth(value) {
  return YEAR_MONTH_RE.test(String(value || ""));
}

function useActiveMonthWhenImplicit(monthInfo, activeYearMonth) {
  if (monthInfo.explicitMonth || !isValidYearMonth(activeYearMonth)) return monthInfo;

  const [year, month] = activeYearMonth.split("-").map(Number);
  return { ...monthInfo, year, month, yearMonth: activeYearMonth };
}

module.exports = { isMonthSelectionCommand, isValidYearMonth, useActiveMonthWhenImplicit };
