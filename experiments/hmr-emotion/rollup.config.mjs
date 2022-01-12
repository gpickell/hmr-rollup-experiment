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
        bundle.search("experiments/hmr-emotion/src"),
        bundle.classify("browser-entry", (name, id) => {
            const list = [
                "experiments!dist/boot",
                "experiments!dist/boot/browser",
                "experiments!dist/boot/hmr-connect-ws",
                "experiments/hmr-emotion/src/**/global.scss",
                "setup",
                id,
            ];

            name = "index";
            return { [name]: list };
        }),

        tools.clean(),
        tools.bind(),
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
        optimize.cssClean(),
    ],
    watch: {
        include: [
            "dist/**",
            "experiments/**",
        ]
    }
});
