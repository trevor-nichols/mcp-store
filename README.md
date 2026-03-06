# MCP Store

Public distribution repo for AgentWorkplace MCP servers.

This repo is designed for the config-driven MCP storefront flow:
- AgentWorkplace fetches one or more remote MCP catalog URLs.
- The app merges curated entries with local `mcp_servers` config state and AgentWorkplace-managed metadata.
- Adding or updating a curated server writes `mcp_servers.<server>` into Codex config, reloads MCP, and verifies runtime/auth status.

This repo publishes JSON catalogs only. MCP entries here are configuration recipes, not ZIP packages.

## Repository layout

```text
mcp-store/
  catalog/
    mcp.manifest.json      # Source-of-truth manifest for curated entries
    stable.json            # Generated stable channel catalog
    beta.json              # Generated beta channel catalog
  servers/
    .curated/              # Stable curated MCP servers
    .system/               # System/internal MCP servers
    .experimental/         # Optional beta/experimental MCP servers
  scripts/
    build-catalog.mjs      # Validate manifest entries and generate channel catalogs
```

## Add an MCP server

1. Create an entry folder under one of:
   - `servers/.curated/<slug>/`
   - `servers/.system/<slug>/`
   - `servers/.experimental/<slug>/`
2. Add `server.json`.
3. Optionally add `README.md` for long-form setup guidance.
4. Add a manifest scaffold entry:

```bash
npm run manifest:add -- servers/.curated/<slug>
```

5. Update the manifest metadata (`version`, `channel`) and the entry metadata in `server.json`.
6. Validate the repo:

```bash
npm run validate:mcp
```

## Manifest format

`catalog/mcp.manifest.json` is the source of truth for publication. Example:

```json
{
  "schemaVersion": 1,
  "servers": [
    {
      "id": "github-cloud",
      "slug": "github-cloud",
      "path": "servers/.curated/github-cloud",
      "version": "1.0.0",
      "channel": "stable"
    }
  ]
}
```

Required:
- `id`
- `slug`
- `path`
- `version` (semver)

Optional:
- `channel` (`stable` default, or `beta`)

Each manifest entry points to an entry folder containing `server.json`.

## `server.json` schema

Each `server.json` is validated against the same constraints the AgentWorkplace backend enforces for remote MCP catalogs. Example:

```json
{
  "serverName": "github",
  "title": "GitHub Cloud",
  "summary": "Connect GitHub over streamable HTTP with OAuth.",
  "shortDescription": "Connect GitHub over streamable HTTP with OAuth.",
  "description": "Curated OAuth-based GitHub MCP configuration for hosted deployments.",
  "icon": "🐙",
  "transport": "streamable_http",
  "authMode": "oauth",
  "requiredEnvVars": [],
  "configTemplate": {
    "url": "https://example.com/github",
    "scopes": ["repo", "read:org"]
  },
  "recommendedPolicy": {
    "enabled": true
  },
  "websiteUrl": "https://github.com/",
  "docsUrl": "https://docs.github.com/"
}
```

Required:
- `serverName`
- `title`
- `summary`
- `description`
- `transport`
- `authMode`
- `configTemplate`

Optional:
- `shortDescription`
- `icon` (`🧰` default)
- `requiredEnvVars`
- `recommendedPolicy`
- `websiteUrl`
- `docsUrl`
- `readmePath`

Validation rules intentionally match the AgentWorkplace MCP store parser:
- `transport` must be `stdio` or `streamable_http`
- `authMode` must be `none`, `oauth`, `bearer_token_env`, or `custom`
- `configTemplate` may use safe MCP config fields such as `command`, `args`, `cwd`, `url`, `env`, `env_vars`, `env_http_headers`, `bearer_token_env_var`, `required`, `scopes`, `startup_timeout_ms`, `startup_timeout_sec`, and `tool_timeout_sec`
- `configTemplate.enabled`, `configTemplate.enabled_tools`, and `configTemplate.disabled_tools` are forbidden; use `recommendedPolicy` instead
- literal secret-bearing fields such as `bearer_token` and `http_headers` are forbidden

## Build and publish

Validate only:

```bash
node scripts/build-catalog.mjs --validate-only
```

Generate channel catalogs:

```bash
node scripts/build-catalog.mjs --repo <owner/repo> --ref <git-ref>
```

Outputs:
- `dist/catalog/stable.json`
- `dist/catalog/beta.json`
- Updates tracked `catalog/stable.json` and `catalog/beta.json` unless `--no-write-tracked` is used

For CI/offline verification without mutating tracked catalogs:

```bash
node scripts/build-catalog.mjs --repo <owner/repo> --ref <git-ref> --no-write-tracked
```

## AgentWorkplace configuration

Point AgentWorkplace at your hosted catalogs, for example:

```bash
VITE_MCP_CATALOG_URLS=https://raw.githubusercontent.com/<owner>/<repo>/main/catalog/stable.json,https://raw.githubusercontent.com/<owner>/<repo>/main/catalog/beta.json
```

Legacy fallback:
- AgentWorkplace still accepts `VITE_MCP_STORE_CATALOG_URL` and `VITE_MCP_STORE_CATALOG_URLS`
- New builds should prefer `VITE_MCP_CATALOG_URL` and `VITE_MCP_CATALOG_URLS`
