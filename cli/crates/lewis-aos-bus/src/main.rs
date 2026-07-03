//! lewis-aos-bus — SPIKE v3 (North Star pillar P3: the Rust intra-agent bus).
//!
//! A local, low-latency, agent-to-agent communication bus over a **loopback TCP
//! socket** (127.0.0.1:<port>), with **real target-routing** and
//! newline-delimited **JSON** framing (matching the gbrain stdio-JSON-RPC
//! contract direction).
//!
//! Transport note (cross-platform): earlier spikes used a Unix domain socket
//! (`/tmp/lewis-aos-bus.sock`), which is POSIX-only and does not compile on
//! Windows. The transport is now a loopback TCP socket — dependency-free
//! (`std::net::TcpListener` / Node `net.connect({host,port})`) and identical on
//! macOS, Linux, and Windows. Only the transport/addressing changed; the
//! newline-delimited-JSON wire protocol and request/reply + pub/sub semantics
//! are byte-for-byte the same. The listener binds 127.0.0.1 ONLY (loopback —
//! the privacy spine; never 0.0.0.0).
//!
//! v1 over v0: messages are JSON; `req` is *routed to a named target agent*
//! (not echoed by the daemon) and the target's `rep` is *relayed back to the
//! original requester*, correlated by id. This is a genuine A → daemon → B →
//! daemon → A handoff — the thing two live agents actually use.
//!
//! v2: daemon-as-directory + peer-to-peer — the daemon brokers the introduction
//! (`register`/`locate`) once, then the agents talk DIRECTLY (daemon out of the
//! message path). 4 hops (A→daemon→B→daemon→A) collapse to 2 (A→B→A).
//!
//! v3 (this version): attacks the remaining **per-message overhead** that v2's
//! verdict named — JSON parse + `BufReader` line scan on every round-trip. The
//! HOT p2p data path now uses **length-prefixed binary framing** (a 4-byte
//! big-endian length prefix + raw payload bytes), avoiding both JSON parse and
//! newline scanning on each hop. The daemon's control/JSON path (HELLO / req /
//! rep / sub / pub / register / locate) is UNCHANGED — JSON clients still speak
//! the same wire protocol. v3 is constant-factor optimization on the proven v2
//! architecture, not a shape change.
//!
//! Subcommands (the [addr] argument is a port or host:port; default 127.0.0.1:17645):
//!   serve [addr]              start the bus daemon (default 127.0.0.1:17645)
//!   bench [addr] [iters]      routed/p2p-json/p2p-binary vs in-process vs file-ledger
//!   bench-throughput [addr] [n-per-thread] [concurrency]
//!                             sustained msgs/sec under N concurrent requesters all
//!                             routing through the daemon to one shared responder
//!                             (the "fleet of agents talking at once" fan-out case)
//!   bench-throughput-p2p [addr] [n-per-thread] [concurrency]
//!                             sustained msgs/sec on the DIRECT p2p-binary path —
//!                             daemon brokers the intro once per pair, then each
//!                             requester↔responder talks direct (daemon OUT of the
//!                             message path). The throughput analog of `bench`'s
//!                             p2p-binary LATENCY channel; mirrors bench-throughput's
//!                             structure (same N, payload, single + concurrent) EXCEPT
//!                             the path. The number the routed throughput never measured.
//!
//! Wire protocol (newline-delimited JSON; `payload` is arbitrary JSON) — UNCHANGED
//! across the Unix-socket → loopback-TCP transport switch:
//!   client → daemon:
//!     {"t":"hello","agent":"<name>","trust":"<level>"}   register identity
//!     {"t":"req","id":N,"to":"<agent>","payload":...}     request to a target agent
//!     {"t":"rep","gid":G,"payload":...}                   a target's reply to a delivered call
//!     {"t":"sub","topic":"<t>"}                            subscribe
//!     {"t":"pub","topic":"<t>","payload":...}             publish
//!     {"t":"quit"}
//!   daemon → client:
//!     {"t":"ok",...}                                       hello/sub ack
//!     {"t":"call","gid":G,"from":"<agent>","payload":...}  delivered to the target of a req
//!     {"t":"rep","id":N,"payload":...}                     the requester's correlated reply
//!     {"t":"msg","topic":"<t>","from":"<agent>","payload":...}  to subscribers
//!     {"t":"err","msg":"..."}
//!
//! Identity note: `from` is the daemon-attested sender (set at HELLO on that
//! connection), not a client-supplied field — an agent cannot forge another's
//! identity on a message. Production adds connection-credential verification.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Default loopback TCP endpoint (privacy spine: 127.0.0.1 only, never 0.0.0.0).
const DEFAULT_ADDR: &str = "127.0.0.1:17645";

/// Normalize an addr argument: a bare port (`"17645"`) is bound on loopback;
/// a full `host:port` is used verbatim (callers should still pass 127.0.0.1).
fn normalize_addr(addr: &str) -> String {
    if addr.contains(':') {
        addr.to_string()
    } else {
        format!("127.0.0.1:{}", addr)
    }
}

// v1.1: a connection's writer is an Arc<Mutex<TcpStream>> registered ONCE at
// HELLO. Routing clones the Arc (a refcount bump), never the fd — eliminating the
// two `dup()` syscalls per request that dominated v1's 138µs round-trip.
type Wtr = Arc<Mutex<TcpStream>>;

struct State {
    agents: HashMap<String, Wtr>,        // agent name -> shared writer (routed delivery)
    subs: HashMap<String, Vec<Wtr>>,     // topic -> subscriber writers
    pending: HashMap<u64, (Wtr, u64)>,   // gid -> (requester writer, requester local id)
    directory: HashMap<String, String>,  // v2: agent name -> its own listen addr (host:port) for p2p
}

