export class UserVisibleError extends Error {
}
export function userVisibleErrorMessage(error) {
    return error instanceof UserVisibleError ? `❌ ${error.message}` : undefined;
}
