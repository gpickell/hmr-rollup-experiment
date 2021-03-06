import Plugin from "./Plugin"

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

    export function root(prefix: string, dir: string)  {
        return Plugin.build({
            name: "interop-root",

            resolveId(id, _, opts) {
                if (id.startsWith(prefix)) {
                    id  = id.substring(prefix.length);
                    
                    const importer = path.resolve(cwd, dir, "__dummy__");
                    return this.resolve(id, importer, opts);
                }

                return undefined;
            }
        });
    }

    export function glob(prefix = "src") {
        const map = new Map<string, [string, string, string]>();
        const ns = Plugin.ns("glob");
        const mapper = Plugin.mapper();
        mapper.add({ ns }, Plugin, {
            resolveId(id) {
                return { id };
            },

            async load(id) {
                const tail = [
                    "export async function __start() {\n",
                    "    const list = Object.values(modules);\n",
                    "    const promises = list.map(async x => (await x()).__start?.());\n",
                    "    return Promise.all(promises);\n",
                    "}\n",
                ];

                const [dir, pattern] = map.get(id)!;
                const code = ["const modules = {"];
                for (const fn of await fs.find(dir, pattern)) {
                    if (code.length > 1) {
                        code.push(",");
                    }
        
                    const name = fn.replace(slashx, "/");
                    const fp = path.resolve(dir, fn);
                    code.push("\n    ");
                    code.push(JSON.stringify(name));
                    code.push(": () => import(");
                    code.push(JSON.stringify(fp));
                    code.push(")");
                }
        
                if (code.length > 1) {
                    code.push("\n");
                }
        
                code.push("};\n");
                code.push("export default modules;\n");
                code.push("\n");
                code.push(...tail);
        
                return code.join("");                
            }
        });
        
        return Plugin.build({
            name: "interop-glob",

            buildStart() {
                map.clear();
            },

            async resolveId(id, importer) {
                if (id[0] === "\0") {
                    return undefined;
                }

                const match = id.match(globx);
                if (match !== null) {
                    const [, hint, pattern] = match;
                    if (importer !== undefined && id.match(relx)) {
                        importer = path.dirname(importer);          
                    } else if (id.match(relx)) {
                        return undefined;
                    } else {
                        importer = path.resolve(cwd, prefix);
                    }
      
                    const dir = path.resolve(importer, hint);
                    const temp = path.normalize(dir + "/");
                    if (temp.startsWith(cwd)) {
                        const key = JSON.stringify([dir, pattern]);
                        const entry = map.get(key) ?? [dir, pattern, Plugin.id(ns)];
                        const [,, id] = entry;
                        map.set(id, entry);
                        map.set(key, entry);

                        return { id };
                    }
                }
    
                return undefined;
            }
        });
    }

    export function alias(modules: Record<string, string>) {
        const mapper = Plugin.mapper();
        for (const [id, name] of Object.entries(modules)) {
            mapper.add({ id }, Plugin, {
                resolveId(_, importer, opts) {
                    return this.resolve(name, importer, opts);
                }
            });
        }

        return Plugin.build({ name: "interop-alias" });
    }

    export function adhoc(name: string, state: Record<string, unknown>) {
        const hints = [] as any[];
        for (const id in state) {
            if (typeof state[id] === "function") {
                hints.push({ id: `${name}/${id}` });
            }
        }

        const mapper = Plugin.mapper();
        const syntheticNamedExports = "__exports";
        mapper.add({ id: name }, Plugin, {
            resolveId(id) {
                return { id, syntheticNamedExports };
            },

            load() {
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

                return code.join("");
            },
        });

        mapper.add(hints, Plugin, {
            resolveId(id) {
                return { id, syntheticNamedExports };
            },

            load(id) {
                id = id.substring(name.length + 1);
                
                const code = [
                    `import * as __imports from ${JSON.stringify(name)};\n`,
                    `export const __exports = { __esModule: true };\n`,
                    `const __results = await __imports[${JSON.stringify(id)}]();\n`,
                    `__results && Object.assign(__exports, __results);\n`,
                ];

                return code.join("");
            },
        });

        return Plugin.build({ name: "interop-adhoc" });
    }
}

export default tools;
