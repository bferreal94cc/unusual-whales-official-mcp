/**
 * Loads secrets from a local .env file so credentials never live in the repo.
 *
 * Values already present in the real environment always win, which keeps MCP
 * client configs (`"env": { "UW_API_KEY": "..." }`) authoritative. The file is
 * optional — when it is missing the process environment is used as-is.
 */

import { existsSync, readFileSync } from "fs"
import { dirname, resolve } from "path"
import { fileURLToPath } from "url"

const HERE = dirname(fileURLToPath(import.meta.url))

/** Strip matching surrounding quotes and trailing inline comments. */
function unwrap(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  const hash = value.indexOf(" #")
  return hash === -1 ? value : value.slice(0, hash).trim()
}

export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed
    const eq = withoutExport.indexOf("=")
    if (eq <= 0) continue
    const key = withoutExport.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    out[key] = unwrap(withoutExport.slice(eq + 1))
  }
  return out
}

/** Candidate .env paths, highest priority first. */
function candidates(): string[] {
  const explicit = process.env.UW_ENV_FILE
  const paths = explicit ? [resolve(explicit)] : []
  paths.push(resolve(process.cwd(), ".env"))
  // Packaged install: dist/env.js -> package root
  paths.push(resolve(HERE, "..", ".env"))
  return paths
}

/**
 * Apply the first readable .env file to process.env without overwriting any
 * variable that is already set. Returns the file that was applied, if any.
 */
export function loadEnv(): string | null {
  for (const path of candidates()) {
    if (!existsSync(path)) continue
    let parsed: Record<string, string>
    try {
      parsed = parseEnvFile(readFileSync(path, "utf8"))
    } catch {
      continue
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value
    }
    return path
  }
  return null
}

/**
 * Applied at import time: modules that read `process.env` while being
 * evaluated (the tool catalog, for instance) must see the file's values.
 */
export const envFileLoaded: string | null = loadEnv()
