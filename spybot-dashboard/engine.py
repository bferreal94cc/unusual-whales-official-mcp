"""SPYBOT research backtester: timestamped *option bid/ask* fills only.

Every decision observes existing rows at time T. An order executes at the
next timestamp at the contract's ask (buy) or bid (sell). No brokerage access.
"""
from __future__ import annotations
import math
from dataclasses import dataclass
import pandas as pd

REQUIRED = {"timestamp", "ticker", "contract", "option_type", "bid", "ask", "spot", "flow_bias", "volume"}

@dataclass
class Config:
    starting_capital: float = 10000.0
    risk_fraction: float = 0.01
    premium_cap_fraction: float = 0.05
    stop_fraction: float = 0.25
    target_fraction: float = 0.40
    max_minutes: int = 25
    min_volume: int = 200
    max_spread_fraction: float = 0.18
    min_flow: float = 0.60
    min_momentum: float = 0.0001
    min_premium_acceleration: float = 0.003
    cooldown_minutes: int = 3
    reversal: bool = False
    fees_per_contract_per_side: float = 0.65


def prepare(raw: pd.DataFrame) -> pd.DataFrame:
    missing = REQUIRED - set(raw.columns)
    if missing:
        raise ValueError("Missing required columns: " + ", ".join(sorted(missing)))
    x = raw.copy()
    x["timestamp"] = pd.to_datetime(x["timestamp"], utc=True, errors="coerce")
    if x.timestamp.isna().any():
        raise ValueError("Every timestamp must be parseable and timezone-aware (UTC recommended)")
    for col in ("bid", "ask", "spot", "flow_bias", "volume"):
        x[col] = pd.to_numeric(x[col], errors="coerce")
    if x[["bid", "ask", "spot", "flow_bias", "volume"]].isna().any().any():
        raise ValueError("Required numeric fields contain invalid or missing values")
    x["ticker"] = x["ticker"].astype(str).str.upper().str.strip()
    x["contract"] = x["contract"].astype(str).str.strip()
    x["option_type"] = x["option_type"].astype(str).str.upper().str.strip()
    if not x["option_type"].isin(["C", "P"]).all():
        raise ValueError("option_type must be C or P")
    if (x.bid < 0).any() or (x.ask <= 0).any() or (x.ask < x.bid).any() or (x.spot <= 0).any():
        raise ValueError("Invalid option bid/ask or underlying spot")
    if (x.flow_bias.abs() > 1).any():
        raise ValueError("flow_bias must be normalized to -1..+1, from as-of signed flow")
    if x.duplicated(["ticker", "contract", "timestamp"]).any():
        raise ValueError("Duplicate quote timestamps for a contract; deduplicate by source/sequence first")
    if "flow_observed_at" in x:
        obs = pd.to_datetime(x.flow_observed_at, utc=True, errors="coerce")
        if obs.isna().any() or (obs > x.timestamp).any():
            raise ValueError("Flow lookahead detected: flow_observed_at must be at/before quote timestamp")
    if "gex_observed_at" in x:
        obs = pd.to_datetime(x.gex_observed_at, utc=True, errors="coerce")
        if obs.isna().any() or (obs > x.timestamp).any():
            raise ValueError("GEX lookahead detected: gex_observed_at must be at/before quote timestamp")
    x = x.sort_values(["timestamp", "ticker", "contract"]).reset_index(drop=True)
    return x


def _signal(row, history, cfg: Config):
    typ = row.option_type
    side = 1 if typ == "C" else -1
    spread = (row.ask - row.bid) / max((row.ask + row.bid) / 2, 0.01)
    if spread > cfg.max_spread_fraction or row.volume < cfg.min_volume or row.bid <= 0:
        return None
    prev = history.get((row.ticker, row.contract), [])
    if len(prev) < 3:
        return None
    prices = [p[1] for p in prev[-3:]]
    momentum = (row.spot / prices[0]) - 1
    mids = [p[2] for p in prev[-3:]]
    mid = (row.ask + row.bid) / 2
    last_prem_change = (mid / max(mids[-1], 0.01)) - 1
    preceding_prem_change = (mids[-1] / max(mids[-2], 0.01)) - 1
    acceleration = last_prem_change - preceding_prem_change
    # No-trade chop: weak directional spot momentum, weak flow or nearby pin.
    if abs(momentum) < cfg.min_momentum or abs(row.flow_bias) < cfg.min_flow:
        return None
    if "gamma_magnet" in row.index and pd.notna(row.gamma_magnet):
        if abs(float(row.spot) - float(row.gamma_magnet)) < float(row.spot) * 0.00025:
            return None
    if momentum * side <= 0 or row.flow_bias * side < cfg.min_flow:
        return None
    if acceleration < cfg.min_premium_acceleration:
        return None
    score = min(1.0, (abs(row.flow_bias) * .55 + min(abs(momentum) * 400, 1) * .25 + min(acceleration * 20, 1) * .20))
    return {"score": score, "acceleration": acceleration, "side": typ}


