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

async function loop(wsUrl: string, baseUrl:string) {
    while (!signal.aborted) {
        const ws = new WebSocket(wsUrl, "hmr");
        ws.onmessage = e => {
            if (typeof e.data === "string") {
                try {
                    const json = JSON.parse(e.data);
                    if (typeof json === "object" && json !== null) {
                        const { chunks } = json;
                        if (Array.isArray(chunks) && chunks.every(x => typeof x === "string")) {
                            for (const chunk of chunks) {
                                const url = new URL(chunk, baseUrl);
                                load(url.toString());
                            }
                        }            
                    }
                } catch {}
            }
        };

        await new Promise<void>(resolve => {
            const done = () => {
                resolve();
                signal.removeEventListener("abort", done);
            };

            ws.onclose = done;
            ws.onerror = done;
            signal.addEventListener("abort", done);

            ws.onopen = () => {
                if (ws.readyState === ws.OPEN && signal.aborted) {
                    ws.close();
                }
            };
        });

        await wait();
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

    const baseUrl = (new URL(url.pathname, url)).toString();
    url.protocol = "ws" + url.protocol.substring(4);

    const wsUrl = (new URL(url.pathname, url)).toString();
    if (watches.has(wsUrl)) {
        return true;
    }

    watches.add(wsUrl);
    loop(wsUrl, baseUrl);

    console.log("[HMR]: ws: url =", wsUrl)

    return true;
}

export function __start() {
    connect();
}
