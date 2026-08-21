/* Periscope board — renders the payload from /api/board. No key ever reaches here. */

let D = null
const tip = document.getElementById('tip')
const $ = id => document.getElementById(id)

/* ---------- formatting ---------- */
const money = (v, dp = 1) => {
  const a = Math.abs(v)
  if (a >= 1e9) return `$${(v / 1e9).toFixed(dp)}B`
  if (a >= 1e6) return `$${(v / 1e6).toFixed(dp)}M`
  if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}K`
  return `$${v.toFixed(0)}`
}
const smoney = (v, dp = 1) => (v < 0 ? '−' : '+') + money(Math.abs(v), dp)
const fmtMoney = v => (v < 0 ? '−' : '') + money(Math.abs(v), 1)
const gam = v => {
  const a = Math.abs(v)
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return v.toFixed(1)
}
const int = v => Math.round(v).toLocaleString()
const sign = v => (v > 0 ? 'pos' : v < 0 ? 'neg' : '')
const md = d => d.slice(5)
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')

/* ---------- table helper ---------- */
function table(el, headers, rows) {
  el.innerHTML =
    `<thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map(r => {
      if (r.group) return `<tr class="grp"><td colspan="${headers.length}">${esc(r.group)}</td></tr>`
      const cls = r.total ? ' class="tot"' : ''
      return `<tr${cls}>${r.cells.map((c, i) => {
        const t = typeof c === 'object' && c !== null ? c : { v: c }
        const klass = [i === 0 ? '' : 'n', t.c || ''].filter(Boolean).join(' ')
        return `<td${klass ? ` class="${klass}"` : ''}${t.style ? ` style="${t.style}"` : ''}>${t.html ?? esc(t.v)}</td>`
      }).join('')}</tr>`
    }).join('')}</tbody>`
}
const chip = (v, bad) => `<span class="chip ${bad ? 'n' : 'p'}">${v}</span>`
const splitBar = (a, b) => {
  const t = a + b, w = t ? (a / t) * 100 : 50
  return `<span class="split"><i style="width:${w.toFixed(1)}%;background:var(--pos)"></i><i style="width:${(100 - w).toFixed(1)}%;background:var(--neg)"></i></span>`
}

/* ---------- sections ---------- */
function renderMast() {
  const lead = D.tickers[0]
  const spot = D.spot[lead]
  const chg = spot.open ? ((spot.close - spot.open) / spot.open) * 100 : 0
  const gh = D.gex_history[lead].at(-1)
  const lastDaily = D.daily[lead].at(-1)
  const dpTotal = D.darkpool.daily.reduce((s, r) => s + r.premium, 0)
  const dpShares = D.darkpool.daily.reduce((s, r) => s + r.shares, 0)

  $('eyebrow').textContent = `Periscope · ${D.tickers.join(' & ')} · sessions ${D.sessions[0]} → ${D.last_session}`
  $('headline').textContent = `Where the positioning sits after ${D.last_session}`

  const tiles = [
    [`${lead} close`, spot.close.toFixed(2), spot.open ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}% from ${spot.open.toFixed(2)} open` : spot.source, ''],
    ...D.tickers.slice(1).map(tk => [`${tk} level`, `≈${D.spot[tk].close.toFixed(0)}`, D.spot[tk].source, '']),
    [`${lead} net gamma`, gam(gh.net_gamma), gh.net_gamma < 0 ? 'dealers short gamma' : 'dealers long gamma', sign(gh.net_gamma)],
    ['Put/call premium', lastDaily.pc_prem.toFixed(2), `${lead}, ${md(D.last_session)} session`, ''],
    ['Dark pool ≥$5M', money(dpTotal, 2), `${int(dpShares)} shares · ${D.sessions.length} sessions`, ''],
  ]
  $('tiles').innerHTML = tiles.map(([dt, dd, sub, cls]) =>
    `<div class="tile"><dt>${esc(dt)}</dt><dd${cls ? ` class="${cls}"` : ''}>${esc(dd)}<span class="sub">${esc(sub)}</span></dd></div>`).join('')
}

