import type { Plugin } from "rollup";
import type { Readable } from "stream";

import fs, { GlobMatch } from "./utils/fs";
import { createReadStream, createWriteStream } from "fs";
import crypto from "crypto";
import http from "http";
import https from "https";
import path from "path";
import urlConvert from "./utils/url-convert";

import tar from "tar";
import yauzl from "yauzl";

let running = false;
const queue: ((next: () => void) => void)[] = [];

async function start() {
    for (const fn of queue) {
        await new Promise<void>(fn);
    }

    queue.length = 0;
    running = false;
}

function enqueue(fn: () => Promise<void>) {
    return new Promise<void>(resolve => {
        queue.push(next => {
            const promise = new Promise<void>(x => x(fn()));
            resolve(promise.finally(next));
        });

        if (!running) {
            running = true;
            start();
        }
    });
}

async function get(url: string | URL) {
    url = new URL(url);
    url.hash = "";

    if (url.protocol === "file:") {
        return new Promise<Readable>((resolve, reject) => {
            const fn = urlConvert(url);
            const stream = createReadStream(fn);    
            stream.on("open", () => resolve(stream));
            stream.on("error", reject);
        });
    }
    
    if (url.protocol === "https:") {
        return new Promise<Readable>((resolve, reject) => {
            const req = https.get(url, { rejectUnauthorized: false });
            req.on("error", reject);
            req.on("response", response => {
                if (response.statusCode === 200) {
                    resolve(response);
                } else {
                    const msg = `${response.statusCode} ${response.statusMessage}`;
                    reject(new Error(`Cannot fetch ${url}, received (${msg}).`));
                }
            });
        });
    }

    if (url.protocol === "http:") {
        return new Promise<Readable>((resolve, reject) => {
            const req = http.get(url);
            req.on("error", reject);
            req.on("response", response => {
                if (response.statusCode === 200) {
                    resolve(response);
                } else {
                    const msg = `${response.statusCode} ${response.statusMessage}`;
                    reject(new Error(`Cannot fetch ${url}, received (${msg}).`));
                }
            });
        });
    }

    throw new Error(`Cannot fetch ${url}, protocol must be one of http, https, or file.`);
}

async function store(fn: string, stream: Readable) {
    await fs.mkdir(path.dirname(fn), { recursive: true }).catch(() => {});

    return new Promise<void>((resolve, reject) => {
        let err: any;
        const result = createWriteStream(fn);
        const done = () => {
            if (result.writableFinished) {
                resolve();
            } else {
                reject(err ?? new TypeError("Could not read download stream to the end."));
            }

            stream.destroy();
        };

        const fail = async (ex: any) => {
            stream.removeAllListeners();

            if (!stream.readableEnded) {
                err = ex;
                result.destroy();
            }
        };

        result.on("error", done);
        result.on("close", done);
        stream.on("error", fail);
        stream.on("close", fail);
    });
}

async function stash(url: string | URL, cacheDir: string, extractDir: string, asName?: string) {
    url = new URL(url);
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.mkdir(extractDir, { recursive: true });

    if (asName === undefined) {
        asName = url.pathname;
    }

    const fnPath = path.join(extractDir, asName);
    if (await fs.exists(fnPath) !== "file") {
        const fnSource = path.join(cacheDir, asName);
        if (await fs.exists(fnSource) !== "file") {
            const nop = () => {};
            const ext = path.extname(asName);
            const name = path.basename(asName, ext);
            const ts = "." + crypto.randomUUID();
            const fnTemp = path.resolve(cacheDir, `${name}${ts}${ext}`);
            const stream = await get(url);
            try {
                await store(fnTemp, stream);
                await fs.rename(fnTemp, fnSource).catch(nop);
            } finally {
                await fs.rm(fnTemp, { recursive: true  }).catch(nop);
            }
        }

        await fs.copyFile(fnSource, fnPath);
    }
}

function openZipFile(fn: string){
    return new Promise<yauzl.ZipFile>((resolve, reject) => {
        const options = { autoClose: true, lazyEntries: true };
        yauzl.open(fn, options, (err, zf) => {
            err ? reject(err) : resolve(zf!);
        });
    });
}

function readZipEntry(zf: yauzl.ZipFile) {
    return new Promise<yauzl.Entry | undefined>((resolve, reject) => {
        zf.on("entry", entry => {
            zf.removeAllListeners();    
            resolve(entry);
        });

        zf.on("error", ex => {
            zf.removeAllListeners();
            zf.close();

            reject(ex);
        });

        zf.on("close", () => {
            resolve(undefined);
        });

        zf.readEntry();
    });
}

