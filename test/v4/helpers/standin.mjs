// Stand-in servers for Quran Lab's hosts (ENDPOINTS_40.md 28.8's checks run on the SDK's real HTTP code): one local
// HTTP server per host name of a role, each answering through the fake API and CDN (fake-api.mjs) or failing the way a
// check asks. The SDK keeps the production host names; the endpoint set's `origins` seam says where each is served.
//
//   mode 'pass'      the fake API or CDN answers
//   mode 'refused'   no server on the port: the connection is refused
//   mode 'hang'      the connection is taken and nothing ever comes (a connect that never completes, as fetch sees it)
//   mode 'reset'     the connection is closed at once, no answer
//   { status, body?, headers? }   that answer (body: an object is sent as JSON, a string as it is)
//   { cutAfter: n }  a model file: n bytes of the answer, then the connection ends
import { createServer } from 'node:http';

/**
 * One server per host. `forward(host, req, body)` gives the Response for 'pass'. Resolves { origins, set(host, mode),
 * log (every request: { host, method, path, headers }), asked(path?) (the hosts in order), close() }.
 */
export async function standins(hosts, forward) {
  const modes = new Map(hosts.map((h) => [h, 'pass']));
  const log = [], servers = new Map(), origins = {}, ports = new Map(), sockets = new Set();
  const handler = (host) => async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks).toString() : undefined;
    log.push({ host, method: req.method, path: req.url, headers: req.headers });
    const m = modes.get(host);
    if (m === 'hang') return; // never answered (the client's bound ends it)
    if (m === 'reset') { req.socket.destroy(); return; }
    if (m && typeof m === 'object' && m.status) {
      const b = m.body === undefined ? '' : typeof m.body === 'string' ? m.body : JSON.stringify(m.body);
      res.writeHead(m.status, { 'content-type': typeof m.body === 'object' ? 'application/json' : 'text/html', ...(m.headers || {}) });
      res.end(b);
      return;
    }
    const r = await forward(host, req, body);
    const h = {};
    r.headers.forEach((v, k) => { h[k] = v; });
    const bytes = Buffer.from(await r.arrayBuffer());
    if (m && typeof m === 'object' && m.cutAfter !== undefined) {
      // a model file that begins and breaks: the status and n bytes, then the connection ends
      res.writeHead(r.status, { ...h, 'content-length': String(bytes.length) });
      res.write(bytes.subarray(0, m.cutAfter), () => setTimeout(() => req.socket.destroy(), 20));
      return;
    }
    res.writeHead(r.status, h);
    res.end(bytes);
  };
  const listen = (host, port = 0) => new Promise((resolve) => {
    const s = createServer(handler(host));
    s.on('connection', (c) => { sockets.add(c); c.on('close', () => sockets.delete(c)); });
    s.listen(port, '127.0.0.1', () => { servers.set(host, s); ports.set(host, s.address().port); resolve(); });
  });
  for (const h of hosts) { await listen(h); origins[h] = `http://127.0.0.1:${ports.get(h)}`; }
  const stop = (host) => new Promise((resolve) => {
    const s = servers.get(host);
    servers.delete(host);
    if (!s) { resolve(); return; }
    s.close(() => resolve());
    for (const c of sockets) if (c.localPort === ports.get(host)) c.destroy();
  });
  return {
    origins, log,
    /** a host's mode from now on ('refused' closes its port; another mode opens it again on the same port) */
    async set(host, mode) {
      if (mode === 'refused') { modes.set(host, mode); await stop(host); return; }
      modes.set(host, mode);
      if (!servers.has(host)) await listen(host, ports.get(host));
    },
    asked: (path = null) => log.filter((x) => !path || x.path.startsWith(path)).map((x) => x.host),
    clear() { log.length = 0; },
    async close() { for (const h of [...servers.keys()]) await stop(h); },
  };
}