function renderFlow() {
  const rows = []
  for (const tk of D.tickers) {
    rows.push({ group: tk })
    for (const r of D.daily[tk]) {
      rows.push({ cells: [
        r.date, money(r.call_prem), money(r.put_prem),
        { html: splitBar(r.call_prem, r.put_prem) },
        { html: chip(r.pc_prem.toFixed(2), r.pc_prem > 1) },
        int(r.call_vol), int(r.put_vol), r.pc_vol.toFixed(2),
        { v: smoney(r.net_prem), c: sign(r.net_prem) },
      ] })
    }
  }
  table($('tblDaily'), ['Session', 'Call prem', 'Put prem', 'Split', 'P/C prem', 'Call vol', 'Put vol', 'P/C vol', 'Net prem'], rows)

  const fw = []
  for (const tk of D.tickers) {
    fw.push({ group: tk })
    const ref = D.spot[tk].close
    for (const r of D.forward[tk]) {
      const mp = Number(r.max_pain) || 0
      const dist = ref && mp ? ((mp - ref) / ref) * 100 : 0
      fw.push({ cells: [
        r.expiry, r.dte ?? '—', money(r.call_prem), money(r.put_prem),
        { html: chip(r.pc_prem.toFixed(2), r.pc_prem > 1) },
        int(r.call_vol), int(r.put_vol),
        `${(r.iv * 100).toFixed(1)}%`, `±${r.impl_move_pct.toFixed(2)}%`,
        mp ? mp.toLocaleString() : '—',
        { v: `${dist >= 0 ? '+' : ''}${dist.toFixed(1)}%`, c: sign(dist) },
      ] })
    }
  }
  table($('tblForward'), ['Expiry', 'DTE', 'Call prem', 'Put prem', 'P/C', 'Call vol', 'Put vol', 'IV', 'Impl. move', 'Max pain', 'vs spot'], fw)

  const bl = []
  for (const tk of D.tickers) {
    bl.push({ group: tk })
    for (const g of D.large_trades[tk]) {
      bl.push({ cells: [
        g.date, String(g.total.n), money(g.total.prem),
        { v: money(g.total.call), c: 'pos' }, { v: money(g.total.put), c: 'neg' },
        ...D.forward_expiries.map(e => g.by_expiry[e] ? money(g.by_expiry[e].prem) : '—'),
      ] })
    }
  }
  table($('tblBlocks'), ['Session', 'Trades', 'Total prem', 'Calls', 'Puts', ...D.forward_expiries.map(md)], bl)

  const top = D.top_trades[D.tickers[0]].slice(0, 10).map(t => ({ cells: [
    t.chain, t.date, t.time,
    { html: chip(t.type.toUpperCase(), t.type === 'put') },
    t.strike.toLocaleString(), t.expiry, money(t.prem, 2), int(t.size),
    `${t.iv.toFixed(0)}%`, `${t.delta >= 0 ? '+' : ''}${t.delta.toFixed(2)}`, t.spot.toFixed(2),
  ] }))
  table($('tblTop'), ['Contract', 'Session', 'Time', 'Side', 'Strike', 'Expiry', 'Premium', 'Size', 'IV', 'Delta', 'Spot'], top)
}

