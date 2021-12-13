import __fs from "fs/promises";
import __path from "path";

import { BigIntStats } from "fs";

import type { IMinimatch } from "minimatch";
import __minimatch from "minimatch";

const { Minimatch } = __minimatch;
const cwd = __path.normalize(process.cwd() + "/");

function safe_stats(path: string) {
    return fs.stat(path, { bigint: true }).catch(() => undefined);
}

function safe_readdir(path: string) {
    return fs.readdir(path).catch(() => []);
}

const cache = new Map<string, Folder>();
class Folder extends Map<string, BigIntStats> {
    #loop?: boolean;
    #promise?: Promise<void>;

    readonly path: string;
    readonly stats: BigIntStats | undefined;

    get exists() {
        return this.stats !== undefined;
    }

    get state() {
        return this.stats?.mtimeNs ?? BigInt(0);
    }

    constructor(path: string) {
        super();
        this.path = path;
    }

    async update() {
        this.#loop = true;

        const promise = this.#promise;
        if (promise !== undefined) {
            return promise;
        }

        let resolve!: () => void;
        this.#promise = new Promise<void>(x => resolve = x);

        let results: [string, BigIntStats | undefined][] | undefined;
        let stats: BigIntStats | undefined;
        let mtime = this.stats?.mtimeNs;
        while (this.#loop) {
            this.#loop = false;
            stats = await safe_stats(this.path);

            if (!stats?.isDirectory()) {
                stats = undefined;
                break;
            }
            
            if (stats.mtimeNs === mtime) {
                break;
            }

            mtime = stats.mtimeNs;

            const names = await safe_readdir(this.path);
            const list = names.map(async name => {
                const path = __path.join(this.path, name);
                const next = await safe_stats(path);
                const last = this.get(name);
                if (last?.mtimeNs === next?.mtimeNs) {
                    return [name, last] as [string, typeof last];    
                }

                return [name, next] as [string, typeof next];
            });

            results = await Promise.all(list);
            this.#loop = true;
        }

        Object.assign(this, { stats });

        if (stats === undefined) {
            this.clear();
            results = undefined;
        }

        if (results !== undefined) {
            this.clear();
            for (const [key, stats] of results) {
                stats && this.set(key, stats);
            }
        }

        resolve();
        this.#promise = undefined;
    }

    async stat(name: string) {
        await this.update();
        return this.get(name);
    }
}

export function clearCache() {
    cache.clear();
}

const contents = new WeakMap<BigIntStats, Buffer>();

export async function peek(...paths: string[]) {
    const { dir, base } = __path.parse(__path.resolve(cwd, ...paths));
    const folder = cache.get(dir);
    const file = folder?.get(base);
    if (file?.isFile()) {
        const content = contents.get(file);
        if (content !== undefined) {
            return content;
        }

        const fn = __path.join(dir, base);
        const update = await fs.readFile(fn).catch(() => undefined);
        if (update === undefined) {
            return undefined;
        }

        contents.set(file, update);
        return update;
    }

    return undefined;
}

export async function load(path: string, ...files: (string | string[])[]) {
    const result = new Map<string, Buffer>();
    const promises: Promise<void>[] = [];
    for (const file of files.flat()) {
        const load = async () => {
            const data = await peek(path, file);
            data && result.set(file, data);
        };

        promises.push(load());
    }

    await Promise.all(promises);
    
    return result;
}

export async function scan(path: string, recursive = false) {
    path = __path.resolve(cwd, path);

    const result: Folder[] = [];
    const queue = new Set<string>();
    queue.add(path);

    for (const path of queue.keys()) {
        const folder = cache.get(path) ?? new Folder(path);
        cache.set(path, folder);

        await folder.update();

        if (folder.exists) {
            result.push(folder);

            if (recursive) {
                for (const [name, stats] of folder) {
                    const path = __path.join(folder.path, name);
                    if (stats.isDirectory()) {
                        queue.add(path);
                    }
                }
            }
        }
    }
    
    return result;
}

export interface GlobMatch {
    (value: string): boolean;
    matchers: IMinimatch[];
}

export function glob(...patterns: (GlobMatch | string | string[])[]): GlobMatch {
    const scope = patterns.flat().map(x => typeof x === "string" ? x : x.matchers).flat();
    const matchers = scope.map(x => typeof x === "string" ? new Minimatch(x) : x);
    const fn = (input: string) => {
        let result: boolean | undefined;
        for (const matcher of matchers) {
            if (result === undefined) {
                result = matcher.negate;
            }

            if (matcher.match(input) !== matcher.negate) {
                result = !matcher.negate;
            }
        }

        return result ?? false;
    };

    const value = matchers.map(x => x.pattern).join(", ");
    return Object.assign(fn, { matchers, toString: () => value })
}

export async function find(path: string, ...globs: (GlobMatch | string | string[])[]) {
    let root: string | undefined;
    const results: string[] = [];
    const matcher = glob(...globs);
    for (const folder of await scan(path, true)) {
        if (root === undefined) {
            root = folder.path;
        }

        for (const [name, stats] of folder) {
            const path = __path.join(folder.path, name);
            const result = __path.relative(root, path);
            if (stats.isFile() && matcher(result)) {
                results.push(result);
            }
        }
    }

    return results;
}

const methods = {
    peek,
    load,
    find,
    glob,
    scan,
};

const fs = Object.assign(Object.create(__fs) as typeof __fs, methods);
export default fs;
