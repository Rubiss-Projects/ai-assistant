export function progressMessage(elapsedMs: number): string {
  const minutes = Math.max(1, Math.floor(elapsedMs / 60_000));
  return `⏳ Still working… (${minutes} minute${minutes === 1 ? "" : "s"} elapsed)`;
}
