import fs from "node:fs";
import path from "node:path";
const MAX_MEMORY = 1024n * 1024n * 1024n;
const decodeMount = (value) => value.replace(/\\([0-7]{3})/g, (_all, octal) => String.fromCharCode(parseInt(octal, 8)));
/** Resolve this process's controller mount and membership, including host cgroup namespaces. */
export function requireBrowserMemoryLimit(read = file => fs.readFileSync(file, "utf8")) {
    const fail = () => new Error("Browser worker requires a cgroup memory and swap limit totalling at most 1 GiB. Use the supplied Compose browser service.");
    try {
        const memberships = read("/proc/self/cgroup").trim().split("\n").map(line => {
            const first = line.indexOf(":"), second = line.indexOf(":", first + 1);
            return { controllers: line.slice(first + 1, second).split(","), directory: line.slice(second + 1) };
        });
        for (const line of read("/proc/self/mountinfo").trim().split("\n")) {
            const [before, after] = line.split(" - ");
            if (!after)
                continue;
            const fields = before.split(" "), [type, _source, options] = after.split(" ");
            const v2 = type === "cgroup2";
            if (!v2 && !(type === "cgroup" && options?.split(",").includes("memory")))
                continue;
            const membership = memberships.find(value => v2 ? value.controllers.length === 1 && value.controllers[0] === "" : value.controllers.includes("memory"));
            if (!membership?.directory.startsWith("/"))
                continue;
            const root = path.posix.normalize(decodeMount(fields[3]));
            const mount = path.posix.normalize(decodeMount(fields[4]));
            const relative = path.posix.relative(root, membership.directory);
            if (relative === ".." || relative.startsWith("../"))
                continue;
            let directory = path.posix.join(mount, relative);
            const leaf = directory;
            let memory, swapOrCombined;
            const minimum = (current, file) => {
                let value;
                try {
                    value = read(file).trim();
                }
                catch {
                    return current;
                }
                if (!/^\d+$/.test(value))
                    return current;
                const limit = BigInt(value);
                return current === undefined || limit < current ? limit : current;
            };
            // An ancestor can impose the effective bound even when the leaf says max.
            while (true) {
                let hierarchical = v2 || directory === leaf;
                if (!hierarchical) {
                    try {
                        hierarchical = read(path.posix.join(directory, "memory.use_hierarchy")).trim() === "1";
                    }
                    catch { /* An unverified v1 ancestor is not an effective bound. */ }
                }
                if (hierarchical) {
                    memory = minimum(memory, path.posix.join(directory, v2 ? "memory.max" : "memory.limit_in_bytes"));
                    swapOrCombined = minimum(swapOrCombined, path.posix.join(directory, v2 ? "memory.swap.max" : "memory.memsw.limit_in_bytes"));
                }
                if (directory === mount)
                    break;
                directory = path.posix.dirname(directory);
            }
            if (memory !== undefined && memory > 0n && memory <= MAX_MEMORY && swapOrCombined !== undefined
                && (v2 ? memory + swapOrCombined <= MAX_MEMORY : swapOrCombined > 0n && swapOrCombined <= MAX_MEMORY))
                return;
        }
    }
    catch {
        throw fail();
    }
    throw fail();
}
