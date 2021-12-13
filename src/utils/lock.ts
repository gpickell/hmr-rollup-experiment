import { FSWatcher, watch } from "fs";

import fs from "fs/promises";
import path from "path";

type State = [value: string, last: Promise<string>, next: Promise<string>];

const done = Promise.resolve("");
const states = new Map<string, State>();
const watchers: FSWatcher[] = [];

function observe(dir: string): State {
    let value = "";
    let last: Promise<string>;
    let resolve!: (value: string) => void;
    let next = last = new Promise<string>(x => resolve = x);
    let state: State = [value, last, next];
    states.set(dir, state);

    let pending: boolean | undefined;
    const fn = path.resolve(dir, "lock.json");
    const read = async () => {
        try {
            const content = await fs.readFile(fn, "utf-8");
            const json = JSON.parse(content);
            const { token } = json;
            if (typeof token === "string") {
                return token;
            }
        } catch {
            // Don't care really.
        }

        return undefined;
    };

    const loop = async () => {
        while (pending) {
            pending = false;

            const token = await read();
            if (!pending && value !== token) {
                if (token) {
                    resolve(token);
                    value = token;
                    last = next;
                    next = new Promise<string>(x => resolve = x);
                } else {
                    value = "";
                    last = next;
                }

                if (states.size > 0) {
                    states.set(dir, [value, last, next]);
                }
            }
        }

        pending = undefined;
    };

    const update = () => {
        if (pending === undefined) {
            pending = true;
            loop();
        }
        
        pending = true;
    };

    const start = async () => {
        await fs.mkdir(dir, { recursive: true });

        const watcher = watch(dir, { persistent: false });
        watcher.on("change", (_, fn) => {
            if (fn === "lock.json") {
                update();
            }
        });

        update();

        if (Object.isFrozen(watchers)) {
            watcher.close();
        } else {
            watchers.push(watcher);
        }
    };

    start();
    return state;
}

namespace lock {
    export function close() {
        for (const watcher of watchers) {
            watcher.removeAllListeners();
            watcher.close();
        }

        states.clear();
        watchers.length = 0;

        Object.freeze(states);
        Object.freeze(watchers);
    }

    export function watch(dir: string, token = "") {
        if (Object.isFrozen(watchers)) {
            return done;
        }

        dir = path.resolve(process.cwd(), dir);

        const [value, last, next] = states.get(dir) ?? observe(dir);       
        if (token && value === token) {
            return next;
        }

        return last;
    }
}

export default lock;