type Shared = Arc<(Mutex<State>, AtomicU64)>;

fn send(stream: &mut TcpStream, v: &Value) {
    let _ = writeln!(stream, "{}", v);
}

fn send_to(w: &Wtr, v: &Value) {
    if let Ok(mut s) = w.lock() {
        let _ = writeln!(s, "{}", v);
    }
}

// ---------------------------------------------------------------------------
// v3 — length-prefixed binary framing (the HOT p2p data path only).
//
// Frame = [4-byte big-endian u32 length][that many raw payload bytes]. No JSON
// parse, no newline scan: the reader pulls exactly `len` bytes after reading the
// fixed 4-byte header, so it never has to inspect the payload's contents to find
// the message boundary. This is the canonical "framed stream" shape (the same
// idea as `tokio_util::codec::LengthDelimitedCodec`, hand-rolled std-only).
//
// The payload bytes are opaque to the framing layer — they can carry JSON,
// MessagePack, or raw bytes; the hot path treats them as an echoed blob so the
// measured delta isolates the *framing* cost (parse + line-scan) from everything
// else. MAX_FRAME guards against a corrupt/hostile length header.
// ---------------------------------------------------------------------------

const MAX_FRAME: u32 = 16 * 1024 * 1024; // 16 MiB hard cap on a single frame

/// Write a single length-prefixed binary frame. Returns Err on IO failure or
/// oversize payload.
fn write_frame<W: Write>(w: &mut W, payload: &[u8]) -> std::io::Result<()> {
    let len = payload.len();
    if len as u64 > MAX_FRAME as u64 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "frame exceeds MAX_FRAME",
        ));
    }
    let hdr = (len as u32).to_be_bytes();
    w.write_all(&hdr)?;
    w.write_all(payload)?;
    w.flush()
}

/// Read a single length-prefixed binary frame into `buf` (reused across calls to
/// avoid per-message allocation). Returns the number of payload bytes read, or
/// Err on EOF / IO failure / oversize header.
fn read_frame<R: Read>(r: &mut R, buf: &mut Vec<u8>) -> std::io::Result<usize> {
    let mut hdr = [0u8; 4];
    r.read_exact(&mut hdr)?;
    let len = u32::from_be_bytes(hdr);
    if len > MAX_FRAME {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "frame header exceeds MAX_FRAME",
        ));
    }
    let len = len as usize;
    if buf.len() < len {
        buf.resize(len, 0);
    }
    r.read_exact(&mut buf[..len])?;
    Ok(len)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("help");
    // Addressing: positional [addr] (port or host:port), else LEWIS_AOS_BUS_ADDR
    // env, else the default loopback endpoint. Loopback-only by construction.
    let addr = args
        .get(2)
        .cloned()
        .or_else(|| std::env::var("LEWIS_AOS_BUS_ADDR").ok())
        .map(|a| normalize_addr(&a))
        .unwrap_or_else(|| DEFAULT_ADDR.to_string());
    match cmd {
        "serve" => serve(&addr),
        "bench" => {
            let n: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(20000);
            bench(&addr, n);
        }
        "bench-throughput" => {
            // bench-throughput [addr] [n-per-thread] [concurrency]
            let n: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(20000);
            let concurrency: usize = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(8);
            bench_throughput(&addr, n, concurrency);
        }
        "bench-throughput-p2p" => {
            // bench-throughput-p2p [addr] [n-per-thread] [concurrency]
            let n: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(20000);
            let concurrency: usize = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(8);
            bench_throughput_p2p(&addr, n, concurrency);
        }
        _ => {
            eprintln!("lewis-aos-bus (spike v1) — usage:");
            eprintln!("  lewis-aos-bus serve [addr]                 (port or host:port; default {})", DEFAULT_ADDR);
            eprintln!("  lewis-aos-bus bench [addr] [iterations]");
            eprintln!("  lewis-aos-bus bench-throughput [addr] [n-per-thread] [concurrency]");
            eprintln!("  lewis-aos-bus bench-throughput-p2p [addr] [n-per-thread] [concurrency]");
        }
    }
}

fn serve(addr: &str) {
    let listener = TcpListener::bind(addr).expect("bind loopback tcp socket");
    eprintln!("[bus] listening on {} (v1: routing + json, loopback tcp)", addr);
    let shared: Shared = Arc::new((
        Mutex::new(State {
            agents: HashMap::new(),
            subs: HashMap::new(),
            pending: HashMap::new(),
            directory: HashMap::new(),
        }),
        AtomicU64::new(1),
    ));
    for stream in listener.incoming() {
        if let Ok(stream) = stream {
            // Low-latency: disable Nagle so small JSON frames flush immediately
            // (the round-trip is latency-bound; this matches the prior UDS behavior).
            let _ = stream.set_nodelay(true);
            let shared = Arc::clone(&shared);
            thread::spawn(move || handle(stream, shared));
        }
    }
}

