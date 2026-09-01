export class UserVisibleError extends Error {}

export function userVisibleErrorMessage(error: unknown): string | undefined {
  return error instanceof UserVisibleError ? `❌ ${error.message}` : undefined;
}
