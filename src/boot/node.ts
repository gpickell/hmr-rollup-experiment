import * as hook from "../hook";

export function __global(id: string, hint: string, def: (id: string, hint: string) => any) {
    if (id === "global") {
        return globalThis;
    }

    if (id === "process") {
        return globalThis.process;
    }

    return def(id, hint);
}

export function __import(id: string) {    
    return import(id);
}

export function init() {
    hook.__global.hook = __global;
    hook.__import.hook = __import;
}

export function __start() {
    init();
}
