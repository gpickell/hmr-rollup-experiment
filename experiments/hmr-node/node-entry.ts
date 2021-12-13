import hmr from "dist/hmr";

hmr.on("start", () => {
    console.log("--- start", hmr.state, hmr.meta);
});

hmr.on("stop", () => {
    console.log("--- stop", hmr.state, hmr.meta);
});

if (!hmr.meta) {
    setInterval(() => {}, 30000);
}

hmr.keep(new Date().valueOf());
console.log("--- state = %s, static = %s, meta = %s", hmr.state, hmr.static, hmr.meta);
console.log("--- bb");

const test = "test";
export default test;
