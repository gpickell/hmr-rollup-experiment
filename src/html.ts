import type HMR from "./hmr/HotModuleContext";
import type { OutputChunk, Plugin } from "rollup";

import { mimeTypes } from "./defaults";
import path from "path";
import resolve from "./utils/resolve";
import sass from "sass";
import fs, { GlobMatch } from "./utils/fs";
import { FileOptimizers } from "./optimize";

const cwd = path.normalize(process.cwd() + "/");
const hmrIndex = resolve("./hmr/index");
const commentx = /^(\s*)<!--\s*([^\s]+)\s*(.*?)\s*-->\s*$/;
const crnlx = /\r?\n/;
const scssx = /\.(sass|s?css)$/;
const nmx = /[\\/]node_modules[\\/]/;
const slashx = /[\\/]+/g;

function loadStyle(hmr: HMR, data: string) {
    if (hmr.ready) {
        const style = document.createElement("style");
        style.append(document.createTextNode(data));

        const current = hmr.meta;
        const { head } = document;
        if (current instanceof HTMLStyleElement) {
            head.replaceChild(style, current);
        } else {
            head.append(style);
        }

        hmr.keep(style);
    }
}

namespace loadStyle {
    export const id = "\0loadStyle";

    export function toCode() {
        const code = [
            loadStyle.toString(),
            "\nexport default loadStyle;\n"
        ];

        return code.join("");
    }

    export function toStyle(text: string) {
        const code = [
            `import hmr from ${expand(hmrIndex)};\n`,
            `import loadStyle from ${expand(loadStyle.id)};\n`,
            `const css = ${expand(text)};\n`,
            `export function __start() {\n`,
            `    loadStyle(hmr, css);\n`,    
            `}\n`,
            `export default css;\n`,
        ];

        return code.join("");
    }
}

function expand(...args: string[]) {
    return args.map(x => JSON.stringify(x)).join(", ");
}

function slashify(fn: string) {
    return fn.replace(slashx, "/");
}

function relative(from: string, to: string) {
    const rel = path.relative(path.dirname(from), to);
    return slashify(rel);
}

export interface HtmlProcessor {
    (this: HtmlProcessorContext, lines: string[], args: string): Promise<void> | void;
}

export interface HtmlProcessorContext extends Map<string, Buffer> {
    readonly links: string[];
    readonly scripts: string[];

    copy(name: string, data: Buffer | string): string;
    emit(line: string): void;
    keep(): void;

    error(info: string): never;
    examine(line: string, args: string): [string, string, string] | undefined;
}

export class HtmlProcessors extends Map<string, HtmlProcessor> {
    static create(plugins: Plugin[]) {
        const result = new this();
        for (const { api } of plugins) {
            if (api instanceof this) {
                for (const [name, handler] of api) {
                    result.set(name, handler);
                }
            }
        }

        result.set("copy", function (lines, args) {
            for (const line of lines) {
                const result = this.examine(line, args);
                if (result !== undefined) {
                    const [prefix, href, suffix] = result;
                    const content = this.get(href);
                    if (content === undefined) {
                        this.error(`copy: ${href} not found.`);
                    }
    
                    const url = this.copy(href, content);
                    this.emit(`${prefix}${url}${suffix}`);
                }
            }
        });
    
        result.set("data", function (lines, args) {
            for (const line of lines) {
                const result = this.examine(line, args);
                if (result !== undefined) {
                    const [prefix, href, suffix] = result;
                    const content = this.get(href);
                    if (content === undefined) {
                        this.error(`data: ${href} not found.`);
                    }
    
                    const data = content.toString("base64");
                    const ext = path.extname(href);
                    const mimeType = mimeTypes[ext as keyof typeof mimeTypes];
                    const url = `data:${mimeType};base64,${data}`;
                    this.emit(`${prefix}${url}${suffix}`);
                }
            }
        });
    
        result.set("omit", () => {});
    
        result.set("links", function (lines, args) {
            for (const line of lines) {
                this.emit(line);
            }
    
            this.keep();
    
            if (args.length > 0) {
                args = ` ${args}`;
            }
    
            for (const script of this.links) {
                this.emit(`<link as="script" rel="preload" crossorigin href=${expand(script)}${args} />`);
            }
        });
    
        result.set("scripts", function (lines, args) {
            for (const line of lines) {
                this.emit(line);
            }
    
            this.keep();
    
            if (args.length > 0) {
                args = ` ${args}`;
            }
    
            for (const script of this.scripts) {
                this.emit(`<script src=${expand(script)}${args}></script>`);
            }
        });

        return result;
    }
}

