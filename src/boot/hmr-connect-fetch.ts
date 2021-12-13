import { urls, load, observe } from "../hmr/runtime";

let connected: boolean | undefined;
const cancellation = new AbortController();
const { signal } = cancellation;
const watches = new Set<string>();

function wait() {
    return new Promise<void>(resolve => {
        let timer: any;
        const done = (th = timer) => {
            if (th !== undefined) {
                clearTimeout(th);
            }

            resolve();
            signal.removeEventListener("abort", done);
            timer = undefined;
        };

        timer = setTimeout(() => done(timer = undefined), 1500);
        signal.addEventListener("abort", done);

        if (signal.aborted) {
            done();
        }
    });
}

async function loop(baseUrl: string) {
    let fetchUrl = new URL("?", baseUrl);
    while (!signal.aborted) {
        try {
            const response = await fetch(fetchUrl.toString(), { method: "POST", signal });
            if (!response.ok) {
                break;
            }

            const { chunks } = await response.json();
            if (Array.isArray(chunks) && chunks.every(x => typeof x === "string")) {
                for (const chunk of chunks) {
                    const url = new URL(chunk, baseUrl);
                    load(url.toString());    
                }
            }

            const loc = response.headers.get("Location");
            if (loc === null) {
                break;
            }

            fetchUrl = new URL(loc, fetchUrl);
        } catch {
            await wait();
        }
    }
}

export function connect() {
    if (connected !== undefined) {
        return connected;
    }

    return connected = observe("connect-fetch", () => {
        if (urls.size < 1) {
            shutdown();
        }

        for (const url of urls) {
            start(url);
        }
    });
}

export function shutdown() {
    cancellation.abort();
    connected = false;
    watches.clear();
}

export function start(asset: string) {
    if (Object.isFrozen(watches)) {
        return false;
    }

    const url = new URL(asset, import.meta.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return false;
    }

    const baseUrl = (new URL("?", url)).toString();
    if (watches.has(baseUrl)) {
        return true;
    }

    watches.add(baseUrl);
    loop(baseUrl);

    console.log("[HMR]: fetch: url =", baseUrl)

    return true;
}

export function __start() {
    connect();
}
