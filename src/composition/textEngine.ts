import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { TurnOutput } from '../core/conversation.js';
import type { SendMessageOptions } from '../providers/types.js';
export interface TextEngine {
  sendMessage(key: string, prompt: string, attachments?: never, options?: SendMessageOptions): Promise<TurnOutput>;
  resetSession(key: string): Promise<void>;
  shutdown(): Promise<void>;
}
export async function createTextEngine(name: string, directory: string): Promise<TextEngine> {
  if (name !== 'fake') {
    const { defaultProviderWorkingDirectory, workspacePathIsAllowed, configuredSecurityMode } = await import('../common/providerSecurity.js');
    if (configuredSecurityMode() === 'shared' && workspacePathIsAllowed(defaultProviderWorkingDirectory(), directory)) throw new Error('Adapter state must be outside provider-readable workspace paths.');
    const { SessionManager } = await import('../sessionManager.js');
    return new SessionManager(name);
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = (key: string) => join(directory, createHash('sha256').update(key).digest('hex') + '.json');
  return {
    async sendMessage(key, prompt) {
      let count = 0;
      try { count = JSON.parse(readFileSync(file(key), 'utf8')).count; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      const output = { content: `Fake response (turn ${count + 1}): ${prompt}`, attachments: [] };
      writeFileSync(file(key) + '.tmp', JSON.stringify({ count: count + 1 }), { mode: 0o600 });
      renameSync(file(key) + '.tmp', file(key));
      return output;
    },
    async resetSession(key) { try { unlinkSync(file(key)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } },
    async shutdown() {},
  };
}