function renderTideTable() {
  const lead = D.tickers[0]
  const rows = D.tide.summary.map(s => {
    const chg = s.open_px ? ((s.close_px - s.open_px) / s.open_px) * 100 : 0
    return { cells: [
      s.date,
      { v: smoney(s.spy_net_call), c: sign(s.spy_net_call) },
      { v: smoney(s.spy_net_put), c: sign(s.spy_net_put) },
      { v: `${s.spy_net_vol >= 0 ? '+' : ''}${int(s.spy_net_vol)}`, c: sign(s.spy_net_vol) },
      { v: `${s.close_px.toFixed(2)} (${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%)`, c: sign(chg) },
      { v: smoney(s.mkt_net_call), c: sign(s.mkt_net_call) },
      { v: smoney(s.mkt_net_put), c: sign(s.mkt_net_put) },
      { v: `${s.mkt_net_vol >= 0 ? '+' : ''}${int(s.mkt_net_vol)}`, c: sign(s.mkt_net_vol) },
    ] }
  })
  table($('tblTide'), ['Session', `${lead} net call`, `${lead} net put`, `${lead} net vol`, `${lead} px`,
    'Market net call', 'Market net put', 'Market net vol'], rows)
}

function renderGexTable() {
  const rows = []
  for (const tk of D.tickers) {
    rows.push({ group: tk })
    const byExpiry = {}
    for (const r of D.gex_by_expiry[tk]) (byExpiry[r.expiry] ??= {})[r.date] = r
    for (const e of D.forward_expiries) {
      const per = byExpiry[e]
      if (!per) continue
      const last = per[D.last_session], first = per[D.sessions[0]]
      if (!last) continue
      const delta = first ? last.net_gex - first.net_gex : 0
      rows.push({ cells: [
        e, last.dte ?? '—',
        ...D.sessions.map(d => per[d] ? { v: gam(per[d].net_gex), c: sign(per[d].net_gex) } : '—'),
        { v: (delta > 0 ? '+' : '') + gam(delta), c: sign(delta) },
        { v: gam(last.net_delta), c: sign(last.net_delta) },
        { v: gam(last.net_charm), c: sign(last.net_charm) },
        { v: gam(last.net_vanna), c: sign(last.net_vanna) },
      ] })
    }
  }
  table($('tblGex'), ['Expiry', 'DTE', ...D.sessions.map(d => `${md(d)} net γ`), 'Δ net γ', 'Net delta', 'Net charm', 'Net vanna'], rows)
}

function renderPool() {
  const dp = D.darkpool
  $('poolNote').textContent = `${dp.ticker} only — a cash-settled index has no shares to print, so it has no off-exchange tape. These are prints of $5M notional and up, which is where the size that matters shows up.`
  const rows = dp.daily.map(r => ({ cells: [
    r.date, String(r.prints), money(r.premium, 2), int(r.shares), r.avg_px.toFixed(2),
    `${r.min_px.toFixed(2)}–${r.max_px.toFixed(2)}`, int(r.session_volume), `${r.pct_of_volume.toFixed(1)}%`,
  ] }))
  const tp = dp.daily.reduce((s, r) => s + r.premium, 0)
  const ts = dp.daily.reduce((s, r) => s + r.shares, 0)
  const tn = dp.daily.reduce((s, r) => s + r.prints, 0)
  rows.push({ total: true, cells: ['Total', String(tn), money(tp, 2), int(ts), '—', '—', '—', '—'] })
  table($('tblPoolDaily'), ['Session', 'Prints', 'Notional', 'Shares', 'Avg price', 'Range', 'Session volume', 'Share of vol'], rows)

  const max = Math.max(...dp.levels.map(l => l.shares), 1)
  const lv = [...dp.levels].sort((a, b) => b.shares - a.shares).map(l => ({ cells: [
    l.px.toLocaleString(), String(l.n), int(l.shares), money(l.prem, 2),
    { html: `<span class="bar" style="width:${((l.shares / max) * 100).toFixed(1)}%"></span>`, style: 'width:150px' },
  ] }))
  table($('tblPoolLevels'), ['Price', 'Prints', 'Shares', 'Notional', 'Weight'], lv)

  const top = dp.top.slice(0, 12).map(t => {
    const mid = t.nbbo_bid && t.nbbo_ask ? (t.nbbo_bid + t.nbbo_ask) / 2 : 0
    const vs = mid ? t.price - mid : 0
    return { cells: [
      t.date, t.time, t.price.toFixed(2), int(t.size), money(t.prem, 2),
      t.nbbo_bid.toFixed(2), t.nbbo_ask.toFixed(2),
      { v: `${vs >= 0 ? '+' : ''}${vs.toFixed(3)}`, c: sign(vs) },
    ] }
  })
  table($('tblPoolTop'), ['Session', 'Time (UTC)', 'Price', 'Shares', 'Notional', 'NBBO bid', 'NBBO ask', 'vs mid'], top)
}

