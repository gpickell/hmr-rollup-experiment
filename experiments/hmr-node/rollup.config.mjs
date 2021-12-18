import { defineConfig } from "rollup";

import bundle from "dist/bundle";
import compile from "dist/compile";
import hoist from "dist/hoist";
import resolve from "dist/resolve";
import tools from "dist/tools";

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
        resolve.cjs(),
        resolve.node(),

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
