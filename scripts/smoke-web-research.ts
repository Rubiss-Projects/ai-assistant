import assert from "node:assert/strict";
import http from "node:http";
import dns from "node:dns/promises";
import fs from "node:fs";
import { createBrowserWorker, requireBrowserMemoryLimit } from "../src/browserWorker.js";
import { fetchBrowserResource } from "../src/utils/browserClient.js";
import { extractWebpage } from "../src/utils/fetchWebpage.js";

// Test-only transport substitution: a public hostname reaches an in-container fixture.
// Production validation still sees and pins a public IP. No public network is needed.
const seen: string[] = [];
requireBrowserMemoryLimit();
const worker = createBrowserWorker();
await new Promise<void>(resolve => worker.listen(0, "127.0.0.1", resolve));
process.env.AI_ASSISTANT_BROWSER_URL = `http://127.0.0.1:${(worker.address() as { port: number }).port}`;
const read = fetchBrowserResource("general");
const fixture = http.createServer((request, response) => {
  seen.push(`${request.method} ${request.url}`);
  response.setHeader("Content-Type", "text/html");
  if (request.url === "/redirect") { response.writeHead(302, { Location: "http://private-fixture.test/private" }); response.end(); return; }
  if (request.url === "/redirect-loopback") { response.writeHead(302, { Location: `http://127.0.0.1:${port}/private` }); response.end(); return; }
  if (request.url === "/script-redirect") { response.end('<script>setTimeout(()=>location.href="/not-found",100)</script>'); return; }
  if (request.url === "/not-found") { response.writeHead(404); response.end("Not found"); return; }
  if (request.url === "/huge-text") { response.end('<body><script>document.body.append("x".repeat(9*1024*1024))</script></body>'); return; }
  if (request.url === "/huge-dom") { response.end('<body><script>for(let i=0;i<60000;i++)document.body.append(document.createElement("span"))</script></body>'); return; }
  if (request.url === "/tamper") { response.end('<body><p>Real article</p><script>window.TextEncoder=class {encode(){return {byteLength:0}}};Array.prototype.join=()=>"Fabricated text";</script></body>'); return; }
  if (request.url === "/data") { response.setHeader("Content-Type", "application/json"); response.end('{"headline":"New panel details","published":"2026-09-12T22:30:00Z"}'); return; }
  response.end(`<html><head><title>Public research fixture</title></head><body><main id="article">Loading</main><script>
    fetch('/data').then(r=>r.json()).then(data=>document.getElementById('article').textContent=data.headline+' '+data.published);
    fetch('/write',{method:'POST',body:'blocked'}).catch(()=>{});
    fetch('http://127.0.0.1/private').catch(()=>{});
    fetch('http://private-fixture.test/private').catch(()=>{});
    fetch('http://169.254.169.254/latest/meta-data/').catch(()=>{});
    try { new WebSocket('ws://research-fixture.test/socket'); } catch {}
    try { const w=new Worker(URL.createObjectURL(new Blob(['postMessage("WORKER_RAN")'],{type:'text/javascript'})));w.onmessage=e=>document.body.append(e.data); } catch {}
    for(let i=0;i<150;i++){const image=new Image();image.src='/blocked-image/'+i;document.body.append(image);}
    for(let i=0;i<12;i++){const frame=document.createElement('iframe');frame.src='/blocked-frame/'+i;document.body.append(frame);}
  </script></body></html>`);
});
await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
const port = (fixture.address() as { port: number }).port;
const originalLookup = dns.lookup;
const originalRequest = http.request;
dns.lookup = (async (host: string, ...args: any[]) => {
  if (host === "research-fixture.test") return [{ address: "93.184.216.34", family: 4 }];
  if (host === "private-fixture.test") return [{ address: "127.0.0.1", family: 4 }];
  return (originalLookup as any)(host, ...args);
}) as typeof dns.lookup;
http.request = ((url: URL, options: http.RequestOptions, callback: Parameters<typeof http.request>[2]) => {
  assert.equal(url.hostname, "research-fixture.test", "Only the validated fixture may reach the test transport");
  return originalRequest(url, { ...options, port, lookup: (_host, _options, done) => done(null, "127.0.0.1", 4) }, callback);
}) as typeof http.request;
try {
  const [resource, concurrent] = await Promise.all([
    read("http://research-fixture.test/", { maxBytes: 8 * 1024 * 1024 }),
    read("http://research-fixture.test/tamper", { maxBytes: 1024 * 1024 }),
  ]);
  assert.equal(extractWebpage(concurrent.data.toString()).text, "Real article");
  const page = extractWebpage(resource.data.toString());
  assert.match(page.text, /New panel details 2026-09-12T22:30:00Z/);
  assert.doesNotMatch(page.text, /WORKER_RAN/);
  assert.ok(seen.includes("GET /data"));
  assert.ok(seen.every(value => value === "GET /" || value === "GET /data" || value === "GET /tamper" || value === "GET /favicon.ico"), JSON.stringify(seen));
  await assert.rejects(read("http://research-fixture.test/redirect", { maxBytes: 1024 * 1024 }), /public internet|HTTP 502|anonymous browser/);
  await assert.rejects(read("http://research-fixture.test/redirect-loopback", { maxBytes: 1024 * 1024 }), /standard ports|HTTP 502|anonymous browser/);
  await assert.rejects(read("http://research-fixture.test/script-redirect", { maxBytes: 1024 * 1024 }), /HTTP 404/);
  await assert.rejects(read("http://research-fixture.test/huge-text", { maxBytes: 8 * 1024 * 1024 }), /DOM|serialized-content/);
  await assert.rejects(read("http://research-fixture.test/huge-dom", { maxBytes: 8 * 1024 * 1024 }), /DOM|serialized-content/);
  const untampered = await read("http://research-fixture.test/tamper", { maxBytes: 1024 * 1024 });
  assert.equal(extractWebpage(untampered.data.toString()).text, "Real article");
  assert.ok(!seen.some(value => /private|write|meta-data|socket/.test(value)));
  assert.match(fs.readFileSync("/sys/fs/cgroup/pids.events", "utf8"), /^max 0$/m, "Browser reads must not exhaust the container PID/thread budget");
  console.log("Memory-limited worker renders public JavaScript/JSON through its API; private-network, write and blob-worker attempts are blocked. Oversized DOM/text is rejected before transfer, snapshot intrinsics resist page tampering, and final navigation status is checked.");
} finally {
  dns.lookup = originalLookup;
  http.request = originalRequest;
  await new Promise<void>(resolve => worker.close(() => resolve()));
  await new Promise<void>(resolve => fixture.close(() => resolve()));
}
