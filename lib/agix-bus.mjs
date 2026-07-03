// agix-bus.mjs — runtime surface for the Rust intra-agent bus (North Star pillar P3).
//
// SPIKE v1. A thin Node client for the local `lewis-aos-bus` daemon: connect over
// a **loopback TCP socket** (127.0.0.1:<port>), speak newline-delimited JSON,
// expose request/reply + pub/sub. This is the `runtime.getBus()` surface — it
// slots beside the runtime's existing swappable surfaces (`getGbrain()` /
// `getBonsai()` / `runAgent()`), and like them it has a smoke-mode stub.
//
// Transport (cross-platform): earlier spikes used a Unix domain socket, which is
// POSIX-only. The transport is now loopback TCP — dependency-free and identical
// on macOS, Linux, and Windows. The wire protocol and request/reply + pub/sub
// semantics are byte-for-byte the same; only the addressing changed.
//
// Wire protocol mirrors cli/crates/lewis-aos-bus/src/main.rs.
//
// Runtime integration (one line, not done here to keep the live runtime untouched):
//   LocalRuntime.getBus = () => createBus({ port: BUS_PORT, agent: this.agentName, trust: this.trust });

import net from 'node:net';

/** Default loopback endpoint — must match the Rust daemon's DEFAULT_ADDR. */
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 17645;

/**
 * Connect to the bus daemon and return a client.
 *
 * New contract: `{ host, port }` (loopback TCP). The legacy `{ port }` is the
 * primary knob; `host` defaults to 127.0.0.1 (loopback — the privacy spine).
 * @param {{host?:string, port?:number, agent?:string, trust?:string}} opts
 */
export function createBus({ host = DEFAULT_HOST, port = DEFAULT_PORT, agent = 'anon', trust = 'observer' } = {}) {
  const conn = net.createConnection({ host, port });
  conn.setNoDelay(true);
  conn.setEncoding('utf8');

  let buf = '';
  let nextId = 1;
  const pending = new Map();      // id -> { resolve }
  const subscribers = new Map();  // topic -> [cb]
  let onCallHandler = null;       // (payload, from) => replyPayload (sync or async)

  let markReady;
  const ready = new Promise((res) => { markReady = res; });

  conn.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      dispatch(msg);
    }
  });
  conn.on('error', (e) => {
    for (const { reject } of pending.values()) reject?.(e);
  });

  function write(obj) { conn.write(JSON.stringify(obj) + '\n'); }

  async function dispatch(msg) {
    switch (msg.t) {
      case 'ok':
        if (msg.hello !== undefined) markReady();
        break;
      case 'rep': {
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p.resolve(msg.payload); }
        break;
      }
      case 'call': {
        // A request routed to THIS agent. Run the handler, reply by gid.
        let payload;
        try {
          payload = onCallHandler ? await onCallHandler(msg.payload, msg.from) : { error: 'no onRequest handler registered' };
        } catch (e) {
          payload = { error: String(e?.message || e) };
        }
        write({ t: 'rep', gid: msg.gid, payload });
        break;
      }
      case 'msg': {
        for (const cb of subscribers.get(msg.topic) || []) cb(msg.payload, msg.from);
        break;
      }
    }
  }

  write({ t: 'hello', agent, trust });

  return {
    ready,
    /** Request a named target agent and await its reply. */
    request(toAgent, payload, { timeoutMs = 5000 } = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`bus request to ${toAgent} timed out`)); }, timeoutMs);
        pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject });
        write({ t: 'req', id, to: toAgent, payload });
      });
    },
    /** Register the handler invoked when another agent requests THIS agent. */
    onRequest(handler) { onCallHandler = handler; },
    /** Subscribe to a topic. */
    subscribe(topic, cb) {
      if (!subscribers.has(topic)) subscribers.set(topic, []);
      subscribers.get(topic).push(cb);
      write({ t: 'sub', topic });
    },
    /** Publish to a topic (fan-out to all subscribers). */
    publish(topic, payload) { write({ t: 'pub', topic, payload }); },
    close() { try { write({ t: 'quit' }); } catch { /* closing */ } conn.end(); },
  };
}

/**
 * Smoke-mode stub — in-memory, no daemon. Mirrors the runtime's smoke-mode
 * contract for the other surfaces. request() routes to a locally-registered
 * onRequest handler if present; otherwise echoes.
 */
export function createBusStub({ agent = 'anon' } = {}) {
  let onCallHandler = null;
  const subscribers = new Map();
  return {
    // Marker so callers (and the runtime's getBus() surface) can tell the
    // in-memory stub from a real socket-backed client — same convention as
    // the other smoke-mode surface stubs (makeSmokeMCPClient, etc.).
    smoke: true,
    ready: Promise.resolve(),
    async request(_toAgent, payload) {
      return onCallHandler ? await onCallHandler(payload, agent) : payload;
    },
    onRequest(h) { onCallHandler = h; },
    subscribe(topic, cb) { if (!subscribers.has(topic)) subscribers.set(topic, []); subscribers.get(topic).push(cb); },
    publish(topic, payload) { for (const cb of subscribers.get(topic) || []) cb(payload, agent); },
    close() {},
  };
}

/** Factory the runtime would call: real client unless SMOKE=1. */
export function getBus(opts = {}) {
  return process.env.SMOKE === '1' ? createBusStub(opts) : createBus(opts);
}
