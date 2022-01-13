import fs, { GlobMatch } from "./utils/fs";
import path from "path";
import resolve from "./utils/resolve";
import Plugin from "./Plugin";

const wordx = /[A-Za-z\-]+/;
const slashx = /[\\/]+/g;

const cwd = path.normalize(process.cwd() + "/");
const hmrIndex = resolve("./hmr/index");
const hmrRuntime = resolve("./hmr/runtime");
const hookIndex = resolve("./hook/index");

function fix(dir: string, id: string, filter: (value: string) => boolean) {
    if (id.startsWith(dir)) {
        id = id.substring(dir.length);
        id = id.replace(slashx, "/");

        return filter(id) ? id : undefined;
    }

    return undefined;
}

function expand(...values: any[]) {
    return values.map(x => JSON.stringify(x)).join(", ");
}

function bundle(): Plugin {
    const outputDirs = new WeakMap<any, string>();
    return Plugin.build({
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
    });
}

namespace bundle {
    interface ClassifyHandler {
        (name: string, id: string, extra: string[]): ClassifyResult;
    }

    interface Classify {
        handler: ClassifyHandler;
    }

    class Classify {}

    class HMR {
        static detector() {
            const mapper = Plugin.mapper();
            return () => {
                for (const _ of mapper.find({}, this)) {
                    return true;
                }

                return false;
            };
        }
    }
    
    export type ClassifyResult = string | string[] | undefined | null | boolean | {
        name: string;
        imports: string | string[];
    };

    function registerEntryGenerator() {
        const ns = Plugin.ns("entry");
        const map = new Map<string, [string, string | string[]]>();
        const syntheticNamedExports = "__exports";
        const mapper = Plugin.mapper();
        const hmr = HMR.detector();
        mapper.add({ ns }, Plugin, {
            resolveId(id) {
                const [, targets] = map.get(id)!;
                if (Array.isArray(targets)) {
                    return { id, syntheticNamedExports };
                }

                return { id };
            },

            load(id) {
                const [name, targets] = map.get(id)!;
                const header = [];
                if (hmr()) {
                    const hint = `${name}.json`;
                    header.push(
                        `import { track } from ${expand(hmrRuntime)};\n`,
                        `track(import.meta.url, ${expand(hint)});\n`,    
                    );
                }
        
                if (Array.isArray(targets)) {
                    const [ boot, ...rest ] = targets;
                    const imports = rest.map(x => `    () => import(${expand(x)}),\n`);
                    const code = [
                        ...header,
                        `import boot from ${expand(boot)};\n`,    
                        `export const __exports = await boot(\n`,
                        ...imports,
                        `);\n`
                    ];
        
                    return code.join("");
                }
        
                const code = [
                    ...header,
                    `export * from ${expand(targets)};\n`,
                    `import * as __module from ${expand(targets)};\n`,
                    `const { default: __default } = __module;\n`,
                    `export default __default;\n`
                ];
        
                return code.join("");
            }
        });

        return { ns, map };
    }

    export function entry(name: string, imports: string | string[]): Plugin {
        const { ns, map } = registerEntryGenerator();
        return Plugin.build({
            name: "interop-bundle-entry",

            buildStart() {
                map.clear();

                const id = Plugin.id(ns);
                map.set(id, [name, imports]);
                this.emitFile({ type: "chunk", name, id });
            }
        });
    }

    export function search(dir = "src"): Plugin {
        dir = path.resolve(cwd, dir);

        let filter: GlobMatch;
        const mapper = Plugin.mapper();
        const { ns, map } = registerEntryGenerator();
        return Plugin.build({
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

            async buildStart() {
                map.clear();

                const groups = new Map<string, string[]>();
                for (const fn of await fs.find(dir, filter)) {
                    const id = path.resolve(dir, fn);
                    const ext = path.extname(id);
                    const kind = path.basename(id, ext);
                    const name = path.basename(path.dirname(id));
                    const key = `${name}/${kind}`;
                    const group = groups.get(key);
                    if (group !== undefined) {
                        group.push(id);
                    } else {
                        groups.set(key, [id]);
                    }
                }

                for (const [id, ...extra] of groups.values()) {
                    const ext = path.extname(id);
                    const kind = path.basename(id, ext);
                    const name = path.basename(path.dirname(id));
                    for (const { handler } of mapper.find({ kind }, Classify)) {
                        let result = handler(name, id, extra);
                        if (result === false) {
                            break;
                        }

                        if (result === true) {
                            result = id;
                        }

                        if (typeof result === "string" || Array.isArray(result)) {
                            result = { name, imports: result };
                        }

                        if (result) {
                            const id = Plugin.id(ns);
                            const { name, imports } = result;
                            map.set(id, [name, imports]);
                            this.emitFile({ type: "chunk", name, id });

                            break;
                        }
                    }
                }
            },
        });
    }

    export function classify(kind: string, handler?: ClassifyHandler): Plugin {
        if (handler === undefined) {
            handler = (_, id) => id;
        }

        const mapper = Plugin.mapper();
        mapper.add({ kind }, Classify, { handler });

        return Plugin.build({ name: "interop-bundle-classify" });
    }

    export function hmr(dir = "src", ...mask: (GlobMatch | string | string[])[]): Plugin {
        dir = path.resolve(cwd, dir);
        dir = path.normalize(dir + "/");

        if (mask.length < 1) {
            mask = ["**/*"];
        }

        const ns = Plugin.ns("hmr");
        const mapper = Plugin.mapper();
        mapper.add({}, HMR, {});
        mapper.add({ ns }, Plugin, {
            resolveId(id) {
                return { id };
            },

            load(id) {
                const ref = id.substring(ns.length);
                const code = [
                    `import { create } from ${expand(hmrRuntime)};\n`,
                    `const hmr = create(${expand(ref)}, import.meta.ver);\n`,
                    `export default hmr;\n`,
                ];
        
                return code.join("");
            }
        });

        let luid = 0;
        const filter = fs.glob(...mask);
        const state = new Map<string, number>();
        return Plugin.build({
            name: "interop-bundle-hmr",

            buildStart() {
                luid = (new Date()).valueOf();
            },

            async resolveId(id, importer, opts) {
                if (importer === undefined) {
                    return undefined;
                }

                const ref = fix(dir, importer, filter);
                if (ref !== undefined) {
                    const result = await this.resolve(id, importer, { ...opts, skipSelf: true });
                    if (result?.id === hmrIndex && !result.external) {
                        return { id: `${ns}${ref}` };;
                    }
                }

                return undefined;
            },

            async transform(_, id) {
                if (fix(dir, id, filter)) {
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
        });
    }
}

export default bundle;
