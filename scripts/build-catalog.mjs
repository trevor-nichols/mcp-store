#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHANNELS = new Set(["stable", "beta"]);
const TRANSPORTS = new Set(["stdio", "streamable_http"]);
const AUTH_MODES = new Set(["none", "oauth", "bearer_token_env", "custom"]);
const ALLOWED_CONFIG_FIELDS = new Set([
  "command",
  "args",
  "cwd",
  "url",
  "env",
  "env_vars",
  "env_http_headers",
  "bearer_token_env_var",
  "required",
  "scopes",
  "startup_timeout_ms",
  "startup_timeout_sec",
  "tool_timeout_sec",
]);
const POLICY_FIELDS = new Set(["enabled", "enabled_tools", "disabled_tools"]);
const FORBIDDEN_CONFIG_FIELDS = new Set(["bearer_token", "http_headers"]);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const defaultManifestPath = resolve(repoRoot, "catalog/mcp.manifest.json");
const defaultOutputPath = resolve(repoRoot, "dist");
const trackedCatalogDir = resolve(repoRoot, "catalog");

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    manifest: defaultManifestPath,
    output: defaultOutputPath,
    repo: "",
    ref: "main",
    manifestCheck: false,
    manifestAdd: "",
    validateOnly: false,
    writeTracked: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--validate-only") {
      args.validateOnly = true;
      continue;
    }
    if (token === "--manifest-check") {
      args.manifestCheck = true;
      continue;
    }
    if (token === "--no-write-tracked") {
      args.writeTracked = false;
      continue;
    }
    if (!token.startsWith("--")) {
      fail(`Unknown argument "${token}"`);
    }

    const [key, valueFromEquals] = token.split("=", 2);
    const value =
      valueFromEquals !== undefined ? valueFromEquals : index + 1 < argv.length ? argv[++index] : "";
    if (!value) {
      fail(`Missing value for ${key}`);
    }

    if (key === "--manifest") {
      args.manifest = resolve(repoRoot, value);
      continue;
    }
    if (key === "--output") {
      args.output = resolve(repoRoot, value);
      continue;
    }
    if (key === "--repo") {
      args.repo = normalizeRepo(value);
      continue;
    }
    if (key === "--ref") {
      args.ref = value.trim();
      continue;
    }
    if (key === "--manifest-add") {
      args.manifestAdd = value.trim();
      continue;
    }
    fail(`Unknown argument "${key}"`);
  }

  return args;
}

function printHelp() {
  console.log(
    [
      "Usage",
      "  node scripts/build-catalog.mjs [options]",
      "",
      "Options",
      "  --validate-only        Validate manifest and entry folders without writing catalogs.",
      "  --manifest <path>      Path to manifest (default: catalog/mcp.manifest.json).",
      "  --output <path>        Output directory for generated catalogs (default: dist).",
      "  --repo <owner/name>    GitHub repository slug for README raw URLs.",
      "  --ref <git-ref>        Git ref used in generated README URLs (default: main).",
      "  --no-write-tracked     Do not overwrite catalog/stable.json or catalog/beta.json.",
      "  --manifest-check       Fail if any servers/*/*/server.json is missing from the manifest.",
      "  --manifest-add <path>  Add a manifest scaffold entry for a server directory.",
      "  --help                 Show this help.",
    ].join("\n"),
  );
}

