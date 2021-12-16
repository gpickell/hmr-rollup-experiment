import type { Plugin } from "rollup";
import type { MinifyOptions as JsTerserOptions } from "terser";
import type { Options as HtmlMinifierOptions } from "html-minifier";
import type { OptimizeOptions as SvgOptimizeOptions } from "svgo";

import type CleanCSS from "clean-css";

import path from "path";

export interface FileOptimizer {
    (file: string, content: string | Buffer): Promise<string | Buffer> | string | Buffer;
}

const converters = {
    asset(data: Data) {
        if (typeof data === "string") {
            return data;
        }

        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    },

    base64(data: Data) {
        if (typeof data === "string") {
            return Buffer.from(data, "utf-8").toString("base64");
        }

        const result = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        return result.toString("base64");
    },

    source(data: Data) {
        if (typeof data === "string") {
            return data;
        }

        const result = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        return result.toString("utf-8");
    }
};

type Data = string | ArrayBufferView;
type Converters = typeof converters;

class API {}

export class FileOptimizers extends Map<string, FileOptimizer[]> {
    add(type: string, fh: FileOptimizer) {
        let list = this.get(type);
        if (list === undefined) {
            this.set(type, list = []);
        }

        list.push(fh);
    }

    async process<K extends keyof Converters>(fn: string, content: Data, result: K) {
        const type = path.extname(fn);
        const list = this.get(type);
        if (list !== undefined) {
            for (const fh of list) {
                let data: string | Buffer;
                if (ArrayBuffer.isView(content)) {
                    data = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
                } else {
                    data = content;
                }

                content = await fh(fn, data);
            }
        }

        return converters[result](content) as ReturnType<Converters[K]>;
    }

    static create(plugins: Plugin[]) {
        let skip = true;
        const result = new this();
        for (const { api } of plugins) {
            if (api instanceof API) {
                skip = false;
            }

            if (api instanceof this) {
                for (const [type, handlers] of api) {
                    for (const handler of handlers) {
                        result.add(type, handler);
                    }
                }
            }
        }

        if (skip) {
            result.clear();
        }

        return result;
    }
}

function optimize(): Plugin {
    let optimizers: FileOptimizers;
    return {
        name: "interop-optimize",
        api: new API(),

        buildStart({ plugins }) {
            optimizers = FileOptimizers.create(plugins);
        },

        async generateBundle(_, bundle) {
            for (const [fn, asset] of Object.entries(bundle)) {
                const type = path.extname(fn);
                if (asset.type === "asset") {
                    if (optimizers.has(type)) {
                        asset.source = await optimizers.process(fn, asset.source, "asset");
                    }
                }

                if (asset.type === "chunk") {
                    if (optimizers.has(type)) {
                        asset.code = await optimizers.process(fn, asset.code, "source");
                    }
                }
            }
        }
    }
}

namespace optimize {
    export function cssClean(options: CleanCSS.OptionsOutput = {}) {
        let current: CleanCSS.MinifierPromise | undefined;
        const optimizer: FileOptimizer = async (_, data) => {
            const { default: CleanCSS } = await import("clean-css");
            const cleaner = current ?? new CleanCSS({ ...options, returnPromise: true });
            current = cleaner;

            const { styles } = await cleaner.minify(data.toString());
            return styles;
        };

        const api = new FileOptimizers();
        api.add(".css", optimizer);
        api.add(".sass", optimizer);
        api.add(".scss", optimizer);

        return {
            name: "interop-css-clean",
            api,
        };
    }

    export function htmlMinifier(options?: HtmlMinifierOptions) {
        options = {
            collapseWhitespace: true,
            ...(options ?? {}),
        };

        const optimizer: FileOptimizer = async (_, data) => {
            console.log("---");
            console.log(data);
            const { minify } = await import("html-minifier");
            const result = minify(data.toString(), options);
            console.log("---");
            console.log(result);
            return result;
        };

        const api = new FileOptimizers();
        api.add(".html", optimizer);

        return {
            name: "interop-optimize-html-minifier",
            api,
        };
    }

    export function jsTerser(options?: JsTerserOptions): Plugin {
        const optimizer: FileOptimizer = async (_, data) => {
            const { minify } = await import("terser");
            const { code } = await minify(data.toString(), options);
            return code ?? data;
        };

        const api = new FileOptimizers();
        api.add(".js", optimizer);
        api.add(".cjs", optimizer);
        api.add(".mjs", optimizer);

        return {
            name: "interop-optimize-js-terser",
            api,
        };
    }

    export function svgOptimizer(options?: SvgOptimizeOptions) {
        const optimizer: FileOptimizer = async (_, data) => {
            const { optimize } = await import("svgo");
            const { data: result } = optimize(data, options);
            return result;
        };

        const api = new FileOptimizers();
        api.add(".svg", optimizer);

        return {
            name: "interop-svg-optimizer",
            api,
        };
    }
}

export default optimize;