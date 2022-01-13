import { defineConfig } from "rollup";

import bundle from "dist/bundle";
import compile from "dist/compile";
import hoist from "dist/hoist";
import html from "dist/html";
import optimize from "dist/optimize";
import resolve from "dist/resolve";
import tools from "dist/tools";

const env = {
    NODE_ENV: "production"
};

const src = [
    "experiments/**",
    "!**/node_modules/**",
];

const base = "experiments/hmr-emotion/src";

export default defineConfig({
    output: {
        dir: "experiments/dist",
    },
    plugins: [
        bundle(),
        bundle.hmr(base),
        bundle.search(base),
        bundle.classify("browser-entry", (name, id) => {
            return {
                name: "index",
                imports: [
                    "!dist/boot",
                    "!dist/boot/browser",
                    "!dist/boot/hmr-connect-ws",
                    "!./**/global.scss",
                    "adhoc/setup",
                    id,    
                ]
            };
        }),

        tools.clean(),
        tools.bind(),
        tools.root("!", base),
        tools.glob(),

        html("experiments/hmr-emotion/public"),
        html.emotion("app", "experiments/**/*.scss"),
        html.image(),

        compile.swc(),
        resolve.cjs(),
        resolve.node(),

        tools.adhoc("adhoc", {
            env,

            setup() {
                Object.assign(process.env, this.env);
            }
        }),

        hoist.externals({ hintMask: src }),
        hoist.globals({ hintMask: src }),

        // optimize(),
        // optimize.htmlMinifier(),
        // optimize.cssClean(),
    ],
    watch: {
        include: [
            "dist/**",
            "experiments/**",
        ]
    }
});