def run_backtest(raw: pd.DataFrame, cfg: Config | None = None):
    cfg = cfg or Config()
    if cfg.starting_capital <= 0 or not (0 < cfg.risk_fraction <= .20) or not (0 < cfg.stop_fraction < 1):
        raise ValueError("Invalid capital or risk configuration")
    df = prepare(raw)
    if len(df) < 5:
        raise ValueError("Need at least 5 distinct quote observations")
    dates = df.timestamp.dt.tz_convert("America/New_York").dt.date
    if len(set(dates)) == 0:
        raise ValueError("No trading sessions")
    # Need current and next quote for each contract; last quote may serve only as forced-liquidation mark.
    by_contract = {(t, c): g.sort_values("timestamp").reset_index(drop=True) for (t, c), g in df.groupby(["ticker", "contract"])}
    next_quote = {}
    for key, g in by_contract.items():
        for idx in range(len(g)-1):
            a, b = g.iloc[idx], g.iloc[idx+1]
            if a.timestamp.tz_convert("America/New_York").date() == b.timestamp.tz_convert("America/New_York").date():
                next_quote[(key[0], key[1], a.timestamp)] = b
    history = {}
    cash = cfg.starting_capital
    position = None
    trades = []
    marks = [{"timestamp": df.iloc[0].timestamp, "equity": cash}]
    last_exit_at = None
    last_exit_side = None
    pending = None
    reversal_confirm = {"C": 0, "P": 0}
    for ts, group in df.groupby("timestamp", sort=True):
        # Execute pending order only if we have the *next* quote for the exact contract.
        if pending is not None:
            key = (pending["ticker"], pending["contract"])
            current = group[(group.ticker == key[0]) & (group.contract == key[1])]
            if not current.empty and ts > pending["requested_at"]:
                q = current.iloc[0]
                if pending["action"] == "buy":
                    n = pending["qty"]
                    total = n * q.ask * 100 + n * cfg.fees_per_contract_per_side
                    if total <= cash:
                        cash -= total
                        position = {**pending, "entry_time": ts, "entry_price": float(q.ask), "qty": n, "cash_out": total}
                else:
                    if position is not None:
                        n = position["qty"]
                        received = n * q.bid * 100 - n * cfg.fees_per_contract_per_side
                        cash += received
                        pnl = received - position["cash_out"]
                        trades.append({"ticker": position["ticker"], "contract": position["contract"],
                            "side": position["side"], "entry_time": position["entry_time"],
                            "exit_time": ts, "entry_ask": position["entry_price"], "exit_bid": float(q.bid),
                            "qty": n, "pnl": round(pnl, 2), "reason": pending["reason"],
                            "signal_score": round(position["score"], 3)})
                        last_exit_at, last_exit_side = ts, position["side"]
                        position = None
                pending = None
        # Evaluate the current quote for an existing position; fills occur later, not here.
        if position is not None and pending is None:
            qq = group[(group.ticker == position["ticker"]) & (group.contract == position["contract"])]
            if not qq.empty:
                q = qq.iloc[0]
                age = (ts - position["entry_time"]).total_seconds()/60
                change = q.bid / position["entry_price"] - 1
                reason = "stop" if change <= -cfg.stop_fraction else ("target" if change >= cfg.target_fraction else ("time" if age >= cfg.max_minutes else None))
                if reason and (position["ticker"], position["contract"], ts) in next_quote:
                    pending = {"action": "sell", "ticker": position["ticker"], "contract": position["contract"], "requested_at": ts, "reason": reason}
        # Decisions use only history up to this event, and no signal print fills.
        if position is None and pending is None:
            candidates = []
            for _, row in group.iterrows():
                sig = _signal(row, history, cfg)
                if sig is None or (row.ticker, row.contract, ts) not in next_quote:
                    continue
                if last_exit_at is not None:
                    dt = (ts - last_exit_at).total_seconds()/60
                    if dt < cfg.cooldown_minutes:
                        continue
                    if last_exit_side is not None and sig["side"] != last_exit_side:
                        if not cfg.reversal:
                            continue
                        reversal_confirm[sig["side"]] += 1
                        if reversal_confirm[sig["side"]] < 2:
                            continue
                candidates.append((sig["score"], row, sig))
            if candidates:
                score, q, sig = max(candidates, key=lambda e: e[0])
                premium = float(q.ask) * 100
                risk_per_contract = max(premium * cfg.stop_fraction, 0.01)
                qty = min(int(cash * cfg.risk_fraction / risk_per_contract),
                          int(cash * cfg.premium_cap_fraction / (premium + cfg.fees_per_contract_per_side)))
                if qty > 0:
                    pending = {"action": "buy", "ticker": q.ticker, "contract": q.contract,
                               "side": q.option_type, "requested_at": ts, "qty": qty, "score": score}
        for _, row in group.iterrows():
            key = (row.ticker, row.contract)
            hist = history.setdefault(key, [])
            hist.append((ts, float(row.spot), (float(row.bid)+float(row.ask))/2))
            if len(hist) > 5:
                del hist[:-5]
        equity = cash
        if position is not None:
            qq = group[(group.ticker == position["ticker"]) & (group.contract == position["contract"])]
            if not qq.empty:
                equity += position["qty"] * float(qq.iloc[0].bid) * 100
            else:
                equity += position["qty"] * float(position["entry_price"] * (1 - cfg.stop_fraction)) * 100
        marks.append({"timestamp": ts, "equity": round(equity, 2)})
    # End-of-file: incomplete positions are NOT counted as completed trade; show explicitly.
    equity_df = pd.DataFrame(marks).drop_duplicates("timestamp", keep="last")
    trades_df = pd.DataFrame(trades)
    max_dd = float((equity_df.equity/equity_df.equity.cummax() - 1).min())
    result = {"starting_capital": cfg.starting_capital, "ending_marked_equity": round(float(equity_df.equity.iloc[-1]),2),
              "return_pct": round(100*(equity_df.equity.iloc[-1]/cfg.starting_capital-1),2),
              "trades": len(trades), "max_drawdown_pct": round(max_dd*100,2),
              "win_rate_pct": round(100*(trades_df.pnl.gt(0).mean()) if not trades_df.empty else 0,2),
              "open_position_at_end": position is not None,
              "unfilled_order_at_end": pending is not None,
              "data_start": str(df.timestamp.min()), "data_end": str(df.timestamp.max()),
              "mode": "with reversal rotation" if cfg.reversal else "base-only"}
    return result, trades_df, equity_df