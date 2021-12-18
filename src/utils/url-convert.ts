import path from "path";

function urlConvert(href: string | URL, baseUrl: URL | string = import.meta.url) {
    const url = new URL(href, baseUrl);
    if (url.protocol !== "file:") {
        throw new TypeError("resolve() was given a non-file url.")
    }

    const { hostname, pathname } = url;
    if (hostname.length > 0) {
        return path.normalize(`//${hostname}${pathname}`);
    }

    if (url.pathname[2] === ":") {
        return path.normalize(pathname.substring(1));
    }

    return path.normalize(pathname);
}

export default urlConvert;