function normalizeRelativePath(pathValue) {
  return String(pathValue ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

function normalizeRepo(repo) {
  const normalized = repo.trim();
  const [owner, name, ...rest] = normalized.split("/");
  if (!owner || !name || rest.length > 0) {
    fail(`Invalid --repo value "${repo}". Expected "owner/name".`);
  }
  return `${owner}/${name}`;
}

function assertInsideRepo(path) {
  const rel = relative(repoRoot, path);
  const relParts = rel.split(/[\\/]/g);
  if (rel.startsWith("..") || relParts.includes("..") || isAbsolute(rel)) {
    fail(`Path "${path}" must stay within repository root.`);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`Unable to parse JSON at ${path}: ${String(error)}`);
  }
}

function writeJson(path, payload) {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function readManifestDocument(manifestPath) {
  const manifest = readJson(manifestPath);
  if (manifest.schemaVersion !== 1) {
    fail(`Unsupported schemaVersion "${manifest.schemaVersion}". Expected 1.`);
  }
  if (!Array.isArray(manifest.servers)) {
    fail('Manifest must contain a "servers" array.');
  }
  return manifest;
}

function validateSlug(value, entryLabel) {
  const slug = String(value ?? "").trim();
  if (!slug || slug === "." || slug === ".." || slug.length > 64) {
    fail(`${entryLabel}: slug is invalid.`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(slug)) {
    fail(`${entryLabel}: slug "${slug}" must match /^[A-Za-z0-9][A-Za-z0-9_-]*$/`);
  }
  return slug;
}

function validateServerName(value, entryLabel) {
  const serverName = String(value ?? "").trim();
  if (!serverName || serverName.length > 128) {
    fail(`${entryLabel}: serverName is required.`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(serverName)) {
    fail(`${entryLabel}: serverName "${serverName}" is invalid.`);
  }
  return serverName;
}

function normalizeVersion(value, entryLabel) {
  const version = String(value ?? "").trim();
  if (!version) {
    fail(`${entryLabel}: version is required.`);
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`${entryLabel}: version "${version}" must be semver.`);
  }
  return version;
}

function normalizeChannel(value, entryLabel) {
  const channel = String(value ?? "stable").trim().toLowerCase();
  if (!CHANNELS.has(channel)) {
    fail(`${entryLabel}: channel "${channel}" must be stable or beta.`);
  }
  return channel;
}

function normalizeHttpUrl(value, fieldName, entryLabel) {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }
  if (!normalized.startsWith("https://") && !normalized.startsWith("http://")) {
    fail(`${entryLabel}: ${fieldName} must start with https:// or http://.`);
  }
  return normalized;
}

function normalizeOptionalString(value) {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeStringArray(value, fieldName, entryLabel) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(`${entryLabel}: ${fieldName} must be an array of strings.`);
  }
  const seen = new Set();
  const normalized = [];
  for (const item of value) {
    const next = normalizeOptionalString(item);
    if (!next) {
      fail(`${entryLabel}: ${fieldName} entries must be non-empty strings.`);
    }
    const key = next.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(next);
  }
  return normalized;
}

function normalizeStringMap(value, fieldName, entryLabel) {
  if (value == null) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${entryLabel}: ${fieldName} must be an object of string values.`);
  }
  const normalized = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const normalizedKey = normalizeOptionalString(key);
    const normalizedValue = normalizeOptionalString(rawValue);
    if (!normalizedKey || !normalizedValue) {
      fail(`${entryLabel}: ${fieldName} keys and values must be non-empty strings.`);
    }
    normalized[normalizedKey] = normalizedValue;
  }
  return normalized;
}

function normalizeRequiredEnvVars(value, entryLabel) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(`${entryLabel}: requiredEnvVars must be an array.`);
  }
  const seen = new Set();
  const normalized = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      fail(`${entryLabel}: requiredEnvVars entries must be objects.`);
    }
    const name = normalizeOptionalString(item.name);
    if (!name) {
      fail(`${entryLabel}: requiredEnvVars entries must include a name.`);
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({
      name,
      description: normalizeOptionalString(item.description),
    });
  }
  return normalized;
}

function normalizeRecommendedPolicy(value, entryLabel) {
  if (value == null) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${entryLabel}: recommendedPolicy must be an object.`);
  }
  const normalized = {};
  if ("enabled" in value) {
    if (typeof value.enabled !== "boolean") {
      fail(`${entryLabel}: recommendedPolicy.enabled must be a boolean.`);
    }
    normalized.enabled = value.enabled;
  }
  if ("enabledTools" in value) {
    normalized.enabledTools = normalizeStringArray(
      value.enabledTools,
      "recommendedPolicy.enabledTools",
      entryLabel,
    );
  }
  if ("disabledTools" in value) {
    normalized.disabledTools = normalizeStringArray(
      value.disabledTools,
      "recommendedPolicy.disabledTools",
      entryLabel,
    );
  }
  return normalized;
}

