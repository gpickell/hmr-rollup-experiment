import express from "express";
import fs from "fs/promises";
import http from "http";
import path from "path";

import createRequestHandler from "./createRequestHandler";
import createSocketHandler from "./createSocketHandler";

const cwd = path.normalize(process.cwd() + "/");
const slashx = /[\\/]+/g;

interface ServerOptions {
    host: string;
    port: number;
    root: string;
    url: string;
}

function optionsFromEnv(name = "dev_", env: Record<string, number | string | undefined> = process.env) {
    let port = 0;
    let host = "";
    let root = "";
    let url = "";
    for (const key in env) {
        const lc = key.toLowerCase();
        const value = env[key];
        if (lc.startsWith(name) && value) {
            const suffix = lc.substring(name.length);
            switch (suffix) {
                case "port":
                    port = Number(value);
                    break;

                case "host":
                    host = value.toString();
                    break;

                case "root":
                    root = value.toString();
                    break;

                case "url":
                    url = value.toString();
                    break;
            }
        }
    }

    const result: Partial<ServerOptions> = {};
    if (isFinite(port) && port > 0 && port < 0xFFFF) {
        result.port = port;
    }

    if (host) {
        result.host = host;
    }

    if (root) {
        result.root = path.resolve(cwd, root);
    }

    if (url) {
        result.url = `/${url}/`.replace(slashx, "/");
    }
    
    return result;
}

async function optionsFromPackageJson() {
    const env: any = {};
    try {
        const fn = path.resolve(cwd, "package.json");
        const content = await fs.readFile(fn, "utf-8").catch(() => undefined);
        if (content !== undefined) {
            const { dev } = JSON.parse(content);
            if (typeof dev === "object" && dev !== null && !Array.isArray(dev)) {
                Object.assign(dev, env);
            }
        }
    } catch {
        // bad file... not our job to nofify
    }

    return optionsFromEnv("", env);
}

function optionsFromCommandLine(args?: string[]) {
    const env: any = {};
    if (Array.isArray(args)) {
        let key: string | undefined;
        const splitx = /^(.*?)=(.*)/;
        for (const value of args) {
            if (value.startsWith("--")) {
                key = value;

                const match = key.match(splitx);
                if (match !== null) {
                    key = undefined;

                    const [, k, v] = match;
                    env[k] = v;
                }
            }
        }    
    }

    return optionsFromEnv("--", env)
}

function createDevServer(options?: Partial<ServerOptions>, args?: string[]) {
    const opts = {
        host: "localhost",
        port: 4080,
        url: "/",
        root: cwd,
        ...optionsFromPackageJson(),
        ...optionsFromEnv(),
        ...optionsFromCommandLine(args),
        ...optionsFromEnv("", options ?? {}),
    };

    const { host, port, root, url } = opts;
    const router = createRequestHandler(root, url);
    const server = http.createServer();
    const app = express();
    app.use(router);

    const { attach, server: wss } = createSocketHandler(root, url);
    attach(server);

    server.on("request", app);
    server.listen(port, host);

    console.log("Starting Dev Server");
    console.log("    url: ", `http://${host}:${port}${url}`);
    console.log("    root:", root);

    return { app, router, server, wss };
}

export default createDevServer;
