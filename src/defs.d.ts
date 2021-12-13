declare module "#package" {
    export const url: string;

    const json: {
        exports: Record<string, string>;
    };

    export default json;
}
