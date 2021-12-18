import commonjs, { RollupCommonJSOptions } from "@rollup/plugin-commonjs";
import nodeResolve, { RollupNodeResolveOptions } from "@rollup/plugin-node-resolve";

import { extensions } from "./defaults";

namespace resolve {
    export function cjs(options?: RollupCommonJSOptions) {
        return commonjs({
            extensions,
            ignoreGlobal: true,
            requireReturnsDefault: false,
            ignoreDynamicRequires: true,
            sourceMap: false,
            esmExternals: true,
            ...(options ?? {})
        });
    }

    export function node(options?: RollupNodeResolveOptions) {
        return nodeResolve({
            extensions,
            preferBuiltins: false,    
            ...(options ?? {})
        });
    }
}

export default resolve;
