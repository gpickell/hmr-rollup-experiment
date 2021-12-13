import type { Plugin } from "rollup";
import builder from "./builder";
import NameSpace from "./utils/NameSpace";

import inject from "@rollup/plugin-inject";
import path from "path";
import fs, { GlobMatch } from "./utils/fs";

const cwd = path.normalize(process.cwd() + "/");
const slashx = /[\\/]+/g;

function fix(importer: string | undefined, filter: (value: string) => boolean) {
    if (importer?.startsWith(cwd)) {
        importer = importer.substring(cwd.length);
        importer = importer.replace(slashx, "/");

        return filter(importer) ? "/" + importer : "/";
    }

    return "/";
}

interface IterableMaybe<T = Iterator<any>> {
    [Symbol.iterator]?(): T;
}

interface ExtractIterable<T> {
    [Symbol.iterator](): T extends IterableMaybe<infer F> ? F : never;
}

function isIterable<T extends IterableMaybe>(what: T): what is T & ExtractIterable<T> {
    return !!what[Symbol.iterator];
}

namespace hoist {
    export interface ExternalsOptions {
        externals?: Iterable<string>;
        hintMask?: GlobMatch | string | string[];
        [Symbol.iterator]?(): Iterator<string>;
    };

    export function externals(options: ExternalsOptions = builder.externals): Plugin {
        const ns = new NameSpace();
        const externals = () => {
            if (isIterable(options)) {
                return options;
            }

            return options.externals ?? builder.externals;
        };
        
        const hintMask = () => {
            return options.hintMask ?? ["src/**"];
        };

        const filter = fs.glob(hintMask());
        const set = new Set(externals());
        return {
            name: "interop-externals",

            resolveId(id, importer, opts) {
                if (ns.contains(id)) {
                    return ns.resolve(this, id, opts)
                }

                if (set.has(id)) {
                    const hint = fix(importer, filter);
                    return ns.addExternal(id, hint);
                }

                return undefined;
            },

            load(id) {
                return ns.load(id);
            }
        };
    }

    export interface GlobalsOptions {
        globals?: Iterable<string>;
        hintMask?: GlobMatch | string | string[];
        [Symbol.iterator]?(): Iterator<string>;
    }

    export function globals(options: GlobalsOptions = builder.globals): Plugin {
        const prefix = NameSpace.alloc();
        const globals = () => {
            const result: Record<string, string> = {};
            if (isIterable(options)) {
                for (const id of options) {
                    result[id] = `${prefix}${id}`;
                }

                return result;
            }

            for (const id of options.globals ?? builder.globals) {
                result[id] = `${prefix}${id}`;
            }

            return result;
        };
        
        const hintMask = () => {
            return options.hintMask ?? ["src/**"];
        };

        const filter = fs.glob(hintMask());
        const ns = new NameSpace();
        const { transform } = inject({ modules: globals() });
        return {
            name: "interop-globals",

            resolveId(id, importer, opts) {
                if (ns.contains(id)) {
                    return ns.resolve(this, id, opts)
                }

                if (id.startsWith(prefix)) {
                    const name = id.substring(prefix.length);
                    const hint = fix(importer, filter);
                    return ns.addGlobal(name, hint);
                }

                return undefined;
            },

            load(id) {
                return ns.load(id);
            },

            transform(code, id) {
                return transform?.call(this, code, id);
            },
        };
    }
}

export default hoist;