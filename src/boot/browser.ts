import * as hook from "../hook";

const global = Object.create(null);
const process = Object.create(null);
const env = Object.create(null);
Object.assign(global, {
    process,
});

Object.assign(process, {
    env,
    version: "",
    versions: {
        browser: navigator.userAgent,
        electron: "",
        node: "",
    }
});

export function __global(id: string, hint: string, def: (id: string, hint: string) => any) {
    if (id === "global") {
        return global;
    }

    if (id === "process") {
        return global.process;
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
