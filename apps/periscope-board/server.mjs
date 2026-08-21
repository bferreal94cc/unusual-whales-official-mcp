#!/usr/bin/env node
/**
 * Periscope board — a local server that keeps your Unusual Whales key on this
 * side of the wire and hands the browser finished JSON.
 *
 *   cp .env.example .env   # add UW_API_KEY
 *   npm start              # http://localhost:8787
 */
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, join, normalize, resolve } from "node:path"

import { APP_ROOT, envFile } from "./src/env.mjs"
import { buildBoard } from "./src/aggregate.mjs"

const PORT = Number(process.env.PORT || 8787)
const CACHE_TTL = Number(process.env.CACHE_TTL || 300) * 1000
const TICKERS = (process.env.TICKERS || "SPY,XSP").split(",").map(s => s.trim().toUpperCase()).filter(Boolean)
const PUBLIC_DIR = resolve(APP_ROOT, "public")

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" }

let cache = { key: null, at: 0, payload: null }
let inFlight = null

async function board(tickers, force) {
  const key = tickers.join(",")
  const fresh = cache.payload && cache.key === key && Date.now() - cache.at < CACHE_TTL
  if (fresh && !force) return { payload: cache.payload, cached: true, age_ms: Date.now() - cache.at }
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const payload = await buildBoard({ tickers })
      cache = { key, at: Date.now(), payload }
      return { payload, cached: false, age_ms: 0 }
    } finally { inFlight = null }
  })()
  return inFlight
}

function send(res, status, body, type = "application/json; charset=utf-8", extra = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...extra })
  res.end(body)
}

async function serveStatic(res, urlPath) {
  const rel = normalize(urlPath === "/" ? "/index.html" : urlPath).replace(/^(\.\.[/\\])+/, "")
  const file = join(PUBLIC_DIR, rel)
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden", "text/plain")
  try {
    const body = await readFile(file)
    send(res, 200, body, TYPES[extname(file)] || "application/octet-stream")
  } catch {
    send(res, 404, "Not found", "text/plain; charset=utf-8")
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`)
  try {
    if (url.pathname === "/api/health") {
      return send(res, 200, JSON.stringify({
        ok: Boolean(process.env.UW_API_KEY),
        key: process.env.UW_API_KEY ? "set" : "missing",
        transport: (process.env.UW_TRANSPORT || "mcp").toLowerCase(),
        env_file: envFile || "none",
        tickers: TICKERS,
        cache_age_ms: cache.payload ? Date.now() - cache.at : null,
        cache_ttl_ms: CACHE_TTL,
      }, null, 2))
    }
    if (url.pathname === "/api/board") {
      const tickers = (url.searchParams.get("tickers") || TICKERS.join(","))
        .split(",").map(s => s.trim().toUpperCase()).filter(Boolean)
      const { payload, cached, age_ms } = await board(tickers, url.searchParams.get("refresh") === "1")
      return send(res, 200, JSON.stringify(payload), "application/json; charset=utf-8",
        { "X-Cache": cached ? "hit" : "miss", "X-Cache-Age-Ms": String(age_ms) })
    }
    if (req.method !== "GET") return send(res, 405, "Method not allowed", "text/plain")
    return serveStatic(res, url.pathname)
  } catch (error) {
    console.error(`[periscope] ${url.pathname}:`, error.message)
    send(res, 502, JSON.stringify({ error: error.message }))
  }
})

server.listen(PORT, () => {
  console.log(`[periscope] http://localhost:${PORT}`)
  console.log(`[periscope] env file: ${envFile || "none"} · key: ${process.env.UW_API_KEY ? "set" : "MISSING"}` +
    ` · transport: ${(process.env.UW_TRANSPORT || "mcp").toLowerCase()} · tickers: ${TICKERS.join(", ")}`)
  if (!process.env.UW_API_KEY) console.log("[periscope] no key yet — cp .env.example .env and set UW_API_KEY")
})

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { server.close(() => process.exit(0)) })
}
