// agix-mcp-client — Q3 unit + protocol tests.
// Runner: node --test test/agix-mcp-client.test.mjs
//
// Spins up an in-process HTTP server speaking minimal MCP (Streamable
// HTTP, JSON-RPC 2.0) plus an OAuth2 token endpoint, so the handshake,
// session header, tool calls, SSE framing, and both OAuth grants are
// exercised end-to-end without network access.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { MCPClient, textFromToolResult, makeSmokeMCPClient } from '../lib/agix-mcp-client.mjs';
import { LocalRuntime } from '../lib/agix-runtime.mjs';

let server;
let baseUrl;
const seen = { tokens: [], grants: [], sessions: [], notifications: 0 };

before(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);

    // OAuth2 token endpoint.
    if (req.url === '/oauth/token') {
      const params = new URLSearchParams(body);
      seen.grants.push(params.get('grant_type'));
      if (params.get('client_id') !== 'agix-client') {
        res.writeHead(401).end(JSON.stringify({ error: 'invalid_client' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: `tok-${seen.grants.length}-${params.get('grant_type')}`,
        token_type: 'Bearer',
        expires_in: 3600,
      }));
      return;
    }

    // MCP endpoint (optionally auth-enforced at /mcp-secure).
    if (req.url === '/mcp' || req.url === '/mcp-secure' || req.url === '/mcp-sse') {
      if (req.url === '/mcp-secure') {
        const auth = req.headers.authorization || '';
        seen.tokens.push(auth);
        if (!auth.startsWith('Bearer tok-')) {
          res.writeHead(401).end();
          return;
        }
      }
      const msg = JSON.parse(body);
      seen.sessions.push(req.headers['mcp-session-id'] || null);

      if (msg.method === 'notifications/initialized') {
        seen.notifications += 1;
        res.writeHead(202).end();
        return;
      }

      const result = routeMethod(msg);
      const response = { jsonrpc: '2.0', id: msg.id, ...result };
      if (req.url === '/mcp-sse') {
        // SSE framing: a ping event first, then the response.
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"jsonrpc":"2.0","method":"ping"}\n\n');
        res.write(`data: ${JSON.stringify(response)}\n\n`);
        res.end();
        return;
      }
      const headers = { 'Content-Type': 'application/json' };
      if (msg.method === 'initialize') headers['Mcp-Session-Id'] = 'sess-123';
      res.writeHead(200, headers);
      res.end(JSON.stringify(response));
      return;
    }

    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function routeMethod(msg) {
  if (msg.method === 'initialize') {
    return { result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'test-mcp', version: '1.0' } } };
  }
  if (msg.method === 'tools/list') {
    return { result: { tools: [{ name: 'echo', description: 'Echoes input', inputSchema: { type: 'object' } }] } };
  }
  if (msg.method === 'tools/call') {
    if (msg.params.name !== 'echo') {
      return { error: { code: -32602, message: `unknown tool ${msg.params.name}` } };
    }
    return { result: { content: [{ type: 'text', text: `echo: ${msg.params.arguments.text}` }], isError: false } };
  }
  return { error: { code: -32601, message: 'method not found' } };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });
}

// ─── Handshake + tools ─────────────────────────────────────────────────

test('initialize handshake captures session id + server info, sends initialized', async () => {
  const client = new MCPClient({ url: `${baseUrl}/mcp` });
  const init = await client.initialize();
  assert.equal(init.serverInfo.name, 'test-mcp');
  assert.equal(client.sessionId, 'sess-123');
  assert.ok(seen.notifications >= 1, 'notifications/initialized was sent');

  const tools = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['echo']);
  // Subsequent requests carry the session header.
  assert.equal(seen.sessions.at(-1), 'sess-123');
});

test('callTool round-trips and textFromToolResult extracts text', async () => {
  const client = new MCPClient({ url: `${baseUrl}/mcp` });
  await client.initialize();
  const result = await client.callTool('echo', { text: 'hello dojo' });
  assert.equal(textFromToolResult(result), 'echo: hello dojo');
});

