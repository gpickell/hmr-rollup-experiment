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

export default defineConfig({
    output: {
        dir: "experiments/dist",
    },
    plugins: [
        bundle(),
        bundle.hmr(src),
        bundle.search("experiments/hmr-browser/src"),
        bundle.classify("browser-entry", (name, id) => {
            const list = [
                "experiments!dist/boot",
                "experiments!dist/boot/browser",
                "experiments!dist/boot/hmr-connect-ws",
                "experiments/hmr-browser/src/**/*.{css,sass,scss}",
                "setup",
                id,
            ];

            name = "index";
            return { [name]: list };
        }),

        tools.clean(),
        tools.bind(),
        tools.glob(),

        html("experiments/hmr-browser/public"),
        html.image(),
        html.scss(),

        compile.swc(),
        resolve.cjs(),
        resolve.node(),

        tools.adhoc({
            env,

            setup() {
                Object.assign(process.env, this.env);
            }
        }),

        hoist.externals({ hintMask: src }),
        hoist.globals({ hintMask: src }),

        // optimize(),
        optimize.htmlMinifier(),
    ],
    watch: {
        include: [
            "dist/**",
            "experiments/**",
        ]
    }
});
