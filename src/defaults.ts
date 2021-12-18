import module from "module";

export const externals = [
    "electron",
    ...module.builtinModules
];

export const extensions = [
    ".mjs",
    ".cjs",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
];

export const globals = [
    "__dirname",
    "__filename",
    "__url",
    "global",
    "globalThis",
    "module",
    "process",
    "require",
];

export enum mimeTypes {
    ".css" = "text/css;charset=utf-8",
    ".gif" = "image/gif",
    ".ico" = "image/x-icon",
    ".jpg" = "image/jpeg",
    ".png" = "image/png",
    ".svg" = "image/svg+xml;charset=utf-8",        
};
