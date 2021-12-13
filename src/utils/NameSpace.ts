import type { PluginContext, ResolveIdResult } from "rollup";
import resolve from "./resolve";
import switches from "./switches";

import fs from "../utils/fs";
import path from "path";

const hmrRuntime = resolve("./hmr/runtime");
const hookIndex = resolve("./hook/index");

const bangx = /^(.*?)!(.*)/;
const slashx = /[\\/]+/;
let nextId = 0;

function expand(...values: any[]) {
    return values.map(x => JSON.stringify(x)).join(", ");
}

export class Module {
    id!: string;
    code?: string;

    load(): Promise<string | undefined> | string | undefined {
        return undefined;
    }

    resolve(): ResolveIdResult {
        return undefined;
    }

    route(): [string, string] | string | undefined {
        return undefined;
    }
}

class ExternalModule extends Module {
    name: string;
    hint: string;

    constructor(name: string, hint: string) {
        super();
        this.name = name;
        this.hint = hint;
    }

    resolve() {
        return { id: this.id, syntheticNamedExports: "__exports" };
    }

    load() {
        const code = [
            `import { __import } from ${expand(hookIndex)};\n`,
            `export const __exports = await __import(${expand(this.name, this.hint)});\n`,
        ];

        return code.join("");
    }
}

class GlobalModule extends Module {
    name: string;
    hint: string;

    constructor(name: string, hint: string) {
        super();
        this.name = name;
        this.hint = hint;
    }

    resolve() {
        return { id: this.id };
    }

    load() {
        const code = [
            `import { __global } from ${expand(hookIndex)};\n`,
            `const value = await __global(${expand(this.name, this.hint)});\n`,
            `export default value;\n`,
        ];

        return code.join("");
    }
}

class HotModule extends Module {
    ref: string;

    constructor(ref: string) {
        super();
        this.ref = ref;
    }

    resolve() {
        return { id: this.id };
    }

    load() {
        const code = [
            `import { create } from ${expand(hmrRuntime)};\n`,
            `const hmr = create(${expand(this.ref)}, import.meta.ver);\n`,
            `export default hmr;\n`,
        ];

        return code.join("");
    }
}

class AliasModule extends Module {
    hint: string;
    importer?: string;

    constructor(hint: string) {
        super();

        const match = hint.match(bangx);
        if (match) {
            [, this.importer, this.hint] = match;
            this.importer = path.resolve(process.cwd(), this.importer, "__dummy__");
        } else {
            this.hint = hint;
        }    
    }

    resolve() {
        return { id: this.id };
    }

    route(): [string, string] | string {
        const { hint, importer } = this;
        return importer ? [hint, importer] : hint;
    }
}

class EntryModule extends Module {
    hint: string;
    targets: string | string[];

    constructor(ns: NameSpace, hint: string, targets: string | string[]) {
        super();
        this.hint = hint + ".json";

        if (Array.isArray(targets)) {
            this.targets = targets.map(x => {
                const { id } = ns.addAlias(x);
                return id;
            });
        } else {
            this.targets = targets;
        }
    }

    resolve() {
        if (Array.isArray(this.targets)) {
            return { id: this.id, syntheticNamedExports: "__exports" };
        }

        return { id: this.id };
    }

    load() {
        const hmr = [
            `import { track } from ${expand(hmrRuntime)};\n`,
            `track(import.meta.url, ${expand(this.hint)});\n`,
        ];

        if (!switches.hmrEnabled) {
            hmr.length = 0;
        }

        const { targets } = this;
        if (Array.isArray(targets)) {
            const [ boot, ...rest ] = targets;
            const imports = rest.map(x => `    () => import(${expand(x)}),\n`);
            const code = [
                ...hmr,
                `import boot from ${expand(boot)};\n`,    
                `export const __exports = await boot(\n`,
                ...imports,
                `);\n`
            ];

            return code.join("");
        }

        const code = [
            ...hmr,
            `export * from ${expand(targets)};\n`,
            `import * as __module from ${expand(targets)};\n`,
            `const { default: __default } = __module;\n`,
            `export default __default;\n`
        ];

        return code.join("");
    }
}

class GlobModule extends Module {
    dir: string;
    pattern: string;

    constructor(dir: string, pattern: string) {
        super();
        this.dir = dir;
        this.pattern = pattern;
    }

    resolve() {
        return { id: this.id };
    }

    async load() {
        const tail = [
            "export async function __start() {\n",
            "    const list = Object.values(modules);\n",
            "    const promises = list.map(async x => (await x()).__start?.());\n",
            "    return Promise.all(promises);\n",
            "}\n",
        ];
        
        const { dir, pattern } = this;
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
}

class NameSpace extends Map<string, Module> {
    static readonly all = new Map<string, NameSpace>();
    
    static alloc() {
        return `\0ns${nextId++}?`;
    }

    readonly id = nextId++;
    readonly prefix = `\0ns${this.id}?`;    

    constructor() {
        super();
        NameSpace.all.set(this.prefix, this);
    }

    contains(id: string) {
        return id.startsWith(this.prefix);
    }

    async resolve(context: PluginContext, id: string, opts: any) {
        const module = this.get(id);
        if (module !== undefined) {
            const target = module.route();
            if (target !== undefined) {
                let id: string;
                let importer: string | undefined;
                if (Array.isArray(target)) {
                    [id, importer] = target;
                } else {
                    id = target;
                }
        
                const result = await context.resolve(id, importer, { ...opts, skipSelf: true});
                if (result === undefined) {
                    context.error(`Could not resolve: ${id}, importer = ${importer}`);
                }

                return result;
            }
        
            const result = module.resolve();
            if (result !== undefined) {
                return result;
            }            
        }

        return undefined;
    }

    async load(id: string) {
        const module = this.get(id);
        if (module !== undefined) {
            let { code } = module;
            if (code === undefined) {
                code = module.code = await module.load();
            }

            return code;
        }

        return undefined;
    }

    register<T extends Module>(key: any, factory: () => T) {
        key = JSON.stringify(Array.isArray(key) ? key : [key]);

        const current = this.get(key) as T | undefined;
        if (current !== undefined) {
            return current.resolve() as ReturnType<T["resolve"]>;
        }

        const id = `${this.prefix}${nextId++}`;
        const module = factory();
        module.id = id;
        this.set(id, module);
        this.set(key, module);

        return module.resolve() as ReturnType<T["resolve"]>;
    }

    addAlias(hint: string) {
        return this.register(["alias", hint], () => new AliasModule(hint));
    }

    addExternal(id: string, hint: string) {
        return this.register(["external", id, hint], () => new ExternalModule(id, hint));
    }

    addGlobal(name: string, hint: string) {
        return this.register(["global", name, hint], () => new GlobalModule(name, hint));
    }

    addEntry(name: string, targets: string | string[]) {
        return this.register(["entry", nextId++], () => new EntryModule(this, name, targets));
    }

    addGlob(dir: string, pattern: string) {
        return this.register(["glob", dir, pattern], () => new GlobModule(dir, pattern));
    }

    addHot(ref: string) {
        return this.register(["hmr", ref], () => new HotModule(ref));
    }
}

export default NameSpace;