function renderNotes() {
  const proxy = D.tickers.find(tk => D.spot[tk].source !== 'UW OHLC')
  const notes = [
    ['Source', `Unusual Whales, pulled through this server at ${new Date(D.generated_at).toLocaleString()}. Last completed session: <code>${D.last_session}</code>.`],
    ['Sessions and expiries', `${D.sessions.length} prior sessions (<code>${D.sessions[0]}</code>–<code>${D.last_session}</code>) and the ${D.forward_expiries.length} expiries that fall next (<code>${D.forward_expiries[0]}</code>–<code>${D.forward_expiries.at(-1)}</code>).`],
    ['Whole tape vs sample', 'Session and expiry premium totals are full aggregates. The block-size table is built from individual trades above a premium floor — the large end of the tape, not a total.'],
    ...(proxy ? [[`${proxy} has no price feed`, `Unusual Whales returns no OHLC for ${proxy}, so its strike window is centred on the volume-weighted busiest strikes (≈${D.spot[proxy].close.toFixed(0)}). Its max-pain and gamma strikes are the API's own values and unaffected.`]] : []),
    ['Deep-in-the-money calls', 'Large "call" prints carrying ~1.00 delta are almost always synthetic stock or financing structures, not directional bets.'],
    ['Gamma sign convention', 'Net gamma is call GEX plus put GEX as the API reports them, with put gamma already negative. Negative net gamma means dealer hedging works with the move, not against it.'],
    ['Not advice', 'Decision support only. No position, order or execution logic is expressed or implied anywhere on this page.'],
  ]
  $('notes').innerHTML = notes.map(([dt, dd]) => `<dt>${esc(dt)}</dt><dd>${dd}</dd>`).join('')
}

/* ---------- chart plumbing ---------- */
function showTip(evt, head, rows) {
  tip.innerHTML = `<div class="t-h">${esc(head)}</div>` + rows.map(r =>
    `<div class="t-r"><span>${esc(r[0])}</span><b${r[2] ? ` style="color:${r[2]}"` : ''}>${esc(r[1])}</b></div>`).join('')
  tip.style.opacity = 1
  const pad = 14, w = 250, h = tip.offsetHeight
  let x = evt.clientX + pad, y = evt.clientY + pad
  if (x + w > window.innerWidth) x = evt.clientX - w - pad
  if (y + h > window.innerHeight) y = evt.clientY - h - pad
  tip.style.left = `${Math.max(4, x)}px`
  tip.style.top = `${Math.max(4, y)}px`
}
const hideTip = () => { tip.style.opacity = 0 }
const svgEl = (w, h, inner) => `<svg viewBox="0 0 ${w} ${h}" role="img">${inner}</svg>`
function bind(box, handler) {
  box.classList.remove('skeleton')
  box.querySelectorAll('[data-tipidx]').forEach(node => {
    const i = +node.dataset.tipidx
    node.addEventListener('mousemove', e => handler(e, i))
    node.addEventListener('mouseleave', hideTip)
  })
  box.addEventListener('mouseleave', hideTip)
}

