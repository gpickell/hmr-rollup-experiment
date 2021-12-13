import fs, { GlobMatch } from "./utils/fs";
import module from "module";

namespace builder {
    /*
    export async function dataUri(filePath: string, mimeType?: string) {
        filePath = path.resolve(process.cwd(), filePath);
        mimeType = mimeType ?? mimeTypes[path.extname(filePath)] ?? "application/octet-stream";
    
        const data = await fs.readFile(filePath);
        const tail = data.toString("base64");
        return `data:${mimeType};base64,${tail}`;
    }*/

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

    export const cjs = {
        extensions,
        ignoreGlobal: true,
        requireReturnsDefault: false,
        ignoreDynamicRequires: true,
        sourceMap: false,
        esmExternals: true,
    };

    export const resolve = {
        extensions,
        preferBuiltins: false,
    };

    export function glob(...patterns: (GlobMatch | string | string[])[]): GlobMatch {
        return fs.glob(...patterns);
    }
}

export default builder;
