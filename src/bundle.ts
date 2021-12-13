import type { Plugin } from "rollup";

import fs, { GlobMatch } from "./utils/fs";
import path from "path";
import resolve from "./utils/resolve";
import NameSpace from "./utils/NameSpace";
import switches from "./utils/switches";

const wordx = /[A-Za-z\-]+/;
const slashx = /[\\/]+/g;

const cwd = path.normalize(process.cwd() + "/");
const hmrIndex = resolve("./hmr/index");
const hmrRuntime = resolve("./hmr/runtime");
const hookIndex = resolve("./hook/index");

function fix(importer: string | undefined, filter: (value: string) => boolean) {
    if (importer?.startsWith(cwd)) {
        importer = importer.substring(cwd.length);
        importer = importer.replace(slashx, "/");

        return filter(importer) ? "/" + importer : "/";
    }

    return "/";
}

function bundle(): Plugin {
    const outputDirs = new WeakMap<any, string>();
    return {
        name: "interop-bundle",

        outputOptions(opts) {
            if (opts.dir === undefined) {
                opts.dir = "dist";
            }

            if (opts.format === undefined) {
                opts.format = "es";
            }

            opts.file = undefined;
            opts.entryFileNames = "assets/entry-[name].[hash].mjs";
            opts.chunkFileNames = info => {
                const { name } = info;
                if (name.startsWith("sys-")) {
                    return "assets/[name].[hash].mjs";
                }

                if (name.startsWith("vendor-")) {
                    return "assets/[name].[hash].mjs";
                }

                const match = info.name.match(wordx);
                if (match !== null) {
                    const [name] = match;
                    const lc = name.toLowerCase();
                    return `assets/app-${lc}.[hash].mjs`;
                }

                return `assets/gen.[hash].mjs`;
            };

            return opts;
        },

        async renderStart(opts) {
            outputDirs.set(this.meta, opts.dir ?? "");
        },

        resolveImportMeta(name, info) {
            const outputDir = outputDirs.get(this.meta);
            if (name === "rootHint" && outputDir) {
                const fn = path.resolve(cwd, outputDir, info.chunkId);
                const rel = path.relative(path.dirname(fn), cwd);
                const rootHint = rel.replace(slashx, "/");
                return JSON.stringify(rootHint);
            }

            return undefined;
        },
    };
}

namespace bundle {
    interface ClassifyHandlerList extends Record<string, ClassifyHandler> {}
    class ClassifyHandlerList {}

    export type ClassifyResult = string | string[] | Record<string, string | string[]> | undefined | null | boolean;

    export interface ClassifyHandler {
        (name: string, id: string): Promise<ClassifyResult> | ClassifyResult;
    }

    export function entry(name: string, targets: string | string[]): Plugin {
        const ns = new NameSpace();
        return {
            name: "interop-bundle-entry",

            async buildStart() {
                ns.clear();

                const { id } = ns.addEntry(name, targets);
                this.emitFile({ type: "chunk", name, id });
            },

            resolveId(id, _, opts) {
                return ns.resolve(this, id, opts);
            },

            load(id) {
                return ns.load(id);
            }
        };
    }