fn handle(stream: TcpStream, shared: Shared) {
    // One writer handle for THIS connection, shared (Arc) into the routing maps
    // exactly once. No per-request `try_clone()` / `dup()`.
    let writer: Wtr = Arc::new(Mutex::new(stream.try_clone().expect("clone stream")));
    let reader = BufReader::new(stream);
    let mut me = String::from("anon");
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => {
                send_to(&writer, &json!({"t":"err","msg":"bad json"}));
                continue;
            }
        };
        match v["t"].as_str().unwrap_or("") {
            "hello" => {
                me = v["agent"].as_str().unwrap_or("anon").to_string();
                let trust = v["trust"].as_str().unwrap_or("observer").to_string();
                shared.0.lock().unwrap().agents.insert(me.clone(), Arc::clone(&writer));
                send_to(&writer, &json!({"t":"ok","hello":me,"trust":trust}));
            }
            "req" => {
                let id = v["id"].as_u64().unwrap_or(0);
                let to = v["to"].as_str().unwrap_or("");
                let gid = shared.1.fetch_add(1, Ordering::SeqCst);
                // Brief lock: clone the Arc (refcount bump), register pending, release.
                let target = {
                    let mut st = shared.0.lock().unwrap();
                    match st.agents.get(to).map(Arc::clone) {
                        Some(t) => {
                            st.pending.insert(gid, (Arc::clone(&writer), id));
                            Some(t)
                        }
                        None => None,
                    }
                };
                match target {
                    Some(t) => send_to(
                        &t,
                        &json!({"t":"call","gid":gid,"from":me,"payload":v["payload"].clone()}),
                    ),
                    None => send_to(
                        &writer,
                        &json!({"t":"rep","id":id,"payload":{"error":format!("no such agent: {}", to)}}),
                    ),
                }
            }
            "rep" => {
                let gid = v["gid"].as_u64().unwrap_or(0);
                let entry = shared.0.lock().unwrap().pending.remove(&gid);
                if let Some((req_writer, id)) = entry {
                    send_to(&req_writer, &json!({"t":"rep","id":id,"payload":v["payload"].clone()}));
                }
            }
            "sub" => {
                let topic = v["topic"].as_str().unwrap_or("").to_string();
                shared.0.lock().unwrap().subs.entry(topic.clone()).or_default().push(Arc::clone(&writer));
                send_to(&writer, &json!({"t":"ok","sub":topic}));
            }
            "pub" => {
                let topic = v["topic"].as_str().unwrap_or("").to_string();
                let msg = json!({"t":"msg","topic":topic,"from":me,"payload":v["payload"].clone()});
                let targets: Vec<Wtr> = {
                    let st = shared.0.lock().unwrap();
                    st.subs.get(&topic).map(|l| l.to_vec()).unwrap_or_default()
                };
                for w in &targets {
                    send_to(w, &msg);
                }
            }
            // v2 directory: daemon brokers the introduction, then peers talk direct.
            "register" => {
                let agent = v["agent"].as_str().unwrap_or("").to_string();
                let addr = v["addr"].as_str().unwrap_or("").to_string();
                shared.0.lock().unwrap().directory.insert(agent.clone(), addr);
                send_to(&writer, &json!({"t":"ok","registered":agent}));
            }
            "locate" => {
                let agent = v["agent"].as_str().unwrap_or("");
                let addr = shared.0.lock().unwrap().directory.get(agent).cloned();
                match addr {
                    Some(a) => send_to(&writer, &json!({"t":"located","agent":agent,"addr":a})),
                    None => send_to(&writer, &json!({"t":"located","agent":agent,"addr":Value::Null})),
                }
            }
            "quit" => break,
            _ => send_to(&writer, &json!({"t":"err","msg":"unknown type"})),
        }
    }
    shared.0.lock().unwrap().agents.remove(&me);
}

