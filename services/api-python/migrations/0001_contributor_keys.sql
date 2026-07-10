-- 0001_contributor_keys.sql
-- Canonical store-of-record for cloud-agent contributor keys — Lane 1 of the
-- cloud-agent authentication design.
--
-- Schema authored by the coordination agent (2026-06-18) and adopted as canonical.
-- A cloud/remote agent authenticates with a scoped, hashed, short-TTL env-var key
-- (agxc_…). Plaintext is shown ONCE at mint; only the hash is stored.
--
-- STATUS: STAGED, not applied. AgixAI has no Postgres backend yet (no DB, no
-- migration framework, no DATABASE_URL). Until the backend stands up, the interim
-- store is agents/contributor-keys.registry.json (hash-only, shaped to these exact
-- columns so it migrates in trivially). Apply this — and load the interim registry
-- rows — when services/api-python gains a database.

CREATE TABLE contributor_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash      text NOT NULL UNIQUE,        -- SHA-256 of the agxc_ token; never store plaintext
  key_prefix    text NOT NULL,               -- first ~8 chars (agxc_xxxx) for display/lookup, non-secret
  tenant_id     text NOT NULL,               -- scopes the key to one tenant/dojo
  scope         text NOT NULL DEFAULT 'read-only',  -- 'read-only' | a named write surface; never blanket admin
  label         text,                        -- human note: which cloud agent/session this is for
  rate_limit_per_min int NOT NULL DEFAULT 60,
  expires_at    timestamptz NOT NULL,        -- short TTL (hours–days); expiry is enforced, not advisory
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL,               -- the identity that minted it (audit)
  last_used_at  timestamptz,
  revoked_at    timestamptz                  -- single-key revoke; null = active
);
CREATE INDEX idx_contributor_keys_prefix ON contributor_keys (key_prefix);
CREATE INDEX idx_contributor_keys_active ON contributor_keys (tenant_id) WHERE revoked_at IS NULL;
