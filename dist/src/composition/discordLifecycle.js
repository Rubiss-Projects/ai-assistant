/** Own resources from acquisition through failed startup and normal shutdown. */
export class DiscordRuntime {
    dependencies;
    sessions;
    conversations;
    client;
    stopping;
    started = false;
    startup = new AbortController();
    constructor(dependencies) {
        this.dependencies = dependencies;
    }
    async start(token) {
        if (this.started || this.stopping)
            throw new Error('Discord runtime already started or stopping.');
        this.started = true;
        try {
            this.sessions = this.dependencies.createSessions();
            this.conversations = this.dependencies.installConversations(this.sessions);
            this.client = this.dependencies.createClient(this.sessions);
            await this.client.login(token);
            await this.client.waitUntilReady?.(this.startup.signal);
            if (this.stopping)
                throw new Error('Discord startup interrupted by shutdown.');
            this.dependencies.startReviews(this.client);
        }
        catch (error) {
            try {
                await this.stop();
            }
            catch (cleanupError) {
                throw new AggregateError([error, cleanupError], 'Discord startup and cleanup failed.');
            }
            throw error;
        }
    }
    stop() {
        this.startup.abort(new Error('Discord startup interrupted by shutdown.'));
        // Cache before cleanup begins so concurrent signals cannot run cleanup twice.
        return this.stopping ??= Promise.resolve().then(async () => {
            const errors = [];
            const attempt = async (action) => {
                try {
                    await action();
                }
                catch (error) {
                    errors.push(error);
                }
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
            if (errors.length)
                throw new AggregateError(errors, 'Discord cleanup failed.');
        });
    }
}
