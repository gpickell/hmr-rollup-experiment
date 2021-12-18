import type { LoadResult, Plugin } from "rollup";
import type { JscConfig, JscTarget } from "@swc/core";

import { extensions } from "./defaults";
import fs from "./utils/fs";
import path from "path";

const jsextx = /\.[cm]?js$/;

namespace compile {
    let target: JscTarget = "es2019";

    class PresetBase {
        constructor(__target: JscTarget) {
            target = __target;
        }
    }

    export class Preset extends PresetBase {
        ts: JscConfig = {
            target,

            parser: {
                syntax: "typescript",
                decorators: true,
                dynamicImport: true,
                tsx: false,
            },

            transform: {
                legacyDecorator: true,
                decoratorMetadata: true,
            }
        };

        tsx: JscConfig = {
            target,

            parser: {
                syntax: "typescript",
                decorators: true,
                dynamicImport: true,
                tsx: true,
            },

            transform: {
                react: {
                    runtime: "automatic",
                    importSource: "react",
                },

                legacyDecorator: true,
                decoratorMetadata: true,
            }
        };

        js: JscConfig = {
            target,

            parser: {
                syntax: "ecmascript",
            },

            transform: this.ts.transform,
        };

        jsx: JscConfig = {
            target,
            
            parser: {
                syntax: "ecmascript",
                jsx: true,
            },

            transform: this.tsx.transform,
        };

        cache = new Map<string, [mtime: bigint, promise: Promise<LoadResult>]>();

        select(ext: string) {
            if (ext === ".ts") {
                return this.ts;
            }

            if (ext === ".tsx") {
                return this.tsx;
            }

            if (ext === ".jsx") {
                return this.jsx;
            }

            return this.js;
        }
    }

    const def = new Preset("es2019");

    export function swc(preset = def, js = false): Plugin {
        const { cache } = preset;
        const exts = new Set(extensions);
        return {
            name: "interop-compiler-swc",

            async load(id) {
                if (id[0] === "\0") {
                    return undefined;
                }

                const ext = path.extname(id);
                if (!exts.has(ext)) {
                    return undefined;
                }

                const stats = await fs.stat(id, { bigint: true });
                const result = cache.get(id);
                if (result !== undefined) {
                    const [mtime, promise] = result;
                    if (mtime >= stats.mtimeNs) {
                        return await promise;
                    }
                }

                const mtime = stats.mtimeNs;
                const compile = async () => {
                    const source = await fs.readFile(id, "utf-8");
                    if (!js && source.match(jsextx)) {
                        return { code: source };
                    }

                    const swc = await import("@swc/core");
                    const { code, map } = await swc.transform(source, {
                        jsc: preset.select(ext),
                        filename: id,
                        sourceMaps: true,
                        inlineSourcesContent: true,
                    });

                    return { code, map };
                };

                const promise = compile();
                cache.set(id, [mtime, promise]);

                return await promise;
            },
        };
    }
}

export default compile;
