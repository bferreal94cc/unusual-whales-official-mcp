"""SPYBOT Research Terminal — mobile-first Streamlit dashboard, read-only UW."""
from __future__ import annotations
import datetime as dt
import hmac
import io
import os
import pandas as pd
import plotly.graph_objects as go
import streamlit as st
from engine import Config, run_backtest, prepare
from uw_client import market_snapshot, payload_rows

st.set_page_config(page_title="SPYBOT | Research Terminal", page_icon="📊", layout="wide", initial_sidebar_state="collapsed")
st.markdown("""<style>
:root {color-scheme:dark} .stApp{background:#090e17;color:#edf2f9}
.block-container{padding-top:1.15rem;max-width:1350px}
h1,h2,h3{letter-spacing:-.02em} .hero{padding:15px 19px;border:1px solid #243246;border-radius:15px;background:linear-gradient(130deg,#132337,#0c1520)}
.hero small{color:#9fb1c7;letter-spacing:.15em;font-weight:700}
.kicker{color:#6ce2cf;font-size:.78rem;font-weight:800;letter-spacing:.14em}
.tag{display:inline-block;background:#1b2d39;color:#a9f6eb;border:1px solid #375459;border-radius:12px;padding:4px 9px;font-size:.75rem}
[data-testid=stMetric]{background:#101b2a;border:1px solid #283449;border-radius:12px;padding:12px}
[data-testid=stMetricLabel]{color:#9fb1c7}
@media(max-width:600px){.block-container{padding:.7rem .75rem 2rem}.hero{padding:12px}.hero h1{font-size:1.65rem}}
</style>""",unsafe_allow_html=True)


def secret(name, default=""):
    try:
        return st.secrets.get(name, os.environ.get(name, default))
    except Exception:
        return os.environ.get(name, default)


def authorize():
    password = str(secret("DASHBOARD_PASSWORD"))
    if not password:
        st.error("Dashboard locked: set DASHBOARD_PASSWORD in Streamlit server secrets before use.")
        st.stop()
    if not st.session_state.get("authorized"):
        st.title("SPYBOT secure access")
        entered = st.text_input("Dashboard password", type="password")
        if st.button("Unlock", type="primary"):
            if hmac.compare_digest(entered, password):
                st.session_state["authorized"] = True
                st.rerun()
            else:
                st.error("Incorrect password")
        st.stop()

authorize()
st.markdown('<div class="hero"><small>SPYBOT / PERISCOPE ENGINE</small><h1 style="margin:5px 0">Options Research Terminal</h1><span class="tag">SPY + QQQ</span> &nbsp;<span class="tag">Read-only • No execution</span></div>',unsafe_allow_html=True)
st.caption("Every dataset is labeled by source and timestamp. Historical observations are not live signals.")

with st.sidebar:
    st.header("Workspace")
    ticker = st.selectbox("Ticker", ["SPY","QQQ","XSP","IWM"],index=0)
    st.caption("Data credentials stay on the server. Never enter secrets into GitHub source.")
    if st.button("Lock dashboard"):
        st.session_state.pop("authorized",None)
        st.rerun()

live, replay, protocol, archive = st.tabs(["Market monitor", "Options backtest", "Rules & methods", "Archive index"])
with live:
    st.subheader("Unusual Whales market monitor")
    st.write("Load the latest available data from your own Unusual Whales API entitlement. Four requests: OHLC, signed net premium ticks, OI GEX, volume GEX.")
    token = str(secret("UNUSUAL_WHALES_API_KEY"))
    if not token:
        st.info("API not connected. Add UNUSUAL_WHALES_API_KEY in Streamlit deployment secrets. No synthetic prices are displayed.")
    elif st.button("Fetch / refresh market data", type="primary"):
        with st.spinner("Querying Unusual Whales..."):
            result = market_snapshot(ticker,token)
        st.session_state[f"snapshot_{ticker}"]={"retrieved_at":dt.datetime.now(dt.timezone.utc).isoformat(),"data":result}
    snap = st.session_state.get(f"snapshot_{ticker}")
    if snap:
        data=snap["data"]
        st.caption("Retrieved at " + snap["retrieved_at"] + " UTC; API may return previous-session data")
        kpis=st.columns(4)
        ohlc=payload_rows(data.get("daily_ohlc",{}).get("payload",{}))
        if ohlc:
            rows=pd.DataFrame(ohlc)
            last=rows.sort_values("date").iloc[-1] if "date" in rows else rows.iloc[-1]
            for col,(name,key) in zip(kpis,[("Latest close","close"),("Session high","high"),("Session low","low"),("Session","date")]):
                col.metric(name,str(last.get(key,"—")))
            if {"date","close"}.issubset(rows.columns):
                rows["close"]=pd.to_numeric(rows.close,errors="coerce")
                st.line_chart(rows.set_index("date")["close"])
        else:
            st.warning("No OHLC rows returned for this entitlement/response format")
        gcols=st.columns(2)
        for column,key,label in [(gcols[0],"gex_oi","Open-interest GEX"),(gcols[1],"gex_volume","Volume GEX")]:
            item=data.get(key,{})
            with column:
                st.markdown("**"+label+"**")
                if item.get("status")=="ok":
                    payload=item.get("payload",{})
                    level=payload.get("data",payload) if isinstance(payload,dict) else {}
                    if isinstance(level,dict):
                        st.write({k:level.get(k) for k in ("date","time","call_wall","put_wall","gamma_flip","gamma_magnet")})
                else:
                    st.info(item.get("error","Unavailable"))
        item=data.get("flow_ticks",{})
        if item.get("status")=="ok":
            flow=payload_rows(item.get("payload",{}))
            if flow:
                ff=pd.DataFrame(flow)
                wanted=[x for x in ("timestamp","date","net_call_premium","net_put_premium") if x in ff.columns]
                st.subheader("Net premium ticks (raw per-minute series)")
                st.dataframe(ff[wanted].tail(80),use_container_width=True,hide_index=True)
                st.caption("Raw net-premium ticks are not necessarily cumulative. Do not interpret gross call/put premium as directional flow.")
        with st.expander("Source responses and errors"):
            st.json(data)
    else:
        st.info("Market overview is empty until you explicitly fetch it with your key.")