function normalizeConfigTemplate(rawTemplate, transport, authMode, entryLabel) {
  if (!rawTemplate || typeof rawTemplate !== "object" || Array.isArray(rawTemplate)) {
    fail(`${entryLabel}: configTemplate must be an object.`);
  }

  const normalized = {};
  for (const [key, rawValue] of Object.entries(rawTemplate)) {
    if (POLICY_FIELDS.has(key)) {
      fail(`${entryLabel}: configTemplate.${key} is not allowed; use recommendedPolicy instead.`);
    }
    if (FORBIDDEN_CONFIG_FIELDS.has(key)) {
      fail(`${entryLabel}: configTemplate.${key} is not allowed in the public MCP catalog.`);
    }
    if (!ALLOWED_CONFIG_FIELDS.has(key)) {
      fail(`${entryLabel}: unsupported configTemplate field "${key}".`);
    }

    if (key === "args" || key === "env_vars" || key === "scopes") {
      normalized[key] = normalizeStringArray(rawValue, `configTemplate.${key}`, entryLabel);
      continue;
    }
    if (key === "command" || key === "cwd" || key === "url" || key === "bearer_token_env_var") {
      const value = normalizeOptionalString(rawValue);
      if (!value) {
        fail(`${entryLabel}: configTemplate.${key} must be a non-empty string.`);
      }
      normalized[key] = value;
      continue;
    }
    if (key === "env" || key === "env_http_headers") {
      normalized[key] = normalizeStringMap(rawValue, `configTemplate.${key}`, entryLabel);
      continue;
    }
    if (key === "required") {
      if (typeof rawValue !== "boolean") {
        fail(`${entryLabel}: configTemplate.required must be a boolean.`);
      }
      normalized[key] = rawValue;
      continue;
    }
    if (key === "startup_timeout_ms") {
      if (!Number.isInteger(rawValue) || rawValue < 0) {
        fail(`${entryLabel}: configTemplate.startup_timeout_ms must be a non-negative integer.`);
      }
      normalized[key] = rawValue;
      continue;
    }
    if (key === "startup_timeout_sec" || key === "tool_timeout_sec") {
      if (typeof rawValue !== "number" || Number.isNaN(rawValue) || rawValue < 0) {
        fail(`${entryLabel}: configTemplate.${key} must be a non-negative number.`);
      }
      normalized[key] = rawValue;
    }
  }

  if (Object.keys(normalized).length === 0) {
    fail(`${entryLabel}: configTemplate must contain at least one managed MCP config field.`);
  }

  if (transport === "stdio") {
    if (!normalized.command) {
      fail(`${entryLabel}: stdio entries must define configTemplate.command.`);
    }
    if (normalized.url) {
      fail(`${entryLabel}: stdio entries may not define configTemplate.url.`);
    }
  }

  if (transport === "streamable_http") {
    if (!normalized.url) {
      fail(`${entryLabel}: streamable_http entries must define configTemplate.url.`);
    }
    for (const forbidden of ["command", "args", "cwd"]) {
      if (forbidden in normalized) {
        fail(`${entryLabel}: streamable_http entries may not define configTemplate.${forbidden}.`);
      }
    }
  }

  const hasBearerTokenEnvVar = "bearer_token_env_var" in normalized;
  if (authMode === "bearer_token_env" && !hasBearerTokenEnvVar) {
    fail(`${entryLabel}: authMode=bearer_token_env requires configTemplate.bearer_token_env_var.`);
  }
  if (authMode !== "bearer_token_env" && hasBearerTokenEnvVar) {
    fail(
      `${entryLabel}: configTemplate.bearer_token_env_var requires authMode=bearer_token_env.`,
    );
  }

  return normalized;
}

function resolveRawReadmeUrl(repo, ref, entryPath, readmePath) {
  if (!repo || !readmePath) {
    return null;
  }
  const repoPath = normalizeRelativePath(resolve(entryPath, readmePath));
  const repoRelativePath = normalizeRelativePath(relative(repoRoot, resolve(entryPath, readmePath)));
  if (!repoRelativePath) {
    return null;
  }
  return `https://raw.githubusercontent.com/${repo}/${ref}/${repoRelativePath}`;
}

