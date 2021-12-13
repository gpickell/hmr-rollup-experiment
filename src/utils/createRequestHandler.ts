import express from "express";
import fs from "fs/promises";
import process from "process";
import path from "path";
import http from "http";
import lock from "./lock";

const cwd = path.normalize(process.cwd() + "/");
const slashx = /[\\/]+/g;

function wrapResponse<T>(res: http.OutgoingMessage, value: T, delay = 0) {    
    return new Promise<T>(resolve => {
        let timer: any;
        const done = (th = timer) => {
            if (th !== undefined) {
                clearTimeout(th);
            }

            resolve(value)
            timer = undefined;
        };

        if (delay > 0) {
            timer = setTimeout(() => done(timer = undefined), delay);
        }
        
        res.on("close", () => done());
    });
}


async function wait<T>(unblock: Promise<T>, dir: string, token = "") {
    const promise = lock.watch(dir, token);
    return await Promise.race([unblock, promise]);
}

function createRequestHandler(dirPath: string, vdir = "/") {
    dirPath = path.resolve(cwd, dirPath);
    dirPath = path.normalize(dirPath + "/");
    vdir = `/${vdir}/`.replace(slashx, "/");

    const lockDir = path.join(dirPath, "assets");
    const dynamic = express.static(dirPath);
    const fixed = express.static(dirPath, { immutable: true, maxAge: 31536000 });
    const router = express.Router();
    router.use(vdir, async (req, res, next) => {
        const { pathname, search } = new URL(req.url, "http://localhost/");
        if (req.method === "GET" || req.method === "HEAD") {
            if (await wait(wrapResponse(res, ""), lockDir)) {
                if (pathname.indexOf("/assets/") >= 0) {
                    fixed(req, res, next);
                } else {
                    dynamic(req, res, next);
                }
            }
        } else if (req.method === "POST") {
            const fn = path.resolve(path.join(dirPath, pathname));
            if (fn.startsWith(dirPath) && fn.endsWith(".json")) {
                const { socket } = res;
                if (socket) {
                    res.on("close", () => socket.end());
                    res.on("finish", () => socket.end());
                    socket.on("finish", () => socket.destroy());
                }

                let json: any;
                let token = search.substring(1);
                const result = await wait(wrapResponse(res, "", 25000), lockDir, token);
                if (result) {
                    token = result;

                    try {
                        const content = await fs.readFile(fn, "utf-8");
                        json = JSON.parse(content);
                    } catch {
                        // Don't care.
                    }
                }

                if (json === undefined) {
                    json = {};
                }

                res.setHeader("Connection", "close");
                res.setHeader("Location", `?${token}`);
                res.statusCode = 200;
                res.json(json);
                res.end();
            } else {
                next();
            }
        } else {
            next();
        }
    });

    return router;
}

export default createRequestHandler;
