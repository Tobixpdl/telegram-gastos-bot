const test = require("node:test");
const assert = require("node:assert/strict");
const { requireApiKey } = require("../src/api");

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("requireApiKey rejects a missing authorization header", () => {
  const res = response();
  let called = false;
  requireApiKey("secret")({ get: () => undefined }, res, () => { called = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error.code, "UNAUTHORIZED");
  assert.equal(called, false);
});

test("requireApiKey accepts the configured bearer token", () => {
  const res = response();
  let called = false;
  requireApiKey("secret")({ get: () => "Bearer secret" }, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.statusCode, null);
});