function normalizeManifestEntries(manifestPath, args) {
  const manifest = readManifestDocument(manifestPath);
  const seenIds = new Set();
  const seenSlugs = new Set();

  return manifest.servers.map((manifestEntry, index) => {
    const entryLabel = `servers[${index}]`;
    const pathValue = normalizeRelativePath(manifestEntry.path);
    if (!pathValue) {
      fail(`${entryLabel}: path is required.`);
    }
    const absoluteEntryPath = resolve(repoRoot, pathValue);
    assertInsideRepo(absoluteEntryPath);
    if (!existsSync(absoluteEntryPath) || !statSync(absoluteEntryPath).isDirectory()) {
      fail(`${entryLabel}: path "${pathValue}" must be an existing directory.`);
    }

    const serverJsonPath = resolve(absoluteEntryPath, "server.json");
    if (!existsSync(serverJsonPath)) {
      fail(`${entryLabel}: missing server.json in ${pathValue}.`);
    }

    const id = normalizeOptionalString(manifestEntry.id);
    if (!id) {
      fail(`${entryLabel}: id is required.`);
    }
    if (seenIds.has(id.toLowerCase())) {
      fail(`${entryLabel}: duplicate id "${id}".`);
    }
    seenIds.add(id.toLowerCase());

    const slug = validateSlug(manifestEntry.slug ?? id, entryLabel);
    if (seenSlugs.has(slug.toLowerCase())) {
      fail(`${entryLabel}: duplicate slug "${slug}".`);
    }
    seenSlugs.add(slug.toLowerCase());

    const version = normalizeVersion(manifestEntry.version, entryLabel);
    const channel = normalizeChannel(manifestEntry.channel, entryLabel);
    const rawServer = readJson(serverJsonPath);
    const serverEntryLabel = `${entryLabel} (${pathValue}/server.json)`;

    if (!rawServer || typeof rawServer !== "object" || Array.isArray(rawServer)) {
      fail(`${serverEntryLabel}: server.json must be an object.`);
    }

    const transport = normalizeOptionalString(rawServer.transport);
    if (!transport || !TRANSPORTS.has(transport)) {
      fail(`${serverEntryLabel}: transport must be stdio or streamable_http.`);
    }

    const authMode = normalizeOptionalString(rawServer.authMode);
    if (!authMode || !AUTH_MODES.has(authMode)) {
      fail(
        `${serverEntryLabel}: authMode must be none, oauth, bearer_token_env, or custom.`,
      );
    }

    const entry = {
      id,
      slug,
      path: pathValue,
      version,
      channel,
      serverName: validateServerName(rawServer.serverName, serverEntryLabel),
      title: normalizeOptionalString(rawServer.title),
      summary: normalizeOptionalString(rawServer.summary),
      shortDescription: normalizeOptionalString(rawServer.shortDescription),
      description: normalizeOptionalString(rawServer.description),
      icon: normalizeOptionalString(rawServer.icon) ?? "🧰",
      transport,
      authMode,
      requiredEnvVars: normalizeRequiredEnvVars(rawServer.requiredEnvVars, serverEntryLabel),
      configTemplate: normalizeConfigTemplate(
        rawServer.configTemplate,
        transport,
        authMode,
        serverEntryLabel,
      ),
      recommendedPolicy: normalizeRecommendedPolicy(rawServer.recommendedPolicy, serverEntryLabel),
      websiteUrl: normalizeHttpUrl(rawServer.websiteUrl, "websiteUrl", serverEntryLabel),
      docsUrl: normalizeHttpUrl(rawServer.docsUrl, "docsUrl", serverEntryLabel),
      readmePath: normalizeOptionalString(rawServer.readmePath),
    };

    if (!entry.title || !entry.summary || !entry.description) {
      fail(`${serverEntryLabel}: title, summary, and description are required.`);
    }

    if (entry.readmePath) {
      const absoluteReadmePath = resolve(absoluteEntryPath, entry.readmePath);
      assertInsideRepo(absoluteReadmePath);
      if (!existsSync(absoluteReadmePath)) {
        fail(`${serverEntryLabel}: readmePath "${entry.readmePath}" does not exist.`);
      }
    }

    return {
      ...entry,
      readmeUrl: resolveRawReadmeUrl(args.repo, args.ref, absoluteEntryPath, entry.readmePath),
    };
  });
}

function buildCatalogPayload(entries, channel) {
  return {
    servers: entries
      .filter((entry) => entry.channel === channel)
      .map((entry) => ({
        id: entry.id,
        slug: entry.slug,
        serverName: entry.serverName,
        title: entry.title,
        summary: entry.summary,
        ...(entry.shortDescription ? { shortDescription: entry.shortDescription } : {}),
        description: entry.description,
        icon: entry.icon,
        version: entry.version,
        transport: entry.transport,
        authMode: entry.authMode,
        requiredEnvVars: entry.requiredEnvVars,
        configTemplate: entry.configTemplate,
        ...(entry.recommendedPolicy ? { recommendedPolicy: entry.recommendedPolicy } : {}),
        ...(entry.websiteUrl ? { websiteUrl: entry.websiteUrl } : {}),
        ...(entry.docsUrl ? { docsUrl: entry.docsUrl } : {}),
        ...(entry.readmeUrl ? { readmeUrl: entry.readmeUrl } : {}),
      })),
  };
}

