import assert from "node:assert/strict";
import test from "node:test";
import { BrowserTrace, browserEvidence, diagnosticUrl, isChallengePage } from "../src/utils/browserDiagnostics.js";

test("diagnostics redact URL secrets and remain bounded", () => {
  const trace = new BrowserTrace();
  for (let i = 0; i < 100; i++) {
    trace.request(String(i), `https://user:password@example.com/${i}?token=secret#private`);
    trace.response(String(i), `https://example.com/${i}?token=secret`, 302, "/next?token=secret#private");
  }
  assert.equal(trace.diagnostics.navigations.length, 12);
  assert.doesNotMatch(JSON.stringify(trace.diagnostics), /password|token|secret|private/);
  assert.equal(diagnosticUrl("data:text/html,secret"), "(non-HTTP URL)");
  assert.equal(diagnosticUrl("invalid"), "(invalid URL)");
});

test("bounded error evidence ignores hidden content and non-document titles", () => {
  const evidence = browserEvidence('<svg><title>Access denied</title></svg><template><title>Robot check</title></template><head><title>Listing</title></head><body><p>Real item</p><div hidden>secret</div><script>secret</script>' + "x".repeat(5000));
  assert.equal(evidence.title, "Listing");
  assert.match(evidence.excerpt ?? "", /^Real item/);
  assert.ok((evidence.excerpt?.length ?? 0) <= 2000);
  assert.doesNotMatch(evidence.excerpt ?? "", /secret/);
  assert.equal(isChallengePage(evidence.title ?? "", evidence.excerpt ?? ""), false);
});
