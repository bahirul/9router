// Regression: an unmatched 4xx (a request-scoped failure) used to hit the
// transient-cooldown default, which locked the account for 30s and — with a
// single connection — answered every other request in that window with a copy of
// the first error. A 400 "maximum context length" from one session therefore
// looked like the same failure in unrelated sessions.
import { describe, expect, it } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("checkFallbackError — request-scoped vs account-scoped failures", () => {
  it("does not cool the account down for a 400 caused by the request", () => {
    const result = checkFallbackError(400, JSON.stringify({
      error: {
        message: "This model's maximum context length is 1048576 tokens. However, you requested 1186139 tokens",
        type: "invalid_request_error",
      },
    }));

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
  });

  it("still falls back for account-scoped statuses", () => {
    for (const status of [401, 402, 403, 404, 429]) {
      expect(checkFallbackError(status, "nope").shouldFallback).toBe(true);
    }
  });

  it("still honours rate-limit / quota wording on any 4xx", () => {
    expect(checkFallbackError(400, "rate limit reached").shouldFallback).toBe(true);
    expect(checkFallbackError(422, "quota exceeded").shouldFallback).toBe(true);
  });

  it("keeps the transient cooldown for unmatched server errors", () => {
    const result = checkFallbackError(503, "upstream exploded");

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThan(0);
  });

  it("gives a transient muse model_not_found a short lock, not the 2-minute 404 lock", () => {
    const body = JSON.stringify({
      error: {
        code: "model_not_found",
        message: "The requested model was not found.",
        type: "invalid_request_error",
      },
    });

    // Still fails over to the next account within the request, but the model
    // lock expires in seconds so one upstream flake cannot black out the model.
    expect(checkFallbackError(404, body, 0, "muse")).toEqual({ shouldFallback: true, cooldownMs: 5000 });
    // Scoped to muse: other providers keep the blanket-404 cooldown.
    expect(checkFallbackError(404, body, 0, "openai").cooldownMs).toBe(120000);
    // And a muse 404 without that wording keeps the blanket rule.
    expect(checkFallbackError(404, "nope", 0, "muse").cooldownMs).toBe(120000);
  });
});
