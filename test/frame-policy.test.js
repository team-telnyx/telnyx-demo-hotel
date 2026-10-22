import { test } from "node:test";
import assert from "node:assert/strict";
import { framePolicy } from "../frame-policy.js";
test("framing remains denied unless exact HTTPS parents are configured", () => {
  assert.equal(framePolicy()["X-Frame-Options"], "DENY");
});
test("only configured origins enter frame ancestors without weakening the default", () => {
  assert.deepEqual(framePolicy("https://suite.example"), { "Content-Security-Policy": "frame-ancestors 'self' https://suite.example" });
  for (const origin of ["*", "http://suite.example", "https://user:secret@suite.example", "https://suite.example/path", "https://suite.example?token=secret", "https://suite.example#*"]) assert.throws(() => framePolicy(origin));
});
