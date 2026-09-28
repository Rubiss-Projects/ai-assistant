import { downloadFileAttachments, prepareDownloadedAttachments } from '../utils/downloadAttachments.js';
import type { SlackApi } from './slack.js';

/** Only URLs from Slack's authenticated file origin may receive the bot token. */
export function slackFileUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com' || url.port
    || url.username || url.password || !url.pathname.startsWith('/files-pri/')) {
    throw new Error('Unsupported Slack file download URL.');
  }
  return url;
}

/** Keep credentials and remote URLs out of provider inputs and diagnostics. */
export async function fetchSlackFile(token: string, value: string, signal: AbortSignal): Promise<Response> {
  let url: URL;
  try { url = slackFileUrl(value); } catch { throw new Error('Unsupported Slack file download URL.'); }
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(url, { headers: { authorization: 'Bearer ' + token }, redirect: 'manual', signal });
    } catch {
      signal.throwIfAborted();
      throw new Error('Slack file download failed. Check connectivity and bot files:read access.');
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    try { url = slackFileUrl(new URL(response.headers.get('location') ?? '', url).href); }
    catch { throw new Error('Slack file download redirect was blocked.'); }
  }
  throw new Error('Slack file download redirected too many times.');
}

/** Event file metadata stays in the adapter closure; the provider receives local files only. */
export async function prepareSlackFiles(raw: unknown, api: SlackApi, signal: AbortSignal) {
  const warnings: string[] = [];
  const files: Array<{ url: string; name: string; contentType: string | null; size?: number }> = [];
  const entries = Array.isArray(raw) ? raw : [];
  if (raw !== undefined && !Array.isArray(raw)) warnings.push('Slack attachment metadata was unavailable.');
  if (entries.length > 5) warnings.push('Only 5 input attachments are accepted per message.');
  const seen = new Set<string>();
  for (const entry of entries.slice(0, 5)) {
    signal.throwIfAborted();
    let file = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const id = typeof file.id === 'string' ? file.id : '';
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    let name = typeof file.name === 'string' ? file.name : 'Slack attachment';
    try {
      if (!file.url_private_download && !file.url_private && /^F[A-Z0-9]+$/.test(id)) {
        const info = await api.call('files.info', { file: id }, signal);
        if (!info.file || typeof info.file !== 'object' || (info.file as Record<string,unknown>).id !== id) throw new Error();
        file = info.file as Record<string, unknown>;
        if (typeof file.name === 'string') name = file.name;
      }
      // Remote integrations need a separate authorization policy.
      if (file.is_external || file.mode === 'external') throw new Error();
      const value = file.url_private_download || file.url_private;
      if (typeof value !== 'string') throw new Error();
      const url = slackFileUrl(value).href;
      files.push({ url, name: safeName(name), contentType: typeof file.mimetype === 'string' ? file.mimetype : null,
        ...(typeof file.size === 'number' && Number.isFinite(file.size) && file.size >= 0 ? { size: file.size } : {}) });
    } catch {
      signal.throwIfAborted();
      warnings.push(safeName(name) + ': file unavailable. Check bot files:read permission and file access; external files are not supported.');
    }
  }
  const downloaded = await downloadFileAttachments(files, signal, {
    mode: 'native',
    fetch: async (url, downloadSignal) => {
      if (!api.downloadFile) throw new Error('Slack file downloads are unavailable. Check bot files:read access.');
      const response = await api.downloadFile(url, downloadSignal);
      // Slack login/error HTML must not be supplied as an image or document.
      const expected = files.find(file => file.url === url)?.contentType;
      if (response.headers.get('content-type')?.startsWith('text/html') && expected !== 'text/html') {
        await response.body?.cancel();
        throw new Error('Slack returned a login/error page. Check bot files:read permission and file access.');
      }
      return response;
    },
  });
  try {
    const prepared = await prepareDownloadedAttachments(downloaded.attachments, 'native');
    return { ...prepared, cleanup: downloaded.cleanup, warnings: [...warnings, ...downloaded.warnings] };
  } catch (error) { await downloaded.cleanup(); throw error; }
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(-180) || 'Slack attachment';
}

