import assert from "node:assert/strict";
import { test } from "node:test";
import { bslFlowAvailabilityAfterCheck } from "../lib/tools.js";

test("BSL Flow initialization stops when upstream cannot be checked and preserves installed Core", () => {
  assert.equal(bslFlowAvailabilityAfterCheck(true, "upstream unavailable"), "upstream-failed-installed");
  assert.equal(bslFlowAvailabilityAfterCheck(false, "upstream unavailable"), "upstream-failed-missing");
  assert.equal(bslFlowAvailabilityAfterCheck(true, ""), "available");
});