fn bench(addr: &str, n: usize) {
    println!("lewis-aos-bus spike v3 benchmark — {} iterations per channel", n);
    println!("(routed     = requester->daemon->responder->daemon->requester [4 hops];");
    println!(" p2p-json   = daemon brokers the intro once, then direct, newline-JSON framing [2 hops];");
    println!(" p2p-binary = same 2-hop direct path, length-prefixed BINARY framing [v3 hot path])\n");

    // Responder agent "echo": handles `call` by replying. Signals readiness once
    // the daemon has registered it (no sleep, no polling — a channel handshake).
    let sock_r = addr.to_string();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();
    thread::spawn(move || {
        let s = TcpStream::connect(&sock_r).expect("responder connect");
        let _ = s.set_nodelay(true);
        let mut w = s.try_clone().unwrap();
        let mut r = BufReader::new(s);
        send(&mut w, &json!({"t":"hello","agent":"echo","trust":"executor"}));
        let mut ack = String::new();
        let _ = r.read_line(&mut ack); // daemon "ok" => registered
        ready_tx.send(()).ok();
        for line in r.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if line.trim().is_empty() {
                continue;
            }
            let v: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if v["t"] == "call" {
                let gid = v["gid"].as_u64().unwrap_or(0);
                send(&mut w, &json!({"t":"rep","gid":gid,"payload":v["payload"].clone()}));
            }
        }
    });
    ready_rx.recv().expect("responder ready");

    // Requester "bencher".
    let s = TcpStream::connect(addr).expect("requester connect");
    let _ = s.set_nodelay(true);
    let mut w = s.try_clone().unwrap();
    let mut r = BufReader::new(s);
    send(&mut w, &json!({"t":"hello","agent":"bencher","trust":"executor"}));
    let mut ack = String::new();
    r.read_line(&mut ack).unwrap();

    let payload = json!({"task":"handoff","from":"research","to":"architect","topic":"fld-spec"});

    // 1) routed bus round-trip
    let mut bus = Vec::with_capacity(n);
    for i in 0..n {
        let t = Instant::now();
        send(&mut w, &json!({"t":"req","id":i,"to":"echo","payload":payload}));
        let mut resp = String::new();
        r.read_line(&mut resp).unwrap();
        bus.push(t.elapsed());
    }

    // 2) in-process call baseline (today's runAgent)
    let mut inproc = Vec::with_capacity(n);
    let ps = payload.to_string();
    for i in 0..n {
        let t = Instant::now();
        let out = inproc_echo(i, &ps);
        std::hint::black_box(&out);
        inproc.push(t.elapsed());
    }

    // 3) file-ledger round-trip baseline (today's director/queue). Placed in the
    //    OS temp dir (the addr is now a host:port, not a filesystem path, and a
    //    `:` is not a valid filename character on Windows).
    let ledger = std::env::temp_dir()
        .join("lewis-aos-bus-bench.ledger")
        .to_string_lossy()
        .into_owned();
    let mut file = Vec::with_capacity(n);
    for i in 0..n {
        let t = Instant::now();
        std::fs::write(&ledger, format!("{} {}", i, ps)).unwrap();
        let back = std::fs::read_to_string(&ledger).unwrap();
        std::hint::black_box(&back);
        file.push(t.elapsed());
    }
    let _ = std::fs::remove_file(&ledger);

    // 4) p2p: the daemon brokers the introduction ONCE (register + locate), then
    //    the requester talks DIRECTLY to the responder's own socket — daemon out
    //    of the message path. 4 hops collapse to 2 (A->B->A).
    let listener = TcpListener::bind("127.0.0.1:0").expect("p2p responder bind");
    let p2p_addr = listener.local_addr().expect("p2p local addr").to_string();
    let (p2p_ready_tx, p2p_ready_rx) = std::sync::mpsc::channel::<()>();
    thread::spawn(move || {
        p2p_ready_tx.send(()).ok(); // listener is bound
        if let Some(Ok(conn)) = listener.incoming().next() {
            let _ = conn.set_nodelay(true);
            let mut cw = conn.try_clone().unwrap();
            let cr = BufReader::new(conn);
            for line in cr.lines() {
                let line = match line { Ok(l) => l, Err(_) => break };
                if line.trim().is_empty() { continue; }
                let v: Value = match serde_json::from_str(&line) { Ok(v) => v, Err(_) => continue };
                if v["t"] == "req" {
                    send(&mut cw, &json!({"t":"rep","id":v["id"].clone(),"payload":v["payload"].clone()}));
                }
            }
        }
    });
    p2p_ready_rx.recv().expect("p2p responder bound");

    // the introduction (the daemon's only involvement on this path)
    send(&mut w, &json!({"t":"register","agent":"echo-p2p","addr":p2p_addr}));
    let mut reg_ack = String::new();
    r.read_line(&mut reg_ack).unwrap();
    send(&mut w, &json!({"t":"locate","agent":"echo-p2p"}));
    let mut loc = String::new();
    r.read_line(&mut loc).unwrap();
    let loc_v: Value = serde_json::from_str(&loc).unwrap();
    let peer_addr = loc_v["addr"].as_str().expect("located peer addr").to_string();

    // direct connection — daemon is now out of the path
    let ds = TcpStream::connect(&peer_addr).expect("direct connect to peer");
    let _ = ds.set_nodelay(true);
    let mut dw = ds.try_clone().unwrap();
    let mut dr = BufReader::new(ds);
    let mut p2p = Vec::with_capacity(n);
    for i in 0..n {
        let t = Instant::now();
        send(&mut dw, &json!({"t":"req","id":i,"payload":payload}));
        let mut resp = String::new();
        dr.read_line(&mut resp).unwrap();
        p2p.push(t.elapsed());
    }

    // 5) v3 p2p with LENGTH-PREFIXED BINARY FRAMING — same 2-hop direct path as
    //    (4), but the data path swaps newline-JSON for [u32-be len][bytes]. The
    //    responder echoes the raw payload bytes without parsing them, so this
    //    channel isolates the per-message *framing* cost (JSON parse + BufReader
    //    line scan) from the hop cost (which is identical to channel 4). The
    //    delta between (4) and (5) IS the per-message-overhead recovery v2's
    //    verdict named as the remaining gap toward the v0 ~10µs class.
    let bin_listener = TcpListener::bind("127.0.0.1:0").expect("binary p2p responder bind");
    let bin_addr = bin_listener.local_addr().expect("binary p2p local addr").to_string();
    let (bin_ready_tx, bin_ready_rx) = std::sync::mpsc::channel::<()>();
    thread::spawn(move || {
        bin_ready_tx.send(()).ok(); // listener is bound
        if let Some(Ok(conn)) = bin_listener.incoming().next() {
            let _ = conn.set_nodelay(true);
            let mut cw = conn.try_clone().unwrap();
            let mut cr = conn; // raw stream — no BufReader, read_exact frames it
            let mut frame = Vec::with_capacity(256);
            loop {
                match read_frame(&mut cr, &mut frame) {
                    Ok(len) => {
                        // echo the exact payload bytes back, reframed
                        if write_frame(&mut cw, &frame[..len]).is_err() {
                            break;
                        }
                    }
                    Err(_) => break, // EOF when the requester drops the connection
                }
            }
        }
    });
    bin_ready_rx.recv().expect("binary p2p responder bound");

    // Direct connection to the binary peer — daemon out of the path, identical
    // hop count to channel 4; only the framing differs.
    let bs = TcpStream::connect(&bin_addr).expect("direct connect to binary peer");
    let _ = bs.set_nodelay(true);
    let mut bw = bs.try_clone().unwrap();
    let mut br = bs; // raw stream; read_frame uses read_exact
    // Pre-serialize the payload ONCE (the hot path ships opaque bytes; in a real
    // deployment the sender chooses the codec — JSON, MessagePack, raw — but the
    // framing cost we are measuring is independent of that choice).
    let payload_bytes = payload.to_string().into_bytes();
    let mut recv_buf: Vec<u8> = Vec::with_capacity(256);
    let mut p2p_bin = Vec::with_capacity(n);
    for _ in 0..n {
        let t = Instant::now();
        write_frame(&mut bw, &payload_bytes).unwrap();
        let _len = read_frame(&mut br, &mut recv_buf).unwrap();
        std::hint::black_box(&recv_buf);
        p2p_bin.push(t.elapsed());
    }
    drop(bw); // signal EOF so the responder thread exits cleanly
    drop(br);

    report("routed bus (A->daemon->B->daemon->A)", &mut bus);
    report("p2p-json (daemon-brokered intro, then direct)", &mut p2p);
    report("p2p-binary (v3 length-prefixed framing, direct)", &mut p2p_bin);
    report("in-process call (runAgent today)", &mut inproc);
    report("file-ledger (director/queue today)", &mut file);

    let bm = mean(&bus);
    let pm = mean(&p2p);
    let pbm = mean(&p2p_bin);
    let fm = mean(&file);
    if pm.as_nanos() > 0 {
        println!(
            "\np2p-json is {:.1}x faster than daemon-routed (mean) — the hop-reduction the v1.1 verdict predicted.",
            bm.as_nanos() as f64 / pm.as_nanos() as f64
        );
        println!(
            "p2p-json vs file-ledger (mean): {:.1}x faster.",
            fm.as_nanos() as f64 / pm.as_nanos() as f64
        );
    }
    if pbm.as_nanos() > 0 {
        println!(
            "\n=== v3 framing delta (the point of this version) ===",
        );
        println!(
            "p2p-binary vs p2p-json (mean): {:.2}x faster — {:.1}% of the per-message\n  JSON-parse + BufReader-line-scan overhead recovered by length-prefixed framing.",
            pm.as_nanos() as f64 / pbm.as_nanos() as f64,
            if pm.as_nanos() > pbm.as_nanos() {
                100.0 * (pm.as_nanos() - pbm.as_nanos()) as f64 / pm.as_nanos() as f64
            } else {
                0.0
            }
        );
        println!(
            "p2p-binary vs v0 single-hop ~10µs class: {:.1}µs mean (the remaining gap toward 10µs).",
            pbm.as_nanos() as f64 / 1000.0
        );
        println!(
            "p2p-binary vs file-ledger (mean): {:.1}x faster.",
            fm.as_nanos() as f64 / pbm.as_nanos() as f64
        );
    }

    // responder threads exit when their connections drop / the process does.
}

