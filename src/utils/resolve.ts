import pkg, { url } from "#package";
import urlConvert from "./url-convert";

function resolve(value: string) {
    const rel = pkg.exports[value];
    if (typeof rel !== "string") {
        throw new Error(`Could not resolve ${value}`);
    }

    return urlConvert(rel, url);
}

export default resolve;
