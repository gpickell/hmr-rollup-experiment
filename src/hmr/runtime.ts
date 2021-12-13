import HotModuleContext, { State, Update } from "./HotModuleContext";

const immediate = Promise.resolve();
const urlx = /\..*?\.[cm]?js$/;

const doa = new HotModuleContext(State.upgrade);

interface Runtime {
    urls: Set<string>;
    load(url: string): void;
    create(id: string, ver: number): HotModuleContext;
    track(url: string): boolean;
    observe(key: string, fn: () => any): boolean;
    freeze(): boolean;
}

function __init(): Runtime {
    /**
    const key = "__hmr__runtime__";
    const current = main[key];
    if (current !== undefined) {
        return current;
    }
    */

    const graph = new Map<string, [HotModuleContext, number, Update]>();
    const observers = new Map<string, () => any>();
    const invalidate = () => {
        if (urls.size > 0 || Object.isFrozen(urls)) {
            for (const fn of observers.values()) {
                immediate.then(fn);
            }    
        }
    };

    const urls = new Set<string>();
    const runtime: Runtime = {
        urls,

        load(url: string) {
            // main[key] = runtime;
            import(url);
        },

        create(id: string, ver: number) {
            let meta: any;
            const current = graph.get(id);
            if (current !== undefined) {
                const [_context, _ver, _update] = current;
                if (_ver >= ver) {
                    return doa;
                }

                _context.invalidate();
                _update.state = State.upgrade;

                meta = _update.meta;
            }

            const update: Update = { meta, state: State.pending };
            const context = new HotModuleContext(meta, update);
            graph.set(id, [context, ver, update]);

            update.state = State.running;
            context.invalidate();

            return context;
        },
    
        track(url: string | URL, hint?: string) {
            if (Object.isFrozen(urls)) {
                return false;
            }

            url = new URL(url);
            url.pathname = url.pathname.replace(urlx, ".json");
            url.search = "";
            url.hash = "";

            if (hint !== undefined) {
                url = new URL(hint, url);
            }

            const key = url.toString();
            if (!urls.has(key)) {
                urls.add(key);
                invalidate();    
            }

            return true;
        },

        observe(key: string, fn: () => any) {
            if (!observers.has(key)) {
                observers.set(key, fn);
                invalidate();

                return true;
            }

            return false;
        },

        freeze() {
            if (Object.isFrozen(urls)) {
                return false;
            }

            Object.freeze(urls);
            invalidate();

            return true;
        }
    };
    
    return runtime;
}

const runtime = __init();
const { urls, load, create, track, observe, freeze } = runtime;
export { urls, load, create, track, observe, freeze };
export default runtime;