test('JSON-RPC errors surface as thrown errors', async () => {
  const client = new MCPClient({ url: `${baseUrl}/mcp` });
  await client.initialize();
  await assert.rejects(() => client.callTool('nope', {}), /unknown tool nope/);
});

test('SSE-framed responses are parsed (ping events skipped)', async () => {
  const client = new MCPClient({ url: `${baseUrl}/mcp-sse` });
  await client.initialize();
  const result = await client.callTool('echo', { text: 'over sse' });
  assert.equal(textFromToolResult(result), 'echo: over sse');
});

// ─── OAuth2 ────────────────────────────────────────────────────────────

test('oauth2 client_credentials: token fetched once, cached, sent as Bearer', async () => {
  seen.tokens.length = 0;
  const grantsBefore = seen.grants.length;
  const client = new MCPClient({
    url: `${baseUrl}/mcp-secure`,
    auth: { type: 'oauth2', token_url: `${baseUrl}/oauth/token`, client_id: 'agix-client', client_secret: 's3cret' },
  });
  await client.initialize();
  await client.callTool('echo', { text: 'authed' });
  assert.equal(seen.grants.length - grantsBefore, 1, 'token fetched once and cached');
  assert.equal(seen.grants.at(-1), 'client_credentials');
  assert.ok(seen.tokens.every((t) => t.startsWith('Bearer tok-')));
});

test('oauth2 refresh_token grant is used when a refresh token is configured', async () => {
  const client = new MCPClient({
    url: `${baseUrl}/mcp-secure`,
    auth: {
      type: 'oauth2', token_url: `${baseUrl}/oauth/token`,
      client_id: 'agix-client', client_secret: 's3cret', refresh_token: 'rt-1',
    },
  });
  await client.initialize();
  assert.equal(seen.grants.at(-1), 'refresh_token');
});

test('expired tokens are refreshed before the next call', async () => {
  const client = new MCPClient({
    url: `${baseUrl}/mcp-secure`,
    auth: { type: 'oauth2', token_url: `${baseUrl}/oauth/token`, client_id: 'agix-client', client_secret: 's3cret' },
  });
  await client.initialize();
  const grantsAfterInit = seen.grants.length;
  client._token.expires_at_ms = Date.now() - 1; // force expiry
  await client.callTool('echo', { text: 'again' });
  assert.equal(seen.grants.length, grantsAfterInit + 1, 'second token fetch after expiry');
});

test('bad oauth client surfaces a clean error', async () => {
  const client = new MCPClient({
    url: `${baseUrl}/mcp-secure`,
    auth: { type: 'oauth2', token_url: `${baseUrl}/oauth/token`, client_id: 'wrong' },
  });
  await assert.rejects(() => client.initialize(), /token endpoint returned 401/);
});

// ─── Runtime primitive ─────────────────────────────────────────────────

test('runtime.getMCPClient caches per url and smoke mode returns the stub', async () => {
  const rt = new LocalRuntime({ agentName: 'research' });
  const a = rt.getMCPClient(`${baseUrl}/mcp`);
  const b = rt.getMCPClient({ url: `${baseUrl}/mcp` });
  assert.equal(a, b, 'cached per url');
  assert.ok(a instanceof MCPClient);

  const smokeRt = new LocalRuntime({ agentName: 'research', smoke: true });
  const stub = smokeRt.getMCPClient('https://example.com/mcp');
  assert.equal(stub.smoke, true);
  await stub.initialize();
  const tools = await stub.listTools();
  assert.equal(tools[0].name, 'smoke-tool');
  const result = await stub.callTool('smoke-tool', { q: 'x' });
  assert.match(textFromToolResult(result), /canned result/);
});

test('smoke stub used by makeSmokeMCPClient matches the client surface', async () => {
  const stub = makeSmokeMCPClient();
  for (const method of ['initialize', 'listTools', 'callTool']) {
    assert.equal(typeof stub[method], 'function');
  }
});