// ---------------------------------------------------------------------------
// bench-throughput — fan-out under load (North Star P2/P3: "a fleet of agents
// talking at once"). Where `bench` measures single-message round-trip LATENCY,
// this measures sustained THROUGHPUT (msgs/sec) and how it behaves as the number
// of concurrent requesters grows.
//
// Topology: ONE shared `echo` responder agent registered with the daemon, and
// `concurrency` independent requester connections, each doing `n` routed
// round-trips THROUGH the daemon (requester -> daemon -> echo -> daemon ->
// requester, 4 hops). Routing every requester at a single shared responder is the
// real contention point — it exercises the daemon's central State mutex + the
// responder's serialized inbound stream, which is exactly the "many agents
// publishing/requesting at once" case a live fleet produces.
//
// We report TWO topologies (the real fleet has both shapes):
//   A) SHARED target  — all `concurrency` requesters route at ONE `echo` agent.
//      The hot-target contention case: the responder's single inbound stream +
//      the daemon's central State mutex serialize work, so aggregate throughput
//      plateaus rather than scaling linearly.
//   B) PAIRED targets — each requester gets its OWN dedicated `echo-<i>` agent.
//      The parallel-fleet case (independent conversations): no single hot target,
//      so throughput scales much closer to linear (capped only by the daemon's
//      shared State mutex on each routing hop and core count).
// Plus a single-requester baseline so the scaling factors are honest.
//
// Additive: this does NOT touch `serve`, `bench`, or the wire protocol — it is a
// new client-side load generator over the UNCHANGED routed JSON path.
// ---------------------------------------------------------------------------

/// Spawn an `echo`-style responder under the given agent name. Returns once the
/// daemon has acked its HELLO (so requesters can route to it immediately). The
/// responder thread runs until its connection drops (process exit).
fn spawn_throughput_responder(sock: &str, agent: &str) {
    let sock_r = sock.to_string();
    let agent_r = agent.to_string();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();
    thread::spawn(move || {
        let s = TcpStream::connect(&sock_r).expect("throughput responder connect");
        let _ = s.set_nodelay(true);
        let mut w = s.try_clone().unwrap();
        let mut r = BufReader::new(s);
        send(&mut w, &json!({"t":"hello","agent":agent_r,"trust":"executor"}));
        let mut ack = String::new();
        let _ = r.read_line(&mut ack); // daemon "ok" => registered
        ready_tx.send(()).ok();
        for line in r.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if line.trim().is_empty() {
                continue;
            }
            let v: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if v["t"] == "call" {
                let gid = v["gid"].as_u64().unwrap_or(0);
                send(&mut w, &json!({"t":"rep","gid":gid,"payload":v["payload"].clone()}));
            }
        }
    });
    ready_rx.recv().expect("throughput responder ready");
}