with replay:
    st.subheader("Options quote replay")
    st.write("Import timestamped historical **option bid/ask** quotes. The engine uses next-timestamp execution, bid/ask spreads, fees, cooldown, chop filters and separate reversal confirmation.")
    uploaded = st.file_uploader("CSV with timestamped options quotes",type=["csv"])
    st.caption("Required: timestamp (UTC), ticker, contract, option_type (C/P), bid, ask, spot, flow_bias (-1 to +1), volume. Optional: gamma_magnet, flow_observed_at, gex_observed_at. Flow bias must be as-of and directionalized.")
    a,b,c=st.columns(3)
    starting=a.number_input("Initial capital ($)",1000.0,1000000.0,10000.0,1000.0)
    risk=b.slider("Stop-based risk (%/trade)",0.25,3.0,1.0,0.25)
    reversal=c.toggle("Allow verified C↔P reversal",value=False)
    d,e,f=st.columns(3)
    minflow=d.slider("Min directional flow",0.2,0.95,0.6,.05)
    stop=e.slider("Stop from entry ask (%)",5,80,25,5)
    target=f.slider("Take profit (%)",10,200,40,5)
    if uploaded is not None:
        try:
            df=pd.read_csv(uploaded)
            normalized=prepare(df)
            st.caption(f"Validated rows: {len(normalized):,} | distinct contracts: {normalized.contract.nunique():,} | window {normalized.timestamp.min()} — {normalized.timestamp.max()}")
            if st.button("Run historical quote replay",type="primary"):
                cfg=Config(starting_capital=starting,risk_fraction=risk/100,reversal=reversal,min_flow=minflow,stop_fraction=stop/100,target_fraction=target/100)
                stats,trades,curve=run_backtest(normalized,cfg)
                st.session_state["last_test"]=(stats,trades,curve)
        except Exception as exc:
            st.error("Input rejected: " + str(exc))
    else:
        st.info("No historical options quotes supplied. The dashboard will not manufacture a win rate or P&L from underlying-only candles.")
    if "last_test" in st.session_state:
        stats,trades,curve=st.session_state["last_test"]
        st.warning("Research simulation only — not verified executable fills. Options gaps, market impact and delayed prints can materially worsen realized results.")
        m=st.columns(4)
        for cell,(lbl,key) in zip(m,[("Marked equity","ending_marked_equity"),("Net return %","return_pct"),("Closed trades","trades"),("Max drawdown %","max_drawdown_pct")]):
            cell.metric(lbl,str(stats[key]))
        st.line_chart(curve.set_index("timestamp").equity)
        st.write("**Backtest audit**",stats)
        if stats["trades"]<20:st.warning("Sample-size warning: fewer than 20 closed trades. Do not infer robustness.")
        if stats["open_position_at_end"] or stats["unfilled_order_at_end"]:st.warning("Open/pending orders remain at dataset end. Ending marked equity is not a realized liquidation value.")
        st.dataframe(trades,use_container_width=True,hide_index=True)
        st.download_button("Download trade ledger",trades.to_csv(index=False),"spybot_trade_ledger.csv","text/csv")
        st.download_button("Download equity series",curve.to_csv(index=False),"spybot_equity.csv","text/csv")

with protocol:
    st.subheader("SPYBOT decision architecture")
    st.markdown("""**Signal:** signed aggressive options flow + underlying momentum + contract premium acceleration + spread/liquidity threshold. **No-trade:** weak momentum, weak flow, gamma magnet chop zone.\n\n**Exit is independent:** target, stop, holding-time limit. Execution occurs on the next recorded quote, not the triggering print.\n\n**Rotation is independent:** only after a position closes and the cooldown elapses; opposite-side signal must persist across two qualifying events. Call→put and put→call must be audited separately.\n\n**Research protocol:** pre-register thresholds, cap parameter sweeps to <60, hold out final third, compare against SPY, report max drawdown, sample count, option fill assumptions, and quarterly concentration. Source snapshots must be available as-of the signal time.\n\n**Not implemented:** brokerage connectivity, real-time order placement, calibrated fill probability, historical options quote procurement, walk-forward automation, and hedge-adjusted GEX model validation.""")
    st.caption("Ref: Unusual Whales official build recipes + user-authored SPYBOT rules (2026).")
with archive:
    st.subheader("Saved trading source index")
    st.write("Research inputs and screenshots belong outside the code repository. The archive inventory is provided as a separate review manifest; do not commit sensitive user screenshots or personal API tokens.")
    st.markdown("[Unusual Whales dashboard example](https://github.com/unusual-whales/api-examples/tree/main/examples/net-prem-ticks-dashboard) · [VectorBT](https://github.com/polakowo/vectorbt) · [Hugging Face Spaces](https://huggingface.co/spaces)")
    st.caption("All duplicate candidates remain pending manual review; this application never deletes Library content.")