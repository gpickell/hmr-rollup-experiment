import type { Plugin } from "rollup";
import type { Duplex, Readable, Writable } from "stream";

import fs, { GlobMatch } from "./utils/fs";
import { createReadStream, createWriteStream } from "fs";
import crypto from "crypto";
import http from "http";
import https from "https";
import path from "path";
import os from "os";
import urlConvert from "./utils/url-convert";

import { fifo, swallow } from "./utils/pipe";
import tar from "tar";
import yauzl from "yauzl";

let running = false;
const queue: ((next: () => void) => void)[] = [];
const tarx = /\.(tar\.|t)[gx]z$/i;
const zipx = /\.zip$/i;

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

async function get(url: string | URL, rejectUnauthorized = true) {
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
            const req = https.get(url, { rejectUnauthorized });
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

function openFileWriter(fn: string) {
    return new Promise<Writable>((resolve, reject) => {
        const result = createWriteStream(fn);
        result.on("open", () => resolve(result));
        result.on("error", reject);
    });
}

function fork(source: Readable, output: Writable, digest: Duplex) {
    return new Promise<string>((resolve, reject) => {
        const data = [] as Buffer[];
        digest.on("data", x => data.push(x));

        const finish = (err?: Error) => {
            const text = Buffer.concat(data).toString("hex");
            err ? reject(err) : resolve(text);
        };

        const [reader, writer] = fifo();
        reader.pipe(output);
        reader.pipe(digest);

        source.on("error", finish);
        output.on("error", finish);
        digest.on("error", finish);

        let count = 0;
        source.on("close", () => {
            if (!source.readableEnded) {
                finish(new TypeError("Source stream did not end properly."));
            }

            ++count >= 3 && finish();
        });

        output.on("close", () => {
            if (!output.writableFinished) {
                finish(new TypeError("Output stream did not end properly."));
            }

            ++count >= 3 && finish();
        });

        digest.on("close", () => {
            if (!digest.readableEnded) {
                finish(new TypeError("Digest stream did not end properly."));
            }

            ++count >= 3 && finish();
        });

        source.pipe(writer);
    });
}

async function stash(url: string | URL, fn: string, hmac: string, rejectUnauthorized = true) {
    let fnTemp: string | undefined;
    let source: Readable | undefined;
    let digest: Duplex | undefined;
    let output: Writable | undefined;

    try {
        url = new URL(url);

        const fnHash = `${fn}.${hmac}`;
        const fileHash = await fs.readFile(fnHash, "utf-8").catch(() => undefined);
        if (fileHash) {
            return fileHash;
        }

        const stat = await fs.lstat(fn).catch(() => undefined);
        if (stat?.isFile()) {
            source = createReadStream(fn);
            output = swallow().resume();
            digest = crypto.createHash(hmac);

            const fileHash = await fork(source, output, digest);
            await fs.writeFile(fnHash, fileHash);

            return fileHash;
        }

        await mkdirParent(fn);

        const uuid = crypto.randomUUID();
        fnTemp = `${fn}.${uuid}`;
        output = await openFileWriter(fnTemp);
        source = await get(url, rejectUnauthorized);
        digest = crypto.createHash(hmac);

        const hash = await fork(source, output, digest);
        await fs.rename(fnTemp, fn);
        await fs.writeFile(fnHash, hash);

        return hash;
    } finally {
        source?.destroy();
        digest?.destroy();
        output?.destroy();
        fnTemp && await clean(fnTemp);
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

            const source = await openZipEntry(zf, entry);
            const output = createWriteStream(fn);
            const digest = swallow().resume();
            await fork(source, output, digest);
        }
    }
}

function findBase(files: string[]) {
    files.sort();
    
    const [head, ...rest] = files;
    if (head === undefined) {
        return "";
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

async function simplify(tmp: string, dir: string, filter: GlobMatch) {
    const files = await fs.find(tmp, filter);
    const base = findBase(files);
    const promises = files.map(async file => {
        const to = path.join(dir, file.substring(base.length));
        const from = path.join(tmp, file);
        await mkdirParent(to);
        await fs.rename(from, to);
    });
    
    await Promise.all(promises);
}

async function extract(fn: string, dir: string, filter: GlobMatch) {
    const tmp = path.resolve(dir, "..", crypto.randomUUID());
    try {
        await clean(dir);
        await mkdir(tmp);

        if (tarx.test(fn)) {
            await tar.x({ file: fn, cwd: tmp });
        }

        if (zipx.test(fn)) {
            await unzip(fn, tmp);
        }

        await simplify(tmp, dir, filter);
    } finally {
        await clean(tmp);
    }
}

export interface Options {
    url: string | URL;
    as?: string;
    dir?: string;
    file?: string;
    extract?: string[];
    hash?: string;
}

function web(options: Options): Plugin {
    const url = new URL(options.url);
    const ext = path.extname(url.pathname);
    const name = path.basename(url.pathname, ext);
    const cacheDir = path.resolve(process.cwd(), web.cacheDir);
    const fn = path.resolve(cacheDir, options.as ?? path.basename(url.pathname));
    const dir = path.resolve(process.cwd(), options.dir ?? `.extract/${name}`);
    const file = path.resolve(dir, options.file ?? path.basename(url.pathname));
    const filter = options.extract ? fs.glob(options.extract) : undefined;
    const hash = options.hash;
    const fnHash = filter ? `${file}.sha256` : `${dir}/.sha256`;
    return {
        name: "interop-web",
        async buildStart() {
            await enqueue(async () => {
                const fileHash = await fs.readFile(fnHash, "utf-8").catch(() => undefined);
                if (!hash || fileHash !== hash) {
                    const current = await stash(url, fn, web.hmac, !hash);
                    console.log("hash-check: url =", url.toString());
                    console.log("  source:", current);
                    console.log("  wanted:", hash ?? "(not given)");

                    if (hash && current !== hash) {
                        throw new Error("Hash does not match!.");
                    }

                    if (filter) {
                        await extract(fn, dir, filter);
                    } else {
                        await mkdirParent(file);
                        await fs.copyFile(fn, file);
                    }
    
                    await fs.writeFile(fnHash, current);
                }
            });
        }
    };
}

namespace web {
    export let cacheDir = path.resolve(os.homedir()) ?? ".download-cache";
    export let hmac = "sha256";
}

export default web;