function renderTide(date) {
  const rows = D.tide.series[date] || []
  const box = $('tideChart')
  if (rows.length < 2) { box.innerHTML = '<p class="fig-sub">No tide data for this session.</p>'; return }
  const W = 720, PA = 168, PB = 74, GAP = 26, ML = 58, MR = 14, MT = 10, MB = 22
  const H = MT + PA + GAP + PB + MB, iw = W - ML - MR
  const xs = i => ML + (iw * i) / (rows.length - 1)
  const pMax = Math.max(...rows.flatMap(r => [Math.abs(r.nc), Math.abs(r.np)])) || 1
  const yA = v => MT + PA / 2 - (v / pMax) * (PA / 2 - 6)
  const px = rows.map(r => r.px).filter(v => v > 0)
  const pxMin = Math.min(...px), pxMax = Math.max(...px), pad = (pxMax - pxMin) * 0.15 || 1
  const yB0 = MT + PA + GAP
  const yB = v => yB0 + PB - ((v - pxMin + pad) / (pxMax - pxMin + pad * 2)) * PB
  const line = (key, y, color) => `<path d="${rows.map((r, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)} ${y(r[key]).toFixed(1)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`

  let g = ''
  for (const v of [pMax, pMax / 2, 0, -pMax / 2, -pMax]) {
    g += `<line class="${v === 0 ? 'axis-line' : 'grid-line'}" x1="${ML}" x2="${W - MR}" y1="${yA(v).toFixed(1)}" y2="${yA(v).toFixed(1)}"/>` +
      `<text class="tick" x="${ML - 8}" y="${(yA(v) + 3).toFixed(1)}" text-anchor="end">${fmtMoney(v)}</text>`
  }
  for (const v of [pxMax, pxMin]) {
    g += `<line class="grid-line" x1="${ML}" x2="${W - MR}" y1="${yB(v).toFixed(1)}" y2="${yB(v).toFixed(1)}"/>` +
      `<text class="tick" x="${ML - 8}" y="${(yB(v) + 3).toFixed(1)}" text-anchor="end">${v.toFixed(2)}</text>`
  }
  rows.forEach((r, i) => {
    if (i % 12 !== 0 && i !== rows.length - 1) return
    g += `<text class="tick" x="${xs(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${r.t}</text>`
  })
  g += line('nc', yA, 'var(--pos)') + line('np', yA, 'var(--neg)') + line('px', yB, 'var(--brass)')
  const last = rows.at(-1), lx = xs(rows.length - 1).toFixed(1)
  g += `<circle cx="${lx}" cy="${yA(last.nc).toFixed(1)}" r="4" fill="var(--pos)" stroke="var(--surface)" stroke-width="2"/>`
  g += `<circle cx="${lx}" cy="${yA(last.np).toFixed(1)}" r="4" fill="var(--neg)" stroke="var(--surface)" stroke-width="2"/>`
  g += `<text class="mark-label" x="${ML + 4}" y="${yB0 - 8}">${D.tickers[0]} price</text>`
  const half = iw / (rows.length - 1) / 2
  rows.forEach((r, i) => {
    g += `<rect class="hit" data-tipidx="${i}" x="${(xs(i) - half).toFixed(1)}" y="${MT}" width="${(half * 2).toFixed(1)}" height="${PA + GAP + PB}"/>`
  })
  box.innerHTML = svgEl(W, H, g)
  bind(box, (e, i) => {
    const r = rows[i]
    showTip(e, `${date} · ${r.t}`, [
      ['Net call premium', fmtMoney(r.nc), 'var(--pos)'],
      ['Net put premium', fmtMoney(r.np), 'var(--neg)'],
      ['Net volume', int(r.nv)],
      [D.tickers[0], r.px.toFixed(2), 'var(--brass)'],
    ])
  })
}

