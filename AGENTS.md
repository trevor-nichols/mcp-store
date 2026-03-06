You are working in the `mcp-store` repo which is used as the public AgentWorkplace MCP catalog.

Repository layout:

mcp-store/
  catalog/
    mcp.manifest.json      # Source-of-truth manifest for curated MCP entries
    stable.json            # Generated stable channel catalog consumed by AgentWorkplace
    beta.json              # Generated beta channel catalog consumed by AgentWorkplace
  servers/
    .curated/              # Stable curated MCP servers
    .system/               # System/internal MCP servers
    .experimental/         # Optional beta/experimental MCP servers
  scripts/
    build-catalog.mjs      # Validate manifest entries and generate channel catalogs

Rules:
1. MCP entry folders live under `servers/.curated/<slug>`, `servers/.system/<slug>`, or `servers/.experimental/<slug>`.
2. Each entry folder must include `server.json`. `README.md` is optional but recommended.
3. `catalog/mcp.manifest.json` is the publication index; keep `id` and `slug` stable once published.
4. MCP entries are configuration recipes, not ZIP packages. Do not add packaging logic.
5. Public catalog entries must not include literal secret-bearing fields such as `bearer_token` or `http_headers`.
6. Use `npm run manifest:add -- <entry-folder>` to scaffold a manifest entry and `npm run validate:mcp` before commits.
7. Generate tracked catalogs with `npm run build:catalog -- --repo <owner/repo> --ref <git-ref>`.

Schema notes:
- Required manifest fields: `id`, `slug`, `path`, `version`.
- `channel` defaults to `stable`; `.experimental` entries typically use `beta`.
- `server.json` must match the AgentWorkplace MCP store schema: `serverName`, `title`, `summary`, `description`, `transport`, `authMode`, and `configTemplate` are required.
