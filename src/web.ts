import type { Plugin } from "rollup";
import type { Readable, Writable } from "stream";

import fs from "./utils/fs";
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

async function mkdir(fn: string) {
    await fs.mkdir(fn, { recursive: true });
}

async function mkdirParent(fn: string) {
    await fs.mkdir(path.dirname(fn), { recursive: true });
}

async function clean(fn: string) {
    return fs.rm(fn, { recursive: true  }).catch(() => {});    
}

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

    console.log("web-fetch: url =", url.toString());

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

function pipeAsync(from: Readable, to: Writable) {
    return new Promise<void>((resolve, reject) => {
        let err: any;
        const done = () => {
            to.removeAllListeners();
            if (!to.writableFinished) {
                reject(err ?? new TypeError("Could not read download stream to the end."));
            } else {
                resolve();
            }

            from.destroy();
        };

        const fail = async (ex: any) => {
            from.removeAllListeners();
            if (!from.readableEnded) {
                err = ex;
                to.destroy();
            }
        };

        to.on("error", done);
        to.on("close", done);
        from.on("error", fail);
        from.on("close", fail);
        from.pipe(to);
    });
}

async function store(fn: string, stream: Readable) {
    const result = createWriteStream(fn);
    return pipeAsync(stream, result);
}

async function stash(url: string | URL, cacheDir: string, files: Set<string>, asName?: string) {
    url = new URL(url);

    if (asName === undefined) {
        asName = path.basename(url.pathname);
    }

    asName = path.resolve(cacheDir, asName);
    asName = asName.replace(/[\\/]\*$/, path.basename(url.pathname));

    if (await fs.exists(asName) !== "file") {
        const ext = path.extname(asName);
        const name = path.join(path.dirname(asName), path.basename(asName, ext));
        const ts = "." + crypto.randomUUID();
        const fnTemp = path.resolve(cacheDir, `${name}${ts}${ext}`);
        await mkdirParent(fnTemp);

        const stream = await get(url);
        try {
            await store(fnTemp, stream);
            await fs.rename(fnTemp, asName).catch(() => {});
        } finally {
            await clean(fnTemp);
        }
    }

    files.add(path.relative(cacheDir, asName));
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

function openZipEntry(zf: yauzl.ZipFile, entry: yauzl.Entry) {
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
            console.log("web-extract:", entry.fileName);

            const fn = path.join(dir, entry.fileName)
            await mkdirParent(fn);

            const stream = await openZipEntry(zf, entry);
            await store(fn, stream);
        }
    }
}

function findBase(files: string[]) {
    files.sort();
    
    const [head, ...rest] = files;
    if (head === undefined) {
        return ".";
    }

    const tail = rest.pop();
    if (tail === undefined) {
        return path.dirname(head);
    }

    const j = Math.min(head.length, tail.length);
    for (let i = 0; i < j && head[i] === tail[i]; i++) {}

    const prefix = head.substring(0, j);
    const [base] = prefix.match(/^(.*[\\/])?/)!;
    return base;
}

async function simplify(dir: string) {
    const files = await fs.find(dir, "**/*");
    const base = findBase(files);
    if (base.length > 0) {
        for (const file of files) {
            const to = path.join(dir, file.substring(base.length));
            const from = path.join(dir, file);
            await mkdirParent(to);
            await fs.rename(from, to);
        }

        const old = path.resolve(dir, base);
        await clean(old);
    }
}

async function extractAll(cacheDir: string, extractDir: string, files: Iterable<string>) {
    let extract = false;
    const tarx = /\.(tar\.|t)[gx]z$/i;
    const zipx = /\.zip$/i;
    for (const file of files) {
        const fn = path.resolve(cacheDir, file);
        if (tarx.test(fn)) {
            const dir = path.resolve(extractDir, file.replace(tarx, ""));
            if (await fs.exists(dir) !== "dir") {
                const filter = (fn: string) => {
                    console.log("web-extract:", fn);
                    return true;
                };

                extract = true;
                await mkdir(dir);
                await tar.x({ file: fn, cwd: dir, filter });
                await simplify(dir);
            }
        }

        if (zipx.test(fn)) {
            const dir = path.resolve(extractDir, file.replace(zipx, ""));
            if (await fs.exists(dir) !== "dir") {
                extract = true;
                await mkdir(dir);
                await unzip(fn, dir);
                await simplify(dir);
            }
        }
    }

    if (extract) {
        const fn = path.resolve(extractDir, ".sha256");
        await clean(fn);
    }
}

async function digest(fn: string, hmac: string) {
    const digest = crypto.createHash(hmac);
    const list: Buffer[] = [];
    digest.on("data", x => list.push(x));

    const stream = createReadStream(fn);
    await pipeAsync(stream, digest);

    const buf = Buffer.concat(list);
    const hash = buf.toString("hex");
    return `${hmac}:${hash}`;
}

function hashIt(value: string, hmac: string) {
    const digest = crypto.createHash(hmac);
    digest.update(value);
    
    const hash = digest.digest("hex");
    return `${hmac}:${hash}`;
}

async function verifyAll(extractDir: string, hmac: string, hash: string) {
    const fnHash = path.resolve(extractDir, ".sha256");
    if (await fs.exists(fnHash) === "file") {
        return true;
    }

    const list: string[] = [];
    const files = await fs.find(extractDir, "**/*");
    for (const file of files) {
        const fn = path.join(extractDir, file);
        const hash = await digest(fn, hmac);
        list.push(hash);

        console.group("web-digest:", file);
        console.log("hash =", hash);
        console.groupEnd();
    }

    const state = list.sort().join(", ");
    const result = hashIt(state, hmac);
    console.group("web-digest-check:", hash);
    console.log("hash =", result);
    console.groupEnd();

    if (hash !== result) {
        return false;
    }

    await mkdirParent(fnHash);
    await fs.writeFile(fnHash, result);

    return true;
}

namespace web {
    export let cacheDir = ".cache";
    export let extractDir = ".extract";
    export let hmac = "sha256";
    export let files = new Set<string>();

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
                    await stash(url, cacheDir, files, as);
                });
            },

            async writeBundle() {
                await job;
            }
        };
    }

    export function extract(): Plugin {
        let job: Promise<void> | undefined;
        return {
            name: "interop-extract",

            async generateBundle() {
                job = job ?? enqueue(async () => {
                    resolve();
                    await extractAll(cacheDir, extractDir, files);
                });

                await job;
            },
        };
    }

    export function verify(hash: string): Plugin {
        let job: Promise<void> | undefined;
        return {
            name: "interop-verify",

            async writeBundle() {
                job = job ?? enqueue(async () => {
                    resolve();
                    
                    if (!await verifyAll(extractDir, hmac, hash)) {
                        this.error("Hash of extracted content does not match!");
                    }
                });

                await job;
            },
        };
    }
}

export default web;
