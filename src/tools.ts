import type { Plugin } from "rollup";
import inject from "@rollup/plugin-inject";
import NameSpace from "./utils/NameSpace";

import fs, { GlobMatch } from "./utils/fs";
import path from "path";
import os from "os";

const cwd = path.normalize(process.cwd() + "/");
const globx = /^(.*?)([^\\/]*\*.*)$/;
const relx = /^\.\.?\//;
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

    function findBase(files: string[]) {
        files.sort();
        
        const [head, ...rest] = files;
        if (head === undefined) {
            return ".";
        }

        const tail = rest.pop();
        if (tail === undefined) {
            return path.dirname(head);
        }

        const j = Math.min(head.length, tail.length);
        for (let i = 0; i < j && head[i] === tail[i]; i++) {}

        const prefix = head.substring(0, j);
        const [base] = prefix.match(/^(.*[\\/])?/)!;
        return base;
    }

    export function copy(root: string, dest = ".", ...patterns: (GlobMatch | string | string[])[]): Plugin {
        if (patterns.length < 1) {
            patterns = ["**/*"];
        }

        root = root.replace(/!/, "/node_modules/");
        root = path.resolve(path.join(process.cwd(), root));

        const filter = fs.glob(...patterns);
        return {
            name: "interop-copy",

            async generateBundle() {
                const files = await fs.find(root, filter);
                const base = findBase(files);
                for (const [file, data] of await fs.load(root, files)) {
                    const fn = file.substring(base.length);
                    this.emitFile({
                        type: "asset",
                        fileName: path.join(dest, fn),
                        source: data,
                    });
                }
            }
        };
    }

    export function xcopy(root: string, dest = ".", ...patterns: (GlobMatch | string | string[])[]): Plugin {
        if (patterns.length < 1) {
            patterns = ["**/*"];
        }

        root = root.replace(/!/, "/node_modules/");
        root = path.resolve(path.join(process.cwd(), root));

        const copy = async (dest: string, base: string, fn: string) => {
            const to = path.join(dest, fn.substring(base.length));
            if (await fs.exists(to) !== "file") {
                const dir = path.dirname(to);
                await fs.mkdir(dir, { recursive: true });

                const from = path.resolve(root, fn);
                await fs.copyFile(from, to);
            }
        };

        const filter = fs.glob(...patterns);
        return {
            name: "interop-xcopy",

            async writeBundle({ dir }) {                
                const files = await fs.find(root, filter);
                const base = findBase(files);
                const to = path.resolve(process.cwd(), dir ?? "dist", dest);
                const copies = files.map(x => copy(to, base, x));
                await Promise.all(copies);
            }
        };
    }

    export function observe(fn: () => any): Plugin {
        let waiter: Promise<void> | undefined;
        return () => {
            return {
                name: "interop-observe",
    
                async buildStart() {
                    if (waiter === undefined) {
                        waiter = (async () => { await fn() })();
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

    async function climb(dir: string, hint: string) {
        dir = path.resolve(dir);

        let last: any;
        while (dir !== last) {
            const dn = path.resolve(dir, "node_modules", hint);
            if (await fs.exists(dn) === "dir") {
                return dir;
            }

            last = dir;
            dir = path.dirname(dir);
        }

        return undefined;
    }

    export function glob(): Plugin {
        const ns = new NameSpace();
        return {
            name: "interop-glob",

            buildStart() {
                ns.clear();
            },
    
            async resolveId(id, importer, opts) {
                if (ns.contains(id)) {
                    return ns.resolve(this, id, opts);
                }

                if (id[0] === "\0" || importer?.[0] === "\0") {
                    return undefined;
                }

                const match = id.match(globx);
                if (match !== null) {
                    const [, hint, pattern] = match;
                    if (importer !== undefined) {
                        importer = path.dirname(importer);

                        if (!id.match(relx)) {
                            importer = await climb(importer, hint);

                            if (importer === undefined) {
                                return undefined;
                            }
                        }
                    } else {
                        if (id.match(relx)) {
                            return undefined;
                        }

                        importer = cwd;
                    }
       
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
            name: "interop-provide",

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

    export function adhoc(name: string, state: Record<string, unknown>): Plugin {
        const ns = new NameSpace();
        ns.addAdhoc(name, state);
        
        return {
            name: "interop-adhoc",

            resolveId(id, _, opts) {
                if (ns.has(id)) {
                    return ns.resolve(this, id, opts);
                }

                if (typeof state[id] === "function") {
                    return ns.addResult(name, id);
                }

                return undefined;
            },

            load(id) {
                return ns.load(id);
            }
        };
    }
}

export default tools;
