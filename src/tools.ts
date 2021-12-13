import type { Plugin } from "rollup";
import inject from "@rollup/plugin-inject";
import NameSpace from "./utils/NameSpace";

import fs, { GlobMatch } from "./utils/fs";
import path from "path";
import os from "os";

const cwd = path.normalize(process.cwd() + "/");
const globx = /^(.*?)([^\\/]*\*.*)$/;
const slashx = /[\\/]+/g;

function slashify(fn: string) {
    return fn.replace(slashx, "/");
}

function relative(from: string, to: string) {
    const rel = path.relative(path.dirname(from), to);
    const result = slashify(rel);
    if (result.startsWith("../")) {
        return result;
    }

    return `./${result}`;
}

namespace tools {
    export function clean(...patterns: (GlobMatch | string | string[])[]): Plugin {
        if (patterns.length < 1) {
            patterns = ["**/*"];
        }

        const filter = fs.glob(...patterns);
        const keep = new Map<string, string[]>();
        const linger = new Map<string, number>();
        const unlink = async (fn: string) => {
            return fs.unlink(fn).catch(() => {});
        };

        const locks: string[] = [];
        return {
            name: "interop-clean",

            async renderStart(opts) {
                if (opts.dir) {
                    const dir = path.resolve(cwd, opts.dir, "assets");
                    await fs.mkdir(dir, { recursive: true });

                    const lockFile = path.resolve(dir, "lock.json");
                    await fs.writeFile(lockFile, "{}");
                    locks.push(lockFile);
                }
            },

            async writeBundle(opts, bundle) {
                if (opts.dir) {
                    const list: string[] = [];
                    for (const asset of Object.values(bundle)) {
                        list.push(asset.fileName);
                    }
    
                    const dir = path.resolve(cwd, opts.dir);                  
                    keep.set(dir, list);
                }
            },

            async closeBundle() {
                const files = new Set<string>();
                for (const [dir] of keep) {
                    for (const fn of await fs.find(dir, filter)) {
                        files.add(path.resolve(dir, fn));
                    }
                }

                const now = (new Date()).valueOf();
                const min = now - 15000;
                for (const [fn, ts] of linger) {
                    if (ts > min) {
                        files.delete(fn);

                        if (ts === Infinity) {
                            linger.set(fn, now);
                        }
                    } else {
                        linger.delete(fn);
                    }
                }

                for (const [dir, list] of keep) {
                    for (const fn of list) {
                        const key = path.resolve(dir, fn);
                        files.delete(key);
                        linger.set(key, Infinity);    
                    }
                }

                for (const fn of locks) {
                    files.delete(fn);
                }

                const promises: any[] = [];
                for (const fn of files) {
                    promises.push(unlink(fn));
                }

                await Promise.all(promises);
                promises.length = 0;

                const token = (new Date()).valueOf().toString();
                const content = JSON.stringify({ token });
                for (const fn of locks) {
                    promises.push(fs.writeFile(fn, content));
                }

                await Promise.all(promises);
                locks.length = 0;
            }
        };
    }

    export function bind(ext = ".mjs", ...patterns: (GlobMatch | string | string[])[]): Plugin {
        if (patterns.length < 1) {
            patterns.push("!**/index.*");
        }

        const filter = fs.glob(...patterns);
        return {
            name: "interop-bind",
            
            generateBundle(_, bundle) {
                const assets = new Map<string, string[]>();
                for (const chunk of Object.values(bundle)) {
                    if (chunk.type === "chunk" && chunk.isEntry) {
                        const fn = `${chunk.name}${ext}`;
                        if (filter(fn)) {
                            let chunks = assets.get(fn);
                            if (chunks === undefined) {
                                assets.set(fn, chunks = []);
                            }

                            const script = relative(fn, chunk.fileName);
                            chunks.push(script);
                        }
                    }
                }

                for (const [fn, chunks] of assets) {
                    const code = chunks.map(x => `import(${JSON.stringify(x)});\n`).join("");
                    this.emitFile({
                        type: "asset",
                        fileName: fn,
                        source: code,
                    });
                }
            }
        };
    }

    export function copy(root: string, ...patterns: (GlobMatch | string | string[])[]): Plugin {
        if (patterns.length < 1) {
            patterns = ["**/*"];
        }

        const filter = fs.glob(...patterns);
        return {
            name: "interop-copy",

            async generateBundle() {
                const dir = path.resolve(cwd, root);
                const files = await fs.find(dir, filter);
                for (const [file, data] of await fs.load(dir, files)) {
                    this.emitFile({
                        type: "asset",
                        fileName: file,
                        source: data,
                    });
                }
            }
        };
    }

    export function observe(fn: () => Promise<void> | void): Plugin {
        let waiter: Promise<void> | void;
        return () => {
            return {
                name: "interop-observe",
    
                async buildStart() {
                    if (waiter === undefined) {
                        waiter = fn();
                    }
    
                    await waiter;
                }
            };
        };
    }

    async function mklink(src: string, dst: string) {
        const target = await fs.realpath(dst).catch(() => undefined);
        if (target !== src) {
            if (target !== undefined) {
                await fs.unlink(dst);
            }

            const dir = path.dirname(dst);
            const type = os.platform() === "win32" ? "junction" : undefined;
            await fs.mkdir(dir, { recursive: true });
            await fs.symlink(src, dst, type);
        }
    }

