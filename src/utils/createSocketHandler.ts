import type { Duplex } from "stream";

import fs from "fs/promises";
import http from "http";
import lock from "./lock";
import path from "path";
import EventEmitter from "events";
import WebSocket, { WebSocketServer } from "ws";

const cwd = path.normalize(process.cwd() + "/");
const slashx = /[\\/]+/g;

function wrap<T>(ws: WebSocket, value: T, delay = 0) {
    return new Promise<T>(resolve => {
        let timer: any;
        const done = (th = timer) => {
            if (th !== undefined) {
                clearInterval(th);
            }

            resolve(value)
            timer = undefined;
        };

        if (delay > 0) {
            let pong: any;
            const tick = () => {
                if (pong) {
                    done();
                } else {
                    pong = (new Date()).toISOString();
                    ws.ping(pong);
                }
            };

            const first = () => {
                clearInterval(timer);
                timer = setInterval(tick, delay);
                tick();
            };

            ws.on("pong", data => {
                if (data.toString() === pong) {
                    pong = undefined;
                }
            });

            timer = setInterval(first, 5000);
        }
        
        ws.on("error", () => done());
        ws.on("close", () => done());
    });
}

async function wait<T>(unblock: Promise<T>, dir: string, token = "") {
    const promise = lock.watch(dir, token);
    return await Promise.race([unblock, promise]);
}

function createWebSocketServer() {
    return new WebSocketServer({ noServer: true });
}

function extractProtocols(req: http.IncomingMessage) {
    const proto = req.headers["sec-websocket-protocol"] ?? "";
    return proto.split(/\s*,\s*/).filter(x => x.length > 0);
}

function createSocketHandler(dirPath: string, vdir = "/", wss = createWebSocketServer(), wsProto = "hmr") {
    dirPath = path.resolve(cwd, dirPath);
    dirPath = path.normalize(dirPath + "/");
    vdir = `/${vdir}/`.replace(slashx, "/");

    const lockDir = path.join(dirPath, "assets");
    const loop = async (ws: WebSocket, fn: string) => {
        let token = "";
        const done = wrap(ws, "", 25000);
        while (token = await wait(done, lockDir, token)) {
            try {
                const content = await fs.readFile(fn, "utf-8");
                ws.send(content);
            } catch {
                // Don't care.
            }
        }

        if (ws.readyState === ws.OPEN) {
            ws.close();
        }
    };

    const handler = new EventEmitter();
    const accept = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
        const { url } = req;
        if (!url || !url.startsWith(vdir)) {
            return false;
        }

        const { pathname } = new URL(url, "http://localhost/");
        const fn = path.resolve(path.join(dirPath, pathname));
        if (!fn.startsWith(dirPath)) {
            return false;
        }
        
        if (wss.shouldHandle(req) && extractProtocols(req).indexOf(wsProto) >= 0) {
            wss.handleUpgrade(req, socket, head, ws => loop(ws, fn));
            return true;
        }

        return false;
    };

    const attach = (server: http.Server) => {
        server.on("upgrade", (req, socket, head) => {
            if (!accept(req, socket, head)) {
                socket.destroy();
            }
        });
    };

    return Object.assign(handler, {
        accept,
        attach,
        server: wss,
    });
}

export default createSocketHandler;
