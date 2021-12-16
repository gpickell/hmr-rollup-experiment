import { defineConfig } from "rollup";

import fs from "fs/promises";
import path from "path";
import typescript from "@rollup/plugin-typescript";

const src = path.normalize(process.cwd() + "/src/");
const relx = /^\.\.?\//;

function autoIndex() {
    return {
        name: "uato-index",
        async generateBundle(_, bundle) {
            const mjsx = /\.[cm]?js$/;
            const indexx = /\/index$/;
            const slashx = /[\\/]+/g;
            const exports = {
                "./package": "./package.mjs"
            };

            for (const chunk of Object.values(bundle)) {
                if (chunk.type === "chunk" && chunk.isEntry) {
                    let from = ("./" + chunk.name).replace(slashx, "/");
                    const to =("./" + chunk.fileName).replace(slashx, "/");
                    from = from.replace(mjsx, "");
                    exports[from] = to;
                    
                    from = from.replace(indexx, "");
                    exports[from] = to;
                }
            }

            const { devDependencies, ...json } = JSON.parse(await fs.readFile("package.json", "utf-8"));
            Object.assign(json, { exports });

            const source = JSON.stringify(json, undefined, 4);
            this.emitFile({
                type: "asset",
                fileName: "package.json",
                source,
            });

            const code = [
                `export const { url } = import.meta;\n`,
                `export default ${source};\n`,
            ];

            this.emitFile({
                type: "asset",
                fileName: "package.mjs",
                source: code.join(""),
            });
        }
    }
}

const inputs = [
    "builder",
    "bundle",
    "compile",
    "hoist",
    "html",
    "tools",
    "optimize",

    "hook/index",
    "hmr/index",
    "hmr/runtime",

    "boot/index",
    "boot/browser",
    "boot/node",
    "boot/hmr-connect-fs",
    "boot/hmr-connect-fetch",
    "boot/hmr-connect-ws",

    "utils/createDevServer",
    "utils/createRequestHandler",
    "utils/createSocketHandler",
    "utils/NameSpace",
];

export default defineConfig({
    input: Object.fromEntries(inputs.map(x => [x, `src/${x}.ts`])),

    output: {
        format: "es",
        dir: "dist",
        sourcemap: "inline",
        chunkFileNames: "[name].[hash].mjs",
        entryFileNames: info => `${info.name}.mjs`,
    },
    external: id => {
        if (id.match(relx)) {
            return false;
        }

        if (id.startsWith(src)) {
            return false;
        }

        return true;
    },
    plugins: [
        typescript(),
        autoIndex(),
    ],
    watch: {
        include: "src/**",
    }
});
