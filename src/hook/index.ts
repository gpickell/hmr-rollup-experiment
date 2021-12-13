export interface Hook {
    (id: string, hint: string, def: (id: string, hint: string) => any): any;
}

const globalThis = (new Function("return this"))();

const def = Object.create(null);
Object.assign(def, { default: undefined, __esModule: true, __missing: true });
Object.freeze(def);

async function __create(id: string) {
    const result = Object.create(def);
    Object.assign(result, { __id: id });
    Object.freeze(result);

    return result;
}

async function __derive(id: string) {
    if (id === "globalThis") {
        return globalThis;
    }

    return undefined;
}

async function __global(id: string, hint: string) {
    const { hook } = __global;
    return await (hook ?? __derive)(id, hint, __derive);
}

namespace __global {
    export let hook: Hook | undefined;
}

async function __import(id: string, hint: string) {
    const { hook } = __import;
    return await (hook ?? __create)(id, hint, __create);
}

namespace __import {
    export let hook: Hook | undefined;
}

export { __import, __global };
