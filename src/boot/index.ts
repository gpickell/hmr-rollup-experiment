async function boot(...importers: (() => any)[]) {
    const exports = { __esModule: true };
    for (const importer of importers) {
        const module = await importer();
        const result = await module.__start?.();
        if (typeof result === "object" && result !== null) {
            Object.assign(exports, result);
        }
    }

    return exports;
}

export default boot;
