interface Sessions { shutdown(): Promise<void> }
interface Conversations { shutdown(): Promise<void> }
interface DiscordClient {
  login(token: string): Promise<unknown>;
  waitUntilReady?(signal: AbortSignal): Promise<void>;
  stopScheduler(): Promise<void>;
  destroy(): void | Promise<void>;
}
interface Dependencies<S extends Sessions, C extends DiscordClient> {
  createSessions(): S;
  installConversations(sessions: S): Conversations;
  createClient(sessions: S): C;
  startReviews(client: C): void;
  stopReviews(): Promise<void>;
}

/** Own resources from acquisition through failed startup and normal shutdown. */
export class DiscordRuntime<S extends Sessions, C extends DiscordClient> {
  private sessions?: S;
  private conversations?: Conversations;
  private client?: C;
  private stopping?: Promise<void>;
  private started = false;
  private readonly startup = new AbortController();

  constructor(private readonly dependencies: Dependencies<S, C>) {}

  async start(token: string): Promise<void> {
    if (this.started || this.stopping) throw new Error('Discord runtime already started or stopping.');
    this.started = true;
    try {
      this.sessions = this.dependencies.createSessions();
      this.conversations = this.dependencies.installConversations(this.sessions);
      this.client = this.dependencies.createClient(this.sessions);
      await this.client.login(token);
      await this.client.waitUntilReady?.(this.startup.signal);
      if (this.stopping) throw new Error('Discord startup interrupted by shutdown.');
      this.dependencies.startReviews(this.client);
    } catch (error) {
      try { await this.stop(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Discord startup and cleanup failed.'); }
      throw error;
    }
  }

  stop(): Promise<void> {
    this.startup.abort(new Error('Discord startup interrupted by shutdown.'));
    // Cache before cleanup begins so concurrent signals cannot run cleanup twice.
    return this.stopping ??= Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      const attempt = async (action: () => unknown) => {
        try { await action(); } catch (error) { errors.push(error); }
      };
      // Conversation shutdown cancels its own turns. Claimed scheduled runs keep
      // their providers and Discord client until the scheduler has drained.
      await Promise.all([
        attempt(() => this.client?.stopScheduler()),
        attempt(() => this.dependencies.stopReviews()),
        attempt(() => this.conversations?.shutdown()),
      ]);
      await Promise.all([
        attempt(() => this.client?.destroy()),
        attempt(() => this.sessions?.shutdown()),
      ]);
      if (errors.length) throw new AggregateError(errors, 'Discord cleanup failed.');
    });
  }
}
