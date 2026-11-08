# SPYBOT Research Terminal — mobile and GitHub-ready

Research-only dashboard for SPY/QQQ options flow, GEX, and historical option-quote replay. Not an automated trading system.

## Deploy from GitHub to your iPhone

1. Create a **private GitHub repository** and upload these files to its root (including `.streamlit` folder). Keep `.streamlit/secrets.toml` OUT of version control.
2. At [Streamlit Community Cloud](https://share.streamlit.io/), connect GitHub, select the repository and set the app file to `app.py`. Community Cloud may require additional private-repo permissions.
3. In deployment **Advanced settings → Secrets**, enter:

   ```toml
   DASHBOARD_PASSWORD = "your-strong-unique-password"
   UNUSUAL_WHALES_API_KEY = "your-private-key"
   ```

4. Deploy and bookmark the HTTPS app URL to your iPhone home screen (Safari → Share → Add to Home Screen). Use the ChatGPT app to analyze results and work on repository changes. ChatGPT does not host a continuously running Streamlit server inside the chat UI.
5. Streamlit Community Cloud may not be adequate for sensitive financial/proprietary data requiring strong user auth. A password prompt here is a lightweight gate, **not** enterprise-grade access control. Upgrade to managed identity-aware hosting for production use.

## Local preview

```bash
python -m pip install -r requirements.txt
cp .streamlit/secrets.toml.example .streamlit/secrets.toml
# edit local secrets.toml with a strong password and API key
streamlit run app.py
```

## Data and engine

- API endpoints confirmed from Unusual Whales official MCP build recipes: `/api/stock/{ticker}/ohlc/1d`, `/api/stock/{ticker}/net-prem-ticks`, `/api/stock/{ticker}/gex-levels?source=oi` and `source=vol`.
- Historical backtests **require as-of option bid/ask quotes** (CSV). Underlying OHLC, gross option premium, and GEX levels alone are not enough to calculate option fills.
- CSV required: `timestamp` (ISO timestamp, UTC recommended), `ticker`, `contract` (option identifier), `option_type` (`C` or `P`), `bid`, `ask`, `spot`, `flow_bias` (-1 bearish to +1 bullish; **derived from signed, time-correct net directional premium**), `volume`. Optional `gamma_magnet`, `flow_observed_at`, `gex_observed_at` are validated against lookahead.
- The backtest enters at **next recorded ask** and exits at **next recorded bid**, with a configurable per-contract fee and no fill at the signal quote. Thin samples and unfinished positions are flagged.
- Research options engine: as-of flow + contract premium acceleration + underlying momentum, no-trade/chop filter, independent stop/target/time exits, optional independent reversal. Not a calibrated alpha model.
- Historic option trade prints are **not** interchangeable with actual bid/ask quote history. Check data licensing/entitlement before export or storage.
- No brokerage tokens, execution endpoints, Robinhood integration or order placement.

## Research stack and sources

- [Unusual Whales official net premium dashboard](https://github.com/unusual-whales/api-examples/tree/main/examples/net-prem-ticks-dashboard)
- [Unusual Whales API docs](https://api.unusualwhales.com/docs/)
- [vectorbt](https://github.com/polakowo/vectorbt) for larger sweeps
- [Backtrader](https://github.com/mementum/backtrader) for event-driven strategy testing
- [QuantStats](https://github.com/ranaroussi/quantstats) for reports
- [Hugging Face Spaces](https://huggingface.co/spaces) for hosting experimental UI demos **only if permitted by data licensing/security**

## Review process

1. Start with 5–10 sessions; inspect source dates, quote timestamps, timezone, session and print conditions.
2. Pre-register hypotheses/thresholds and assess base, C→P and P→C separately.
3. Backtest each fill using only information available at T; next-quote fills with costs.
4. First two-thirds in sample; final third holdout, then paper trading before considering any real capital.
5. Report all tested variants, trade count, return, Sharpe (only if properly sampleable), max drawdown, quarterly concentration, and SPY benchmark.

## Limitations

The prototype does not automatically run a parameter sweep, enforce a session holiday calendar, reconstruct quote history from Unusual Whales, model gap/latency or advanced exchange fill mechanics, or provide persistent streaming alerts. It is a working research scaffold rather than a validated profitable strategy. For a production deployment, implement centralized auth and database-backed snapshots. User Library file cleanup is separate from this source repository.