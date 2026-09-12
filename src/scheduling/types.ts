import type { ProviderName } from "../providers/types.js";
import type { LookupRecord } from "../utils/fetchWebpage.js";
export interface ScheduledTask {
  id: string;
  guildId: string;
  ownerId: string;
  channelId: string;
  kind: "message" | "ai";
  content: string;
  cron: string;
  timezone: string;
  /** Inclusive start, stored as an absolute Unix timestamp in milliseconds. */
  startAt?: number;
  /** Exclusive cutoff, stored as an absolute Unix timestamp in milliseconds. */
  endAt?: number;
  provider?: ProviderName;
  model?: string;
  reasoning?: string;
  contextMessages: number;
  enabled: boolean;
  nextRunAt: number;
  revision: number;
  createdAt: number;
  lastStartedAt?: number;
  pauseReason?: string;
  /** Source-backed, model-reported values; always stale context on later runs. */
  lastVerifiedLookups?: LookupRecord[];
}
export type RunState = "queued" | "running" | "ready" | "sending" | "succeeded" | "failed" | "delivery_failed" | "uncertain" | "cancelled";
export interface DeliveryPart { content: string; attachment?: { name: string; base64: string } }
export interface TaskRun {
  id: string; taskId: string; channelId: string; taskRevision: number; occurrence: string; startedAt: number;
  state: RunState; parts: DeliveryPart[]; messageIds: string[]; error?: string;
  lookups?: LookupRecord[];
  /** Generation restarts for this occurrence; bounds crash loops without disabling the schedule. */
  recoveryAttempts?: number;
}
