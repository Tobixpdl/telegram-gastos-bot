const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseDeleteMonthCommand,
  partitionMonthlyExpenses,
} = require("../src/delete-month");

test("parses a month reset and defaults to the current year", () => {
  assert.deepEqual(parseDeleteMonthCommand("borrar todo septiembre", 2026), {
    valid: true,
    year: 2026,
    month: 9,
    yearMonth: "2026-09",
    includeInstallments: false,
  });
});

test("accepts an explicit year and an explicit request to include installments", () => {
  assert.deepEqual(parseDeleteMonthCommand("borrar todos septiembre 2025 incluyendo cuotas", 2026), {
    valid: true,
    year: 2025,
    month: 9,
    yearMonth: "2025-09",
    includeInstallments: true,
  });
});

test("requires a month for a bulk deletion", () => {
  assert.deepEqual(parseDeleteMonthCommand("borrar todo", 2026), { valid: false });
  assert.equal(parseDeleteMonthCommand("borrar rappi 10000", 2026), null);
});

test("preserves installments unless they were explicitly included", () => {
  const rows = [
    { id: "ordinary" },
    { id: "installment", installmentPlanId: "plan-1" },
  ];

  assert.deepEqual(partitionMonthlyExpenses(rows, false), {
    deletable: [{ id: "ordinary" }],
    preservedInstallments: [{ id: "installment", installmentPlanId: "plan-1" }],
  });
  assert.deepEqual(partitionMonthlyExpenses(rows, true), {
    deletable: rows,
    preservedInstallments: [],
  });
});