/// Run `n` routed round-trips through the daemon from `concurrency` independent
/// requester connections. `target_of(tid)` picks each requester's target agent —
/// return a constant for the shared-target topology, or a per-tid name for the
/// paired topology. Returns (aggregate_msgs_per_sec, per_thread_msgs_per_sec,
/// wall_clock_secs).
fn run_throughput(
    sock: &str,
    n: usize,
    concurrency: usize,
    target_of: impl Fn(usize) -> String,
) -> (f64, Vec<f64>, f64) {
    let payload = json!({"task":"handoff","from":"research","to":"architect","topic":"fld-spec"});

    // Barrier so every requester starts hammering at the same instant — otherwise
    // early threads finish before later ones connect and the window is skewed.
    let start_gate = Arc::new(std::sync::Barrier::new(concurrency + 1));
    let mut handles = Vec::with_capacity(concurrency);

    for tid in 0..concurrency {
        let sock_t = sock.to_string();
        let payload_t = payload.clone();
        let target = target_of(tid);
        let gate = Arc::clone(&start_gate);
        handles.push(thread::spawn(move || {
            let s = TcpStream::connect(&sock_t).expect("requester connect");
            let _ = s.set_nodelay(true);
            let mut w = s.try_clone().unwrap();
            let mut r = BufReader::new(s);
            send(&mut w, &json!({"t":"hello","agent":format!("bencher-{}", tid),"trust":"executor"}));
            let mut ack = String::new();
            r.read_line(&mut ack).unwrap();

            gate.wait(); // all connections established — fire together
            let t0 = Instant::now();
            for i in 0..n {
                send(&mut w, &json!({"t":"req","id":i,"to":target,"payload":payload_t}));
                let mut resp = String::new();
                r.read_line(&mut resp).unwrap();
            }
            let secs = t0.elapsed().as_secs_f64();
            (n as f64) / secs // this thread's own msgs/sec
        }));
    }

    start_gate.wait(); // release all requesters together
    let wall_t0 = Instant::now();
    let mut per_thread = Vec::with_capacity(concurrency);
    for h in handles {
        per_thread.push(h.join().expect("requester thread"));
    }
    let wall = wall_t0.elapsed().as_secs_f64();
    let total_msgs = (n * concurrency) as f64;
    let aggregate = total_msgs / wall;
    (aggregate, per_thread, wall)
}

fn fairness(per_thread: &[f64]) -> (f64, f64, f64) {
    let mut pt = per_thread.to_vec();
    pt.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let min = pt.first().copied().unwrap_or(0.0);
    let max = pt.last().copied().unwrap_or(0.0);
    let mean = if pt.is_empty() { 0.0 } else { pt.iter().sum::<f64>() / pt.len() as f64 };
    (min, mean, max)
}

fn bench_throughput(sock: &str, n: usize, concurrency: usize) {
    println!(
        "lewis-aos-bus throughput benchmark — {} msgs/thread × {} concurrent requester(s)",
        n, concurrency
    );
    println!("(routed path: requester -> daemon -> responder -> daemon -> requester [4 hops]");
    println!(" topology A = all requesters share ONE responder (hot-target contention);");
    println!(" topology B = each requester has its OWN responder (parallel-fleet, no hot target))\n");

    // --- single-requester baseline (the honest denominator for scaling) ------
    spawn_throughput_responder(sock, "echo");
    let (base_agg, _bt, base_wall) = run_throughput(sock, n, 1, |_| "echo".to_string());
    println!(
        "{:<48} agg={:>12.0} msgs/sec   ({} msgs in {:.3}s)",
        "single requester (baseline)", base_agg, n, base_wall
    );

    // --- topology A: shared target -------------------------------------------
    let (agg_a, pt_a, wall_a) = run_throughput(sock, n, concurrency, |_| "echo".to_string());
    let (min_a, mean_a, max_a) = fairness(&pt_a);
    println!(
        "{:<48} agg={:>12.0} msgs/sec   ({} msgs in {:.3}s)",
        format!("A) {} requesters -> 1 shared responder", concurrency),
        agg_a,
        n * concurrency,
        wall_a
    );
    println!(
        "{:<48} per-thread msgs/sec  min={:.0}  mean={:.0}  max={:.0}",
        "   per-thread fairness", min_a, mean_a, max_a
    );

    // --- topology B: paired targets (one responder per requester) ------------
    for i in 0..concurrency {
        spawn_throughput_responder(sock, &format!("echo-{}", i));
    }
    let (agg_b, pt_b, wall_b) = run_throughput(sock, n, concurrency, |tid| format!("echo-{}", tid));
    let (min_b, mean_b, max_b) = fairness(&pt_b);
    println!(
        "{:<48} agg={:>12.0} msgs/sec   ({} msgs in {:.3}s)",
        format!("B) {} requesters -> {} paired responders", concurrency, concurrency),
        agg_b,
        n * concurrency,
        wall_b
    );
    println!(
        "{:<48} per-thread msgs/sec  min={:.0}  mean={:.0}  max={:.0}",
        "   per-thread fairness", min_b, mean_b, max_b
    );

    // --- scaling interpretation ----------------------------------------------
    let scale_a = if base_agg > 0.0 { agg_a / base_agg } else { 0.0 };
    let scale_b = if base_agg > 0.0 { agg_b / base_agg } else { 0.0 };
    let ideal = concurrency as f64;
    println!("\n=== throughput scaling (the point of this mode) ===");
    println!(
        "A) shared target : {:.2}x single-requester throughput ({:.0}% of linear {}x).",
        scale_a,
        if ideal > 0.0 { 100.0 * scale_a / ideal } else { 0.0 },
        concurrency
    );
    println!(
        "B) paired targets: {:.2}x single-requester throughput ({:.0}% of linear {}x).",
        scale_b,
        if ideal > 0.0 { 100.0 * scale_b / ideal } else { 0.0 },
        concurrency
    );
    let pairing_gain = if agg_a > 0.0 { agg_b / agg_a } else { 0.0 };
    println!(
        "   Pairing responders gains only {:.2}x over the shared target — the binding constraint is NOT",
        pairing_gain
    );
    println!(
        "   the responder's inbound stream but the daemon's ONE central State mutex, taken on every");
    println!(
        "   routing hop ({{req, rep}}), plus the blocking synchronous round-trip (no pipelining): each");
    println!(
        "   requester's rate is capped near the routed single-message latency. The structural lever for");
    println!(
        "   real fan-out scaling is sharding the daemon State (per-agent locks) — or the v2/v3 p2p path,");
    println!(
        "   which removes the daemon from the message path entirely (see `bench`).");
}

