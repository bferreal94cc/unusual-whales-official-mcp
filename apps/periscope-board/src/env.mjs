/**
 * Loads .env from the app directory without pulling in a dependency.
 * Anything already set in the real environment wins, so `UW_API_KEY=… npm start`
 * and container env vars both override the file.
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function unwrap(raw) {
  const value = raw.trim()
  if (value.length >= 2) {
    const a = value[0], b = value[value.length - 1]
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return value.slice(1, -1)
  }
  const hash = value.indexOf(" #")
  return hash === -1 ? value : value.slice(0, hash).trim()
}

export function parseEnv(text) {
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith("#")) continue
    const body = t.startsWith("export ") ? t.slice(7).trim() : t
    const eq = body.indexOf("=")
    if (eq <= 0) continue
    const key = body.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    out[key] = unwrap(body.slice(eq + 1))
  }
  return out
}

export function loadEnv() {
  for (const path of [process.env.UW_ENV_FILE, resolve(APP_ROOT, ".env"), resolve(APP_ROOT, "../../.env")]) {
    if (!path || !existsSync(path)) continue
    let parsed
    try { parsed = parseEnv(readFileSync(path, "utf8")) } catch { continue }
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v
    }
    return path
  }
  return null
}

export const envFile = loadEnv()
export { APP_ROOT }
