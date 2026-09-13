import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { isPublicAddress, PublicFetchError } from "./fetchArtifact.js";
export function publicBrowserUrl(raw) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        throw new PublicFetchError("policy_blocked", "Use a public HTTP(S) URL.");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) {
        throw new PublicFetchError("policy_blocked", "Use public HTTP(S) URLs on standard ports, without credentials.");
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && !isPublicAddress(host))
        throw new PublicFetchError("policy_blocked", "Private network addresses are unavailable.");
    return url;
}
/** Resolve once for the actual socket: Chromium never resolves destination hosts itself. */
export async function publicBrowserAddress(host) {
    const addresses = await dns.lookup(host.replace(/^\[|\]$/g, ""), { all: true, verbatim: true });
    if (!addresses.length || addresses.some(value => !isPublicAddress(value.address))) {
        throw new PublicFetchError("policy_blocked", "URLs must resolve only to public internet addresses.");
    }
    return addresses.find(value => value.family === 4) ?? addresses[0];
}
/** Per-read authenticated proxy. Every connection, including redirects and CDN requests, is DNS-pinned. */
export async function createPublicBrowserProxy(signal, maxBytes = 64 * 1024 * 1024) {
    signal.throwIfAborted();
    const username = "reader", password = randomBytes(24).toString("hex");
    const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    const sockets = new Set();
    let closed = false, connections = 0, bytes = 0;
    let lastError;
    const server = http.createServer();
    const stop = () => { closed = true; for (const socket of sockets)
        socket.destroy(); server.close(); };
    const track = (socket) => {
        sockets.add(socket);
        socket.on("error", () => { });
        socket.once("close", () => sockets.delete(socket));
        socket.on("data", (data) => {
            bytes += data.length;
            if (bytes > maxBytes) {
                lastError = new PublicFetchError("too_large", "Browser transfer budget exceeded.");
                stop();
            }
        });
    };
    const allowed = (request) => {
        if (closed || request.headers["proxy-authorization"] !== authorization)
            return false;
        if (++connections > 128) {
            lastError = new PublicFetchError("too_large", "Browser connection budget exceeded.");
            stop();
            return false;
        }
        return true;
    };
    const failed = (error) => {
        lastError = error instanceof PublicFetchError ? error : new PublicFetchError("network_error", "Could not connect to the public source.");
    };
    server.on("connection", socket => { if (closed)
        socket.destroy();
    else
        track(socket); });
    server.on("connect", (request, client, head) => {
        void (async () => {
            if (!allowed(request)) {
                client.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=reader\r\nConnection: close\r\n\r\n");
                return;
            }
            // CONNECT accepts an authority only, never a path, userinfo, or alternate port.
            if (!/^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):443$/.test(request.url ?? ""))
                throw new PublicFetchError("policy_blocked", "Only HTTPS tunnels on port 443 are available.");
            const url = publicBrowserUrl(`https://${request.url}`);
            const address = await publicBrowserAddress(url.hostname);
            if (closed || client.destroyed)
                return;
            const upstream = net.connect({ host: address.address, family: address.family, port: 443 });
            track(upstream);
            upstream.setTimeout(15_000, () => upstream.destroy());
            client.once("close", () => upstream.destroy());
            upstream.once("close", () => client.destroy());
            upstream.once("connect", () => {
                if (closed || client.destroyed) {
                    upstream.destroy();
                    return;
                }
                client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                if (head.length)
                    upstream.write(head);
                client.pipe(upstream).pipe(client);
            });
        })().catch(error => { failed(error); client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); });
    });
    server.on("request", (request, response) => {
        void (async () => {
            if (!allowed(request)) {
                response.writeHead(407, { "Proxy-Authenticate": "Basic realm=reader" });
                response.end();
                return;
            }
            if (!["GET", "HEAD"].includes(request.method ?? ""))
                throw new PublicFetchError("policy_blocked", "Only page reads are available.");
            const url = publicBrowserUrl(request.url ?? "");
            if (url.protocol !== "http:")
                throw new PublicFetchError("policy_blocked", "HTTPS requires a tunnel.");
            const address = await publicBrowserAddress(url.hostname);
            if (closed || response.destroyed)
                return;
            const headers = { ...request.headers, host: url.host };
            for (const key of ["proxy-authorization", "proxy-connection", "connection", "upgrade", "content-length", "transfer-encoding"])
                delete headers[key];
            const upstream = http.request(url, {
                method: request.method, headers, agent: false, family: address.family,
                lookup: (_host, _options, callback) => callback(null, address.address, address.family),
            }, incoming => {
                response.writeHead(incoming.statusCode ?? 502, incoming.headers);
                incoming.on("error", () => response.destroy());
                incoming.pipe(response);
            });
            upstream.on("socket", track);
            upstream.on("error", () => { if (!response.headersSent)
                response.writeHead(502); response.end(); });
            upstream.setTimeout(15_000, () => upstream.destroy());
            response.once("close", () => upstream.destroy());
            upstream.end();
        })().catch(error => { failed(error); if (!response.headersSent)
            response.writeHead(502); response.end(); });
    });
    server.on("upgrade", (_request, socket) => socket.destroy());
    signal.addEventListener("abort", stop, { once: true });
    try {
        await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
        signal.throwIfAborted();
        const port = server.address().port;
        return {
            server: `http://127.0.0.1:${port}`, username, password,
            get error() { return lastError; },
            close: async () => { signal.removeEventListener("abort", stop); stop(); },
        };
    }
    catch (error) {
        signal.removeEventListener("abort", stop);
        stop();
        throw error;
    }
}
