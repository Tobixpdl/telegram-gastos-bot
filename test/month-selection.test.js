const test = require("node:test");
const assert = require("node:assert/strict");
const { isMonthSelectionCommand, isValidYearMonth } = require("../src/month-selection");

test("month selection only matches the dedicated mes command", () => {
  assert.equal(isMonthSelectionCommand("mes septiembre"), true);
  assert.equal(isMonthSelectionCommand("mes actual"), true);
  assert.equal(isMonthSelectionCommand("mes"), true);
  assert.equal(isMonthSelectionCommand("meses"), false);
  assert.equal(isMonthSelectionCommand("gastos mes agosto"), false);
  assert.equal(isMonthSelectionCommand("gastos agosto"), false);
});

test("active months use a valid YYYY-MM key", () => {
  assert.equal(isValidYearMonth("2026-09"), true);
  assert.equal(isValidYearMonth("2026-13"), false);
  assert.equal(isValidYearMonth("septiembre"), false);
});