function html(templatePath: string, whichPath = "index.html", ...patterns: (GlobMatch | string | string[])[]): Plugin {
    templatePath = path.resolve(process.cwd(), templatePath);

    if (patterns.length < 1) {
        patterns.push("**/index.html");
    }

    let processors: HtmlProcessors;
    const filter = fs.glob(...patterns);
    return {
        name: "interop-html",

        buildStart({ plugins }) {
            processors = HtmlProcessors.create(plugins);
        },
       
        async generateBundle(_, bundle) {
            const files = await fs.find(templatePath, "**/*");
            const contents = await fs.load(templatePath, files);
            for (const [fn, data] of contents) {
                contents.set(slashify(fn), data);
            }

            const template = contents.get(whichPath);
            if (template === undefined) {
                this.error(`${whichPath} does not exist.`);
            }

            const assets = new Map<string, OutputChunk[]>();
            for (const chunk of Object.values(bundle)) {
                if (chunk.type === "chunk" && chunk.isEntry) {
                    const fn = `${chunk.name}.html`;
                    if (filter(fn)) {
                        let chunks = assets.get(fn);
                        if (chunks === undefined) {
                            assets.set(fn, chunks = []);
                        }

                        chunks.push(chunk);
                    }
                }
            }

            for (const [fn, chunks] of assets) {
                const links: string[] = [];
                const queue = new Set(chunks);
                for (const chunk of queue) {
                    links.push(relative(fn, chunk.fileName));

                    for (const id of chunk.imports) {
                        const chunk = bundle[id];
                        if (chunk.type === "chunk") {
                            queue.add(chunk);
                        }
                    }

                    for (const id of chunk.dynamicImports) {
                        const chunk = bundle[id];
                        if (chunk.type === "chunk") {
                            queue.add(chunk);
                        }
                    }
                }

                const scripts: string[] = [];        
                for (const chunk of chunks) {
                    scripts.push(relative(fn, chunk.fileName));
                }

                let indent = "";
                const lines: string[] = [];
                const result: string[] = [];
                const html = template.toString().split(crnlx);
                const context: HtmlProcessorContext = Object.assign(contents, {
                    links,
                    scripts,

                    copy: (name: string, data: Buffer) => {
                        if (bundle[name] === undefined) {
                            this.emitFile({
                                type: "asset",
                                fileName: name,
                                source: data
                            });    
                        }
                        
                        return relative(fn, name);
                    },

                    emit(line: string) {
                        if (line[0] !== " ") {
                            lines.push(`${indent}${line}`);
                        } else {
                            lines.push(line);
                        }                        
                    },

                    keep() {
                        result.push(...lines);
                        lines.length = 0;
                    },

                    error: (text: string) => {
                        this.error(text);
                    },

                    examine(line: string, hint: string) {
                        const [prefix, suffix] = hint.split("*");
                        if (!prefix || !suffix) {
                            return undefined;
                        }

                        const i = line.indexOf(prefix) + prefix.length;
                        if (i < prefix.length) {
                            return undefined;
                        }

                        const temp = line.substring(i);
                        const j = temp.indexOf(suffix);
                        if (j < 0) {
                            return undefined;
                        }

                        const head = line.substring(0, i);
                        const data = temp.substring(0, j);
                        const tail = temp.substring(j);
                        return [head, data, tail] as [string, string, string];
                    }
                });

                for (const line of html) {
                    const match = line.match(commentx);
                    if (match) {
                        const [,, which, args] = match;
                        const processor = processors.get(which);
                        if (processor !== undefined) {
                            const input = [...lines];
                            lines.length = 0;

                            [, indent] = match;
                            await processor.call(context, input, args);
                        } else {
                            context.keep();
                            lines.push(line);
                        }
                    } else {
                        context.keep();
                        lines.push(line);
                    }
                }

                context.keep();

                this.emitFile({
                    type: "asset",
                    fileName: fn,
                    source: result.join("\n"),
                });
            }

            return undefined;
        }
    };
}

