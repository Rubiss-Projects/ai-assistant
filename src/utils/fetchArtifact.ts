import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import ipaddr from "ipaddr.js";

export function inputByteLimit(): number {
  const value = Number(process.env.AI_INPUT_ATTACHMENT_MAX_BYTES ?? 100 * 1024 * 1024);
  if (!Number.isSafeInteger(value) || value < 1 || value > 512 * 1024 * 1024) {
    throw new Error("AI_INPUT_ATTACHMENT_MAX_BYTES must be between 1 and 536870912.");
  }
  return value;
}

export function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === "unicast";
  } catch { return false; }
}

export function artifactFilename(value: string): string {
  return path.basename(value.replace(/\\/g, "/")).replace(/[^a-zA-Z0-9._ -]/g, "_").replace(/^\.+/, "_").slice(0, 120) || "download.bin";
}

export interface FetchedArtifact {
  data: Buffer;
  filename: string;
  contentType: string;
}

/** DNS is validated AND pinned to the connection, including every redirect. */
export async function fetchPublicArtifact(rawUrl: string, signal?: AbortSignal): Promise<FetchedArtifact> {
  const deadline = AbortSignal.timeout(30_000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const maxBytes = inputByteLimit();
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= 5; hop++) {
    combined.throwIfAborted();
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Only public HTTP(S) file URLs without embedded credentials are supported.");
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    // Race DNS against the same deadline; the eventual DNS answer has no side effects.
    const addresses = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
      const abort = () => reject(new Error("Download cancelled or timed out."));
      combined.addEventListener("abort", abort, { once: true });
      dns.lookup(hostname, { all: true, verbatim: true }).then(resolve, reject)
        .finally(() => combined.removeEventListener("abort", abort));
      if (combined.aborted) abort();
    });
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new Error("Artifact URLs must resolve only to public internet addresses.");
    }
    const address = addresses.find((candidate) => candidate.family === 4) ?? addresses[0];
    const result = await new Promise<{ redirect?: string; file?: FetchedArtifact }>((resolve, reject) => {
      const request = (url.protocol === "https:" ? https : http).get(url, {
        signal: combined,
        agent: false,
        // A fixed family disables Node's multi-address lookup contract. The
        // callback below deliberately exposes only the validated, pinned address.
        family: address.family,
        headers: { "User-Agent": "ai-assistant-artifacts/1", "Accept-Encoding": "identity" },
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      }, (response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const redirect = response.headers.location;
          response.destroy();
          if (!redirect) reject(new Error("Redirect has no destination."));
          else resolve({ redirect });
          return;
        }
        if (status !== 200) {
          response.destroy();
          reject(new Error(status === 401 || status === 403
            ? "The file URL is expired or requires authentication. Provide a fresh public URL or its Discord message link."
            : `File download failed (HTTP ${status}).`));
          return;
        }
        if (Number(response.headers["content-length"] ?? 0) > maxBytes) {
          response.destroy(); reject(new Error(`Input exceeds the ${maxBytes}-byte limit.`)); return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            response.destroy(new Error(`Input exceeds the ${maxBytes}-byte limit.`));
          } else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const data = Buffer.concat(chunks);
          const contentType = (response.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
          if (contentType === "text/html" || /^\s*(?:<!doctype html|<html[\s>])/i.test(data.subarray(0, 512).toString())) {
            reject(new Error("This URL returned a webpage, not a file. Use a direct media/download URL.")); return;
          }
          const disposition = response.headers["content-disposition"];
          const name = disposition?.match(/filename="([^"]+)"/i)?.[1] ?? path.basename(url.pathname);
          resolve({ file: { data, filename: artifactFilename(name), contentType } });
        });
      });
      request.on("error", reject);
    });
    if (result.file) return result.file;
    url = new URL(result.redirect!, url);
  }
  throw new Error("Too many download redirects (maximum 5).");
}