    export function search(prefix = "."): Plugin {
        let filter: GlobMatch;
        const ns = new NameSpace();
        const dir = path.resolve(cwd, prefix);
        return {
            name: "interop-bundle-search",

            options(opts) {
                let { input } = opts;
                if (typeof input === "string") {
                    input = [input];
                }

                if (!Array.isArray(input) && input) {
                    input = Object.values(input);
                }

                if (!input || input.length < 1) {
                    input = ["**/*-entry.{cjs,mjs,js,jsx,ts,tsx}"];
                }

                filter = fs.glob(input);
                return { ...opts, input: [] };
            },

            async buildStart({ plugins }) {
                ns.clear();

                let auto: ClassifyHandler | undefined = (name, id) => ({ [name]: id });
                const handlers: Record<string, ClassifyHandler> = Object.create(null);
                for (const { api } of plugins) {
                    if (api instanceof ClassifyHandlerList) {
                        auto = undefined;
                        Object.assign(handlers, api);
                    }
                }

                const results: Promise<Record<string, string | string[]>>[] = [];
                for (const fn of await fs.find(dir, filter)) {
                    const key = path.basename(fn, path.extname(fn));
                    const fp = path.resolve(cwd, prefix, fn);
                    const handler = auto ?? handlers[key];
                    if (handler !== undefined && fp.startsWith(cwd)) {
                        const id = path.relative(cwd, fp).replace(slashx, "/");
                        const resolver = async () => {
                            const name = path.basename(path.dirname(id));
                            const result = await handlers[key](name, id);
                            if (typeof result === "string" || Array.isArray(result)) {
                                return { [name]: result };
                            }

                            if (typeof result === "object" && result) {
                                return result;
                            }

                            if (result) {
                                return { [name]: id };
                            }

                            return {};
                        };

                        results.push(resolver());
                    }
                }

                for (const result of await Promise.all(results)) {
                    for (const name in result) {
                        const targets = result[name];
                        if (typeof targets === "string" || Array.isArray(targets)) {
                            const { id } = ns.addEntry(name, targets);
                            this.emitFile({ type: "chunk", name, id });
                        }
                    }
                }
            },

            resolveId(id, _, opts) {
                return ns.resolve(this, id, opts);
            },

            load(id) {
                return ns.load(id);
            },
        };
    }

    export function classify(name: string, handler?: ClassifyHandler): Plugin {
        if (handler === undefined) {
            handler = (name, id) => ({ [name]: id });
        }

        const api = new ClassifyHandlerList();
        api[name] = handler;

        return {
            name: "interop-bundle-classify",
            api,
        };
    }

    export function hmr(...mask: (GlobMatch | string | string[])[]): Plugin {
        switches.hmrEnabled = true;

        let luid = 0;
        const filter = fs.glob(...mask);
        const ns = new NameSpace();
        const state = new Map<string, number>();
        return {
            name: "interop-bundle-hmr",

            buildStart() {
                luid = (new Date()).valueOf();
            },

            async resolveId(id, importer, opts) {
                if (ns.contains(id)) {
                    return ns.resolve(this, id, opts);
                }

                const ref = fix(importer, filter);
                if (ref !== "/") {
                    const result = await this.resolve(id, importer, { ...opts, skipSelf: true });
                    if (result?.id === hmrIndex && !result.external) {
                        return ns.addHot(ref);
                    }
                }

                return undefined;
            },

            load(id) {
                return ns.load(id);
            },

            async transform(_, id) {
                if (fix(id, filter) !== "/") {
                    const stats = await fs.stat(id).catch(() => undefined);
                    state.set(id, stats?.mtimeMs ?? 0);
                }

                return undefined;
            },

            outputOptions(opts) {
                const nmx = /[\\/]node_modules[\\/]+@?(.*?)[\\/]/;
                opts.manualChunks = id => {
                    if (id[0] === "\0") {
                        return undefined;
                    }
    
                    if (id === hookIndex) {
                        return "sys-hook";
                    }
    
                    if (id === hmrRuntime) {
                        return "sys-runtime";
                    }
    
                    const match = id.match(nmx);
                    if (match !== null) {
                        const [, hint] = match;
                        return `vendor-${hint}`;
                    }
    
                    return undefined;
                };

                return opts;
            },

            augmentChunkHash(chunk) {
                let mtime = 0;
                for (const id in chunk.modules) {
                    mtime = Math.max(mtime, state.get(id) ?? 0);
                }

                return mtime > 0 ? mtime.toString() : undefined;
            },

            resolveImportMeta(prop) {
                if (prop === "ver") {
                    return JSON.stringify(luid);
                }

                return undefined;
            },

            generateBundle(_, bundle) {
                const assets = new Map<string, string[]>();
                for (const chunk of Object.values(bundle)) {
                    if (chunk.type === "chunk" && chunk.isEntry) {
                        const name = chunk.name.replace(slashx, "-");
                        const fn = `assets/${name}.json`;
                        let chunks = assets.get(fn);
                        if (chunks === undefined) {
                            assets.set(fn, chunks = []);
                        }
    
                        chunks.push(path.basename(chunk.fileName));
                    }
                }
    
                for (const [fn, chunks] of assets) {
                    this.emitFile({
                        type: "asset",
                        fileName: fn,
                        source: JSON.stringify({ chunks }, undefined, 4),
                    });
                }
    
                return undefined;
            },
        };
    }
}

export default bundle;
