import assert from "node:assert/strict";
import http from "node:http";
import dns from "node:dns/promises";
import { fetchBrowserWebpage } from "../src/utils/fetchBrowserWebpage.js";
import { extractWebpage } from "../src/utils/fetchWebpage.js";
// Test-only transport substitution: a public hostname reaches an in-container fixture.
// Production validation still sees and pins a public IP. No public network is needed.
const seen = [];
const fixture = http.createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    response.setHeader("Content-Type", "text/html");
    if (request.url === "/redirect") {
        response.writeHead(302, { Location: "http://private-fixture.test/private" });
        response.end();
        return;
    }
    if (request.url === "/redirect-loopback") {
        response.writeHead(302, { Location: `http://127.0.0.1:${port}/private` });
        response.end();
        return;
    }
    if (request.url === "/script-redirect") {
        response.end('<script>setTimeout(()=>location.href="/not-found",100)</script>');
        return;
    }
    if (request.url === "/not-found") {
        response.writeHead(404);
        response.end("Not found");
        return;
    }
    if (request.url === "/data") {
        response.setHeader("Content-Type", "application/json");
        response.end('{"headline":"New panel details","published":"2026-09-12T22:30:00Z"}');
        return;
    }
    response.end(`<html><head><title>Public research fixture</title></head><body><main id="article">Loading</main><script>
    fetch('/data').then(r=>r.json()).then(data=>document.getElementById('article').textContent=data.headline+' '+data.published);
    fetch('/write',{method:'POST',body:'blocked'}).catch(()=>{});
    fetch('http://127.0.0.1/private').catch(()=>{});
    fetch('http://private-fixture.test/private').catch(()=>{});
    fetch('http://169.254.169.254/latest/meta-data/').catch(()=>{});
    try { new WebSocket('ws://research-fixture.test/socket'); } catch {}
  </script></body></html>`);
});
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
const port = fixture.address().port;
const originalLookup = dns.lookup;
const originalRequest = http.request;
dns.lookup = (async (host, ...args) => {
    if (host === "research-fixture.test")
        return [{ address: "93.184.216.34", family: 4 }];
    if (host === "private-fixture.test")
        return [{ address: "127.0.0.1", family: 4 }];
    return originalLookup(host, ...args);
});
http.request = ((url, options, callback) => {
    assert.equal(url.hostname, "research-fixture.test", "Only the validated fixture may reach the test transport");
    return originalRequest(url, { ...options, port, lookup: (_host, _options, done) => done(null, "127.0.0.1", 4) }, callback);
});
try {
    const resource = await fetchBrowserWebpage("http://research-fixture.test/", { maxBytes: 8 * 1024 * 1024 });
    const page = extractWebpage(resource.data.toString());
    assert.match(page.text, /New panel details 2026-09-12T22:30:00Z/);
    assert.ok(seen.includes("GET /data"));
    assert.ok(seen.every(value => value === "GET /" || value === "GET /data" || value === "GET /favicon.ico"), JSON.stringify(seen));
    await assert.rejects(fetchBrowserWebpage("http://research-fixture.test/redirect", { maxBytes: 1024 * 1024 }), /public internet|HTTP 502|anonymous browser/);
    await assert.rejects(fetchBrowserWebpage("http://research-fixture.test/redirect-loopback", { maxBytes: 1024 * 1024 }), /standard ports|HTTP 502|anonymous browser/);
    await assert.rejects(fetchBrowserWebpage("http://research-fixture.test/script-redirect", { maxBytes: 1024 * 1024 }), /HTTP 404/);
    assert.ok(!seen.some(value => /private|write|meta-data|socket/.test(value)));
    console.log("General browser renders JavaScript and public JSON; POST, WebSocket, private-IP, private-DNS and redirect requests cannot reach the fixture.");
}
finally {
    dns.lookup = originalLookup;
    http.request = originalRequest;
    await new Promise(resolve => fixture.close(() => resolve()));
}