function renderStrike(tk) {
  const spot = D.spot[tk].close
  const rows = D.gex_by_strike[tk].filter(r => !spot || Math.abs(r.strike - spot) / spot <= 0.03)
    .sort((a, b) => b.strike - a.strike)
  const box = $('strikeChart')
  if (!rows.length) { box.innerHTML = '<p class="fig-sub">No strike data.</p>'; return }
  const W = 720, ML = 52, MR = 18, MT = 18, MB = 26, RH = 11
  const H = MT + rows.length * RH + MB, iw = W - ML - MR, cx = ML + iw / 2
  const max = Math.max(...rows.map(r => Math.abs(r.net_gex))) || 1
  const xw = v => (Math.abs(v) / max) * (iw / 2 - 4)
  let g = ''
  for (const f of [-1, -0.5, 0.5, 1]) {
    const x = cx + f * (iw / 2 - 4)
    g += `<line class="grid-line" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${MT}" y2="${MT + rows.length * RH}"/>` +
      `<text class="tick" x="${x.toFixed(1)}" y="${H - 8}" text-anchor="middle">${gam(f * max)}</text>`
  }
  g += `<line class="axis-line" x1="${cx}" x2="${cx}" y1="${MT}" y2="${MT + rows.length * RH}"/>` +
    `<text class="tick" x="${cx}" y="${H - 8}" text-anchor="middle">0</text>`
  rows.forEach((r, i) => {
    const y = MT + i * RH, w = xw(r.net_gex), pos = r.net_gex >= 0
    const x = pos ? cx + 1 : cx - 1 - w
    g += `<rect x="${x.toFixed(1)}" y="${y + 1.5}" width="${Math.max(w, 0.6).toFixed(1)}" height="${RH - 3}" rx="1.5" fill="${pos ? 'var(--pos)' : 'var(--neg)'}"/>`
    if (r.strike % 5 === 0) g += `<text class="tick" x="${ML - 10}" y="${y + RH / 2 + 3}" text-anchor="end">${r.strike.toFixed(0)}</text>`
  })
  const step = rows.length > 1 ? rows[0].strike - rows[1].strike : 1
  const sy = MT + ((rows[0].strike - spot) / step) * RH + RH / 2
  if (sy > MT && sy < MT + rows.length * RH) {
    g += `<line class="spot-line" x1="${ML - 4}" x2="${W - MR}" y1="${sy.toFixed(1)}" y2="${sy.toFixed(1)}"/>` +
      `<text class="spot-tag" x="${W - MR}" y="${(sy - 5).toFixed(1)}" text-anchor="end">spot ${spot.toFixed(2)}</text>`
  }
  rows.forEach((r, i) => {
    g += `<rect class="hit" data-tipidx="${i}" x="${ML}" y="${MT + i * RH}" width="${iw}" height="${RH}"/>`
  })
  box.innerHTML = svgEl(W, H, g)
  bind(box, (e, i) => {
    const r = rows[i]
    showTip(e, `${tk} · strike ${r.strike.toFixed(0)}`, [
      ['Call gamma', gam(r.call_gex), 'var(--pos)'],
      ['Put gamma', gam(r.put_gex), 'var(--neg)'],
      ['Net gamma', gam(r.net_gex)],
      ['Distance from spot', `${(((r.strike - spot) / spot) * 100).toFixed(2)}%`],
    ])
  })
}

