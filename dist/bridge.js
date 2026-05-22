import http from "node:http";
import { DASHBOARD_HTML } from "./dashboard.js";
/**
 * HTTP server that the Roblox game connects to. Roblox HttpService can only
 * make outbound requests, so the game POSTs events here and long-polls for
 * commands. Everything is plain JSON over HTTP for simplicity and low latency
 * on localhost.
 *
 * Endpoints:
 *   POST /events    -> ingest a batch of events
 *   POST /state     -> replace the live game-state snapshot
 *   POST /results   -> report results of executed commands
 *   GET  /poll      -> long-poll for queued commands
 *   GET  /health    -> liveness probe
 */
export function startBridge(store, opts) {
    const server = http.createServer((req, res) => {
        handle(req, res, store, opts).catch((err) => {
            log(`unhandled error: ${err?.stack || err}`);
            if (!res.headersSent)
                sendJson(res, 500, { error: String(err) });
        });
    });
    server.listen(opts.port, opts.host, () => {
        log(`bridge listening on http://${opts.host}:${opts.port}`);
    });
    return server;
}
async function handle(req, res, store, opts) {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const path = url.pathname;
    if (path === "/health") {
        return sendJson(res, 200, {
            ok: true,
            connected: store.isConnected(),
            latestSeq: store.latestSeq,
        });
    }
    // ---- Dashboard (read-only, no auth) ----------------------------------
    // The web dashboard and its data endpoints are public on localhost so the
    // browser can load them without the Roblox shared key.
    if (req.method === "GET" && (path === "/" || path === "/dashboard")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(DASHBOARD_HTML);
    }
    if (req.method === "GET" && path === "/api/state") {
        const state = store.getState();
        return sendJson(res, 200, {
            connected: store.isConnected(),
            lastContactMsAgo: store.lastContact ? Date.now() - store.lastContact : null,
            latestSeq: store.latestSeq,
            context: state?.context ?? null,
            executor: state?.executor ?? null,
            players: state?.players ?? [],
        });
    }
    if (req.method === "GET" && path === "/api/events") {
        const afterSeq = Number(url.searchParams.get("afterSeq") ?? 0) || 0;
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 1000);
        const events = store.query({ afterSeq, limit });
        return sendJson(res, 200, { latestSeq: store.latestSeq, events });
    }
    // Auth for everything except health and the dashboard.
    if (opts.authKey) {
        const key = req.headers["x-roblox-key"];
        if (key !== opts.authKey) {
            return sendJson(res, 401, { error: "bad or missing x-roblox-key" });
        }
    }
    if (req.method === "POST" && path === "/events") {
        const body = await readJson(req);
        const batch = Array.isArray(body) ? body : body?.events;
        if (!Array.isArray(batch)) {
            return sendJson(res, 400, { error: "expected array of events or {events:[...]}" });
        }
        const latest = store.ingest(batch);
        return sendJson(res, 200, { ok: true, latestSeq: latest });
    }
    if (req.method === "POST" && path === "/state") {
        const body = (await readJson(req));
        store.setState(body);
        return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && path === "/results") {
        const body = await readJson(req);
        const arr = Array.isArray(body) ? body : body?.results ?? [body];
        for (const r of arr)
            if (r && r.id)
                store.recordResult(r);
        return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && path === "/poll") {
        // Roblox heartbeat + command pickup. Touch lastContact immediately.
        store.touch();
        const cmds = await store.waitForCommands(opts.pollTimeoutSec * 1000);
        return sendJson(res, 200, { commands: cmds, serverTime: Date.now() });
    }
    return sendJson(res, 404, { error: `no route for ${req.method} ${path}` });
}
function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (c) => {
            size += c.length;
            if (size > 8 * 1024 * 1024) {
                reject(new Error("payload too large"));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8").trim();
            if (!raw)
                return resolve(undefined);
            try {
                resolve(JSON.parse(raw));
            }
            catch (e) {
                reject(new Error("invalid JSON body"));
            }
        });
        req.on("error", reject);
    });
}
function sendJson(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(data),
    });
    res.end(data);
}
function log(msg) {
    // Bridge logs go to stderr so they never corrupt MCP stdio on stdout.
    process.stderr.write(`[roblox-mcp:bridge] ${msg}\n`);
}
