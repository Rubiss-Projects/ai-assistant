import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import net from "node:net";
import dns from "node:dns/promises";
import { createPublicBrowserProxy, publicBrowserAddress, publicBrowserUrl } from "../src/utils/publicBrowserProxy.js";

test("public browser URLs and DNS reject credentials, alternate ports, private and mixed address answers", async t => {
  for (const url of ["file:///etc/passwd", "http://user:secret@example.com", "http://example.com:8080", "http://127.1", "https://[::1]", "http://169.254.169.254", "http://2130706433"]) assert.throws(() => publicBrowserUrl(url));
  assert.equal(publicBrowserUrl("https://example.com/page").hostname, "example.com");
  for (const addresses of [["127.0.0.1"], ["93.184.216.34", "192.168.1.1"], ["::ffff:127.0.0.1"]]) {
    t.mock.method(dns, "lookup", async () => addresses.map(address => ({ address, family: address.includes(":") ? 6 : 4 })));
    await assert.rejects(publicBrowserAddress("example.com"), /public internet/);
  }
});

test("proxy authentication, read-only HTTP, and HTTPS destination validation apply before connections", async t => {
  t.mock.method(dns, "lookup", async () => [{ address: "127.0.0.1", family: 4 }]);
  const controller = new AbortController();
  const proxy = await createPublicBrowserProxy(controller.signal);
  t.after(() => proxy.close());
  const target = new URL(proxy.server);
  const auth = `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}`;
  const request = (method: string, path: string, authenticated = true) => new Promise<number>((resolve, reject) => {
    const req = http.request({ host: target.hostname, port: target.port, method, path, headers: authenticated ? { "Proxy-Authorization": auth } : {} });
    req.once("response", response => { resolve(response.statusCode!); response.resume(); });
    req.once("connect", (response, socket) => { resolve(response.statusCode!); socket.destroy(); });
    req.once("error", reject);
    req.end();
  });
  assert.equal(await request("GET", "http://example.com", false), 407);
  assert.equal(await request("POST", "http://example.com"), 502);
  assert.equal(await request("CONNECT", "example.com:22"), 502);
  assert.equal(await request("CONNECT", "example.com:443/path"), 502);
  assert.equal(await request("CONNECT", "127.0.0.1:443"), 502);
  assert.equal(await request("CONNECT", "internal.test:443"), 502);
  assert.equal(await request("GET", "http://internal.test"), 502);
});

test("HTTPS sockets use the validated IP and cancellation tears down active tunnels", async t => {
  const fixture = net.createServer(socket => socket.pipe(socket));
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => fixture.close(() => resolve())));
  const port = (fixture.address() as net.AddressInfo).port;
  const originalConnect = net.connect;
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  t.mock.method(net, "connect", (options: net.NetConnectOpts & { host: string; port: number }) => {
    assert.equal(options.host, "93.184.216.34");
    assert.equal(options.port, 443);
    return originalConnect({ host: "127.0.0.1", port });
  });
  const controller = new AbortController();
  const proxy = await createPublicBrowserProxy(controller.signal);
  t.after(() => proxy.close());
  const target = new URL(proxy.server);
  const socket = originalConnect({ host: target.hostname, port: Number(target.port) });
  t.after(() => socket.destroy());
  await new Promise<void>(resolve => socket.once("connect", resolve));
  socket.write(`CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}\r\n\r\n`);
  const reply = await new Promise<Buffer>(resolve => socket.once("data", resolve));
  assert.match(reply.toString(), /200 Connection Established/);
  socket.write("echo");
  assert.equal((await new Promise<Buffer>(resolve => socket.once("data", resolve))).toString(), "echo");
  const closed = new Promise<void>(resolve => socket.once("close", resolve));
  controller.abort();
  await closed;
});
