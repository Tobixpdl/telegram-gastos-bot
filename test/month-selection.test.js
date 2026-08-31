const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isMonthSelectionCommand,
  isValidYearMonth,
  useActiveMonthWhenImplicit,
} = require("../src/month-selection");

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

test("an implicit query uses the active month", () => {
  const calendarMonth = { year: 2026, month: 8, yearMonth: "2026-08", explicitMonth: false };
  assert.deepEqual(useActiveMonthWhenImplicit(calendarMonth, "2026-09"), {
    year: 2026,
    month: 9,
    yearMonth: "2026-09",
    explicitMonth: false,
  });
});

test("an explicit query keeps its requested month", () => {
  const requestedMonth = { year: 2026, month: 8, yearMonth: "2026-08", explicitMonth: true };
  assert.deepEqual(useActiveMonthWhenImplicit(requestedMonth, "2026-09"), requestedMonth);
});