function collectServerJsonDirectories(rootDir) {
  const results = [];
  if (!existsSync(rootDir)) {
    return results;
  }
  for (const scopeName of readdirSync(rootDir)) {
    const scopePath = resolve(rootDir, scopeName);
    if (!statSync(scopePath).isDirectory()) {
      continue;
    }
    for (const slugName of readdirSync(scopePath)) {
      const entryPath = resolve(scopePath, slugName);
      if (!statSync(entryPath).isDirectory()) {
        continue;
      }
      if (existsSync(resolve(entryPath, "server.json"))) {
        results.push(normalizeRelativePath(relative(repoRoot, entryPath)));
      }
    }
  }
  return results.sort((left, right) => left.localeCompare(right));
}

function runManifestCheck(manifestPath) {
  const manifest = readManifestDocument(manifestPath);
  const manifestPaths = new Set(
    manifest.servers.map((entry) => normalizeRelativePath(entry.path).toLowerCase()),
  );
  const discovered = collectServerJsonDirectories(resolve(repoRoot, "servers"));
  const missing = discovered.filter((path) => !manifestPaths.has(path.toLowerCase()));
  if (missing.length > 0) {
    fail(`Manifest is missing entries for: ${missing.join(", ")}`);
  }
}

function addManifestEntry(manifestPath, entryPath) {
  const manifest = readManifestDocument(manifestPath);
  const normalizedPath = normalizeRelativePath(entryPath);
  if (!normalizedPath) {
    fail("manifest:add requires a non-empty path.");
  }
  const absoluteEntryPath = resolve(repoRoot, normalizedPath);
  assertInsideRepo(absoluteEntryPath);
  if (!existsSync(absoluteEntryPath) || !statSync(absoluteEntryPath).isDirectory()) {
    fail(`Entry path "${normalizedPath}" must be an existing directory.`);
  }
  if (!existsSync(resolve(absoluteEntryPath, "server.json"))) {
    fail(`Entry path "${normalizedPath}" must contain server.json.`);
  }

  const slug = absoluteEntryPath.split(/[\\/]/).pop() ?? "new-server";
  const channel = normalizedPath.includes("/.experimental/") ? "beta" : "stable";
  const nextEntry = {
    id: slug,
    slug,
    path: normalizedPath,
    version: "0.1.0",
    channel,
  };
  const existsAlready = manifest.servers.some(
    (entry) => normalizeRelativePath(entry.path).toLowerCase() === normalizedPath.toLowerCase(),
  );
  if (existsAlready) {
    fail(`Manifest already contains "${normalizedPath}".`);
  }

  manifest.servers.push(nextEntry);
  manifest.servers.sort((left, right) => left.path.localeCompare(right.path));
  writeJson(manifestPath, manifest);
  console.log(`Added manifest entry for ${normalizedPath}`);
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (args.manifestAdd) {
    addManifestEntry(args.manifest, args.manifestAdd);
    return;
  }

  if (args.manifestCheck) {
    runManifestCheck(args.manifest);
  }

  const entries = normalizeManifestEntries(args.manifest, args);
  const stableCatalog = buildCatalogPayload(entries, "stable");
  const betaCatalog = buildCatalogPayload(entries, "beta");

  if (args.validateOnly) {
    console.log(
      `Validated ${entries.length} MCP catalog entr${entries.length === 1 ? "y" : "ies"}.`,
    );
    return;
  }

  ensureDir(resolve(args.output, "catalog"));
  writeJson(resolve(args.output, "catalog/stable.json"), stableCatalog);
  writeJson(resolve(args.output, "catalog/beta.json"), betaCatalog);

  if (args.writeTracked) {
    writeJson(resolve(trackedCatalogDir, "stable.json"), stableCatalog);
    writeJson(resolve(trackedCatalogDir, "beta.json"), betaCatalog);
  }

  console.log(
    `Built MCP catalogs (${stableCatalog.servers.length} stable, ${betaCatalog.servers.length} beta).`,
  );
}

main();
