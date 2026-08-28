const test = require("node:test");
const assert = require("node:assert/strict");
const { csvCell, expenseDescription, expensesToCsv } = require("../src/expense-export");

test("csvCell escapes commas, quotes and newlines", () => {
  assert.equal(csvCell('café, "centro"'), '"café, ""centro"""');
});

test("expenseDescription removes the trailing amount from Telegram text", () => {
  assert.equal(expenseDescription({ originalText: "supermercado café 3.450,50" }), "supermercado café");
});

test("expensesToCsv exports stable import columns and exact cents", () => {
  const csv = expensesToCsv([{ id: "abc", expenseDateIso: "2026-08-10", originalText: "almuerzo 12500", amountCents: 1250000, source: "telegram" }]);
  assert.match(csv, /^\uFEFFid,date,description,amount,amount_cents,currency,category,source/);
  assert.match(csv, /abc,2026-08-10,almuerzo,12500\.00,1250000,ARS,,telegram/);
});
