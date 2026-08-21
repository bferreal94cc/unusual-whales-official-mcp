/**
 * Turns raw Unusual Whales responses into the single JSON payload the board renders.
 *
 * Everything the page shows is computed here, server-side, so the browser never
 * needs a key and never has to know which endpoint a number came from.
 */
import { call, pool, paginate } from "./uw.mjs"

const num = v => Number(v ?? 0) || 0
const DP_MIN_PREMIUM = "5000000"      // dark-pool prints of $5M notional and up
const BLOCK_FLOOR = { SPY: 250_000, DEFAULT: 25_000 }

/** The last N sessions Unusual Whales has data for, newest last. */
async function resolveSessions(ticker, count) {
  const history = await call("get_greek_exposure_by_ticker", { ticker, timeframe: "1M" })
  const dates = [...new Set(history.map(r => r.date))].sort()
  if (dates.length < count) throw new Error(`Only ${dates.length} sessions available for ${ticker}`)
  return dates.slice(-count)
}

export async function buildBoard({ tickers = ["SPY", "XSP"], sessionCount = 3, forwardCount = 5 } = {}) {
  const started = Date.now()
  const primary = tickers[0]
  const sessions = await resolveSessions(primary, sessionCount)
  const lastSession = sessions[sessions.length - 1]

  // --- one flat batch of requests, capped in flight -------------------------
  const raw = {}
  const jobs = []
  const add = (key, fn) => jobs.push(async () => { raw[key] = await fn() })

  for (const tk of tickers) {
    add(`flow_expiry_${tk}`, () => call("get_flow_per_expiry", { ticker: tk }))
    add(`maxpain_${tk}`, () => call("get_max_pain", { ticker: tk }))
    add(`ivts_${tk}`, () => call("get_implied_volatility_term_structure", { ticker: tk }))
    add(`gex_hist_${tk}`, () => call("get_greek_exposure_by_ticker", { ticker: tk, timeframe: "1M" }))
    add(`gex_strike_${tk}`, () => call("get_greek_exposure_by_strike", { ticker: tk }))
    for (const date of sessions) {
      add(`flow_strike_${tk}_${date}`, () => call("get_flow_per_strike", { ticker: tk, date }))
      add(`gex_expiry_${tk}_${date}`, () => call("get_greek_exposure_by_expiry", { ticker: tk, date }))
      add(`trades_${tk}_${date}`, () => paginate("get_option_trades", {
        ticker_symbol: tk, limit: 50, min_premium: BLOCK_FLOOR[tk] ?? BLOCK_FLOOR.DEFAULT,
      }, date))
    }
  }
  for (const date of sessions) {
    add(`dp_${date}`, () => paginate("get_dark_pool_trades", {
      ticker_symbol: primary, limit: 50, min_premium: DP_MIN_PREMIUM,
    }, date))
    add(`tide_${date}`, () => call("get_market_etf_tide", { ticker: primary, date }))
    add(`tide_mkt_${date}`, () => call("get_market_tide", { date, interval_5m: true }))
  }
  await pool(jobs, 5)
  const rows = key => (Array.isArray(raw[key]) ? raw[key] : [])

  // --- the five expiries that land in the next trading days -----------------
  const forward = [...new Set(rows(`flow_expiry_${primary}`).map(r => r.expiry))]
    .filter(e => e > lastSession).sort().slice(0, forwardCount)

  // --- reference level ------------------------------------------------------
  const spot = {}
  for (const tk of tickers) {
    const mp = rows(`maxpain_${tk}`)[0] || {}
    let close = num(mp.close), source = "UW OHLC"
    if (!close) {
      // Cash-settled indices have no OHLC feed; anchor on the volume-weighted busiest strikes.
      const busiest = [...rows(`flow_strike_${tk}_${lastSession}`)]
        .sort((a, b) => (b.call_volume + b.put_volume) - (a.call_volume + a.put_volume)).slice(0, 4)
      const weight = busiest.reduce((s, r) => s + r.call_volume + r.put_volume, 0)
      close = weight ? busiest.reduce((s, r) => s + num(r.strike) * (r.call_volume + r.put_volume), 0) / weight : 0
      source = "peak-volume strike proxy"
    }
    spot[tk] = { close, open: num(mp.open), source }
  }

  // --- flow: whole-session totals ------------------------------------------
  const daily = {}
  for (const tk of tickers) {
    daily[tk] = sessions.map(date => {
      const rs = rows(`flow_strike_${tk}_${date}`)
      const sum = (key) => rs.reduce((s, r) => s + num(r[key]), 0)
      const call_prem = sum("call_premium"), put_prem = sum("put_premium")
      const call_vol = rs.reduce((s, r) => s + (r.call_volume || 0), 0)
      const put_vol = rs.reduce((s, r) => s + (r.put_volume || 0), 0)
      const netCall = sum("call_premium_ask_side") - sum("call_premium_bid_side")
      const netPut = sum("put_premium_ask_side") - sum("put_premium_bid_side")
      return {
        date, call_prem, put_prem, call_vol, put_vol,
        pc_prem: call_prem ? put_prem / call_prem : 0,
        pc_vol: call_vol ? put_vol / call_vol : 0,
        net_prem: netCall - netPut, strikes: rs.length,
      }
    })
  }

  // --- flow: the forward expiries ------------------------------------------
  const forwardFlow = {}
  for (const tk of tickers) {
    const byExpiry = Object.fromEntries(rows(`flow_expiry_${tk}`).map(r => [r.expiry, r]))
    const iv = Object.fromEntries(rows(`ivts_${tk}`).map(r => [r.expiry, r]))
    const mp = Object.fromEntries(rows(`maxpain_${tk}`).map(r => [r.expiry, r]))
    forwardFlow[tk] = forward.filter(e => byExpiry[e]).map(e => {
      const r = byExpiry[e], i = iv[e] || {}, m = mp[e] || {}
      const call_prem = num(r.call_premium), put_prem = num(r.put_premium)
      return {
        expiry: e, dte: i.dte ?? null, call_prem, put_prem,
        call_vol: r.call_volume, put_vol: r.put_volume,
        pc_prem: call_prem ? put_prem / call_prem : 0,
        iv: num(i.volatility), impl_move_pct: num(i.implied_move_perc) * 100,
        max_pain: m.max_pain ?? null,
      }
    })
  }

  // --- flow: block-size trades ---------------------------------------------
  const large = {}, topTrades = {}
  for (const tk of tickers) {
    large[tk] = sessions.map(date => {
      const ts = rows(`trades_${tk}_${date}`)
      const total = { n: 0, prem: 0, call: 0, put: 0 }
      const byExpiry = {}
      for (const t of ts) {
        const prem = num(t.premium)
        total.n++; total.prem += prem; total[t.option_type] += prem
        if (!forward.includes(t.expiry)) continue
        const bucket = byExpiry[t.expiry] ??= { n: 0, prem: 0, call: 0, put: 0 }
        bucket.n++; bucket.prem += prem; bucket[t.option_type] += prem
      }
      return { date, total, by_expiry: byExpiry }
    })
    topTrades[tk] = sessions.flatMap(d => rows(`trades_${tk}_${d}`))
      .sort((a, b) => num(b.premium) - num(a.premium)).slice(0, 12)
      .map(t => ({
        date: t.executed_at.slice(0, 10), time: t.executed_at.slice(11, 19),
        chain: t.option_chain_id, type: t.option_type, strike: num(t.strike), expiry: t.expiry,
        prem: num(t.premium), size: t.size, iv: num(t.implied_volatility) * 100,
        delta: num(t.delta), spot: num(t.underlying_price),
      }))
  }

  // --- gamma ----------------------------------------------------------------
  const gexByExpiry = {}, gexByStrike = {}, gexHistory = {}
  for (const tk of tickers) {
    gexByExpiry[tk] = sessions.flatMap(date =>
      rows(`gex_expiry_${tk}_${date}`).filter(r => forward.includes(r.expiry)).map(r => ({
        date, expiry: r.expiry, dte: r.dte,
        call_gex: num(r.call_gex), put_gex: num(r.put_gex), net_gex: num(r.call_gex) + num(r.put_gex),
        call_delta: num(r.call_delta), put_delta: num(r.put_delta),
        net_delta: num(r.call_delta) + num(r.put_delta),
        net_charm: num(r.call_charm) + num(r.put_charm),
        net_vanna: num(r.call_vanna) + num(r.put_vanna),
      })))
    const ref = spot[tk].close
    gexByStrike[tk] = rows(`gex_strike_${tk}`)
      .map(r => ({ strike: num(r.strike), call_gex: num(r.call_gex), put_gex: num(r.put_gex), net_gex: num(r.call_gex) + num(r.put_gex) }))
      .filter(r => !ref || Math.abs(r.strike - ref) / ref <= 0.06)
      .sort((a, b) => a.strike - b.strike)
    gexHistory[tk] = rows(`gex_hist_${tk}`).map(r => ({
      date: r.date,
      call_gamma: num(r.call_gamma), put_gamma: num(r.put_gamma),
      net_gamma: num(r.call_gamma) + num(r.put_gamma),
      net_delta: num(r.call_delta) + num(r.put_delta),
      net_vanna: num(r.call_vanna) + num(r.put_vanna),
      net_charm: num(r.call_charm) + num(r.put_charm),
    })).sort((a, b) => a.date.localeCompare(b.date))
  }

  // --- tide ------------------------------------------------------------------
  const tideSeries = {}, tideSummary = []
  for (const date of sessions) {
    const rs = rows(`tide_${date}`).filter(r => r.timestamp)
    tideSeries[date] = rs.filter((_, i) => i % 5 === 0 || i === rs.length - 1).map(r => ({
      t: r.timestamp.slice(11, 16), nc: num(r.net_call_premium), np: num(r.net_put_premium),
      nv: num(r.net_volume), px: num(r.underlying_price),
    }))
    const last = rs[rs.length - 1] || {}
    const firstPriced = rs.find(r => num(r.underlying_price) > 0) || {}
    const mkt = rows(`tide_mkt_${date}`)
    const mktLast = mkt[mkt.length - 1] || {}
    tideSummary.push({
      date,
      spy_net_call: num(last.net_call_premium), spy_net_put: num(last.net_put_premium),
      spy_net_vol: num(last.net_volume),
      open_px: num(firstPriced.underlying_price), close_px: num(last.underlying_price),
      mkt_net_call: num(mktLast.net_call_premium), mkt_net_put: num(mktLast.net_put_premium),
      mkt_net_vol: num(mktLast.net_volume),
    })
  }

  // --- dark pool -------------------------------------------------------------
  const dpDaily = [], allPrints = []
  for (const date of sessions) {
    const rs = rows(`dp_${date}`)
    allPrints.push(...rs)
    const prices = rs.map(r => num(r.price))
    const shares = rs.reduce((s, r) => s + Number(r.size || 0), 0)
    const sessionVolume = rs.reduce((m, r) => Math.max(m, Number(r.volume || 0)), 0)
    dpDaily.push({
      date, prints: rs.length,
      premium: rs.reduce((s, r) => s + num(r.premium), 0), shares,
      avg_px: prices.length ? prices.reduce((s, p) => s + p, 0) / prices.length : 0,
      min_px: prices.length ? Math.min(...prices) : 0,
      max_px: prices.length ? Math.max(...prices) : 0,
      session_volume: sessionVolume,
      pct_of_volume: sessionVolume ? (shares / sessionVolume) * 100 : 0,
    })
  }
  const levels = {}
  for (const r of allPrints) {
    const bucket = levels[Math.round(num(r.price))] ??= { px: Math.round(num(r.price)), shares: 0, prem: 0, n: 0 }
    bucket.shares += Number(r.size || 0); bucket.prem += num(r.premium); bucket.n++
  }

  return {
    generated_at: new Date().toISOString(),
    build_ms: Date.now() - started,
    tickers, sessions, last_session: lastSession, forward_expiries: forward,
    spot, daily, forward: forwardFlow, large_trades: large, top_trades: topTrades,
    gex_by_expiry: gexByExpiry, gex_by_strike: gexByStrike, gex_history: gexHistory,
    tide: { series: tideSeries, summary: tideSummary },
    darkpool: {
      ticker: primary,
      daily: dpDaily,
      levels: Object.values(levels).sort((a, b) => a.px - b.px),
      top: [...allPrints].sort((a, b) => num(b.premium) - num(a.premium)).slice(0, 15).map(r => ({
        date: r.executed_at.slice(0, 10), time: r.executed_at.slice(11, 19),
        price: num(r.price), size: Number(r.size || 0), prem: num(r.premium),
        nbbo_bid: num(r.nbbo_bid), nbbo_ask: num(r.nbbo_ask),
      })),
    },
  }
}