function renderHist(tk) {
  const rows = D.gex_history[tk]
  const box = $('histChart')
  const W = 460, H = 250, ML = 56, MR = 16, MT = 14, MB = 30
  const iw = W - ML - MR, ih = H - MT - MB
  const vals = rows.map(r => r.net_gamma)
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), span = hi - lo || 1
  const xs = i => ML + (iw * i) / (rows.length - 1)
  const ys = v => MT + ih - ((v - lo) / span) * ih
  let g = ''
  for (const v of [hi, (hi + lo) / 2, lo]) {
    g += `<line class="grid-line" x1="${ML}" x2="${W - MR}" y1="${ys(v).toFixed(1)}" y2="${ys(v).toFixed(1)}"/>` +
      `<text class="tick" x="${ML - 8}" y="${(ys(v) + 3).toFixed(1)}" text-anchor="end">${gam(v)}</text>`
  }
  if (lo < 0 && hi > 0) g += `<line class="axis-line" x1="${ML}" x2="${W - MR}" y1="${ys(0).toFixed(1)}" y2="${ys(0).toFixed(1)}"/>`
  g += `<path d="${rows.map((r, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)} ${ys(r.net_gamma).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--pos)" stroke-width="2" stroke-linejoin="round"/>`
  const li = rows.length - 1, lv = rows[li].net_gamma
  g += `<circle cx="${xs(li).toFixed(1)}" cy="${ys(lv).toFixed(1)}" r="4.5" fill="${lv >= 0 ? 'var(--pos)' : 'var(--neg)'}" stroke="var(--surface)" stroke-width="2"/>` +
    `<text class="mark-label" x="${(xs(li) - 6).toFixed(1)}" y="${(ys(lv) - 9).toFixed(1)}" text-anchor="end">${gam(lv)}</text>`
  for (const i of [0, Math.floor(rows.length / 2), li]) {
    g += `<text class="tick" x="${xs(i).toFixed(1)}" y="${H - 10}" text-anchor="middle">${md(rows[i].date)}</text>`
  }
  const half = iw / (rows.length - 1) / 2
  rows.forEach((r, i) => {
    g += `<rect class="hit" data-tipidx="${i}" x="${(xs(i) - half).toFixed(1)}" y="${MT}" width="${(half * 2).toFixed(1)}" height="${ih}"/>`
  })
  box.innerHTML = svgEl(W, H, g)
  bind(box, (e, i) => {
    const r = rows[i]
    showTip(e, `${tk} · ${r.date}`, [
      ['Net gamma', gam(r.net_gamma)],
      ['Call gamma', gam(r.call_gamma), 'var(--pos)'],
      ['Put gamma', gam(r.put_gamma), 'var(--neg)'],
      ['Net delta', gam(r.net_delta)],
    ])
  })
}

function renderLadder(tk) {
  const rows = D.gex_by_expiry[tk]
  const box = $('ladderChart')
  const exp = D.forward_expiries.filter(e => rows.some(r => r.expiry === e))
  const cells = []
  for (const e of exp) for (const d of D.sessions) {
    const r = rows.find(x => x.expiry === e && x.date === d)
    if (r) cells.push({ e, d, v: r.net_gex, r })
  }
  if (!cells.length) { box.innerHTML = '<p class="fig-sub">No expiry data.</p>'; return }
  const W = 460, H = 250, ML = 56, MR = 12, MT = 14, MB = 38
  const iw = W - ML - MR, ih = H - MT - MB
  const vals = cells.map(c => c.v)
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), span = hi - lo || 1
  const ys = v => MT + ih - ((v - lo) / span) * ih
  const gw = iw / exp.length, bw = Math.min(16, (gw - 10) / D.sessions.length)
  let g = ''
  for (const v of [hi, (hi + lo) / 2, lo]) {
    g += `<line class="grid-line" x1="${ML}" x2="${W - MR}" y1="${ys(v).toFixed(1)}" y2="${ys(v).toFixed(1)}"/>` +
      `<text class="tick" x="${ML - 8}" y="${(ys(v) + 3).toFixed(1)}" text-anchor="end">${gam(v)}</text>`
  }
  g += `<line class="axis-line" x1="${ML}" x2="${W - MR}" y1="${ys(0).toFixed(1)}" y2="${ys(0).toFixed(1)}"/>`
  cells.forEach((c, i) => {
    const gi = exp.indexOf(c.e), di = D.sessions.indexOf(c.d)
    const gx = ML + gi * gw + (gw - bw * D.sessions.length - 2 * (D.sessions.length - 1)) / 2
    const x = gx + di * (bw + 2), y0 = ys(0), y1 = ys(c.v)
    g += `<rect data-tipidx="${i}" x="${x.toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(Math.abs(y1 - y0), 1.5).toFixed(1)}" rx="1.5" fill="${c.v >= 0 ? 'var(--pos)' : 'var(--neg)'}" style="cursor:crosshair"/>`
  })
  exp.forEach((e, gi) => {
    g += `<text class="tick" x="${(ML + gi * gw + gw / 2).toFixed(1)}" y="${H - 20}" text-anchor="middle">${md(e)}</text>`
  })
  g += `<text class="mark-label" x="${ML}" y="${H - 5}">${D.sessions.map(md).join(' · ')} per group</text>`
  box.innerHTML = svgEl(W, H, g)
  bind(box, (e, i) => {
    const c = cells[i]
    showTip(e, `${tk} · ${c.e} · session ${c.d}`, [
      ['Net gamma', gam(c.v)],
      ['Call gamma', gam(c.r.call_gex), 'var(--pos)'],
      ['Put gamma', gam(c.r.put_gex), 'var(--neg)'],
      ['Net vanna', gam(c.r.net_vanna)],
    ])
  })
}

