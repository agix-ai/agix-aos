// agix-mcp-client — Q3 MCP client extension (Sprint 3, re-gated 2026-06-10).
//
// A dependency-free Model Context Protocol client over the Streamable
// HTTP transport (JSON-RPC 2.0). Built natively rather than vendoring
// DeerFlow's module, preserving the runtime's zero-framework dependency
// posture; if/when @anthropic-ai/sdk ships a native MCP client surface
// we can swap the transport behind this same interface.
//
// Scope (v1): initialize handshake (+ session id), tools/list,
// tools/call, bearer + OAuth2 auth (client_credentials and
// refresh_token grants, cached with expiry), JSON and SSE response
// framing. Resources/prompts/sampling are follow-ups when an agent
// needs them.
//
//   const client = runtime.getMCPClient({ url, auth });
//   await client.initialize();
//   const tools = await client.listTools();
//   const result = await client.callTool('search', { query: '…' });
//   textFromToolResult(result) → concatenated text blocks
//
// Auth shapes:
//   { type: 'bearer', token }
//   { type: 'oauth2', token_url, client_id, client_secret,
//     scope?, refresh_token? }      // refresh_token present → that grant
//
// Spec: docs/dev-backlog/2026-05-19-agix-runtime-extensions.md §Sprint 3.

const PROTOCOL_VERSION = '2025-06-18';

export class MCPClient {
  constructor({ url, auth = null, fetchImpl, clientName = 'agix', clientVersion = '0.2.0' } = {}) {
    if (!url) throw new Error('MCPClient: url is required');
    this.url = url;
    this.auth = auth;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    this.sessionId = null;
    this.serverInfo = null;
    this._nextId = 1;
    this._token = null;          // { access_token, expires_at_ms }
  }

  // ─── Auth ─────────────────────────────────────────────────────────

  async _authHeader() {
    if (!this.auth) return {};
    if (this.auth.type === 'bearer') {
      return { Authorization: `Bearer ${this.auth.token}` };
    }
    if (this.auth.type === 'oauth2') {
      if (!this._token || Date.now() >= this._token.expires_at_ms) {
        this._token = await this._fetchOAuthToken();
      }
      return { Authorization: `Bearer ${this._token.access_token}` };
    }
    throw new Error(`MCPClient: unknown auth type "${this.auth.type}"`);
  }

  async _fetchOAuthToken() {
    const { token_url, client_id, client_secret, scope, refresh_token } = this.auth;
    if (!token_url || !client_id) {
      throw new Error('MCPClient oauth2: token_url and client_id are required');
    }
    const grant = refresh_token ? 'refresh_token' : 'client_credentials';
    const body = new URLSearchParams({
      grant_type: grant,
      client_id,
      ...(client_secret ? { client_secret } : {}),
      ...(scope ? { scope } : {}),
      ...(refresh_token ? { refresh_token } : {}),
    });
    const res = await this.fetchImpl(token_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(`MCPClient oauth2: token endpoint returned ${res.status}`);
    }
    const json = await res.json();
    if (!json.access_token) throw new Error('MCPClient oauth2: no access_token in response');
    // Refresh 30s early; default 5 min when the server omits expires_in.
    const ttlMs = (Number(json.expires_in) || 300) * 1000;
    return { access_token: json.access_token, expires_at_ms: Date.now() + ttlMs - 30_000 };
  }

  // ─── JSON-RPC over Streamable HTTP ────────────────────────────────

  async _rpc(method, params = {}, { notification = false } = {}) {
    const id = notification ? undefined : this._nextId++;
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        ...(await this._authHeader()),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }),
    });

    const newSession = res.headers?.get?.('mcp-session-id');
    if (newSession) this.sessionId = newSession;

    if (notification) {
      // Notifications expect 202/204; tolerate any 2xx.
      if (!res.ok) throw new Error(`MCP ${method}: server returned ${res.status}`);
      return null;
    }
    if (!res.ok) {
      throw new Error(`MCP ${method}: server returned ${res.status}`);
    }

    const contentType = res.headers?.get?.('content-type') || '';
    const message = contentType.includes('text/event-stream')
      ? await readSseResponse(res, id)
      : await res.json();

    if (message?.error) {
      throw new Error(`MCP ${method}: ${message.error.message || 'server error'} (code ${message.error.code})`);
    }
    return message?.result ?? null;
  }

  // ─── Protocol surface ─────────────────────────────────────────────

  async initialize() {
    const result = await this._rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.clientName, version: this.clientVersion },
    });
    this.serverInfo = result?.serverInfo ?? null;
    await this._rpc('notifications/initialized', {}, { notification: true });
    return result;
  }

  async listTools() {
    const result = await this._rpc('tools/list');
    return result?.tools ?? [];
  }

  async callTool(name, args = {}) {
    if (!name) throw new Error('MCPClient.callTool: tool name is required');
    return this._rpc('tools/call', { name, arguments: args });
  }
}

// Concatenate the text blocks of a tools/call result. Non-text blocks
// (images, resources) are skipped — callers that need them read the
// result content directly.
export function textFromToolResult(result) {
  return (result?.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// Minimal SSE reader: accumulate `data:` lines, parse each event as
// JSON, return the message whose id matches the request. Servers close
// the stream after the response; we also stop as soon as we see it.
async function readSseResponse(res, id) {
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    // Process complete events (separated by a blank line).
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = rawEvent
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      if (!data) continue;
      try {
        const message = JSON.parse(data);
        if (message.id === id) return message;
      } catch { /* keep scanning */ }
    }
  }
  throw new Error('MCP: SSE stream ended without a response to the request');
}

// Smoke-mode stub, symmetric to the other runtime stubs: canned shapes,
// no network, calls logged.
export function makeSmokeMCPClient({ url = 'smoke://mcp' } = {}) {
  return {
    smoke: true,
    url,
    sessionId: 'smoke-session',
    serverInfo: { name: 'smoke-mcp-server', version: '0.0.0' },
    async initialize() {
      console.error(`  [smoke] would initialize MCP session · ${url}`);
      return { protocolVersion: PROTOCOL_VERSION, serverInfo: this.serverInfo, capabilities: {} };
    },
    async listTools() {
      console.error(`  [smoke] would list MCP tools · ${url}`);
      return [{ name: 'smoke-tool', description: 'Canned smoke tool', inputSchema: { type: 'object' } }];
    },
    async callTool(name, args = {}) {
      console.error(`  [smoke] would call MCP tool · ${name}(${Object.keys(args).join(', ')})`);
      return { content: [{ type: 'text', text: `[smoke] canned result from ${name}` }], isError: false };
    },
  };
}
