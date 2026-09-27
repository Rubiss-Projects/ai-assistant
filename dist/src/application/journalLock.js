import Database from 'better-sqlite3';
import { openSync, closeSync, writeFileSync, readFileSync, fsyncSync, linkSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const protocol = 'sqlite-v1';
/** SQLite holds the OS lock; the marker also excludes older, sentinel-only workers. */
export class JournalLock {
    database;
    marker;
    ownsMarker = false;
    constructor(directory) {
        this.marker = join(directory, 'owner.lock');
        const databasePath = join(directory, 'owner.sqlite');
        this.database = new Database(databasePath, { timeout: 0 });
        try {
            chmodSync(databasePath, 0o600);
            // Keep this transaction open for the owner's entire lifetime. The kernel
            // releases it on exit, SIGKILL, or host crash, including across PID namespaces.
            this.database.exec('BEGIN EXCLUSIVE');
            this.recoverMarker();
            const temporary = this.marker + '.' + randomUUID() + '.tmp';
            const fd = openSync(temporary, 'wx', 0o600);
            try {
                try {
                    writeFileSync(fd, JSON.stringify({ lockProtocol: protocol, pid: process.pid, started: new Date().toISOString() }));
                    fsyncSync(fd);
                }
                finally {
                    closeSync(fd);
                }
                // Publish a complete marker without replacing a racing legacy owner's
                // file. A crash before publication cannot leave a partial ownership record.
                linkSync(temporary, this.marker);
                this.ownsMarker = true;
            }
            finally {
                unlinkSync(temporary);
            }
        }
        catch (error) {
            this.close();
            if (error instanceof Database.SqliteError && error.code === 'SQLITE_BUSY') {
                throw new Error('Another worker owns this turn journal.', { cause: error });
            }
            throw error;
        }
    }
    recoverMarker() {
        let contents;
        try {
            contents = readFileSync(this.marker, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return;
            throw error;
        }
        let previous;
        try {
            previous = JSON.parse(contents);
        }
        catch { /* Unknown ownership fails closed below. */ }
        if (typeof previous !== 'object' || previous === null || !('lockProtocol' in previous) || previous.lockProtocol !== protocol) {
            throw new Error('Legacy or unrecognized journal owner.lock: stop all workers and archive only the stale marker before restarting.');
        }
        // Acquiring the database lock proves no worker using this protocol is alive.
        unlinkSync(this.marker);
    }
    close() {
        if (!this.database.open)
            return;
        try {
            if (this.ownsMarker) {
                unlinkSync(this.marker);
                this.ownsMarker = false;
            }
        }
        finally {
            // Never unlink owner.sqlite: waiters must keep locking the same inode.
            this.database.close();
        }
    }
}
