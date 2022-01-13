import type { PluginContext, ResolveIdResult } from "rollup";
import resolve from "./resolve";

const hmrRuntime = resolve("./hmr/runtime");
const hookIndex = resolve("./hook/index");

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

class EntryModule extends Module {
    hint: string;
    targets: string | string[];
    track: boolean;

    constructor(hint: string, targets: string | string[], track: boolean) {
        super();
        this.hint = hint + ".json";
        this.targets = targets;
        this.track = track;
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

        if (!this.track) {
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

    async load(id: string, emit?: string) {
        const module = this.get(id);
        if (module !== undefined) {
            let { code } = module;
            if (code === undefined) {
                code = module.code = await module.load();
            }

            if (emit) {
                console.log("---", emit, id);
                console.log(code);
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

        const result = module.resolve();
        if (typeof result === "string") {
            this.set(result, module);
        } else if (result && !result.external) {
            this.set(result.id, module);
        }

        return result as ReturnType<T["resolve"]>;
    }

    addExternal(id: string, hint: string) {
        return this.register(["external", id, hint], () => new ExternalModule(id, hint));
    }

    addGlobal(name: string, hint: string) {
        return this.register(["global", name, hint], () => new GlobalModule(name, hint));
    }

    addEntry(name: string, targets: string | string[], track: boolean) {
        return this.register(nextId++, () => new EntryModule(name, targets, track));
    }

    addHot(ref: string) {
        return this.register(["hmr", ref], () => new HotModule(ref));
    }
}

export default NameSpace;
