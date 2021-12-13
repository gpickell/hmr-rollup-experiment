import { defineConfig } from "rollup";

import builder from "dist/builder";
import bundle from "dist/bundle";
import compile from "dist/compile";
import hoist from "dist/hoist";
import tools from "dist/tools";
import commonjs from "@rollup/plugin-commonjs";
import resolve from "@rollup/plugin-node-resolve";

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
        bundle.search("experiments/hmr-node"),
        bundle.classify("node-entry", (name, id) => {
            const list = [
                "experiments!dist/boot",
                "experiments!dist/boot/node",
                "experiments!dist/boot/hmr-connect-fs",
                id,
            ];

            return { [name]: list };
        }),

        tools.clean(),
        tools.bind(),

        compile.swc(),
        commonjs(builder.cjs),
        resolve(builder.resolve),

        hoist.externals({ hintMask: src }),
        hoist.globals({ hintMask: src }),
    ],
    watch: {
        include: [
            "dist/**",
            "experiments/**",
        ]
    }
});
