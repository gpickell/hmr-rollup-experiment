import fs from "fs/promises";
import lock from "../utils/lock";
import path from "path";
import process from "process";
import urlConvert from "../utils/url-convert";

import { urls, load, observe } from "../hmr/runtime";

let connected: boolean | undefined;
const pending = new Map<string, boolean>();
const watches = new Set<string>();

const cwd = path.normalize(process.cwd() + "/");
const slashx = /[\\/]+/g;

function fix(fn: string) {
    if (fn.startsWith(cwd)) {
        fn = fn.substring(cwd.length);
        fn = fn.replace(slashx, "/");
    }

    return fn;
}

async function read(fn: string, baseUrl: URL) {
    while (pending.get(fn) === true) {
        pending.set(fn, false);

        try {
            const content = await fs.readFile(fn, "utf-8");
            const { chunks } = JSON.parse(content);
            if (Array.isArray(chunks) && chunks.every(x => typeof x === "string")) {
                for (const chunk of chunks) {
                    const url = new URL(chunk, baseUrl);
                    load(url.toString());    
                }
            }
        } catch {
            // don't care.... probably a race condition with change events.
        }
    }

    pending.delete(fn);
}

async function loop(fn: string, url: URL) {
    let token = "_";
    const dir = path.dirname(fn);
    while (token) {
        token = await lock.watch(dir, token);
        
        if (watches.has(fn)) {
            if (pending.get(fn) === undefined) {
                pending.set(fn, true);
                read(fn, url);
            }
            
            pending.set(fn, true);
        }
    }
}

export function connect() {
    if (connected !== undefined) {
        return connected;
    }

    return connected = observe("connect-fs", () => {
        if (urls.size < 1) {
            shutdown();
        }

        for (const url of urls) {
            start(url);
        }
    });
}

export function shutdown() {
    connected = false;
    lock.close();
    watches.clear();
    Object.freeze(watches);
}

export function start(asset: string) {
    if (Object.isFrozen(watches)) {
        return false;
    }

    const url = new URL(asset, import.meta.url);
    if (url.protocol !== "file:") {
        return false;
    }

    const fn = urlConvert(url.toString(), import.meta.url);
    if (watches.has(fn)) {
        return true;
    }

    console.log("[HMR]: fs.watch: file =", fix(fn))
    watches.add(fn);

    loop(fn, url);
    return true;
}

export function __start() {
    connect();
}
