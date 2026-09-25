import { CodexReviewWorker, serveReviews } from "./common/codexReviewWorker.js";
import { runCodexReview } from "./common/codexReviewRunner.js";

process.umask(0o077);
const worker = new CodexReviewWorker("/data/review-jobs", runCodexReview);
const server = await serveReviews(worker);
console.info("[codex-review] Private review worker listening; one on-demand Codex process, ChatGPT login only.");
async function stop() { server.close(); server.closeAllConnections(); await worker.close(); process.exit(0); }
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
