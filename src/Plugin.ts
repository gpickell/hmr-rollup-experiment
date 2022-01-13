import path from "path/posix";
import type { Plugin as IPlugin } from "rollup";

interface Plugin extends Partial<IPlugin> {}

class Lookup extends Map<string, any[]> {}

let nextId = 0;
let nextMapper: Mapper | undefined;
const lookups = new WeakMap<IPlugin, Lookup>();
const cwd = path.normalize(process.cwd() + "/");

function add(key: string, item: any, map?: Lookup) {
    if (map) {
        const list = map.get(key) ?? [];
        list.push(item);
        map.set(key, list);
    }
}

class Mapper extends Lookup {
    lookup?: Lookup;

    add<T>(hints: any, cls: new () => T, props: T) {
        const inst = Object.assign(new cls(), props);
        if (Array.isArray(hints)) {
            for (const item of hints) {
                const hint = typeof item !== "string" ? JSON.stringify(item) : item;
                add(hint, inst, this);
                add(hint, inst, this.lookup);
            }
        } else {
            if (typeof hints !== "string") {
                hints = JSON.stringify(hints);
            }

            add(hints, inst, this);
            add(hints, inst, this.lookup);    
        }

        return inst;
    }

    *find<T>(hint: any, cls: new () => T) {
        if (typeof hint !== "string") {
            hint = JSON.stringify(hint);
        }

        const list = this.lookup?.get(hint);
        if (list !== undefined) {
            for (const inst of list) {
                if (inst instanceof cls) {
                    yield inst;
                }
            }
        }
    }
}

class Plugin {
    static id(ns: string) {
        return `${ns}${nextId++}`;
    }

    static ns(name: string) {
        return `\0ns@${nextId++}@${name}?`;
    }

    static path(dir: string) {
        dir = path.resolve(dir);
        dir = path.normalize(dir + "/");

        return dir;
    }

    static mapper() {
        return nextMapper ?? (nextMapper = new Mapper());
    }

    static build(plugin: IPlugin): IPlugin {
        let root: IPlugin;
        let self: IPlugin;
        const mapper = this.mapper();
        nextMapper = undefined;

        return self = {
            ...plugin,

            buildStart(opts) {
                if (root === undefined) {
                    let lookup: Lookup | undefined;
                    const { plugins } = opts;
                    for (const plugin of plugins) {
                        lookup = lookups.get(plugin);

                        if (lookup !== undefined) {
                            root = plugin;
                            mapper.lookup = lookup;
                            break;
                        }
                    }

                    if (lookup === undefined) {
                        root = self;
                        lookups.set(self, lookup = mapper.lookup = new Lookup());
                    }

                    for (const [key, list] of mapper) {
                        for (const inst of list) {
                            add(key, inst, lookup);
                        }
                    }
                }
                
                if (plugin.buildStart) {
                    return plugin.buildStart.call(this, opts);
                }

                return undefined;
            },

            async resolveId(id, importer, opts) {
                if (self === root) {
                    for (const plugin of mapper.find({ id }, Plugin)) {
                        const result = await plugin.resolveId?.call(this, id, importer, opts);    
                        if (result !== undefined) {
                            return result;
                        }
                    }

                    if (id.startsWith("\0ns@")) {
                        const ns = id.substring(0, id.indexOf("?") + 1);
                        for (const plugin of mapper.find({ ns }, Plugin)) {
                            const result = await plugin.resolveId?.call(this, id, importer, opts);    
                            if (result !== undefined) {
                                return result;
                            }
                        }
                    }
                }
                
                return await plugin.resolveId?.call(this, id, importer, opts);
            },

            async load(id) {
                if (self === root) {
                    for (const plugin of mapper.find({ id }, Plugin)) {
                        const result = await plugin.load?.call(this, id);
                        if (result !== undefined) {
                            return result;
                        }
                    }

                    if (id.startsWith("\0ns@")) {
                        const ns = id.substring(0, id.indexOf("?") + 1);
                        for (const plugin of mapper.find({ ns }, Plugin)) {
                            const result = await plugin.load?.call(this, id);
                            if (result !== undefined) {
                                return result;
                            }
                        }                        
                    }

                    if (id.startsWith(cwd)) {
                        const ext = path.extname(id);
                        for (const plugin of mapper.find({ ext }, Plugin)) {
                            const result = await plugin.load?.call(this, id);
                            if (result !== undefined) {
                                return result;
                            }
                        }
                    }
                }

                return await plugin.load?.call(this, id);
            },
        };
    }
}

export default Plugin;