/* ---------- wiring ---------- */
function setGexTicker(tk) {
  renderStrike(tk); renderHist(tk); renderLadder(tk)
  $('strikeCap').textContent = `Net gamma by strike — ${tk}`
  $('histCap').textContent = `Net gamma by session — ${tk}`
  $('ladderCap').textContent = `Expiry ladder — ${tk}`
}
function buildToggles() {
  $('tideToggle').innerHTML = D.sessions.map((d, i) =>
    `<button type="button" data-tide="${d}" aria-pressed="${i === D.sessions.length - 1}">${md(d)}</button>`).join('')
  $('gexToggle').innerHTML = D.tickers.map((tk, i) =>
    `<button type="button" data-gexticker="${tk}" aria-pressed="${i === 0}">${tk}</button>`).join('')
  $('tideCap').textContent = `${D.tickers[0]} tide, intraday`
  document.querySelectorAll('[data-tide]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('[data-tide]').forEach(o => o.setAttribute('aria-pressed', String(o === b)))
    renderTide(b.dataset.tide)
  }))
  document.querySelectorAll('[data-gexticker]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('[data-gexticker]').forEach(o => o.setAttribute('aria-pressed', String(o === b)))
    setGexTicker(b.dataset.gexticker)
  }))
}
function renderAll() {
  renderMast(); renderFlow(); renderTideTable(); renderGexTable(); renderPool(); renderNotes()
  buildToggles()
  renderTide(D.sessions.at(-1))
  setGexTicker(D.tickers[0])
  $('boot').hidden = true
  $('board').hidden = false
}
function status(state, text, meta = '') {
  $('statusDot').className = `dot ${state}`
  $('statusText').textContent = text
  $('statusMeta').textContent = meta
}
async function load(force = false) {
  const btn = $('refreshBtn')
  btn.disabled = true
  status('wait', force ? 'refreshing…' : 'loading…')
  try {
    const res = await fetch(`/api/board${force ? '?refresh=1' : ''}`)
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `server returned ${res.status}`)
    }
    D = await res.json()
    renderAll()
    const cached = res.headers.get('X-Cache') === 'hit'
    status('', `${D.tickers.join(' · ')} · ${D.sessions.length} sessions`,
      `${cached ? 'cached' : 'fresh'} · built in ${(D.build_ms / 1000).toFixed(1)}s · ${new Date(D.generated_at).toLocaleTimeString()}`)
  } catch (error) {
    status('bad', 'failed', error.message)
    $('boot').innerHTML = `<h2>Could not load the board</h2><p>${esc(error.message)}</p>` +
      `<code>cp .env.example .env &amp;&amp; edit UW_API_KEY</code>`
    $('boot').hidden = false
  } finally {
    btn.disabled = false
  }
}
$('refreshBtn').addEventListener('click', () => load(true))
let resizeTimer
window.addEventListener('resize', () => {
  if (!D) return
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    renderTide(document.querySelector('[data-tide][aria-pressed="true"]').dataset.tide)
    setGexTicker(document.querySelector('[data-gexticker][aria-pressed="true"]').dataset.gexticker)
  }, 160)
})
load()