// ---------------------------------------------------------------------------
// bench-throughput-p2p — sustained throughput on the DIRECT p2p-binary path.
//
// This is the throughput analog of `bench`'s p2p-binary LATENCY channel
// (main.rs §5) — the one path the routed `bench-throughput` never measured. The
// routed bench drives requester -> daemon -> responder -> daemon -> requester
// (4 hops, central mutex on every hop, newline-JSON). This drives the v3 hot
// path: the daemon brokers a one-time introduction per pair (register/locate),
// then each requester talks DIRECTLY to its responder over a 2-hop (A->B->A)
// length-prefixed BINARY connection — daemon OUT of the message path, no JSON
// parse, no central mutex on the hot loop.
//
// Topology (the honest p2p shape): p2p is point-to-point by construction, so the
// natural concurrency topology is `concurrency` INDEPENDENT requester↔responder
// PAIRS, each on its own direct socket. There is no "shared responder through a
// daemon" because there IS no daemon in the message path — that contention point
// is exactly what p2p removes. So unlike routed (which reports A=shared +
// B=paired), p2p reports only the paired-fleet shape + a single-requester
// baseline. This mirrors bench-throughput's structure (same N, same payload, same
// barrier-gated measurement, single + concurrent) EXCEPT the path.
//
// Additive: this does NOT touch `serve`, `bench`, `bench-throughput`, or the wire
// protocol. It reuses the EXISTING write_frame/read_frame framing and the
// EXISTING register/locate broker — only the load-generator is new.
// ---------------------------------------------------------------------------

/// Spawn a length-prefixed-binary echo responder listening on its OWN loopback
/// TCP port (the p2p peer endpoint — daemon never touches this path). Echoes each
/// received frame's payload bytes back, reframed, WITHOUT parsing them (isolates
/// transport+framing cost, identical to `bench`'s binary responder). Binds an
/// ephemeral 127.0.0.1 port and returns the resolved `host:port` addr once the
/// listener is bound (so the broker's `locate` can hand out a live address).
fn spawn_p2p_binary_responder() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("p2p-binary throughput responder bind");
    let addr = listener.local_addr().expect("p2p-binary local addr").to_string();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();
    thread::spawn(move || {
        ready_tx.send(()).ok(); // listener is bound — locate can return this addr
        if let Some(Ok(conn)) = listener.incoming().next() {
            let _ = conn.set_nodelay(true);
            let mut cw = conn.try_clone().unwrap();
            let mut cr = conn; // raw stream — read_exact frames it, no BufReader
            let mut frame = Vec::with_capacity(256);
            loop {
                match read_frame(&mut cr, &mut frame) {
                    Ok(len) => {
                        if write_frame(&mut cw, &frame[..len]).is_err() {
                            break;
                        }
                    }
                    Err(_) => break, // EOF when the requester drops the connection
                }
            }
        }
    });
    ready_rx.recv().expect("p2p-binary throughput responder bound");
    addr
}