namespace html {
    export function emotion(prefix = "app", ...mask: (GlobMatch | string | string[])[]): Plugin {
        if (mask.length < 1) {
            mask = ["src/**/*.css"];
        }

        let optimizers: FileOptimizers;
        const filter = fs.glob(...mask);
        return {
            name: "interop-html-emotion",

            buildStart({ plugins }) {
                optimizers = FileOptimizers.create(plugins);
            },

            async resolveId(id, importer) {
                if (id === loadStyle.id) {
                    return id;
                }

                if (importer === undefined) {
                    return undefined;
                }

                if (importer[0] === "\0") {
                    return undefined;
                }

                if (importer.match(nmx)) {
                    return undefined;
                }

                if (id === "@emotion/css") {
                    return { id: `\0${id}`, syntheticNamedExports: "__exports"  };
                }

                return undefined;
            },

            async load(id) {
                if (id === loadStyle.id) {
                    return loadStyle.toCode();
                }

                if (id === "\0@emotion/css") {
                    const code = [
                        `import createInstance from "@emotion/css/create-instance";\n`,
                        `const key = ${JSON.stringify(prefix)};\n`,
                        `export const __exports = createInstance({ key });\n`,
                    ];

                    return code.join("");
                }

                if (id[0] === "\0") {
                    return undefined;
                }

                if (!id.startsWith(cwd)) {
                    return undefined;
                }

                const rel = path.relative(cwd, id);
                if (!filter(rel)) {
                    return undefined;
                }

                const { cache, css, flush, injectGlobal } = await import("@emotion/css");
                flush();

                const source = await fs.readFile(id, "utf-8");
                if (path.basename(id).startsWith("global.")) {
                    injectGlobal(source);

                    const values = Object.values(cache.inserted);
                    const text = await optimizers.process(id, values.join("\n"), "source");
                    return loadStyle.toStyle(text);
                }

                const name = "." + css(source);
                const values = Object.values(cache.inserted);
                const fixed = values.join("").split(name).join("&");
                const text = await optimizers.process(id, fixed, "source");
                const code = [
                    `import { css } from "@emotion/css";\n`,
                    `const className = css(${JSON.stringify(text)});\n`,
                    `export default className;\n`,
                ];

                return code.join("");
            }
        };
    }

    export function image(): Plugin {
        let optimizers: FileOptimizers;
        return {
            name: "interop-html-image",

            buildStart({ plugins }) {
                optimizers = FileOptimizers.create(plugins);
            },

            async load(id: string) {
                if (id[0] === "\0") {
                    return undefined;
                }

                const ext = path.extname(id) as keyof typeof mimeTypes;
                if (ext === ".css") {
                    return undefined;
                }

                const mimeType = mimeTypes[ext];
                if (mimeType) {
                    const image = await fs.readFile(id);
                    const data = await optimizers.process(id, image, "base64");
                    const url = `data:${mimeType};base64,${data}`;
                    const code = [
                        `const data = ${expand(url)};\n`,
                        `export default data;\n`,
                    ];

                    return code.join("");
                }

                return undefined;
            },            
        };
    }

    export function scss(): Plugin {
        let optimizers: FileOptimizers;
        return {
            name: "interop-html-sass",

            buildStart({ plugins }) {
                optimizers = FileOptimizers.create(plugins);
            },

            resolveId(id: string) {
                if (id === loadStyle.id) {
                    return id;
                }

                return undefined;
            },

            async load(id: string) {
                if (id === loadStyle.id) {
                    return loadStyle.toCode();
                }

                if (id[0] === "\0") {
                    return undefined;
                }

                if (!id.match(scssx)) {
                    return undefined;
                }

                const importer = async (id: string, importer: string) => {
                    const result = await this.resolve(id, importer);
                    return result?.external ? undefined : result?.id;
                };

                const options: sass.Options = {
                    file: id,
                    sourceMap: true,
                    sourceMapContents: true,
                    sourceMapEmbed: true,
                    importer: (url, src, done) => {
                        const resolve = (id?: string) => {
                            done?.(id ? { file: id } : null);
                        };

                        const reject = (error: Error) => {
                            done?.(error);
                        };

                        importer(url, src).then(resolve, reject);
                    }
                };
                
                const { css } = await new Promise<sass.Result>((resolve, reject) => {
                    sass.render(options, (ex, result) => {
                        ex && reject(ex);
                        resolve(result);
                    });
                });

                const text = await optimizers.process(id, css, "source");
                return loadStyle.toStyle(text);
            }
        };
    }
}

export default html;
