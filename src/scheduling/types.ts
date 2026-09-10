import type { ProviderName } from "../providers/types.js";
export interface ScheduledTask {
  id: string;
  guildId: string;
  ownerId: string;
  channelId: string;
  kind: "message" | "ai";
  content: string;
  cron: string;
  timezone: string;
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
}
export type RunState = "running" | "ready" | "sending" | "succeeded" | "failed" | "delivery_failed" | "uncertain" | "cancelled";
export interface DeliveryPart { content: string; attachment?: { name: string; base64: string } }
export interface TaskRun {
  id: string; taskId: string; channelId: string; taskRevision: number; occurrence: string; startedAt: number;
  state: RunState; parts: DeliveryPart[]; messageIds: string[]; error?: string;
}