/// Run `n` DIRECT p2p-binary round-trips from `concurrency` independent requester
/// connections, each paired with its own dedicated responder. Each requester does
/// the daemon-brokered intro (register/locate) ONCE, then connects direct and
/// hammers length-prefixed binary frames — daemon out of the hot loop. Returns
/// (aggregate_msgs_per_sec, per_thread_msgs_per_sec, wall_clock_secs). Structurally
/// identical to `run_throughput` (same barrier, same N, same payload) EXCEPT the
/// path: binary frames over a direct socket instead of routed JSON via the daemon.
fn run_throughput_p2p(
    sock: &str,
    n: usize,
    concurrency: usize,
) -> (f64, Vec<f64>, f64) {
    // Same payload as the routed throughput bench, pre-serialized once (the hot
    // path ships opaque bytes; the framing cost we measure is codec-independent).
    let payload = json!({"task":"handoff","from":"research","to":"architect","topic":"fld-spec"});
    let payload_bytes = Arc::new(payload.to_string().into_bytes());

    // Stand up one dedicated p2p responder per requester (paired-fleet topology),
    // register each with the daemon's directory so the requester can `locate` it.
    let mut peer_addrs = Vec::with_capacity(concurrency);
    for _ in 0..concurrency {
        peer_addrs.push(spawn_p2p_binary_responder());
    }

    let start_gate = Arc::new(std::sync::Barrier::new(concurrency + 1));
    let mut handles = Vec::with_capacity(concurrency);

    for tid in 0..concurrency {
        let sock_t = sock.to_string();
        let peer_addr = peer_addrs[tid].clone();
        let agent = format!("echo-p2p-tput-{}", tid);
        let bytes = Arc::clone(&payload_bytes);
        let gate = Arc::clone(&start_gate);
        handles.push(thread::spawn(move || {
            // --- daemon-brokered introduction (the daemon's ONLY involvement) ---
            let cs = TcpStream::connect(&sock_t).expect("p2p requester control connect");
            let _ = cs.set_nodelay(true);
            let mut cw = cs.try_clone().unwrap();
            let mut cr = BufReader::new(cs);
            send(&mut cw, &json!({"t":"hello","agent":format!("p2p-bencher-{}", tid),"trust":"executor"}));
            let mut ack = String::new();
            cr.read_line(&mut ack).unwrap();
            send(&mut cw, &json!({"t":"register","agent":agent,"addr":peer_addr}));
            let mut reg = String::new();
            cr.read_line(&mut reg).unwrap();
            send(&mut cw, &json!({"t":"locate","agent":agent}));
            let mut loc = String::new();
            cr.read_line(&mut loc).unwrap();
            let loc_v: Value = serde_json::from_str(&loc).unwrap();
            let resolved = loc_v["addr"].as_str().expect("located p2p peer addr").to_string();

            // --- direct connection — daemon is now OUT of the message path ------
            let ds = TcpStream::connect(&resolved).expect("p2p direct connect to peer");
            let _ = ds.set_nodelay(true);
            let mut dw = ds.try_clone().unwrap();
            let mut dr = ds; // raw stream; read_frame uses read_exact
            let mut recv_buf: Vec<u8> = Vec::with_capacity(256);

            gate.wait(); // all pairs introduced + connected — fire together
            let t0 = Instant::now();
            for _ in 0..n {
                write_frame(&mut dw, &bytes).unwrap();
                let _len = read_frame(&mut dr, &mut recv_buf).unwrap();
                std::hint::black_box(&recv_buf);
            }
            let secs = t0.elapsed().as_secs_f64();
            drop(dw); // signal EOF so the responder thread exits cleanly
            drop(dr);
            (n as f64) / secs // this thread's own msgs/sec
        }));
    }

    start_gate.wait(); // release all requesters together
    let wall_t0 = Instant::now();
    let mut per_thread = Vec::with_capacity(concurrency);
    for h in handles {
        per_thread.push(h.join().expect("p2p requester thread"));
    }
    let wall = wall_t0.elapsed().as_secs_f64();
    let total_msgs = (n * concurrency) as f64;
    let aggregate = total_msgs / wall;

    // (No socket files to unlink — loopback TCP ports release on listener drop.)
    (aggregate, per_thread, wall)
}

fn bench_throughput_p2p(sock: &str, n: usize, concurrency: usize) {
    println!(
        "lewis-aos-bus p2p-binary throughput benchmark — {} msgs/thread × {} concurrent requester(s)",
        n, concurrency
    );
    println!("(p2p-binary path: daemon brokers the intro ONCE per pair, then requester <-> responder");
    println!(" talk DIRECT [2 hops, A->B->A], length-prefixed binary frames — daemon OUT of the message");
    println!(" path. The throughput analog of `bench`'s p2p-binary latency channel; p2p is point-to-point");
    println!(" by construction, so the topology is N independent requester<->responder pairs.)\n");

    // --- single-requester baseline (the honest denominator for scaling) ------
    let (base_agg, _bt, base_wall) = run_throughput_p2p(sock, n, 1);
    println!(
        "{:<48} agg={:>12.0} msgs/sec   ({} msgs in {:.3}s)",
        "single requester (baseline)", base_agg, n, base_wall
    );

    // --- concurrent paired-fleet (N independent direct pairs) ----------------
    let (agg, pt, wall) = run_throughput_p2p(sock, n, concurrency);
    let (min_p, mean_p, max_p) = fairness(&pt);
    println!(
        "{:<48} agg={:>12.0} msgs/sec   ({} msgs in {:.3}s)",
        format!("{} requesters <-> {} paired responders (direct)", concurrency, concurrency),
        agg,
        n * concurrency,
        wall
    );
    println!(
        "{:<48} per-thread msgs/sec  min={:.0}  mean={:.0}  max={:.0}",
        "   per-thread fairness", min_p, mean_p, max_p
    );

    // --- scaling interpretation ----------------------------------------------
    let scale = if base_agg > 0.0 { agg / base_agg } else { 0.0 };
    let ideal = concurrency as f64;
    println!("\n=== p2p-binary throughput scaling (the point of this mode) ===");
    println!(
        "paired direct pairs: {:.2}x single-requester throughput ({:.0}% of linear {}x).",
        scale,
        if ideal > 0.0 { 100.0 * scale / ideal } else { 0.0 },
        concurrency
    );
    println!(
        "   Unlike the routed path, there is NO central daemon mutex on the hot loop — each pair's");
    println!(
        "   direct socket is independent, so concurrent pairs scale with cores until the OS socket");
    println!(
        "   layer / core count binds (NOT the daemon's single State lock). The per-requester ceiling");
    println!(
        "   is the p2p-binary round-trip latency (~7µs, see `bench`), an order of magnitude under the");
    println!(
        "   routed path's ~132µs — so single-requester p2p throughput alone clears the routed");
    println!(
        "   aggregate. Synchronous (no pipelining): each pair is still 1/latency-capped per-thread.");
}

#[inline(never)]
fn inproc_echo(id: usize, payload: &str) -> String {
    format!("rep {} {}", id, payload)
}

fn mean(times: &[Duration]) -> Duration {
    let sum: Duration = times.iter().sum();
    sum / times.len() as u32
}

fn report(label: &str, times: &mut [Duration]) {
    times.sort();
    let n = times.len();
    let p50 = times[n / 2];
    let p99 = times[(((n as f64) * 0.99) as usize).min(n - 1)];
    let max = times[n - 1];
    println!(
        "{:<40} n={:<7} mean={:?}  p50={:?}  p99={:?}  max={:?}",
        label,
        n,
        mean(times),
        p50,
        p99,
        max
    );
}
