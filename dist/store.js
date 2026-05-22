import { randomUUID } from "node:crypto";
/**
 * In-memory hub shared between the HTTP bridge (Roblox side) and the MCP
 * server (Claude side). Holds a ring buffer of events, the latest game state,
 * a command queue, and pending long-poll waiters for low-latency delivery.
 */
export class Store {
    events = [];
    seq = 0;
    capacity;
    state = null;
    /** Commands waiting to be picked up by the Roblox game. */
    commandQueue = [];
    /** Results of dispatched commands, keyed by command id. */
    results = new Map();
    /** Resolvers for /poll long-polls waiting for a command. */
    pollWaiters = [];
    /** Resolvers for event subscribers waiting for new events past a seq. */
    eventWaiters = [];
    /** Last time the Roblox game contacted us (ms). */
    lastContact = 0;
    /** Mark that the Roblox game just contacted us. */
    touch() {
        this.lastContact = Date.now();
    }
    constructor(capacity = 5000) {
        this.capacity = capacity;
    }
    // ---- Events ----------------------------------------------------------
    ingest(raw) {
        const now = Date.now();
        this.lastContact = now;
        for (const e of raw) {
            const ev = { ...e, seq: ++this.seq, ingestedAt: now };
            this.events.push(ev);
        }
        if (this.events.length > this.capacity) {
            this.events.splice(0, this.events.length - this.capacity);
        }
        this.flushEventWaiters();
        return this.seq;
    }
    /** Return events matching filters, newest-last. */
    query(opts = {}) {
        const { types, userId, afterSeq, sinceMs, limit = 100 } = opts;
        const cutoff = sinceMs != null ? Date.now() - sinceMs : undefined;
        let out = this.events.filter((e) => {
            if (afterSeq != null && e.seq <= afterSeq)
                return false;
            if (types && !types.includes(e.type))
                return false;
            if (userId != null && e.userId !== userId)
                return false;
            if (cutoff != null && e.ingestedAt < cutoff)
                return false;
            return true;
        });
        if (out.length > limit)
            out = out.slice(out.length - limit);
        return out;
    }
    get latestSeq() {
        return this.seq;
    }
    /** Resolve with events after `afterSeq`, waiting up to `timeoutMs` if none yet. */
    waitForEvents(afterSeq, timeoutMs) {
        const existing = this.query({ afterSeq, limit: 1000 });
        if (existing.length > 0)
            return Promise.resolve(existing);
        return new Promise((resolve) => {
            const waiter = { afterSeq, resolve };
            this.eventWaiters.push(waiter);
            setTimeout(() => {
                const i = this.eventWaiters.indexOf(waiter);
                if (i >= 0) {
                    this.eventWaiters.splice(i, 1);
                    resolve([]);
                }
            }, timeoutMs);
        });
    }
    flushEventWaiters() {
        if (this.eventWaiters.length === 0)
            return;
        const waiters = this.eventWaiters;
        this.eventWaiters = [];
        for (const w of waiters) {
            const evs = this.query({ afterSeq: w.afterSeq, limit: 1000 });
            w.resolve(evs);
        }
    }
    // ---- State -----------------------------------------------------------
    setState(state) {
        this.state = state;
        this.lastContact = Date.now();
    }
    getState() {
        return this.state;
    }
    isConnected(staleMs = 10000) {
        return this.lastContact > 0 && Date.now() - this.lastContact < staleMs;
    }
    // ---- Commands --------------------------------------------------------
    enqueueCommand(kind, args) {
        const cmd = { id: randomUUID(), kind, args, queuedAt: Date.now() };
        this.commandQueue.push(cmd);
        this.flushPollWaiters();
        return cmd;
    }
    /** Drain queued commands immediately (used by the synchronous poll path). */
    drainCommands() {
        const cmds = this.commandQueue;
        this.commandQueue = [];
        return cmds;
    }
    /** Long-poll: resolve with commands as soon as any are queued, or after timeout. */
    waitForCommands(timeoutMs) {
        if (this.commandQueue.length > 0) {
            return Promise.resolve(this.drainCommands());
        }
        return new Promise((resolve) => {
            const waiter = (cmds) => resolve(cmds);
            this.pollWaiters.push(waiter);
            setTimeout(() => {
                const i = this.pollWaiters.indexOf(waiter);
                if (i >= 0) {
                    this.pollWaiters.splice(i, 1);
                    resolve([]);
                }
            }, timeoutMs);
        });
    }
    flushPollWaiters() {
        if (this.pollWaiters.length === 0 || this.commandQueue.length === 0)
            return;
        const cmds = this.drainCommands();
        const waiters = this.pollWaiters;
        this.pollWaiters = [];
        // Only the first waiter receives the commands to avoid duplicate execution
        // across pollers; the rest resolve empty and will re-poll.
        waiters.forEach((w, i) => w(i === 0 ? cmds : []));
    }
    // ---- Command results -------------------------------------------------
    recordResult(res) {
        this.results.set(res.id, res);
        this.lastContact = Date.now();
    }
    getResult(id) {
        return this.results.get(id);
    }
    /** Wait for a command result up to timeoutMs, polling internally. */
    async waitForResult(id, timeoutMs) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const r = this.results.get(id);
            if (r)
                return r;
            await new Promise((res) => setTimeout(res, 25));
        }
        return this.results.get(id) ?? null;
    }
}
