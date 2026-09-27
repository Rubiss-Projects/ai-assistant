/** Own resources from acquisition through failed startup and normal shutdown. */
export class DiscordRuntime {
    dependencies;
    sessions;
    conversations;
    client;
    stopping;
    started = false;
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
            await attempt(() => this.client?.stopScheduler());
            await attempt(() => this.dependencies.stopReviews());
            await attempt(() => this.client?.destroy());
            await attempt(() => this.conversations?.shutdown());
            await attempt(() => this.sessions?.shutdown());
            if (errors.length)
                throw new AggregateError(errors, 'Discord cleanup failed.');
        });
    }
}
