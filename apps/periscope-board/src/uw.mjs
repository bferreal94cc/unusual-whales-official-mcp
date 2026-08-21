/**
 * One way in and out of Unusual Whales. The key lives here, server-side, and is
 * never handed to the browser.
 *
 * Two transports carry the same data: `mcp` speaks JSON-RPC to the hosted MCP
 * server (the tool names below are its tool names), `rest` calls the public REST
 * API directly. Set UW_TRANSPORT to pick.
 */

const MCP_URL = "https://api.unusualwhales.com/api/mcp"
const REST_ORIGIN = "https://api.unusualwhales.com"
const TIMEOUT_MS = 45_000

/** MCP tool -> REST route + how its arguments map onto the query string. */
const REST_ROUTES = {
  get_flow_per_expiry: a => [`/api/stock/${enc(a.ticker)}/flow-per-expiry`, {}],
  get_flow_per_strike: a => [`/api/stock/${enc(a.ticker)}/flow-per-strike`, pick(a, "date")],
  get_max_pain: a => [`/api/stock/${enc(a.ticker)}/max-pain`, pick(a, "date")],
  get_implied_volatility_term_structure: a => [`/api/stock/${enc(a.ticker)}/volatility/term-structure`, pick(a, "date")],
  get_greek_exposure_by_ticker: a => [`/api/stock/${enc(a.ticker)}/greek-exposure`, pick(a, "date", "timeframe")],
  get_greek_exposure_by_expiry: a => [`/api/stock/${enc(a.ticker)}/greek-exposure/expiry`, pick(a, "date")],
  get_greek_exposure_by_strike: a => [`/api/stock/${enc(a.ticker)}/greek-exposure/strike`, pick(a, "date")],
  get_option_trades: a => ["/api/option-trades", omit(a, [])],
  get_dark_pool_trades: a => [`/api/darkpool/${enc(a.ticker_symbol || "SPY")}`, omit(a, ["ticker_symbol"])],
  get_market_tide: a => ["/api/market/market-tide", pick(a, "date", "interval_5m", "otm_only")],
  get_market_etf_tide: a => [`/api/market/${enc(a.ticker)}/etf-tide`, pick(a, "date")],
}

const enc = v => encodeURIComponent(String(v))
const pick = (o, ...keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]))
const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)))

function apiKey() {
  const k = process.env.UW_API_KEY
  if (!k) throw new Error("UW_API_KEY is not set — copy .env.example to .env and add your key")
  return k
}

async function withTimeout(fn) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try { return await fn(ctl.signal) } finally { clearTimeout(timer) }
}

function unwrapPayload(text) {
  const parsed = JSON.parse(text)
  return parsed && !Array.isArray(parsed) && parsed.data !== undefined ? parsed.data : parsed
}

async function viaMcp(tool, args) {
  const res = await withTimeout(signal => fetch(MCP_URL, {
    method: "POST",
    signal,
    headers: {
      "Authorization": `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "UW-CLIENT-API-ID": "100001",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  }))
  if (!res.ok) throw new Error(`MCP ${tool} → HTTP ${res.status}`)
  const body = await res.json()
  if (body.error) throw new Error(`MCP ${tool} → ${body.error.message || JSON.stringify(body.error)}`)
  const text = body?.result?.content?.[0]?.text
  if (typeof text !== "string") throw new Error(`MCP ${tool} → unexpected response shape`)
  if (text.startsWith("Invalid arguments")) throw new Error(`MCP ${tool} → ${text.slice(0, 160)}`)
  return unwrapPayload(text)
}

async function viaRest(tool, args) {
  const route = REST_ROUTES[tool]
  if (!route) throw new Error(`No REST route mapped for ${tool} — use UW_TRANSPORT=mcp`)
  const [path, query] = route(args)
  const url = new URL(path, REST_ORIGIN)
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue
    if (Array.isArray(v)) v.forEach(item => url.searchParams.append(`${k}[]`, String(item)))
    else url.searchParams.append(k, String(v))
  }
  const res = await withTimeout(signal => fetch(url, {
    signal,
    headers: { "Authorization": `Bearer ${apiKey()}`, "Accept": "application/json", "UW-CLIENT-API-ID": "100001" },
  }))
  if (!res.ok) throw new Error(`REST ${path} → HTTP ${res.status}`)
  return unwrapPayload(await res.text())
}

/** Call one Unusual Whales tool. Retries twice on transport failure. */
export async function call(tool, args = {}) {
  const transport = (process.env.UW_TRANSPORT || "mcp").toLowerCase()
  const run = transport === "rest" ? viaRest : viaMcp
  let lastError
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await run(tool, args) } catch (error) {
      lastError = error
      if (attempt < 2) await new Promise(r => setTimeout(r, 400 * 2 ** attempt))
    }
  }
  throw lastError
}

/** Run tasks with a ceiling on in-flight requests, so a board refresh can't flood the API. */
export async function pool(tasks, limit = 5) {
  const results = new Array(tasks.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++
      results[i] = await tasks[i]()
    }
  }))
  return results
}

/** Walk backwards through one session with `older_than`, since each page caps at 50 rows. */
export async function paginate(tool, base, day, { pages = 14, stamp = "executed_at" } = {}) {
  const rows = []
  let cursor = `${day}T23:59:59Z`
  for (let page = 0; page < pages; page++) {
    const batch = await call(tool, { ...base, newer_than: `${day}T00:00:00Z`, older_than: cursor })
    if (!Array.isArray(batch) || batch.length === 0) break
    rows.push(...batch)
    const last = batch[batch.length - 1]?.[stamp]
    if (!last || last === cursor) break
    cursor = last
    if (batch.length < 50) break
  }
  const seen = new Set()
  return rows.filter(r => {
    const key = r.id ?? JSON.stringify(r)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