    export function link(from: string, to: string, links: Record<string, string>) {
        const promises: any[] = [];
        return {
            name: "interop-link",

            async buildStart() {
                if (promises.length < 1) {
                    for (const [key, value] of Object.entries(links)) {
                        const src = path.resolve(cwd, from, key);
                        const dst = path.resolve(cwd, to, value);
                        promises.push(mklink(src, dst));
                    }
                }

                await Promise.all(promises);
            }
        };
    }

    const tasks: Promise<void>[] = [];

    async function fetch(url: string) {
        url;
        return "";
    }

    async function relink(src: string, dst: string) {
        const x = await fs.stat(src, { bigint: true }).catch(() => undefined);
        const y = await fs.stat(dst, { bigint: true }).catch(() => undefined);
        if (x?.mtimeNs !== y?.mtimeNs || x?.size !== y?.size) {
            if (y !== undefined) {
                await fs.unlink(dst);
            }

            await fs.link(src, dst);
        }
    }

    export async function dlx(url: string, to: string, ...patterns: (GlobMatch | string | string[])[]) {
        to = path.resolve(cwd, to);

        const filter = fs.glob(...patterns);
        const promises: any[] = [];
        return () => {
            return {
                name: "interop-dlx",
    
                async buildStart() {
                    if (promises.length < 1) {
                        const deps = [...tasks];
                        tasks.length = 0;
    
                        const execute = async () => {
                            for (const dep of deps) {
                                await dep;
                            }

                            const dir = await fetch(url);
                            const names = await fs.find(dir, filter);
                            await fs.mkdir(to, { recursive: true });
                            
                            const promises: any[] = []
                            for (const name of names) {
                                const src = path.resolve(dir, name);
                                const dst = path.resolve(to, name);
                                promises.push(relink(src, dst));
                            }

                            await Promise.all(promises);
                        };
    
                        const promise = execute();
                        promises.push(promise);
                        tasks.push(promise.catch(() => undefined));
                    }
    
                    await Promise.all(promises);
                }
            };
        };
    }

    export function glob(): Plugin {
        const ns = new NameSpace();
        return {
            name: "interop-glob",

            buildStart() {
                ns.clear();
            },
    
            async resolveId(id, importer) {
                if (ns.contains(id)) {
                    return id;
                }

                if (id[0] === "\0" || importer?.[0] === "\0") {
                    return undefined;
                }
   
                importer = importer ? path.dirname(importer) : cwd;

                const match = id.match(globx);
                if (match !== null) {
                    const [, hint, pattern] = match;
                    const dir = path.resolve(importer, hint);
                    const temp = path.join(dir, "__dummy__")
                    if (temp.startsWith(cwd)) {
                        return ns.addGlob(dir, pattern);
                    }
                }
    
                return undefined;
            },
    
            load(id) {
                return ns.load(id);
            }
        };
    }

    export function alias(modules: Record<string, string>): Plugin {
        const ns = new NameSpace();
        return {
            name: "interop-alias",

            resolveId(id, _, opts) {
                if (ns.contains(id)) {
                    return ns.resolve(this, id, opts)
                }

                const target = modules[id];
                if (target !== undefined) {                    
                    const { id } = ns.addAlias(target);
                    return ns.resolve(this, id, opts);
                }

                return undefined;
            }
        };
    }

    export function provide(modules: Record<string, string>): Plugin {
        const prefix = NameSpace.alloc();
        const globals = () => {
            const result: Record<string, string> = {};
            for (const [key, value] of Object.entries(modules)) {
                result[key] = `${prefix}${value}`;
            }

            return result;
        };

        const ns = new NameSpace();
        const { transform } = inject({ modules: globals() });
        return {
            name: "interop-alias",

            resolveId(id, _, opts) {
                if (ns.contains(id)) {
                    return ns.resolve(this, id, opts)
                }

                const hint = id;
                if (id.startsWith(prefix)) {
                    const target = hint.substring(prefix.length);
                    const { id } = ns.addAlias(target);
                    return ns.resolve(this, id, opts);
                }

                return undefined;
            },

            transform(code, id) {
                return transform?.call(this, code, id);
            }
        };
    }

    export function adhoc(state: Record<string, unknown>): Plugin {
        const str = JSON.stringify(state);
        const code = [
            `export const __exports = { __esModule: true };\n`,
            `Object.assign(__exports, ${str});\n`,
        ];

        for (const value of Object.values(state)) {
            if (typeof value === "function") {
                code.push(`Object.assign(__exports, { ${value.toString()} });\n`);
            }
        }

        return {
            name: "interop-adhoc",

            resolveId(id) {
                if (typeof state[id] === "function") {
                    return { id, syntheticNamedExports: "__exports" };
                }

                return undefined;
            },

            load(id) {
                if (typeof state[id] === "function") {
                    const result = [...code];
                    result.push(`__exports[${JSON.stringify(id)}]();\n`);

                    return result.join("");
                }

                return undefined;
            }
        };
    }
}

export default tools;
