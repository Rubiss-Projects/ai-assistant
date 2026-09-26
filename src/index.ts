import { config } from "dotenv";
config();
const adapter = process.env.AI_ASSISTANT_ADAPTER?.trim() || 'discord';
if (adapter === 'discord') await import('./composition/discord.js');
else if (adapter === 'slack') {
  const { startSlack } = await import('./adapters/slack.js');
  const slack = await startSlack();
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await slack.stop(); };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
} else throw new Error('AI_ASSISTANT_ADAPTER must be discord or slack. Use ai-assistant cli for local conversations.');