function openZIpFile(zf: yauzl.ZipFile, entry: yauzl.Entry) {
    return new Promise<Readable>((resolve, reject) => {
        zf.openReadStream(entry, (err, stream) => {
            if (err) {
                zf.close();
                reject(err);
            } else {
                resolve(stream!);
            }
        });
    });
}

async function unzip(fn: string, dir: string) {
    let entry: yauzl.Entry | undefined;
    const fx = /[^\/]$/;
    const zf = await openZipFile(fn);
    while (entry = await readZipEntry(zf)) {
        if (entry.fileName.match(fx)) {
            const stream = await openZIpFile(zf, entry);
            await store(path.join(dir, entry.fileName), stream);
        }
    }
}

async function extractAll(extractDir: string, filter: GlobMatch) {
    const files = await fs.find(extractDir, filter);
    const extx = /\.(tar\.gz|tar\.xz|tgz|txz|zip)$/;
    for (const file of files) {
        const fn = path.join(extractDir, file);
        const name = path.basename(fn).replace(extx, "");
        const dir = path.join(path.dirname(fn), name);
        await fs.mkdir(dir, { recursive: true });

        if (fn.endsWith("z")) {
            await tar.x({ file: fn, cwd: dir })
        } else {
            await unzip(fn, dir);
        }
    }
}

function digest(fn: string, hmac: string) {
    return new Promise<string>((resolve, reject) => {
        const stream = createReadStream(fn);
        const digest = crypto.createHash(hmac);
        stream.pipe(digest);
        stream.on("error", reject);
        stream.on("close", () => digest.destroy());

        const list: Buffer[] = [];
        digest.on("data", x => list.push(x));
        digest.on("close", () => {
            const buf = Buffer.concat(list);
            resolve(buf.toString("hex"));
        });
    });
}

async function verifyOne(extractDir: string, fn: string, hmac: string) {
    fn = path.join(extractDir, fn);

    const ext = "." + hmac;
    const hash = await digest(fn, hmac);
    const current = await fs.readFile(fn + ext, "utf-8").catch(() => undefined);
    if (current !== undefined) {
        if (current !== hash) {
            const name = path.basename(fn);
            throw new TypeError(`${name} does not match hash.`);
        }
    } else {
        await fs.writeFile(fn + ext, hash, "utf-8");
    }
}

async function verifyAll(extractDir: string, filter: GlobMatch, hmac: string) {
    const files = await fs.find(extractDir, filter);
    const promises = files.map(x => verifyOne(extractDir, x, hmac));
    await Promise.all(promises);
}

namespace web {
    export let cacheDir = ".cache";
    export let extractDir = ".extract";
    export let hmac = "sha256";

    function resolve() {
        cacheDir = path.resolve(process.cwd(), cacheDir);
        extractDir = path.resolve(process.cwd(), extractDir);
    }

    export function download(url: string, as?: string): Plugin {
        let job: Promise<void> | undefined;
        return {
            name: "interop-download",

            buildStart() {
                job = job ?? enqueue(async () => {
                    resolve();
                    await stash(url, cacheDir, extractDir, as);                    
                });
            },

            async writeBundle() {
                await job;
            }
        };
    }

    export function extract(...patterns: (GlobMatch | string | string[])[]): Plugin {
        if (patterns.length < 1) {
            patterns = [
                "*.zip",
                "*.tar.{g,x}z",
                "*.t{g,x}z",
            ];
        }

        let job: Promise<void> | undefined;
        const filter = fs.glob(...patterns);
        return {
            name: "interop-extract",

            async generateBundle() {
                job = job ?? enqueue(async () => {
                    resolve();
                    await extractAll(extractDir, filter);
                });

                await job;
            },
        };
    }

    export function verify(...patterns: (GlobMatch | string | string[])[]) {
        if (patterns.length < 1) {
            patterns = [
                "*.zip",
                "*.tar.{g,x}z",
                "*.t{g,x}z",
            ];
        }

        let job: Promise<void> | undefined;
        const filter = fs.glob(...patterns);
        return {
            name: "interop-verify",

            async generateBundle() {
                job = job ?? enqueue(async () => {
                    resolve();
                    await verifyAll(extractDir, filter, hmac);
                });

                await job;
            },
        };
    }
}

export default web;
