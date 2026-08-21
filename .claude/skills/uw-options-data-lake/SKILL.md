---
name: uw-options-data-lake
description: >
  Build and maintain a local data lake of transaction-level Unusual Whales options data
  (the Full Tape) on the user's own machine. Use whenever the user wants to download the
  full option-trades tape day by day, back-fill a historical range, convert a downloaded
  tape zip into a query-ready columnar file, check what their data lake already covers, or
  understand how much disk a range will cost before committing to it. Also builds an offline
  silver layer of 1-minute per-contract OHLCV-plus-greeks bars from that bronze tape, for
  measuring the forward performance of a contract over time. It also ships one worked options
  screener that runs on the bronze tape and flags contracts at the moment they meet an
  unusual-activity setup, as an adaptable template for the user's own screening criteria, plus
  a companion forward command that reads the silver bars to report neutral key prices for each
  screened contract after its moment of detection. Especially useful for UW API
  subscribers who want their own durable, offline copy of the trades tape rather than
  re-querying the API every time.
---

# uw-options-data-lake: Unusual Whales Full Tape data lake

This skill turns any AI assistant into a medallion-format data lake builder using transaction-level options data from Unusual Whales.
The assistant writes one **self-contained Python script (included in full below)** and verifies it with the script's own selftest.
The assistant then drives it to download and convert the Full Tape one trading day at a time.
The result is a **bronze layer** of daily Parquet files on the user's disk.
No repo clone, no setup ritual, no virtualenv (though virtual environments are a good idea).
**The user is responsible for supplying the Skill URL and the UW API key** (recommended in a .env file that is never committed).
From there, the assistant installs uv then executes the script from end-to-end.
An optional **silver layer** builder creates 1-minute per contract bars from the **bronze layer**, which allows the user to calculate forward performance for option contracts.
(see "Silver: 1-minute per-contract bars" below.)
A worked **screener** runs directly on the **bronze layer** to flag contracts the moment they meet unusual option activity filter criteria.
**This setup is meant as an adaptable example.**
(see "Screener: example call screen" below.)
The `screen` command saves its flagged contracts to a small CSV, then a companion `forward` command reads the **silver layer** bars to report forward prices for each of those contracts after its moment of detection.
(see "Forward performance" below.)

> **Disclaimer: read before using.**
> This skill is provided for **educational and informational purposes only**.
> It is **not investment advice** and not a recommendation to buy or sell any security.
> Trading options involves substantial risk, including the loss of your entire investment.
> You are solely responsible for your decisions; consult a licensed financial professional before acting on anything derived from this data.
> Unusual Whales accepts no liability for losses incurred from its use.

## When to use this skill

Use it when the user wants to:

- Build a local, offline copy of the options Full Tape for a date or a range of dates.
- Back-fill as much history as their subscription allows, then keep the lake current day by day.
- Convert a Full Tape zip they already downloaded into a validated Parquet file.
- See what their lake already covers, and how much disk a planned range will cost first.
- Build 1-minute per-contract bars (the silver layer) from bronze to study a contract's forward performance, offline.
- Screen the bronze tape for an unusual-activity setup and flag each contract at the moment it qualifies, then adapt the example to their own criteria.
- Measure how each screened contract traded after its moment of detection, reading the silver bars for neutral key prices (lowest, highest, and latest), without baking in any buy-or-sell-specific return.

## What "bronze" means here

Bronze is the faithful, unedited landing of the source data in an efficient columnar format.
The script downloads a day's tape (a zip containing one CSV of that day's option trades), converts it to Parquet, validates the conversion, and then deletes the transient zip and CSV.
The Parquet **is** the bronze layer: it keeps all **40 columns**, does no sorting, and drops no rows.

The only typing bronze applies is to the two timestamp columns.
`executed_at` and `created_at` are parsed to `Datetime[us, UTC]` (microsecond precision, tz-aware, anchored at UTC); every other column keeps polars' inferred default (numerics as `Int64`/`Float64`, everything else as text).
Bronze stays in UTC; any Eastern-time presentation is a later concern, not something bronze does.
Parquet is written with ZSTD level **3** compression, a strong size-versus-speed balance for this data.

Before a day's Parquet is kept, it must pass a validation gate: the row count must match the source CSV, all 40 columns must be present, the two timestamps must be typed, and neither may have gained a null beyond the genuinely-empty tokens in the source.
That last check is deliberate: a non-empty timestamp that failed to parse would otherwise be silently coerced to null, so the gate fails loudly instead.
Deleting the zip and CSV happens **only after** this gate passes.

Each day lands as one file under a dataset-named subdirectory: `lake/bronze/full-tape/YYYY-MM-DD.parquet`, one per trading day.
The `full-tape/` directory names the source dataset (the Unusual Whales Full Tape), so both you and the assistant can see at a glance where those files came from, and the lake has room to grow other bronze datasets alongside the Full Tape later without ambiguity.

## Disk space: read before a bulk build

This data is large. The planner uses deliberately worst-case per-day anchors, sized above the heaviest day seen so far (2026-06-05, a high-volume selloff: a 2.05 GB zip, a 5.84 GB CSV, a 1.42 GB Parquet) so even a busy session cannot blow the estimate. A normal day is roughly 30% smaller.

- Download zip: up to **2.60 GB**, transient, deleted after conversion.
- Extracted CSV: up to **7.50 GB**, transient, deleted after conversion.
- Bronze Parquet (what you keep): up to **1.80 GB** per day.

Two numbers matter when planning:

- **Steady-state footprint** is Parquet only: up to **1.80 GB per trading day** retained at this worst-case rate. A full year of trading days (about 252) is therefore on the order of 450 GB at the ceiling; a typical year lands nearer 290 GB. Once the lake has real files, the estimate switches to their measured average, so this worst-case anchor only governs the very first build.
- **Peak transient disk** during each day's conversion is the zip plus the CSV plus the Parquet at once, up to **11.90 GB**. This peak, not the steady state, is what bites a small laptop drive, because it is needed briefly for every single day.

The `build` command will not start a bulk download blind.
By default it prints a disk estimate for the requested range and stops; it only proceeds when you pass `--confirm`.
Once the lake has real files, the estimate uses their measured average rather than the figures above.

## Your historical window

How far back you can pull is a per-subscriber setting, not a fixed constant.
When you request a date older than your window, the API returns an HTTP 403 whose JSON body carries `code: historic_data_access_missing` and states your earliest available date.
This is a legitimate entitlement response, **not** an authentication failure, and the script treats it as such.

- Run `probe` to learn your real window in one request: it reports your earliest available date and your lookback in trading days.
- `build` probes automatically and clamps the requested range to your allowed window, telling you what it clamped rather than erroring on each out-of-range date.
- Guideposts at the time of writing (your actual window can differ, which is why the probe is authoritative): Trial API is 90 trading days; Basic and Advanced API are 730 trading days.
- To request access older than your window, email **dev@unusualwhales.com** with your use case.

## Silver: 1-minute per-contract bars

Silver is an optional second layer built entirely from your local bronze, with no network and no API quota.
It reads bronze Parquet and writes bars; it never modifies bronze.
Where bronze is the faithful transaction-level tape, silver is an aggregate: **1-minute OHLCV-plus-greeks bars, one row per (contract, minute)**.
The grain is one bar per (`option_chain_id`, minute), and bars are sparse: a bar exists only for a minute that had at least one non-canceled trade for that contract, so illiquid contracts do not fill the file with empty minutes.

Two different jobs motivate the split.
An unusual-activity screener wants the transaction-level rows and runs on bronze directly.
Measuring the forward performance of a flagged contract wants time series, and that is what silver bars are for; 1-minute matches an existing UW public-API granularity, so it should feel familiar.

Each bar carries the **33-column** bar schema, grouped by role:

- Contract dimensions (constant within a contract): `option_chain_id`, `underlying_symbol`, `security_type`, `option_type`, `strike`, `expiry`.
- Bucket keys: `minute_utc` (the canonical key) and `minute_et`.
- Price and flow: `open`, `high`, `low`, `close`, `volume`, `trade_count`, `premium`, `vwap`.
- Side volumes: `ask_volume`, `bid_volume`, `mid_volume`, `no_side_volume`, `multi_volume`.
- Bar-close snapshots: `bid_close`, `ask_close`, `underlying_open`, `underlying_close`, `iv_close`, `delta_close`, `gamma_close`, `theta_close`, `vega_close`, `rho_close`, `theo_close`, `open_interest`.

A few definitions are worth knowing before you rely on the numbers:

- Canceled prints are excluded from OHLC, volume, and every snapshot. They are rare (about 0.003% of prints) but over half sit at their contract's price extreme, so keeping them would distort the high and low. Late, cross, and out-of-sequence prints are kept, because they are legitimate executions; a screener that wants them gone filters on bronze at query time.
- `volume` is the sum of trade `size` over non-canceled prints in the minute. The side volumes are different: the tape's per-side counters are running cumulative totals per contract, so each side volume is that counter's per-minute increment (this minute's running total minus the prior minute's), not a sum.
- `security_type` is derived from the tape's own `tags` and is one of `equity`, `etf`, or `index`; no external reference table is needed.
- `minute_utc` is the canonical bucket key in UTC. `minute_et` is the same minute in US/Eastern, and it is exact: Eastern time is a whole-hour offset from UTC, so 1-minute buckets align identically either way. Bronze stays UTC; silver is where the Eastern-time column is delivered.

Silver has its own lake area, Hive-partitioned by date:

- Path: `lake/silver/option-contracts-1m/date=YYYY-MM-DD/bars.parquet`, one partition per trading day, sorted within by (`option_chain_id`, `minute_utc`) and written ZSTD level 3. The dataset directory is named for what the bars are of (option contracts) at what grain (1-minute), so the layout says what it holds on sight.
- Scan the whole silver lake with `pl.scan_parquet("lake/silver/option-contracts-1m/", hive_partitioning=True)`, which exposes `date` as a column and prunes partitions by a date filter.
- The partition date equals the bronze date, which equals the Eastern-time session date; regular US options hours never cross a UTC midnight, so there is no cross-day bleed.

On disk, silver bars run about 250 MB per day (roughly 22% of that day's bronze), and the planner's worst-case anchor is up to **350.00 MB** per day; once any silver files exist the estimate switches to their measured average.
Silver has no large disk transient the way bronze conversion does; its real cost is RAM, because one day is sorted and grouped in memory during the build.
Every partition is validated before it is committed (bar volume reconciles to the source, the grain is unique, the 33-column schema and its dtypes are exact, every bar has at least one trade, OHLC bounds hold, and `security_type` is in range), and the file is written to a temporary name and renamed into place, so a partition only ever appears once it is complete and valid.

Build and inspect silver like bronze:

- `uv run uw_options_data_lake.py silver-build 2026-07-27 2026-07-31` prints a disk estimate and stops; re-run with `--confirm` to build. Omit the end date to build a single day. It skips dates that have no bronze yet and is an idempotent no-op for dates already built.
- `uv run uw_options_data_lake.py silver-status` shows silver coverage against bronze: how many bronze dates in the window have bars, the total size, and the dates present.
- The no-argument status now includes a `silver:` line alongside the bronze coverage.

A worked forward-performance read, one contract's intraday tape:

```py
import polars as pl

bars = pl.scan_parquet("lake/silver/option-contracts-1m/", hive_partitioning=True)
one = (
    bars.filter(
        (pl.col("date") == pl.date(2026, 7, 31))
        & (pl.col("option_chain_id") == "MSTR270115C00095000")
    )
    .sort("minute_utc")
    .select("minute_et", "open", "high", "low", "close", "volume", "vwap", "delta_close")
)
print(one.collect())
```

## Screener: example call screen

The skill ships one worked **options screener** that runs directly on the bronze tape.
It is a read-only query on the tape: no network and no API quota, and it never modifies the lake.
It does save its flagged contracts to a small results CSV (by default under `lake/screens/`) so the `forward` command can reuse them; see "Forward performance" below.
It is meant as a template, so the defaults reproduce one illustrative bullish long-dated call setup and the assistant adapts them to whatever the user wants to screen for.

Unlike the silver bars, the screener runs on transaction-level **bronze** on purpose, because it reports each contract's **moment of detection**: the first print at which that contract's running-cumulative metrics satisfy every criterion at once.
That is what an alerting screener does, the instant a contract crosses the thresholds it is flagged, and a minute-bar aggregate cannot pinpoint that instant.
A contract can qualify intraday and then drift back under a threshold by the close; the moment-of-detection flag still fired, and that is the point.

The defaults screen for calls on stocks or ADRs (no ETFs or indexes), at least **181** days to expiration, at most 12% in the money, at least **$500,000** in cumulative premium, at least **80%** ask-side, volume at least 1.5x open interest, at most 10% multi-leg, at most 10% floor, and an average fill price of at most **$50** per contract.
Every threshold is a field on the `ScreenCriteria` dataclass in the script, so screening for a different setup is a matter of changing those values (or `option_type` / `security_types`) and re-running:

```py
@dataclass
class ScreenCriteria:
    option_type: str = "call"
    security_types: tuple[str, ...] = ("equity",)   # equity is stock or ADR; not etf / index
    min_vol_oi_ratio: float = 1.5
    min_ask_pct: float = 0.80
    min_premium: float = 500_000.0
    min_dte: int = 181
    min_otm_pct: float = -0.12          # at most 12% ITM: strike >= 0.88 * spot
    max_multi_pct: float = 0.10
    max_floor_pct: float = 0.10
    max_avg_price: float = 50.0
```

A few definitions sit behind the numbers:

- Moneyness is `otm_pct = strike / underlying_price - 1`, so a strike 5% above spot is `+0.05` and a call 12% in the money is `-0.12`. `min_otm_pct = -0.12` means "at most 12% in the money" and admits everything from there up through deep out of the money; set it to `0.0` for out-of-the-money only.
- Ask-side and multi-leg percentages come straight from the tape's own running-cumulative counters (`ask_vol` and `multi_vol` over `volume`), which is UW's own trade-side and multi-leg classification, so the screen does not re-derive them.
- Premium and floor are the only cumulatives the screen sums itself; floor volume is the trade `size` on prints flagged `futures_floor`, and average fill price is cumulative premium divided by volume divided by 100.
- The screen keeps canceled, cross, and late prints, because it rides the tape's own `volume` counter and matching that total is the point. This is the opposite of the silver bars, which drop canceled prints for a clean high and low.

Filtering on a field the example does not use, a greek like `delta` or a bid-side ratio mirroring `ask_pct`, takes only a new field on `ScreenCriteria` and the matching clause in `screen_bronze`'s filter.
The screen reads the whole bronze row, so there is no separate source-column list to keep in sync as you adapt it.

Run it over a single date or a range; each session is screened independently and every row carries its `date`:

```
$ uv run uw_options_data_lake.py screen 2026-07-31
screen: illustrative bullish long-dated call filter (moment of detection)
hits: 6 qualifying contract(s)
contracts[6]{date,ticker,contract,expiry,dte,detected_utc,strike,spot,otm_pct,volume,oi,vol_oi,premium,avg_price,detected_price,ask_pct,multi_pct,floor_pct}:
  2026-07-31,ADBE,ADBE270617C00330000,2027-06-17,321,"2026-07-31 19:18:49Z",330.0,250.32,0.3183,542,350,1.55,1306167,24.1,24.25,0.9926,0.0018,0.0
  2026-07-31,CRWV,CRWV270319C00110000,2027-03-19,231,"2026-07-31 18:59:30Z",110.0,72.54,0.5164,898,570,1.58,1089503,12.13,12.15,0.9878,0.0,0.0
  ...
help[3]:
  Wrote the screen result to lake/screens/screen_2026-07-31.csv
  Run `uw_options_data_lake.py forward lake/screens/screen_2026-07-31.csv` to measure each contract's forward performance after detection (build silver over the horizon first)
  ...
```

The detection timestamp is UTC, matching bronze.
Each row also carries two anchor prices at that instant: `avg_price` (the volume-weighted fill up to detection) and `detected_price` (the moment-of-detection print's own traded price).
The full result is written to `lake/screens/screen_<window>.csv` (override with `--out`) at full precision, which is the natural handoff to the silver bars: the `forward` command reads that CSV and reports how each contract traded afterward (see "Forward performance" below).

## Forward performance

`forward` is the mirror of the screener: where the screener is a bronze consumer, `forward` is a silver consumer.
It reads a screen result CSV and, for each flagged contract, reports a few neutral key prices observed **strictly after** that contract's moment of detection.
By default it writes nothing (pass `--out PATH` to also save the full-precision result as a durable CSV for later reuse), and it is offline (silver only, no key) except for one case: pricing a contract that has already expired needs a single network read (see `theo_at_expiry` below).

For each contract it reports three forward prices from the silver bars:

- `min_after`: the lowest price the contract traded after detection (the minimum bar `low` over the forward window).
- `max_after`: the highest price after detection (the maximum bar `high`).
- `latest_after`: the latest observed price after detection (the `close` of the last forward bar).

A fourth price appears once a contract has **expired**: `theo_at_expiry`, its intrinsic value at expiry, `max(0, underlying - strike)` for a call and `max(0, strike - underlying)` for a put.
The underlying's regular-hours close on the expiry date comes from the Unusual Whales daily OHLC endpoint, so this is the one place `forward` reads the network and the one place it needs an API key (resolved the same way as `build`, see "Providing your API key").
It is computed only for contracts whose expiry has already passed (the `expired` column flags them) and is null otherwise, and the underlying close is fetched once per unique ticker and expiry.
Because the shipped screen targets long-dated contracts, none of them have expired yet, so in practice `forward` stays fully offline until enough time passes.

Two anchor prices from the screen ride along so the forward prices are interpretable: `detected_price` (the moment-of-detection print's own traded price) and `avg_price` (the volume-weighted fill up to detection).

These are deliberately **neutral, direction-agnostic prices**.
`forward` does not label them adverse or favorable and computes no return or profit-and-loss, because whether a move is good or bad, and the sign of any return, depends on whether the user is buying or selling the option, which the skill cannot know.
Once you state buy-or-sell intent, applying max-adverse / max-favorable excursion or a return is straightforward downstream; `forward` intentionally stops at the raw prices.
All prices are per-share option premium and directly comparable: `detected_price`, `avg_price`, the silver `open`/`high`/`low`/`close`, and the `theo_at_expiry` intrinsic are the same dollars, with no contract-multiplier confusion.

The forward window is every bar with `minute_utc` strictly greater than the detection minute.
Cutting strictly after the detection minute drops the unrecoverable remainder of that one minute (bars are 1-minute) but guarantees no pre-detection print can leak into the forward prices, and a single comparison covers both the rest of the detection day and every later day.

Forward prices are limited by the silver layer or the contract expiration, whichever comes first.
Every row reports `last_fwd_utc`, the last forward bar minute, and `fwd_bars`, the count of forward bars found.
Without these values, `latest_after` could be mistaken for contract value at expiry when it is really just where your silver layer data stops.
Forward prices will be returned as null when the silver layer is thin or missing data.
If that happens, the command will tell you to build more bars in the silver layer.

The workflow is screen once, then run `forward` and re-run it as your silver grows:

```
$ uv run uw_options_data_lake.py screen 2026-07-27
... writes lake/screens/screen_2026-07-27.csv ...

$ uv run uw_options_data_lake.py silver-build 2026-07-27 2026-07-31 --confirm
... builds the 1-minute bars over the horizon ...

$ uv run uw_options_data_lake.py forward lake/screens/screen_2026-07-27.csv
bin: ~/uw-lake/uw_options_data_lake.py
forward: contract price performance after its detection
lake: /home/you/uw-lake/lake
screen_csv: /home/you/uw-lake/lake/screens/screen_2026-07-27.csv
contract_count: 33
silver_last_available_date: 2026-07-31
with_forward_bars: 33 of 33 have >=1 forward bar
expired: 0 expired; 0 priced at expiry (intrinsic)
forward[33]{ticker,contract,strike,expiry,dte,detected_utc,detected_price,avg_price,min_after,max_after,latest_after,last_fwd_utc,fwd_bars,theo_at_expiry,expired}:
  GOOGL,GOOGL271217C00390000,390.0,2027-12-17,508,"2026-07-27 15:03:45Z",42.0,42.0,39.0,54.68,54.68,"2026-07-31 16:54:00Z",32,"",False
  ADBE,ADBE270617C00330000,330.0,2027-06-17,321,"2026-07-31 19:18:49Z",24.25,24.1,24.05,24.25,24.1,"2026-07-31 19:41:00Z",2,"",False
  ...
```

Here every contract is long-dated, so `expired` is `False` and `theo_at_expiry` is empty; the command makes no network call.
Once a contract's expiry has passed, its row shows `expired` `True` and `theo_at_expiry` set to the intrinsic value from the underlying's close at expiry.

That loop works because detection is a frozen historical fact: the CSV never needs regenerating, only more silver behind it.
And because `forward` only needs the detection identity and its anchor prices, it works on any CSV that carries those columns, not just this screener's output, so a hand-curated watchlist works too.

## Installing `uv` (one-time)

The script uses [`uv`](https://docs.astral.sh/uv/) to run with its dependencies (polars, httpx, tzdata) declared inline, so there is nothing to `pip install`.

- Windows (PowerShell): `irm https://astral.sh/uv/install.ps1 | iex`
- macOS / Linux: `curl -LsSf https://astral.sh/uv/install.sh | sh`

## Providing your API key

The script reads the key, most secure first.
It accepts either `UW_API_KEY` or `UW_API_TOKEN` (UW's docs use "key" and "token" interchangeably); if both are set, `UW_API_KEY` wins.

1. `UW_API_KEY` (or `UW_API_TOKEN`) in your environment.
2. A `UW_API_KEY=your-key` (or `UW_API_TOKEN=your-key`) line in a `.env` file in the working directory (add `.env` to `.gitignore` and never commit it).
3. `--api-key` on the command line (plaintext, last resort).

Find your key at https://unusualwhales.com/settings.
If a key has ever been pasted into a chat or committed, rotate it.

## How to run it

Write the script below to `uw_options_data_lake.py`, then:

1. **Always run the selftest first.** `uv run uw_options_data_lake.py --selftest` makes zero API calls and proves the file transcribed correctly. It runs **211 checks** covering the trading-day calendar, the historic-window 403 boundary parse, the response sniff, the no-new-nulls timestamp gate, the download progress throttle, the bronze and silver path layout, the silver bar builder and its validation gate, the incremental silver build with its disk estimate, the screener gate and its moment-of-detection logic, the durable screen-result CSV round trip, the forward-performance key prices over silver, the OHLC parse plus intrinsic-at-expiry pricing, and the durable forward-result CSV write. Do not build until it reports all checks passing.
2. **See your window.** `uv run uw_options_data_lake.py probe` reports your earliest available date and lookback.
3. **Estimate, then build.** `uv run uw_options_data_lake.py build 2026-07-27 2026-07-31` prints the disk estimate and stops; re-run with `--confirm` to download and convert. Omit the end date to build a single day.
4. **Check the lake.** `uv run uw_options_data_lake.py` with no arguments shows live coverage: dates present, the window, and total Parquet size.

Other commands: `convert <zip>` lands a tape zip you already have (non-destructive, it leaves the zip and CSV in place); `download <date>` streams one day's zip without converting; `silver-build` and `silver-status` build and inspect the offline 1-minute bar layer (see "Silver: 1-minute per-contract bars"); `screen <start> [end]` runs the worked screener over the bronze tape and writes its result CSV (offline, see "Screener: example call screen"); `forward <screen.csv>` reads that CSV and reports each contract's neutral key prices after detection from the silver bars, and can save the full result with `--out PATH` (offline, except a single OHLC read to price any already-expired contract; see "Forward performance").

All structured output is on stdout as [TOON](https://toonformat.dev); download and conversion progress go to stderr.
Re-requesting a date already in the lake is a no-op with a success exit code, so a build is safe to re-run and resumes at the first missing date.

### Output channels and exit codes

- **stdout** carries only the structured result an agent consumes, including errors, each with an actionable `help:` line.
- **stderr** carries progress (the multi-GB download bar) and diagnostics.
- Exit codes: `0` success (including no-ops), `1` error, `2` usage error.

### If the script reports an error

The `error:` line states what happened and the `help:` line states the remedy.
The common cases: no API key (supply one as above), a date older than your window (the message states your earliest date), the daily request quota exhausted (it resets at **20:00 US/Eastern**), and a requested year past the built-in NYSE holiday table (which currently ends after **2028**; add the next year from the NYSE calendar page and re-run).

## The script

```python
#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "polars>=1.0.0",
#     "httpx>=0.27.0",
#     "tzdata>=2024.1",
# ]
# ///
"""uw_options_data_lake.py - build a local bronze data lake of Unusual Whales option trades.

Downloads the transaction-level options Full Tape day by day and lands each day as
a lossless bronze Parquet (all 40 columns, no sort, no drops, timestamps typed to
Datetime[us, UTC], ZSTD level 3). The download zip and extracted CSV are transient:
once a day's Parquet is written AND validated they are deleted, so the steady-state
footprint is Parquet only.

USAGE
    uv run uw_options_data_lake.py --selftest        # zero network, no key; run FIRST
    uv run uw_options_data_lake.py                    # live lake status (content-first)
    uv run uw_options_data_lake.py convert <zip>      # local zip -> validated bronze parquet
    uv run uw_options_data_lake.py probe              # your historical window (one request)
    uv run uw_options_data_lake.py download <date>    # stream one day's zip (no convert)
    uv run uw_options_data_lake.py build <start> [end] # download+convert+validate a range
    uv run uw_options_data_lake.py silver-status       # 1-min bar coverage vs bronze
    uv run uw_options_data_lake.py silver-build <start> [end]  # build 1-min bars from local bronze
    uv run uw_options_data_lake.py screen <start> [end] # screen bronze for an example setup
    uv run uw_options_data_lake.py forward <screen.csv> # key prices after each detection (silver)

    The API key comes from UW_API_KEY or UW_API_TOKEN (environment or a local
    .env file), or --api-key. build and silver-build print a disk estimate and
    stop unless you pass --confirm. The silver and screen commands are offline and
    need no key; forward is offline too unless a contract has already expired, in
    which case it fetches that contract's underlying close at expiry and needs a key.

WHY --selftest EXISTS
    This file is handed to an agent that writes it to disk then runs it. --selftest
    proves correct transcription and logic with zero API calls in about one second.
    Run --selftest first.

DISCLAIMER
    Educational and informational purposes only. Not investment advice. Options
    trading risks the loss of your entire investment.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
import time
import zipfile
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import polars as pl

# ============================================================================
# CONSTANTS
# ============================================================================

API_BASE = "https://api.unusualwhales.com/api"
FULL_TAPE_PATH = "/option-trades/full-tape"
UW_CLIENT_API_ID = "100003"  # UW usage attribution
USER_AGENT = "uw-options-data-lake/1.0 (+https://unusualwhales.com)"

HTTP_TIMEOUT = 60.0
STREAM_CHUNK = 1 << 20
DOWNLOAD_MAX_RETRIES = 3

PARQUET_COMPRESSION = "zstd"
PARQUET_COMPRESSION_LEVEL = 3
INFER_SCHEMA_ROWS = 200_000

TIMESTAMP_COLUMNS: tuple[str, ...] = ("executed_at", "created_at")
BRONZE_TIMESTAMP_DTYPE = pl.Datetime(time_unit="us", time_zone="UTC")

EXPECTED_COLUMNS: tuple[str, ...] = (
    "id", "underlying_symbol", "executed_at", "nbbo_bid", "nbbo_ask", "size",
    "price", "option_chain_id", "alert_score", "created_at", "report_flags",
    "tags", "expiry", "option_type", "open_interest", "strike", "premium",
    "aggregated_trade_id", "volume", "underlying_price", "ewma_nbbo_ask",
    "ewma_nbbo_bid", "implied_volatility", "delta", "theta", "gamma", "vega",
    "rho", "theo", "upstream_condition_detail", "market_center_locate",
    "canceled", "trade_id", "exchange", "ask_vol", "bid_vol", "no_side_vol",
    "mid_vol", "multi_vol", "stock_multi_vol",
)

# Deliberately worst-case per-day disk anchors for the pre-build estimate, sized ABOVE
# the heaviest day observed so the warning never under-reserves. Basis: 2026-06-05, a
# high-volume S&P selloff of 14,931,931 rows that produced a 2.05 GB zip -> 5.84 GB CSV
# -> 1.42 GB Parquet; a normal day (2026-07-31, 12.85M rows -> 1.72/5.05/1.14 GB) is
# ~30% smaller. Anchors carry ~25% margin over that heavy day for an even more extreme
# session. The Parquet figure is only the fallback for an empty lake; disk_estimate
# averages the lake's own files once any exist, so this worst-case rate governs only
# the very first build.
ZIP_BYTES_PER_DAY = 2_600_000_000
CSV_BYTES_PER_DAY = 7_500_000_000
PARQUET_BYTES_PER_DAY_ESTIMATE = 1_800_000_000

# Silver bars measured ~250 MB/day (2026-07-31), ~22% of that day's bronze parquet.
# This worst-case anchor scales the heaviest observed bronze day by that ratio and
# carries margin; silver_disk_estimate switches to the lake's measured silver average
# once any silver files exist. Silver has no large disk transient (it streams bronze
# in and writes bars out); its real transient cost is RAM, not disk.
SILVER_BYTES_PER_DAY_ESTIMATE = 350_000_000

DEFAULT_LAKE = Path("lake")
BRONZE_SUBDIR = "bronze"
BRONZE_DATASET = "full-tape"
WORK_SUBDIR = "_work"

SILVER_SUBDIR = "silver"
SILVER_BARS_DATASET = "option-contracts-1m"
SILVER_BARS_FILE = "bars.parquet"

SCREENS_SUBDIR = "screens"

SILVER_COLUMNS: tuple[str, ...] = (
    "option_chain_id", "underlying_symbol", "security_type", "option_type",
    "strike", "expiry", "minute_utc", "minute_et", "open", "high", "low",
    "close", "volume", "trade_count", "premium", "vwap", "ask_volume",
    "bid_volume", "mid_volume", "no_side_volume", "multi_volume", "bid_close",
    "ask_close", "underlying_open", "underlying_close", "iv_close", "delta_close",
    "gamma_close", "theta_close", "vega_close", "rho_close", "theo_close",
    "open_interest",
)

# The bronze columns used to create contract-level price bars in silver.
# `volume` is the running cumulative counter, kept as the sort tiebreaker.
# Price bars in silver are derived from sum(size).
SILVER_SOURCE_COLUMNS: tuple[str, ...] = (
    "option_chain_id", "underlying_symbol", "executed_at", "price", "size",
    "premium", "canceled", "volume", "nbbo_bid", "nbbo_ask", "underlying_price",
    "implied_volatility", "delta", "gamma", "theta", "vega", "rho", "theo",
    "open_interest", "option_type", "strike", "expiry", "tags",
    "ask_vol", "bid_vol", "mid_vol", "no_side_vol", "multi_vol",
)

SILVER_SIDE_COUNTERS: tuple[str, ...] = (
    "ask_vol", "bid_vol", "mid_vol", "no_side_vol", "multi_vol",
)
SILVER_SIDE_VOLUMES: tuple[str, ...] = (
    "ask_volume", "bid_volume", "mid_volume", "no_side_volume", "multi_volume",
)

SILVER_MINUTE_UTC_DTYPE = pl.Datetime(time_unit="us", time_zone="UTC")
SILVER_SECURITY_TYPES: tuple[str, ...] = ("equity", "etf", "index")
CANCELED_DOMAIN: tuple[str, ...] = ("t", "f")

# The `screen` output row per qualifying contract at its moment-of-detection print.
# `detected_price` is the price of the contract at its moment-of-detection print.
# `avg_price` is the volume-weighted average price of the contract at its
# moment-of-detection print.
SCREEN_COLUMNS: tuple[str, ...] = (
    "underlying_symbol", "option_chain_id", "security_type", "option_type",
    "strike", "expiry", "dte", "detected_at", "underlying_price", "otm_pct",
    "volume", "open_interest", "vol_oi_ratio", "cum_premium", "avg_price",
    "detected_price", "ask_pct", "multi_pct", "floor_pct",
)

# The subset of SCREEN_COLUMNS columns that `forward` requires from the `screen` output CSV.
FORWARD_INPUT_COLUMNS: tuple[str, ...] = (
    "underlying_symbol", "option_chain_id", "option_type", "strike", "expiry", "dte",
    "detected_at", "detected_price", "avg_price",
)

# The forward price columns `forward` derives from silver after the detection minute.
FORWARD_METRIC_COLUMNS: tuple[str, ...] = (
    "min_after", "max_after", "latest_after", "last_forward_minute", "forward_bars",
)

# The columns for settling contract prices at expiry.
FORWARD_EXPIRY_COLUMNS: tuple[str, ...] = ("theo_at_expiry", "expired")

FORWARD_COLUMNS: tuple[str, ...] = (
    FORWARD_INPUT_COLUMNS + FORWARD_METRIC_COLUMNS + FORWARD_EXPIRY_COLUMNS
)

_FORWARD_AGG_SCHEMA: dict[str, pl.DataType] = {
    "option_chain_id": pl.String(),
    "detection_minute": pl.Datetime(time_unit="us", time_zone="UTC"),
    "min_after": pl.Float64(),
    "max_after": pl.Float64(),
    "latest_after": pl.Float64(),
    "last_forward_minute": pl.Datetime(time_unit="us", time_zone="UTC"),
    "forward_bars": pl.Int64(),
}

EASTERN_TZ = "America/New_York"
EASTERN = ZoneInfo(EASTERN_TZ)
SILVER_MINUTE_ET_DTYPE = pl.Datetime(time_unit="us", time_zone=EASTERN_TZ)
QUOTA_RESET_HOUR_ET = 20

DEV_HISTORIC_EMAIL = "dev@unusualwhales.com"


class FatalError(Exception):
    """The operation cannot continue. `help` carries the remedy as a sibling of the
    message so main() can emit an `error:` / `help:` pair an agent can act on."""

    def __init__(self, message: str, help_text: str | None = None) -> None:
        super().__init__(message)
        self.help = help_text


class NoDataForDate(Exception):
    """The endpoint has no tape for this date (404/empty). Skip it, keep going."""


# ============================================================================
# AXI OUTPUT: TOON on stdout, progress on stderr, structured errors
# ============================================================================

def out(line: str = "") -> None:
    sys.stdout.write(line + "\n")


def progress(line: str = "") -> None:
    sys.stderr.write(line + "\n")


def _toon_scalar(value: object) -> str:
    """Render one TOON scalar, quoting only when a bare token would be ambiguous."""
    s = "" if value is None else str(value)
    if s == "" or s != s.strip() or any(c in s for c in ',:"\n[]{}'):
        return '"' + s.replace('"', '""') + '"'
    return s


def emit_obj(pairs: Sequence[tuple[str, object]]) -> None:
    for key, value in pairs:
        out(f"{key}: {_toon_scalar(value)}")


def emit_table(name: str, fields: Sequence[str], rows: Sequence[Sequence[object]]) -> None:
    out(f"{name}[{len(rows)}]{{{','.join(fields)}}}:")
    for row in rows:
        out("  " + ",".join(_toon_scalar(c) for c in row))


def emit_help(lines: Sequence[str]) -> None:
    out(f"help[{len(lines)}]:")
    for line in lines:
        out(f"  {line}")


def emit_error(err: FatalError) -> None:
    out(f"error: {err}")
    if err.help:
        out(f"help: {err.help}")


def human_bytes(n: float) -> str:
    """Decimal (base-1000) sizes, matching how laptop drive capacity is labeled, so
    the disk-space warning reads against the number on the user's drive."""
    size = float(n)
    if size < 1000:
        return f"{int(size)} B"
    for unit in ("KB", "MB", "GB", "TB"):
        size /= 1000.0
        if size < 1000 or unit == "TB":
            return f"{size:.2f} {unit}"
    return f"{size:.2f} TB"


class ProgressMeter:
    """Throttled multi-GB download progress on stderr, emits one
    newline checkpoint per quarter so logs stay small."""

    def __init__(self, label: str, total_bytes: int, *,
                 isatty: bool | None = None,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self.label = label
        self.total = total_bytes
        self.isatty = sys.stderr.isatty() if isatty is None else isatty
        self._clock = clock
        self._last_t = -1.0
        self._last_pct = -1
        self._quarters: set[int] = set()

    def _line(self, seen: int, pct: int) -> str:
        if self.total > 0:
            return (f"  downloading {self.label}: "
                    f"{human_bytes(seen)} / {human_bytes(self.total)} ({pct}%)")
        return f"  downloading {self.label}: {human_bytes(seen)}"

    def update(self, seen: int) -> None:
        if self.isatty:
            now = self._clock()
            if now - self._last_t < 0.25:
                return
            pct = int(seen * 100 / self.total) if self.total > 0 else -1
            if self.total > 0 and pct == self._last_pct:
                return
            self._last_t, self._last_pct = now, pct
            sys.stderr.write("\r" + self._line(seen, pct))
            sys.stderr.flush()
        elif self.total > 0:
            quarter = min(seen * 4 // self.total, 3)
            if quarter >= 1 and quarter not in self._quarters:
                self._quarters.add(quarter)
                progress(self._line(seen, quarter * 25))

    def done(self, seen: int) -> None:
        if self.isatty:
            sys.stderr.write("\r" + self._line(seen, 100) + "\n")
            sys.stderr.flush()
        else:
            progress(self._line(seen, 100))


def home_path(p: Path) -> str:
    try:
        return "~/" + str(p.resolve().relative_to(Path.home())).replace("\\", "/")
    except ValueError:
        return str(p)


# ============================================================================
# US MARKET CALENDAR
# ============================================================================
# The holiday set is a hand-maintained TABLE, not a computation, so it is checkable
# against the NYSE page in a couple of minutes and can carry ad-hoc closures. The
# downloader uses it to skip weekends/holidays and not waste requests/quota on days
# with no tape. Time-zone math is delegated to zoneinfo/tzdata, never hand-rolled.
#
# Source: https://www.nyse.com/markets/hours-calendars, transcribed 2026-07-15.
# Each row is MM-DD in date order. A Saturday New Year's drops the January entry
# (the NYSE does not close the preceding Friday); ad-hoc closures appear inline.
# Running past the last year is a loud failure by design: a guessed holiday is
# indistinguishable from a real one at the call site and would silently request a
# closed day. Add the next year from the NYSE page each year.
_MARKET_HOLIDAYS: dict[int, str] = {
    2025: "01-01 01-09 01-20 02-17 04-18 05-26 06-19 07-04 09-01 11-27 12-25",
    2026: "01-01 01-19 02-16 04-03 05-25 06-19 07-03 09-07 11-26 12-25",
    2027: "01-01 01-18 02-15 03-26 05-31 06-18 07-05 09-06 11-25 12-24",
    2028: "01-17 02-21 04-14 05-29 06-19 07-04 09-04 11-23 12-25",
}

MARKET_HOLIDAYS: dict[int, frozenset[date]] = {
    y: frozenset(date(y, int(md[:2]), int(md[3:])) for md in mds.split())
    for y, mds in _MARKET_HOLIDAYS.items()
}


def market_holidays(year: int) -> frozenset[date]:
    try:
        return MARKET_HOLIDAYS[year]
    except KeyError:
        lo, hi = min(MARKET_HOLIDAYS), max(MARKET_HOLIDAYS)
        raise FatalError(
            f"the NYSE holiday table does not cover {year}; it runs {lo}-{hi}. "
            "Refusing to guess, because a missing holiday silently requests a closed "
            "day that returns no tape.",
            f"add {year} to _MARKET_HOLIDAYS from "
            "https://www.nyse.com/markets/hours-calendars, then re-run.",
        )


def is_trading_day(d: date) -> bool:
    return d.weekday() < 5 and d not in market_holidays(d.year)


def previous_trading_day(d: date) -> date:
    for _ in range(15):
        if is_trading_day(d):
            return d
        d -= timedelta(days=1)
    raise ValueError(f"no trading day found on or before {d}")


def next_trading_day(d: date) -> date:
    for _ in range(15):
        d += timedelta(days=1)
        if is_trading_day(d):
            return d
    raise ValueError(f"no trading day found after {d}")


def trading_days(start: date, end: date) -> list[date]:
    """Every NYSE trading day in [start, end] inclusive, ascending."""
    if end < start:
        return []
    days: list[date] = []
    d = start
    while d <= end:
        if is_trading_day(d):
            days.append(d)
        d += timedelta(days=1)
    return days


def eastern_now() -> datetime:
    return datetime.now(EASTERN)


def most_recent_available_date(now_et: datetime | None = None) -> date:
    """The latest trading day whose full tape should be available.

    A day's tape is only complete after its session; today's becomes available
    after the ~20:00 ET daily boundary, so before then the answer is the prior
    trading day.
    """
    now_et = now_et or eastern_now()
    d = now_et.date()
    if not (is_trading_day(d) and now_et.hour >= QUOTA_RESET_HOUR_ET):
        d = d - timedelta(days=1)
    return previous_trading_day(d)


# ============================================================================
# LAKE LAYOUT
# ============================================================================

def bronze_dir(lake: Path) -> Path:
    return lake / BRONZE_SUBDIR / BRONZE_DATASET


def work_dir(lake: Path) -> Path:
    return lake / WORK_SUBDIR


def bronze_path(lake: Path, d: date) -> Path:
    return bronze_dir(lake) / f"{d.isoformat()}.parquet"


def _parse_lake_date(name: str) -> date | None:
    m = re.fullmatch(r"(\d{4}-\d{2}-\d{2})\.parquet", name)
    if not m:
        return None
    try:
        return date.fromisoformat(m.group(1))
    except ValueError:
        return None


def present_dates(lake: Path) -> dict[date, int]:
    """{date: parquet_size_bytes} for every bronze date already in the lake."""
    bd = bronze_dir(lake)
    if not bd.is_dir():
        return {}
    found: dict[date, int] = {}
    for p in bd.glob("*.parquet"):
        d = _parse_lake_date(p.name)
        if d is not None:
            found[d] = p.stat().st_size
    return found


def parquet_row_count(path: Path) -> int:
    return int(pl.scan_parquet(path).select(pl.len()).collect().item())


def silver_dir(lake: Path) -> Path:
    return lake / SILVER_SUBDIR


def silver_bars_dir(lake: Path) -> Path:
    return silver_dir(lake) / SILVER_BARS_DATASET


def silver_partition_dir(lake: Path, d: date) -> Path:
    return silver_bars_dir(lake) / f"date={d.isoformat()}"


def silver_partition_path(lake: Path, d: date) -> Path:
    return silver_partition_dir(lake, d) / SILVER_BARS_FILE


def _parse_silver_partition_date(name: str) -> date | None:
    m = re.fullmatch(r"date=(\d{4}-\d{2}-\d{2})", name)
    if not m:
        return None
    try:
        return date.fromisoformat(m.group(1))
    except ValueError:
        return None


def present_silver_dates(lake: Path) -> dict[date, int]:
    """{date: bars_parquet_size_bytes} for every silver partition that holds a bars file.

    A partition counts as present only once its bars.parquet exists, so a bare
    date= directory left behind by an interrupted build is never reported present.
    """
    bd = silver_bars_dir(lake)
    if not bd.is_dir():
        return {}
    found: dict[date, int] = {}
    for p in bd.glob("date=*"):
        if not p.is_dir():
            continue
        d = _parse_silver_partition_date(p.name)
        if d is None:
            continue
        bars = p / SILVER_BARS_FILE
        if bars.is_file():
            found[d] = bars.stat().st_size
    return found


def silver_coverage(bronze: Iterable[date], silver: Iterable[date]) -> tuple[list[date], list[date]]:
    """(bronze dates that still need a silver build, silver dates with no bronze source),
    both sorted ascending. Silver builds only from local bronze, so an orphan silver date
    means its bronze parquet was removed after the bars were built."""
    bset, sset = set(bronze), set(silver)
    missing = sorted(bset - sset)
    orphan = sorted(sset - bset)
    return missing, orphan


def screens_dir(lake: Path) -> Path:
    return lake / SCREENS_SUBDIR


def screen_result_path(lake: Path, start: date, end: date | None) -> Path:
    """Where `screen` persists its result by default. A single-date screen is
    named for that date; a range carries both endpoints."""
    if end is None or end == start:
        name = f"screen_{start.isoformat()}.csv"
    else:
        name = f"screen_{start.isoformat()}_{end.isoformat()}.csv"
    return screens_dir(lake) / name


def write_screen_csv(frame: pl.DataFrame, path: Path) -> None:
    """Persist a raw screen result losslessly so `forward` can read it back.
    detected_at is written ISO-UTC to microseconds and expiry as an ISO date;
    read_screen_csv is the exact inverse."""
    path.parent.mkdir(parents=True, exist_ok=True)
    frame.with_columns(
        pl.col("detected_at").dt.strftime("%Y-%m-%dT%H:%M:%S%.6f+00:00"),
        pl.col("expiry").cast(pl.String),
    ).write_csv(path)


def read_screen_csv(path: Path) -> pl.DataFrame:
    """Inverse of write_screen_csv: detected_at back to Datetime[us, UTC] and
    expiry back to Date. The remaining columns round-trip through polars' CSV types."""
    return pl.read_csv(path).with_columns(
        pl.col("detected_at").str.to_datetime(time_unit="us", time_zone="UTC"),
        pl.col("expiry").str.to_date(),
    )


def write_forward_csv(frame: pl.DataFrame, path: Path) -> None:
    """Persist a full-precision forward result CSV for human or AI reuse. Both
    UTC timestamp columns (detected_at, last_forward_minute) are written ISO-UTC to
    microseconds and expiry as an ISO date; a null last_forward_minute stays blank.
    All other columns keep polars' CSV formatting."""
    path.parent.mkdir(parents=True, exist_ok=True)
    frame.with_columns(
        pl.col("detected_at").dt.strftime("%Y-%m-%dT%H:%M:%S%.6f+00:00"),
        pl.col("last_forward_minute").dt.strftime("%Y-%m-%dT%H:%M:%S%.6f+00:00"),
        pl.col("expiry").cast(pl.String),
    ).write_csv(path)


# ============================================================================
# DISK ESTIMATE
# ============================================================================

@dataclass
class DiskEstimate:
    to_fetch: int
    per_day_parquet: int
    steady_state_total: int
    peak_transient: int
    parquet_anchor: str


def disk_estimate(lake: Path, to_fetch: int) -> DiskEstimate:
    """Steady-state Parquet total and per-day peak transient disk for `to_fetch` days.

    The per-day Parquet size is measured from the lake's own files once any exist;
    before that it falls back to the empirical estimate anchor.
    """
    present = present_dates(lake)
    if present:
        per_day = round(sum(present.values()) / len(present))
        anchor = f"measured from {len(present)} lake file(s)"
    else:
        per_day = PARQUET_BYTES_PER_DAY_ESTIMATE
        anchor = "estimated (no lake files yet)"
    peak = ZIP_BYTES_PER_DAY + CSV_BYTES_PER_DAY + per_day
    return DiskEstimate(
        to_fetch=to_fetch,
        per_day_parquet=per_day,
        steady_state_total=per_day * to_fetch,
        peak_transient=peak,
        parquet_anchor=anchor,
    )


@dataclass
class SilverDiskEstimate:
    to_build: int
    per_day_bars: int
    steady_state_total: int
    bars_anchor: str


def silver_disk_estimate(lake: Path, to_build: int) -> SilverDiskEstimate:
    """Steady-state silver bars total for `to_build` days. There is no peak transient to
    report (unlike bronze): a build streams bronze in and writes bars out, so disk grows
    only by the committed partition. Per-day size is measured from the lake's own silver
    files once any exist; before that it falls back to the empirical anchor."""
    present = present_silver_dates(lake)
    if present:
        per_day = round(sum(present.values()) / len(present))
        anchor = f"measured from {len(present)} silver file(s)"
    else:
        per_day = SILVER_BYTES_PER_DAY_ESTIMATE
        anchor = "estimated (no silver files yet)"
    return SilverDiskEstimate(
        to_build=to_build,
        per_day_bars=per_day,
        steady_state_total=per_day * to_build,
        bars_anchor=anchor,
    )


# ============================================================================
# HTTP: historic-window boundary, response sniff, streaming download
# ============================================================================

def build_headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        # The tape zip is served under an octet-stream-ish content-type; a narrow
        # Accept (e.g. application/zip) draws a 406, so accept anything and sniff.
        "Accept": "*/*",
        "User-Agent": USER_AGENT,
        "UW-CLIENT-API-ID": UW_CLIENT_API_ID,
    }


ZIP_MAGIC = b"PK\x03\x04"


def looks_like_zip(head: bytes) -> bool:
    return head[:4] == ZIP_MAGIC


def parse_boundary(message: str) -> tuple[date | None, int | None]:
    """Pull the caller's earliest available date and trading-day lookback out of a
    `historic_data_access_missing` message. Either may be None if the wording moved."""
    earliest: date | None = None
    m = re.search(r"(\d{4}-\d{2}-\d{2})", message)
    if m:
        try:
            earliest = date.fromisoformat(m.group(1))
        except ValueError:
            earliest = None
    lookback: int | None = None
    m = re.search(r"(\d+)\s+trading\s+days", message)
    if m:
        lookback = int(m.group(1))
    return earliest, lookback


def classify_403(body: str, headers: dict[str, str]) -> str:
    """Which of four mutually-exclusive 403s this is. The historic-window boundary
    is checked FIRST: it is a legitimate entitlement response, not a failure, and
    only a real UW body carries its `code`."""
    low = body.lower()
    if "historic_data_access_missing" in low:
        return "historic_boundary"
    deny = headers.get("x-deny-reason", "")
    if deny == "host_not_allowed" or any(
            s in low for s in ("not in allowlist", "egress", "host_not_allowed")):
        return "egress"
    if any(s in low for s in ("cloudflare", "1010", "access denied", "bot", "browser integrity")):
        return "cloudflare"
    return "auth"


def _raise_403(body: str, headers: dict[str, str], d: date) -> None:
    kind = classify_403(body, headers)
    if kind == "historic_boundary":
        earliest, lookback = parse_boundary(body)
        window = (f"your earliest available date is {earliest.isoformat()}"
                  if earliest else "the response did not state an earliest date")
        span = f" ({lookback} trading days)" if lookback else ""
        raise FatalError(
            f"{d.isoformat()} is older than your historical window: {window}{span}.",
            f"request {earliest.isoformat() if earliest else 'a more recent date'} "
            f"or later, or email {DEV_HISTORIC_EMAIL} to request full historic access.",
        )
    if kind == "egress":
        raise FatalError(
            "403 from this environment's egress proxy, NOT from UW: the request was "
            "blocked before it left the box, so your key and subscription are not the "
            f"problem. body: {body[:200]}",
            "allow api.unusualwhales.com in your egress/network settings, or run this "
            "on your own machine where the API is reachable.",
        )
    if kind == "cloudflare":
        raise FatalError(
            "403 from Cloudflare, NOT an auth error: the request was blocked upstream "
            f"before it reached UW's auth layer. body: {body[:200]}",
            "a VPN, proxy, or datacenter IP can trip Cloudflare; try a different network.",
        )
    raise FatalError(
        f"403 from UW: the key is valid but this request was refused. body: {body[:200]}",
        "your key may have expired or your plan may not cover this endpoint; check "
        "https://unusualwhales.com/settings.",
    )


def _raise_for_status(status: int, body: str, headers: dict[str, str], d: date) -> None:
    if status == 401:
        raise FatalError(
            "401 from UW: bad or missing API key.",
            "set a working key in UW_API_KEY or a local .env, or pass --api-key. "
            "Get one at https://unusualwhales.com/pricing?product=api.",
        )
    if status == 403:
        _raise_403(body, headers, d)
    if status == 404:
        raise NoDataForDate(f"no tape for {d.isoformat()} (404)")
    if status == 429:
        daily = headers.get("x-uw-daily-req-count")
        cap = headers.get("x-uw-token-req-limit")
        try:
            exhausted = daily is not None and cap is not None and int(daily) >= int(cap)
        except ValueError:
            exhausted = False
        if exhausted:
            raise FatalError(
                f"daily UW request quota exhausted ({daily} of {cap}). It resets at "
                "20:00 US/Eastern and does not recover in-session.",
                "wait for the 20:00 US/Eastern reset or upgrade your tier at "
                "https://unusualwhales.com/pricing?product=api.",
            )
        raise FatalError(
            "429 from UW: per-minute rate limit, retries exhausted.",
            "wait a minute and re-run; build resumes at the first missing date.",
        )
    raise FatalError(
        f"{d.isoformat()} returned unexpected HTTP {status}. body: {body[:200]}",
        "re-run; if it persists, verify the endpoint at "
        "https://api.unusualwhales.com/docs#/.",
    )


class Client:
    """Plain httpx client for the Full Tape endpoint. httpx is a hard dependency, so
    there is no multi-backend fallback."""

    def __init__(self, api_key: str) -> None:
        self.headers = build_headers(api_key)

    def _full_tape_url(self, d: date) -> str:
        return f"{API_BASE}{FULL_TAPE_PATH}/{d.isoformat()}"

    def download(self, d: date, dest: Path, *, show_progress: bool = True) -> Path:
        """Stream one date's tape zip to `dest`, sniffing JSON-vs-zip before committing
        a `.zip`. Raises FatalError / NoDataForDate on any non-tape response."""
        url = self._full_tape_url(d)
        with httpx.stream("GET", url, headers=self.headers, timeout=HTTP_TIMEOUT,
                          follow_redirects=True) as r:
            if r.status_code != 200:
                body = r.read().decode("utf-8", "replace")
                low = {k.lower(): v for k, v in r.headers.items()}
                _raise_for_status(r.status_code, body, low, d)
            ctype = r.headers.get("content-type", "").lower()
            chunks = r.iter_bytes(chunk_size=STREAM_CHUNK)
            first = next(chunks, b"")
            if "json" in ctype or not looks_like_zip(first):
                body = (first + b"".join(chunks)).decode("utf-8", "replace")
                low = {k.lower(): v for k, v in r.headers.items()}
                # A 200 that is not a zip is the boundary/error body arriving with an
                # OK status; route it through the same 403 classifier.
                _raise_403(body, low, d)
            dest.parent.mkdir(parents=True, exist_ok=True)
            total_bytes = int(r.headers.get("content-length", "0") or "0")
            meter = ProgressMeter(d.isoformat(), total_bytes) if show_progress else None
            seen = 0
            with open(dest, "wb") as f:
                f.write(first)
                seen += len(first)
                for chunk in chunks:
                    f.write(chunk)
                    seen += len(chunk)
                    if meter is not None:
                        meter.update(seen)
            if meter is not None:
                meter.done(seen)
        return dest

    def probe_boundary(self) -> tuple[date | None, int | None]:
        """Discover the caller's earliest available date by requesting an obviously
        out-of-range date once. Returns (earliest, lookback_trading_days); (None, None)
        means the caller appears to have unlimited history."""
        probe_date = date(2022, 1, 3)
        url = self._full_tape_url(probe_date)
        with httpx.stream("GET", url, headers=self.headers, timeout=HTTP_TIMEOUT,
                          follow_redirects=True) as r:
            body = r.read().decode("utf-8", "replace")
            low = {k.lower(): v for k, v in r.headers.items()}
            if r.status_code == 200 and looks_like_zip(body.encode("utf-8", "replace")[:4]):
                return None, None
            if r.status_code in (200, 403) and "historic_data_access_missing" in body.lower():
                return parse_boundary(body)
            if r.status_code != 200:
                _raise_for_status(r.status_code, body, low, probe_date)
        return None, None

    def _ohlc_url(self, ticker: str, d: date) -> str:
        return f"{API_BASE}/stock/{ticker}/ohlc/1d?date={d.isoformat()}&limit=1"

    def fetch_ohlc_close(self, ticker: str, d: date) -> float | None:
        """The regular-hours close for `ticker` on `d` from the UW 1-day OHLC endpoint,
        or None when the API has no regular-hours bar for that date (e.g. a holiday).
        Raises FatalError on a genuine auth / quota / unexpected failure."""
        headers = {**self.headers, "Accept": "application/json"}
        r = httpx.get(self._ohlc_url(ticker, d), headers=headers, timeout=HTTP_TIMEOUT,
                      follow_redirects=True)
        if r.status_code == 200:
            return parse_ohlc_close(r.text, d)
        low = {k.lower(): v for k, v in r.headers.items()}
        try:
            _raise_for_status(r.status_code, r.text, low, d)
        except NoDataForDate:
            return None
        return None


# ============================================================================
# CONVERTER: local zip -> validated bronze Parquet
# ============================================================================

@dataclass
class SourceMetrics:
    rows: int
    empty_tokens: dict[str, int]


@dataclass
class BronzeMetrics:
    rows: int
    columns: tuple[str, ...]
    null_counts: dict[str, int]
    dtypes: dict[str, pl.DataType]


@dataclass
class ConvertResult:
    date: date | None
    parquet_path: Path
    csv_path: Path
    rows: int
    parquet_bytes: int


def open_tape_zip(zip_path: Path) -> zipfile.ZipFile:
    try:
        return zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile:
        head = zip_path.read_bytes()[:2000].decode("utf-8", "replace")
        if "historic_data_access_missing" in head:
            earliest, lookback = parse_boundary(head)
            span = f" ({lookback} trading days)" if lookback else ""
            window = (f"earliest available: {earliest.isoformat()}"
                      if earliest else "no earliest date stated")
            raise FatalError(
                f"{zip_path.name} is not a tape zip; it is a historic-data-access error "
                f"body ({window}{span}).",
                f"delete this file and request an in-window date, or email "
                f"{DEV_HISTORIC_EMAIL} for full historic access.",
            )
        raise FatalError(
            f"{zip_path.name} is not a valid zip file.",
            "re-download the date; a truncated or error response was saved by mistake.",
        )


def extract_csv(zip_path: Path, dest_dir: Path) -> Path:
    """Stream the single CSV entry out of a tape zip to `dest_dir`. Never materializes
    the entry in memory."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    with open_tape_zip(zip_path) as zf:
        names = zf.namelist()
        if len(names) != 1:
            raise FatalError(
                f"{zip_path.name} contains {len(names)} entries; expected exactly 1 CSV.",
                "re-download the date; the archive is not in the expected shape.",
            )
        entry = names[0]
        dest = dest_dir / Path(entry).name
        with zf.open(entry) as src, open(dest, "wb") as dst:
            while True:
                chunk = src.read(STREAM_CHUNK)
                if not chunk:
                    break
                dst.write(chunk)
    return dest


def _collect_streaming(lf: pl.LazyFrame) -> pl.DataFrame:
    for kwargs in ({"engine": "streaming"}, {"streaming": True}, {}):
        try:
            return lf.collect(**kwargs)  # type: ignore[arg-type]
        except TypeError:
            continue
    return lf.collect()


def _empty_or_null(col: str) -> pl.Expr:
    return (pl.col(col).is_null() | (pl.col(col).cast(pl.String).str.strip_chars() == "")).sum()


def source_metrics(csv_path: Path) -> SourceMetrics:
    lf = pl.scan_csv(csv_path, infer_schema_length=INFER_SCHEMA_ROWS)
    agg = lf.select(
        [pl.len().alias("__rows__")]
        + [_empty_or_null(c).alias(c) for c in TIMESTAMP_COLUMNS]
    )
    row = _collect_streaming(agg).row(0, named=True)
    return SourceMetrics(
        rows=int(row["__rows__"]),
        empty_tokens={c: int(row[c]) for c in TIMESTAMP_COLUMNS},
    )


def write_bronze_parquet(csv_path: Path, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    lf = pl.scan_csv(csv_path, infer_schema_length=INFER_SCHEMA_ROWS)
    lf = lf.with_columns(
        pl.col(c).str.to_datetime(time_unit="us", time_zone="UTC", strict=False)
        for c in TIMESTAMP_COLUMNS
    )
    try:
        lf.sink_parquet(
            out_path,
            compression=PARQUET_COMPRESSION,
            compression_level=PARQUET_COMPRESSION_LEVEL,
        )
    except pl.exceptions.PolarsError as e:
        raise FatalError(
            f"polars could not convert {csv_path.name} to Parquet: {e}",
            "the CSV schema may have shifted; re-download the date and re-run.",
        )


def bronze_metrics(parquet_path: Path) -> BronzeMetrics:
    lf = pl.scan_parquet(parquet_path)
    schema = lf.collect_schema()
    agg = lf.select(
        [pl.len().alias("__rows__")]
        + [pl.col(c).null_count().alias(c) for c in TIMESTAMP_COLUMNS]
    )
    row = _collect_streaming(agg).row(0, named=True)
    return BronzeMetrics(
        rows=int(row["__rows__"]),
        columns=tuple(schema.names()),
        null_counts={c: int(row[c]) for c in TIMESTAMP_COLUMNS},
        dtypes={c: schema[c] for c in TIMESTAMP_COLUMNS},
    )


def validate_bronze(src: SourceMetrics, bronze: BronzeMetrics) -> list[str]:
    """Every reason the conversion is not a faithful bronze landing. Empty means the
    Parquet may be kept and (in build) the transient zip/CSV deleted."""
    problems: list[str] = []
    if bronze.columns != EXPECTED_COLUMNS:
        problems.append(
            f"columns differ from the 40-column tape schema "
            f"(got {len(bronze.columns)} columns)"
        )
    if bronze.rows != src.rows:
        problems.append(f"row count {bronze.rows} != source {src.rows}")
    for c in TIMESTAMP_COLUMNS:
        if bronze.dtypes.get(c) != BRONZE_TIMESTAMP_DTYPE:
            problems.append(f"{c} is {bronze.dtypes.get(c)}, expected {BRONZE_TIMESTAMP_DTYPE}")
        new_nulls = bronze.null_counts[c] - src.empty_tokens[c]
        if new_nulls > 0:
            problems.append(
                f"{c} gained {new_nulls} null(s) beyond the {src.empty_tokens[c]} empty "
                "source token(s): a non-empty timestamp failed to parse"
            )
    return problems


def convert_zip(zip_path: Path, lake: Path, d: date | None = None) -> ConvertResult:
    """Local zip -> validated bronze Parquet. Non-destructive: leaves the zip and the
    extracted CSV in place. Raises FatalError if the validation gate fails."""
    if d is None:
        d = _parse_lake_date(zip_path.stem + ".parquet") or _date_from_tape_name(zip_path.name)
    out_path = bronze_path(lake, d) if d else lake / (zip_path.stem + ".parquet")

    progress(f"extracting {zip_path.name} ...")
    csv_path = extract_csv(zip_path, work_dir(lake))
    progress(f"scanning source rows in {csv_path.name} ...")
    src = source_metrics(csv_path)
    progress(f"writing bronze parquet ({src.rows:,} rows) ...")
    write_bronze_parquet(csv_path, out_path)
    bronze = bronze_metrics(out_path)
    problems = validate_bronze(src, bronze)
    if problems:
        out_path.unlink(missing_ok=True)
        raise FatalError(
            "bronze validation failed for " + (d.isoformat() if d else zip_path.name)
            + ": " + "; ".join(problems),
            "the Parquet was removed; the zip and CSV are untouched. Investigate the "
            "source before retrying.",
        )
    return ConvertResult(
        date=d,
        parquet_path=out_path,
        csv_path=csv_path,
        rows=bronze.rows,
        parquet_bytes=out_path.stat().st_size,
    )


def _date_from_tape_name(name: str) -> date | None:
    m = re.search(r"(\d{4})[-_]?(\d{2})[-_]?(\d{2})", name)
    if not m:
        return None
    try:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


# ============================================================================
# PIPELINE: download -> convert -> validate -> gated delete
# ============================================================================

def build_one(client: Client, d: date, lake: Path) -> ConvertResult | None:
    """Full per-date pipeline. Returns None if the date is already present (idempotent
    no-op) or has no tape. Deletes the zip AND CSV only after validation passes."""
    dest = bronze_path(lake, d)
    if dest.exists():
        return None
    zip_path = work_dir(lake) / f"full_tape_{d.strftime('%Y%m%d')}.zip"
    try:
        client.download(d, zip_path)
    except NoDataForDate:
        progress(f"  {d.isoformat()}: no tape (skipped)")
        return None
    result = convert_zip(zip_path, lake, d=d)
    zip_path.unlink(missing_ok=True)
    result.csv_path.unlink(missing_ok=True)
    return result


# ============================================================================
# COMMANDS
# ============================================================================

def _resolve_window(lake: Path, start: date | None, end: date | None,
                    earliest: date | None) -> tuple[date, date]:
    latest = most_recent_available_date()
    lo = start or earliest or latest
    if earliest and lo < earliest:
        lo = earliest
    hi = min(end or latest, latest)
    return lo, hi


def cmd_status(lake: Path, start: date | None, end: date | None) -> int:
    present = present_dates(lake)
    silver = present_silver_dates(lake)
    latest = most_recent_available_date()
    lo = start or (min(present) if present else latest)
    hi = end or latest
    window = trading_days(lo, hi)
    in_window = [d for d in window if d in present]
    silver_in_window = [d for d in in_window if d in silver]
    total_bytes = sum(present.values())
    silver_bytes = sum(silver.values())

    emit_obj([
        ("bin", home_path(Path(__file__))),
        ("description", "Build a local bronze data lake of Unusual Whales option trades"),
        ("lake", str(lake)),
        ("window", f"{lo.isoformat()} to {hi.isoformat()} ({len(window)} trading days)"),
        ("present", f"{len(in_window)} of {len(window)} trading days in window"),
        ("lake_total", f"{len(present)} dates, {human_bytes(total_bytes)} bronze parquet"),
        ("silver", (f"{len(silver_in_window)} of {len(in_window)} bronze dates in window have "
                    f"1-min bars ({len(silver)} dates, {human_bytes(silver_bytes)})")),
    ])

    if not present:
        out("dates: 0 dates present")
    else:
        recent = sorted(present, reverse=True)[:30]
        rows = [(d.isoformat(), present[d], human_bytes(present[d])) for d in recent]
        emit_table("dates", ("date", "bytes", "size"), rows)
        if len(present) > len(recent):
            progress(f"(showing {len(recent)} most recent of {len(present)} dates)")

    missing = [d for d in window if d not in present]
    silver_todo = [d for d in in_window if d not in silver]
    hints = []
    if missing:
        hints.append(f"Run `{_prog()} build {missing[0].isoformat()} "
                     f"{missing[-1].isoformat()} --confirm` to fill the window")
    if silver_todo:
        hints.append(f"Run `{_prog()} silver-build {silver_todo[0].isoformat()} "
                     f"{silver_todo[-1].isoformat()} --confirm` to build 1-min bars from bronze")
    hints.append(f"Run `{_prog()} probe` to learn your historical window")
    hints.append(f"Run `{_prog()} convert <path-to-zip>` to land a local zip")
    emit_help(hints)
    return 0


def cmd_convert(zip_path: Path, lake: Path) -> int:
    if not zip_path.exists():
        raise FatalError(f"no such file: {zip_path}",
                         f"pass a path to a downloaded tape zip, e.g. `{_prog()} convert "
                         "full_tape_20260731.zip`.")
    result = convert_zip(zip_path, lake)
    emit_obj([
        ("converted", result.date.isoformat() if result.date else zip_path.name),
        ("parquet", str(result.parquet_path)),
        ("rows", result.rows),
        ("size", human_bytes(result.parquet_bytes)),
        ("validated", "row count, 40 columns, timestamps typed, no new nulls"),
    ])
    emit_help([
        (f"The zip and extracted CSV were left in place ({work_dir(lake)}); `build` "
         "deletes them after validation."),
        f"Run `{_prog()}` to see updated lake status.",
    ])
    return 0


def cmd_probe(client: Client) -> int:
    earliest, lookback = client.probe_boundary()
    if earliest is None:
        emit_obj([("history", "no lower bound detected (full historic access)")])
        return 0
    latest = most_recent_available_date()
    # The API's lookback is authoritative and is computed against its own reference
    # day, so prefer it over a local inclusive enumeration (which can differ by one).
    window_days = lookback if lookback is not None else len(trading_days(earliest, latest))
    emit_obj([
        ("earliest", earliest.isoformat()),
        ("latest_available", latest.isoformat()),
        ("lookback", f"{lookback} trading days" if lookback else "unknown"),
        ("window", f"{earliest.isoformat()} to {latest.isoformat()} ({window_days} trading days)"),
    ])
    emit_help([
        (f"Run `{_prog()} build {earliest.isoformat()} {latest.isoformat()} --confirm` "
         "to build the whole window"),
        f"Email {DEV_HISTORIC_EMAIL} to request access older than {earliest.isoformat()}",
    ])
    return 0


def cmd_download(client: Client, d: date, lake: Path) -> int:
    dest = work_dir(lake) / f"full_tape_{d.strftime('%Y%m%d')}.zip"
    try:
        client.download(d, dest)
    except NoDataForDate:
        emit_obj([("date", d.isoformat()), ("result", "no tape available (no-op)")])
        return 0
    emit_obj([
        ("downloaded", d.isoformat()),
        ("zip", str(dest)),
        ("size", human_bytes(dest.stat().st_size)),
    ])
    emit_help([f"Run `{_prog()} convert {dest}` to land it as validated bronze parquet"])
    return 0


def cmd_build(client: Client, start: date, end: date | None, lake: Path, confirm: bool) -> int:
    earliest, _lookback = client.probe_boundary()
    lo, hi = _resolve_window(lake, start, end, earliest)
    if hi < lo:
        raise FatalError(
            f"requested window is empty after clamping to your available range "
            f"({lo.isoformat()} to {hi.isoformat()}).",
            f"pick a start on or after {(earliest or lo).isoformat()}.",
        )
    window = trading_days(lo, hi)
    present = present_dates(lake)
    todo = [d for d in window if d not in present]

    if start < (earliest or start):
        progress(f"note: clamped start up to your earliest available date "
                 f"{earliest.isoformat()}")

    if not todo:
        emit_obj([
            ("window", f"{lo.isoformat()} to {hi.isoformat()} ({len(window)} trading days)"),
            ("result", f"all {len(window)} trading days already present (no-op)"),
        ])
        return 0

    if not confirm:
        est = disk_estimate(lake, len(todo))
        emit_obj([
            ("window", f"{lo.isoformat()} to {hi.isoformat()} ({len(window)} trading days)"),
            ("present", f"{len(window) - len(todo)}"),
            ("to_fetch", est.to_fetch),
            ("per_day_parquet", f"{human_bytes(est.per_day_parquet)} ({est.parquet_anchor})"),
            ("steady_state_added", human_bytes(est.steady_state_total)),
            ("peak_transient_per_day", (f"{human_bytes(est.peak_transient)} "
             "(zip + CSV + parquet during each conversion)")),
            ("confirm_required", "true"),
        ])
        emit_help([
            f"Re-run with --confirm to download and convert {est.to_fetch} day(s).",
            "The zip and CSV for each day are deleted after its parquet validates.",
        ])
        return 0

    built = 0
    skipped = 0
    for i, d in enumerate(todo, 1):
        progress(f"[{i}/{len(todo)}] {d.isoformat()}")
        result = build_one(client, d, lake)
        if result is None:
            skipped += 1
        else:
            built += 1
            progress(f"  ok {d.isoformat()}: {result.rows:,} rows, "
                     f"{human_bytes(result.parquet_bytes)}")

    now_present = present_dates(lake)
    emit_obj([
        ("window", f"{lo.isoformat()} to {hi.isoformat()} ({len(window)} trading days)"),
        ("built", built),
        ("skipped", skipped),
        ("lake_total", (f"{len(now_present)} dates, "
         f"{human_bytes(sum(now_present.values()))} bronze parquet")),
    ])
    emit_help([f"Run `{_prog()}` to see updated lake status"])
    return 0


# ============================================================================
# SILVER BUILDER: bronze parquet -> validated 1-minute per-contract bars
# ============================================================================

def source_noncanceled_volume(bronze_parquet: Path) -> int:
    """sum(size) over non-canceled trades, the figure a faithful bar set reconciles to."""
    v = (pl.scan_parquet(bronze_parquet)
         .filter(pl.col("canceled") == "f")
         .select(pl.col("size").sum())
         .collect().item())
    return int(v or 0)


def _canceled_domain_guard(df: pl.DataFrame) -> None:
    seen = df.get_column("canceled").unique().to_list()
    unknown = sorted(str(v) for v in seen if v not in CANCELED_DOMAIN)
    if unknown:
        raise FatalError(
            f"the `canceled` column holds value(s) outside {set(CANCELED_DOMAIN)}: "
            f"{unknown}. Refusing to build bars, because an unknown token could be an "
            "off-market bust silently kept in OHLC.",
            "inspect the bronze parquet; the source encoding of `canceled` may have "
            "changed from the 't'/'f' this build was validated against.",
        )


def _price_pass(df: pl.DataFrame) -> pl.DataFrame:
    """OHLCV, premium, trade_count, and all bar-close snapshots over non-canceled trades.
    Sorting by (chain, executed_at, volume) makes first()/last() the true open/close even
    when several prints share a microsecond timestamp (volume is monotone per chain)."""
    live = (df.filter(pl.col("canceled") == "f")
            .with_columns(pl.col("executed_at").dt.truncate("1m").alias("minute_utc"))
            .sort(["option_chain_id", "executed_at", "volume"]))
    return live.group_by(["option_chain_id", "minute_utc"], maintain_order=True).agg(
        pl.col("price").first().alias("open"),
        pl.col("price").max().alias("high"),
        pl.col("price").min().alias("low"),
        pl.col("price").last().alias("close"),
        pl.col("size").sum().alias("volume"),
        pl.len().cast(pl.Int64).alias("trade_count"),
        pl.col("premium").sum().alias("premium"),
        pl.col("nbbo_bid").last().alias("bid_close"),
        pl.col("nbbo_ask").last().alias("ask_close"),
        pl.col("underlying_price").first().alias("underlying_open"),
        pl.col("underlying_price").last().alias("underlying_close"),
        pl.col("implied_volatility").last().alias("iv_close"),
        pl.col("delta").last().alias("delta_close"),
        pl.col("gamma").last().alias("gamma_close"),
        pl.col("theta").last().alias("theta_close"),
        pl.col("vega").last().alias("vega_close"),
        pl.col("rho").last().alias("rho_close"),
        pl.col("theo").last().alias("theo_close"),
        pl.col("open_interest").last().alias("open_interest"),
        pl.col("underlying_symbol").first().alias("underlying_symbol"),
        pl.col("option_type").first().alias("option_type"),
        pl.col("strike").first().alias("strike"),
        pl.col("expiry").first().alias("expiry"),
        pl.col("tags").first().alias("tags"),
    )


def _side_pass(df: pl.DataFrame) -> pl.DataFrame:
    """Per-minute side volumes from cumulative per-chain counters by de-cumulations.
    The counters are running totals so a minute's own volume is the telescoping
    delta max(this minute) - max(prior minute). The first minute of a chain uses
    the raw value."""
    per_minute = (df.with_columns(pl.col("executed_at").dt.truncate("1m").alias("minute_utc"))
                  .group_by(["option_chain_id", "minute_utc"])
                  .agg([pl.col(c).max().alias(c) for c in SILVER_SIDE_COUNTERS])
                  .sort(["option_chain_id", "minute_utc"]))
    deltas = per_minute.with_columns([
        (pl.col(counter) - pl.col(counter).shift(1).over("option_chain_id"))
        .fill_null(pl.col(counter)).clip(lower_bound=0).alias(out_name)
        for counter, out_name in zip(SILVER_SIDE_COUNTERS, SILVER_SIDE_VOLUMES)
    ])
    return deltas.select(["option_chain_id", "minute_utc", *SILVER_SIDE_VOLUMES])


def build_bars(bronze_parquet: Path) -> pl.DataFrame:
    """One bronze day -> its 1-minute per-contract OHLCV+greeks bars (the 33-column
    silver schema, sorted by (option_chain_id, minute_utc)). Returns a DataFrame,
    does not write. Raises FatalError if `canceled` carries a value outside {t, f}"""
    df = pl.read_parquet(bronze_parquet, columns=list(SILVER_SOURCE_COLUMNS))
    _canceled_domain_guard(df)
    bars = _price_pass(df).join(_side_pass(df), on=["option_chain_id", "minute_utc"], how="left")
    bars = bars.with_columns(
        (pl.col("premium") / pl.col("volume") / 100).alias("vwap"),
        pl.col("minute_utc").dt.convert_time_zone(EASTERN_TZ).alias("minute_et"),
        pl.when(pl.col("tags").str.contains("etf", literal=True)).then(pl.lit("etf"))
          .when(pl.col("tags").str.contains("index", literal=True)).then(pl.lit("index"))
          .otherwise(pl.lit("equity")).alias("security_type"),
        pl.col("expiry").str.to_date().alias("expiry"),
    )
    return bars.select(SILVER_COLUMNS).sort(["option_chain_id", "minute_utc"])


def validate_silver(bars: pl.DataFrame, source_noncanceled_vol: int) -> list[str]:
    """Every reason a bar set is not a faithful silver partition. Empty means it may be
    committed. Pure: it inspects the frame and one source figure, does no I/O."""
    problems: list[str] = []
    cols = tuple(bars.columns)
    if cols != SILVER_COLUMNS:
        problems.append(
            f"columns differ from the {len(SILVER_COLUMNS)}-column silver schema "
            f"(got {len(cols)} columns)")
        return problems

    schema = bars.schema
    if schema["minute_utc"] != SILVER_MINUTE_UTC_DTYPE:
        problems.append(f"minute_utc is {schema['minute_utc']}, expected {SILVER_MINUTE_UTC_DTYPE}")
    if schema["minute_et"] != SILVER_MINUTE_ET_DTYPE:
        problems.append(f"minute_et is {schema['minute_et']}, expected {SILVER_MINUTE_ET_DTYPE}")

    vol = int(bars["volume"].sum()) if bars.height else 0
    if vol != source_noncanceled_vol:
        problems.append(f"bar volume sum {vol} != source non-canceled size sum "
                        f"{source_noncanceled_vol}")

    dupes = bars.height - bars.select(["option_chain_id", "minute_utc"]).n_unique()
    if dupes > 0:
        problems.append(f"{dupes} duplicate (option_chain_id, minute_utc) grain row(s)")

    if bars.height and int(bars["trade_count"].min()) < 1:
        problems.append("a bar has trade_count < 1; empty bars must not be emitted")

    ohlc_bad = bars.filter(
        (pl.col("low") > pl.min_horizontal("open", "close"))
        | (pl.col("high") < pl.max_horizontal("open", "close"))
    ).height
    if ohlc_bad > 0:
        problems.append(f"{ohlc_bad} bar(s) violate OHLC bounds "
                        "(low > min(open, close) or high < max(open, close))")

    bad_sec = bars.filter(~pl.col("security_type").is_in(SILVER_SECURITY_TYPES)).height
    if bad_sec > 0:
        problems.append(f"{bad_sec} bar(s) have a security_type outside {SILVER_SECURITY_TYPES}")

    return problems


@dataclass
class SilverBuildResult:
    date: date
    partition_path: Path
    bars: int
    parquet_bytes: int


def build_silver_one(lake: Path, d: date) -> SilverBuildResult | None:
    """Build one date's silver partition from local bronze, committing bars.parquet only
    after validate_silver passes. Returns None if the partition already exists (idempotent
    no-op) or the date has no bronze parquet. Raises FatalError if the gate fails.

    The commit is temp-then-rename within the partition dir, so a partition file only ever
    appears once it is complete and validated; an interrupted build leaves at most a .tmp."""
    dest = silver_partition_path(lake, d)
    if dest.exists():
        return None
    bronze = bronze_path(lake, d)
    if not bronze.exists():
        return None

    src_vol = source_noncanceled_volume(bronze)
    bars = build_bars(bronze)
    problems = validate_silver(bars, src_vol)
    if problems:
        raise FatalError(
            f"silver validation failed for {d.isoformat()}: " + "; ".join(problems),
            "no partition was written and the bronze parquet is untouched. Investigate "
            "the bronze source before retrying.",
        )

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.parent / (SILVER_BARS_FILE + ".tmp")
    bars.write_parquet(tmp, compression=PARQUET_COMPRESSION,
                       compression_level=PARQUET_COMPRESSION_LEVEL)
    tmp.replace(dest)
    return SilverBuildResult(date=d, partition_path=dest, bars=bars.height,
                             parquet_bytes=dest.stat().st_size)


# ============================================================================
# SILVER COMMANDS (offline: read local bronze, write local silver)
# ============================================================================

def cmd_silver_status(lake: Path, start: date | None, end: date | None) -> int:
    bronze = present_dates(lake)
    silver = present_silver_dates(lake)
    latest = most_recent_available_date()
    lo = start or (min(bronze) if bronze else (min(silver) if silver else latest))
    hi = end or latest
    window = trading_days(lo, hi)
    bronze_in = [d for d in window if d in bronze]
    silver_in = [d for d in window if d in silver]
    todo = [d for d in bronze_in if d not in silver]
    _missing, orphan = silver_coverage(bronze, silver)
    silver_bytes = sum(silver.values())

    emit_obj([
        ("bin", home_path(Path(__file__))),
        ("dataset", f"{SILVER_SUBDIR}/{SILVER_BARS_DATASET} (1-min per-contract OHLCV+greeks bars)"),
        ("lake", str(lake)),
        ("window", f"{lo.isoformat()} to {hi.isoformat()} ({len(window)} trading days)"),
        ("bronze_present", f"{len(bronze_in)} of {len(window)} trading days in window"),
        ("silver_present", f"{len(silver_in)} of {len(bronze_in)} bronze dates in window have bars"),
        ("silver_total", f"{len(silver)} dates, {human_bytes(silver_bytes)} bars parquet"),
    ])

    if not silver:
        out("silver_dates: 0 dates present")
    else:
        recent = sorted(silver, reverse=True)[:30]
        rows = [(d.isoformat(), silver[d], human_bytes(silver[d])) for d in recent]
        emit_table("silver_dates", ("date", "bytes", "size"), rows)
        if len(silver) > len(recent):
            progress(f"(showing {len(recent)} most recent of {len(silver)} silver dates)")

    hints = []
    if todo:
        hints.append(f"Run `{_prog()} silver-build {todo[0].isoformat()} "
                     f"{todo[-1].isoformat()} --confirm` to build 1-min bars from bronze")
    elif not bronze:
        hints.append(f"Run `{_prog()} build <start> <end> --confirm` to land bronze first")
    if orphan:
        hints.append(f"{len(orphan)} silver date(s) have no bronze parquet "
                     f"(earliest {orphan[0].isoformat()})")
    hints.append(f"Run `{_prog()}` to see combined bronze + silver status")
    emit_help(hints)
    return 0


def cmd_silver_build(lake: Path, start: date, end: date | None, confirm: bool) -> int:
    bronze = present_dates(lake)
    silver = present_silver_dates(lake)
    latest = most_recent_available_date()
    lo = start
    hi = min(end or latest, latest)
    window = trading_days(lo, hi)
    have_bronze = [d for d in window if d in bronze]
    todo = [d for d in have_bronze if d not in silver]
    no_bronze = [d for d in window if d not in bronze]

    if no_bronze:
        progress(f"note: {len(no_bronze)} window date(s) have no bronze parquet and are "
                 f"skipped; run `{_prog()} build ...` to land them first")

    if not todo:
        result = (f"all {len(have_bronze)} bronze date(s) in window already have bars (no-op)"
                  if have_bronze else "no bronze dates in window to build from (no-op)")
        emit_obj([
            ("window", f"{lo.isoformat()} to {hi.isoformat()} ({len(window)} trading days)"),
            ("result", result),
        ])
        return 0

    if not confirm:
        est = silver_disk_estimate(lake, len(todo))
        emit_obj([
            ("window", f"{lo.isoformat()} to {hi.isoformat()} ({len(window)} trading days)"),
            ("bronze_present", len(have_bronze)),
            ("already_silver", len(have_bronze) - len(todo)),
            ("to_build", est.to_build),
            ("per_day_bars", f"{human_bytes(est.per_day_bars)} ({est.bars_anchor})"),
            ("steady_state_added", human_bytes(est.steady_state_total)),
            ("transient", "RAM only (one day sorted in memory); no large disk transient"),
            ("confirm_required", "true"),
        ])
        emit_help([
            f"Re-run with --confirm to build 1-min bars for {est.to_build} day(s).",
            "Each partition is committed only after its bars pass validate_silver.",
        ])
        return 0

    built = 0
    skipped = 0
    for i, d in enumerate(todo, 1):
        progress(f"[{i}/{len(todo)}] {d.isoformat()}")
        result = build_silver_one(lake, d)
        if result is None:
            skipped += 1
        else:
            built += 1
            progress(f"  ok {d.isoformat()}: {result.bars:,} bars, "
                     f"{human_bytes(result.parquet_bytes)}")

    now_silver = present_silver_dates(lake)
    emit_obj([
        ("window", f"{lo.isoformat()} to {hi.isoformat()} ({len(window)} trading days)"),
        ("built", built),
        ("skipped", skipped),
        ("silver_total", (f"{len(now_silver)} dates, "
         f"{human_bytes(sum(now_silver.values()))} bars parquet")),
    ])
    emit_help([f"Run `{_prog()} silver-status` to see updated silver coverage"])
    return 0


# ============================================================================
# SCREENER: bronze -> qualifying contracts at their moment of detection
# ============================================================================

@dataclass
class ScreenCriteria:
    """Thresholds for the example screen, defaulting to one illustrative bullish
    long-dated call filter. Every field is a knob: change it to screen differently.
    min_otm_pct is single-sided moneyness (strike / spot - 1), so -0.12 admits
    everything from 12% in the money upward through deep out of the money; set it to
    0.0 for out-of-the-money only."""

    option_type: str = "call"
    security_types: tuple[str, ...] = ("equity",)
    min_vol_oi_ratio: float = 1.5
    min_ask_pct: float = 0.80
    min_premium: float = 500_000.0
    min_dte: int = 181
    min_otm_pct: float = -0.12
    max_multi_pct: float = 0.10
    max_floor_pct: float = 0.10
    max_avg_price: float = 50.0


def security_type_expr() -> pl.Expr:
    """equity / etf / index from the bronze `tags` tokens. Separate from build_bars'
    inline copy so the settled silver code is not touched. Fold the two together
    only in a deliberate silver-preserving cleanup."""
    return (pl.when(pl.col("tags").str.contains("etf", literal=True)).then(pl.lit("etf"))
              .when(pl.col("tags").str.contains("index", literal=True)).then(pl.lit("index"))
              .otherwise(pl.lit("equity")).alias("security_type"))


def screen_bronze(bronze_parquet: Path, criteria: ScreenCriteria, session: date) -> pl.DataFrame:
    """One bronze day -> the contracts that satisfy every screen criteria at its
    MOMENT OF DETECTION, the first transaction at which all criteria are met at once.
    Returns a DataFrame sorted by cum_premium descending, does not write anything.
    `session` is the bronze partition date used to calculate days til expiry. Only
    cum_premium and cum_floor are summed because bronze carries no cumulative premium
    or floor counter. Canceled and cross/late transactions are kept on purpose to
    stay true to the reality of trade reporting."""
    c = criteria
    # Read the full bronze row and let polars' projection pushdown load only the
    # columns this query actually references, so adapting the gate to a new bronze
    # field (a greek, a bid-side counter) needs no source-column list to keep in sync.
    lf = pl.scan_parquet(bronze_parquet).with_columns(
        security_type_expr(),
        (pl.col("expiry").str.to_date() - pl.lit(session)).dt.total_days().alias("dte"),
    ).filter(
        # Structural gates are contract-constant, so they drop whole non-qualifying
        # chains and leave the native cumulative counters intact within kept chains.
        (pl.col("option_type") == c.option_type)
        & pl.col("security_type").is_in(c.security_types)
        & (pl.col("dte") >= c.min_dte)
        & (pl.col("open_interest") > 0)
        & pl.col("underlying_price").is_not_null()
    )

    lf = lf.sort(["option_chain_id", "executed_at", "volume"]).with_columns(
        pl.col("premium").cum_sum().over("option_chain_id").alias("cum_premium"),
        pl.when(pl.col("report_flags").str.contains("floor", literal=True))
          .then(pl.col("size")).otherwise(0)
          .cum_sum().over("option_chain_id").alias("cum_floor"),
    ).with_columns(
        (pl.col("volume") / pl.col("open_interest")).alias("vol_oi_ratio"),
        (pl.col("ask_vol") / pl.col("volume")).alias("ask_pct"),
        (pl.col("multi_vol") / pl.col("volume")).alias("multi_pct"),
        (pl.col("cum_floor") / pl.col("volume")).alias("floor_pct"),
        (pl.col("cum_premium") / pl.col("volume") / 100).alias("avg_price"),
        (pl.col("strike") / pl.col("underlying_price") - 1).alias("otm_pct"),
    )

    gate = (
        (pl.col("vol_oi_ratio") >= c.min_vol_oi_ratio)
        & (pl.col("ask_pct") >= c.min_ask_pct)
        & (pl.col("cum_premium") >= c.min_premium)
        & (pl.col("otm_pct") >= c.min_otm_pct)
        & (pl.col("multi_pct") <= c.max_multi_pct)
        & (pl.col("floor_pct") <= c.max_floor_pct)
        & (pl.col("avg_price") <= c.max_avg_price)
    )
    detected = (lf.filter(gate)
                  .group_by("option_chain_id", maintain_order=True).first()
                  .with_columns(
                      pl.col("executed_at").alias("detected_at"),
                      pl.col("price").alias("detected_price"),
                      pl.col("expiry").str.to_date().alias("expiry"),
                  ))
    return (detected.select(SCREEN_COLUMNS)
                    .sort(["cum_premium", "option_chain_id"], descending=[True, False])
                    .collect())


def cmd_screen(lake: Path, start: date, end: date | None, out: Path | None) -> int:
    criteria = ScreenCriteria()
    bronze = present_dates(lake)
    latest = most_recent_available_date()
    lo = start
    hi = min(end or latest, latest)
    window = trading_days(lo, hi)
    have_bronze = [d for d in window if d in bronze]
    no_bronze = [d for d in window if d not in bronze]

    if no_bronze:
        progress(f"note: {len(no_bronze)} window date(s) have no bronze parquet and are "
                 f"skipped; run `{_prog()} build ...` to land them first")

    frames: list[pl.DataFrame] = []
    for d in have_bronze:
        progress(f"screening {d.isoformat()} ...")
        res = screen_bronze(bronze_path(lake, d), criteria, d)
        if res.height:
            frames.append(res.with_columns(pl.lit(d.isoformat()).alias("date")))

    total = sum(f.height for f in frames)
    emit_obj([
        ("bin", home_path(Path(__file__))),
        ("screen", "illustrative bullish long-dated call filter (moment of detection)"),
        ("lake", str(lake)),
        ("window", f"{lo.isoformat()} to {hi.isoformat()} ({len(window)} trading days)"),
        ("bronze_scanned", f"{len(have_bronze)} of {len(window)} trading days had bronze"),
        ("hits", f"{total} qualifying contract(s)"),
    ])

    if not frames:
        out("contracts: 0 qualifying contracts")
        hints = []
        if no_bronze:
            hints.append(f"Run `{_prog()} build {lo.isoformat()} {hi.isoformat()} --confirm` "
                         f"to land bronze for this window first")
        hints.append(f"Edit ScreenCriteria in {_prog()} to screen a different setup, then re-run")
        emit_help(hints)
        return 0

    combined = pl.concat(frames).sort(["cum_premium", "option_chain_id"],
                                      descending=[True, False])
    out_path = out or screen_result_path(lake, start, end)
    write_screen_csv(combined, out_path)

    disp = combined.select(
        pl.col("date"),
        pl.col("underlying_symbol").alias("ticker"),
        pl.col("option_chain_id").alias("contract"),
        pl.col("expiry").cast(pl.String).alias("expiry"),
        pl.col("dte"),
        pl.col("detected_at").dt.strftime("%Y-%m-%d %H:%M:%SZ").alias("detected_utc"),
        pl.col("strike").round(2),
        pl.col("underlying_price").round(2).alias("spot"),
        pl.col("otm_pct").round(4),
        pl.col("volume"),
        pl.col("open_interest").alias("oi"),
        pl.col("vol_oi_ratio").round(2).alias("vol_oi"),
        pl.col("cum_premium").round(0).cast(pl.Int64).alias("premium"),
        pl.col("avg_price").round(2),
        pl.col("detected_price").round(2).alias("detected_price"),
        pl.col("ask_pct").round(4),
        pl.col("multi_pct").round(4),
        pl.col("floor_pct").round(4),
    )
    emit_table("contracts", tuple(disp.columns), disp.rows())
    emit_help([
        f"Wrote the screen result to {out_path}",
        (f"Run `{_prog()} forward {out_path}` to measure each contract's forward "
         "performance after detection (build silver over the horizon first)"),
        (f"Edit ScreenCriteria in {_prog()} to screen a different setup "
         "(thresholds, calls/puts, security types), then re-run"),
    ])
    return 0


# ============================================================================
# FORWARD PERFORMANCE: silver -> neutral key prices after the moment of detection
# ============================================================================

def forward_metrics(bars_scan: pl.LazyFrame | None, detections: pl.DataFrame) -> pl.DataFrame:
    """Augment each detection with the neutral forward prices observed STRICTLY
    AFTER its detection minute in the silver bars. Left-joined, so a contract with
    no forward bars keeps its row with null prices and forward_bars 0 (never dropped).

    Prices are direction-agnostic (no MAE/MFE, no return): min_after / max_after are
    the low / high extremes over the forward window, latest_after is the last bar's
    close, and last_forward_minute / forward_bars mark where the local silver stops.
    `bars_scan` is None when no silver exists yet, which yields all-null metrics."""
    det = detections.with_columns(
        pl.col("detected_at").dt.truncate("1m").alias("detection_minute"))

    if bars_scan is None:
        agg = pl.DataFrame(schema=_FORWARD_AGG_SCHEMA)
    else:
        keys = det.select("option_chain_id", "detection_minute").unique()
        earliest = det.select(pl.col("detected_at").dt.date().min()).item()
        agg = (bars_scan
               .filter(pl.col("date") >= earliest)
               .join(keys.lazy(), on="option_chain_id", how="inner")
               .filter(pl.col("minute_utc") > pl.col("detection_minute"))
               .group_by("option_chain_id", "detection_minute")
               .agg(
                   pl.col("low").min().alias("min_after"),
                   pl.col("high").max().alias("max_after"),
                   pl.col("close").sort_by("minute_utc").last().alias("latest_after"),
                   pl.col("minute_utc").max().alias("last_forward_minute"),
                   pl.len().cast(pl.Int64).alias("forward_bars"),
               ).collect())

    return (det.join(agg, on=["option_chain_id", "detection_minute"], how="left")
               .with_columns(pl.col("forward_bars").fill_null(0))
               .drop("detection_minute"))


def parse_ohlc_close(body: str, d: date) -> float | None:
    """The regular-hours close for `d` from a UW `/stock/{t}/ohlc/1d` response body,
    or None if absent. The `data` list carries pre-market (`pr`), post-market (`po`),
    and regular (`r`) rows per date; only the regular-hours close is the settle
    reference, and every price is a string to cast to float."""
    try:
        data = json.loads(body).get("data", [])
    except (ValueError, AttributeError):
        return None
    iso = d.isoformat()
    for rec in data:
        if rec.get("date") == iso and rec.get("market_time") == "r":
            try:
                return float(rec["close"])
            except (TypeError, ValueError, KeyError):
                return None
    return None


def intrinsic_at_expiry(option_type: str, strike: float, underlying_close: float) -> float:
    """The option's intrinsic value at expiry given the underlying's settle price:
    max(0, S - K) for a call, max(0, K - S) for a put."""
    if option_type == "call":
        return max(0.0, underlying_close - strike)
    if option_type == "put":
        return max(0.0, strike - underlying_close)
    raise FatalError(
        f"unknown option_type {option_type!r}; expected 'call' or 'put'.",
        "the screen CSV's option_type column must be 'call' or 'put'.")


def with_theo_at_expiry(metrics: pl.DataFrame, today: date,
                        fetch_close: Callable[[str, date], float | None]) -> pl.DataFrame:
    """Add `expired` (expiry strictly before `today`) and `theo_at_expiry` (the option's
    intrinsic value from the underlying's regular-hours close at expiry). `fetch_close`
    is called at most once per unique (underlying_symbol, expiry) among expired contracts
    and returns None when no settle price is available, leaving theo null; unexpired
    contracts are always null. Injecting `fetch_close` keeps this pure and offline-testable."""
    rows = metrics.select("underlying_symbol", "expiry", "option_type", "strike").rows()
    expired_flags: list[bool] = []
    theos: list[float | None] = []
    cache: dict[tuple[str, date], float | None] = {}
    for ticker, expiry, option_type, strike in rows:
        is_expired = expiry is not None and expiry < today
        expired_flags.append(is_expired)
        if not is_expired:
            theos.append(None)
            continue
        key = (ticker, expiry)
        if key not in cache:
            cache[key] = fetch_close(ticker, expiry)
        close = cache[key]
        theos.append(None if close is None
                     else intrinsic_at_expiry(option_type, strike, close))
    return metrics.with_columns(
        pl.Series("theo_at_expiry", theos, dtype=pl.Float64),
        pl.Series("expired", expired_flags, dtype=pl.Boolean),
    )


def cmd_forward(lake: Path, csv_path: Path, api_key: str | None, out: Path | None) -> int:
    if not csv_path.is_file():
        raise FatalError(
            f"screen CSV not found: {csv_path}",
            f"run `{_prog()} screen <start> [end]` first to produce one, or pass its path.")

    header = pl.read_csv(csv_path, n_rows=0).columns
    missing = [c for c in FORWARD_INPUT_COLUMNS if c not in header]
    if missing:
        raise FatalError(
            f"{csv_path} is missing required column(s): {', '.join(missing)}",
            (f"regenerate it with `{_prog()} screen ...`, or supply a CSV carrying "
             f"{', '.join(FORWARD_INPUT_COLUMNS)}."))
    detections = read_screen_csv(csv_path)

    silver = present_silver_dates(lake)
    bars_scan = (pl.scan_parquet(silver_bars_dir(lake), hive_partitioning=True)
                 if silver else None)
    metrics = forward_metrics(bars_scan, detections).sort("detected_at")

    today = eastern_now().date()
    n_expired = int((metrics["expiry"] < today).sum())
    if n_expired:
        client = Client(resolve_api_key(api_key))

        def fetch_close(ticker: str, expiry: date) -> float | None:
            progress(f"fetching {ticker} regular-hours close at expiry {expiry.isoformat()} ...")
            return client.fetch_ohlc_close(ticker, expiry)
    else:
        def fetch_close(ticker: str, expiry: date) -> float | None:
            return None
    metrics = with_theo_at_expiry(metrics, today, fetch_close)

    if out is not None:
        write_forward_csv(metrics, out)

    with_forward = int((metrics["forward_bars"] > 0).sum())
    n_priced = int(metrics["theo_at_expiry"].is_not_null().sum())
    horizon = max(silver).isoformat() if silver else "none built yet"
    emit_obj([
        ("bin", home_path(Path(__file__))),
        ("forward", "contract price performance after its detection"),
        ("lake", str(lake.resolve())),
        ("screen_csv", str(csv_path.resolve())),
        ("contract_count", metrics.height),
        ("silver_last_available_date", horizon),
        ("with_forward_bars", f"{with_forward} of {metrics.height} have >=1 forward bar"),
        ("expired", f"{n_expired} expired; {n_priced} priced at expiry (intrinsic)"),
    ])

    disp = metrics.select(
        pl.col("underlying_symbol").alias("ticker"),
        pl.col("option_chain_id").alias("contract"),
        pl.col("strike").round(2),
        pl.col("expiry").cast(pl.String).alias("expiry"),
        pl.col("dte"),
        pl.col("detected_at").dt.strftime("%Y-%m-%d %H:%M:%SZ").alias("detected_utc"),
        pl.col("detected_price").round(2).alias("detected_price"),
        pl.col("avg_price").round(2),
        pl.col("min_after").round(2),
        pl.col("max_after").round(2),
        pl.col("latest_after").round(2),
        pl.col("last_forward_minute").dt.strftime("%Y-%m-%d %H:%M:%SZ").alias("last_fwd_utc"),
        pl.col("forward_bars").alias("fwd_bars"),
        pl.col("theo_at_expiry").round(2).alias("theo_at_expiry"),
        pl.col("expired"),
    )
    emit_table("forward", tuple(disp.columns), disp.rows())

    hints: list[str] = []
    if out is not None:
        hints.append(f"Wrote the full forward result to {out.resolve()}")
    censored = metrics.height - with_forward
    if censored:
        hints.append(
            f"{censored} contract(s) have no silver bars after detection; run "
            f"`{_prog()} silver-build <start> <end> --confirm` over the forward horizon, "
            "then re-run this command")
    hints.append(
        "min_after / max_after / latest_after are bounded by the silver dates present "
        "locally (last_fwd_utc shows where the data stops), NOT the contract expiry")
    if n_expired:
        hints.append(
            "theo_at_expiry is the intrinsic value at expiry from the underlying's regular-hours "
            "close (the one network read); it is null for contracts not yet expired")
    hints.append(
        "these are neutral prices: apply buy-vs-sell intent yourself to read them as "
        "adverse / favorable or as a return")
    emit_help(hints)
    return 0


# ============================================================================
# API KEY RESOLUTION (.env)
# ============================================================================

def parse_dotenv_value(text: str, name: str) -> str | None:
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, sep, val = line.partition("=")
        if not sep or key.strip() != name:
            continue
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        return val or None
    return None


def load_dotenv_key(name: str, path: str = ".env") -> str | None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return None
    return parse_dotenv_value(text, name)


# UW documentation uses "key" and "token" interchangeably, so accept either name;
# the first present wins, so UW_API_KEY takes precedence over UW_API_TOKEN.
API_KEY_ENV_NAMES: tuple[str, ...] = ("UW_API_KEY", "UW_API_TOKEN")


def _select_key(lookup) -> str | None:
    for name in API_KEY_ENV_NAMES:
        value = lookup(name)
        if value:
            return value
    return None


def resolve_api_key(explicit: str | None) -> str:
    key = (explicit
           or _select_key(os.environ.get)
           or _select_key(load_dotenv_key))
    if not key:
        names = " or ".join(API_KEY_ENV_NAMES)
        raise FatalError(
            "no API key.",
            f"provide your UW key, most secure first: (1) set {names} in the "
            f"environment; (2) put {API_KEY_ENV_NAMES[0]}=your-key (or "
            f"{API_KEY_ENV_NAMES[1]}=your-key) in a .env in this directory "
            "(gitignore it); (3) pass --api-key (plaintext, last resort). "
            "Find your key at https://unusualwhales.com/settings.",
        )
    return key


# ============================================================================
# CLI
# ============================================================================

def _prog() -> str:
    return "uw_options_data_lake.py"


def _parse_date_arg(s: str) -> date:
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise FatalError(f"'{s}' is not a valid YYYY-MM-DD date.",
                         "use ISO dates, e.g. 2026-07-31.")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog=_prog(),
        description="Build a local bronze data lake of Unusual Whales option trades.",
        epilog="Educational use only. Not investment advice.",
    )
    p.add_argument("--selftest", action="store_true",
                   help="verify this file transcribed correctly (0 API calls). Run first.")
    p.add_argument("--lake", type=Path, default=DEFAULT_LAKE, metavar="DIR",
                   help=f"lake directory (default: {DEFAULT_LAKE})")
    p.add_argument("--api-key", default=None,
                   help="UW API key. Prefer UW_API_KEY in the environment or a local "
                        ".env; this flag is a plaintext last resort.")
    sub = p.add_subparsers(dest="command")

    s = sub.add_parser("status", help="show live lake coverage (default with no command)")
    s.add_argument("--start", type=_parse_date_arg, default=None, metavar="YYYY-MM-DD")
    s.add_argument("--end", type=_parse_date_arg, default=None, metavar="YYYY-MM-DD")

    c = sub.add_parser("convert", help="convert a local tape zip to validated bronze parquet")
    c.add_argument("zip", type=Path)

    sub.add_parser("probe", help="discover your historical window (one request)")

    d = sub.add_parser("download", help="stream one date's tape zip (no convert)")
    d.add_argument("date", type=_parse_date_arg, metavar="YYYY-MM-DD")

    b = sub.add_parser("build", help="download+convert+validate a date or range")
    b.add_argument("start", type=_parse_date_arg, metavar="START")
    b.add_argument("end", type=_parse_date_arg, nargs="?", default=None, metavar="END")
    b.add_argument("--confirm", action="store_true",
                   help="proceed with the download; without it, build only estimates disk")

    ss = sub.add_parser("silver-status", help="show silver (1-min bars) coverage vs bronze")
    ss.add_argument("--start", type=_parse_date_arg, default=None, metavar="YYYY-MM-DD")
    ss.add_argument("--end", type=_parse_date_arg, default=None, metavar="YYYY-MM-DD")

    sb = sub.add_parser("silver-build",
                        help="build 1-min per-contract bars from local bronze (offline)")
    sb.add_argument("start", type=_parse_date_arg, metavar="START")
    sb.add_argument("end", type=_parse_date_arg, nargs="?", default=None, metavar="END")
    sb.add_argument("--confirm", action="store_true",
                    help="proceed with the build; without it, silver-build only estimates disk")

    sc = sub.add_parser("screen",
                        help="screen bronze for an example unusual-activity setup (offline)")
    sc.add_argument("start", type=_parse_date_arg, metavar="START")
    sc.add_argument("end", type=_parse_date_arg, nargs="?", default=None, metavar="END")
    sc.add_argument("--out", type=Path, default=None, metavar="PATH",
                    help="write the screen result CSV here (default: lake/screens/screen_<window>.csv)")

    fw = sub.add_parser("forward",
                        help="key prices after each screened contract's detection (offline, silver)")
    fw.add_argument("csv", type=Path, metavar="SCREEN_CSV")
    fw.add_argument("--out", type=Path, default=None, metavar="PATH",
                    help="also save the full forward result to this CSV (durable, reusable)")
    return p


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.selftest:
        return selftest()

    lake: Path = args.lake
    try:
        if args.command in (None, "status"):
            start = getattr(args, "start", None)
            end = getattr(args, "end", None)
            return cmd_status(lake, start, end)
        if args.command == "convert":
            return cmd_convert(args.zip, lake)
        if args.command == "probe":
            return cmd_probe(Client(resolve_api_key(args.api_key)))
        if args.command == "download":
            return cmd_download(Client(resolve_api_key(args.api_key)), args.date, lake)
        if args.command == "build":
            return cmd_build(Client(resolve_api_key(args.api_key)),
                             args.start, args.end, lake, args.confirm)
        if args.command == "silver-status":
            return cmd_silver_status(lake, args.start, args.end)
        if args.command == "silver-build":
            return cmd_silver_build(lake, args.start, args.end, args.confirm)
        if args.command == "screen":
            return cmd_screen(lake, args.start, args.end, args.out)
        if args.command == "forward":
            return cmd_forward(lake, args.csv, args.api_key, args.out)
        parser.error(f"unknown command: {args.command}")
    except FatalError as e:
        emit_error(e)
        return 1
    except KeyboardInterrupt:
        return 130
    return 0


# ============================================================================
# SELFTEST (zero API calls)
# ============================================================================

# The real historic-window 403 body, captured 2026-08-02. The selftest routes it
# through classify_403 / parse_boundary to prove an entitlement response is never
# mistaken for an auth failure.
_BOUNDARY_FIXTURE = (
    '{"code":"historic_data_access_missing","message":"The earliest date currently '
    "available to you is 2026-03-23 (90 trading days) so 2025-12-31 in query param "
    "date will not return historical data.\\nIf you wish to access full historic data "
    'please email dev@unusualwhales.com with your use case."}'
)

# A real /stock/{ticker}/ohlc/1d body (AAPL, date=2026-07-21), carrying pre-market
# (pr), post-market (po), and regular (r) rows for two dates. The regular-hours close
# for 2026-07-21 is 327.74; the selftest proves parse_ohlc_close picks it out.
_OHLC_FIXTURE = json.dumps({"data": [
    {"close": "323.2", "high": "327.406", "low": "322", "open": "325.58",
     "date": "2026-07-21", "total_volume": 515856, "market_time": "pr", "volume": 515856},
    {"close": "324.5", "high": "327.89", "low": "324.15", "open": "327.59",
     "date": "2026-07-21", "total_volume": 41338917, "market_time": "po", "volume": 9993455},
    {"close": "327.74", "high": "329.6", "low": "322.2204", "open": "323.13",
     "date": "2026-07-21", "total_volume": 31345462, "market_time": "r", "volume": 41338918},
    {"close": "327.86", "high": "328.07", "low": "325.92", "open": "326.46",
     "date": "2026-07-22", "total_volume": 343670, "market_time": "pr", "volume": 343670},
    {"close": "325.74", "high": "326.7", "low": "325", "open": "325.95",
     "date": "2026-07-22", "total_volume": 38755930, "market_time": "po", "volume": 11769020},
    {"close": "325.89", "high": "328.9995", "low": "323.34", "open": "327.87",
     "date": "2026-07-22", "total_volume": 26986910, "market_time": "r", "volume": 38755930},
]})


def _synthetic_tape_csv(rows: list[dict[str, str]]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(EXPECTED_COLUMNS)
    for r in rows:
        writer.writerow([r.get(c, "") for c in EXPECTED_COLUMNS])
    return buf.getvalue()


def _base_tape_row(executed: str, created: str) -> dict[str, str]:
    return {c: "" for c in EXPECTED_COLUMNS} | {
        "id": "019fb85e-0ff4-7953-aec8-a0ad1c0c757d",
        "underlying_symbol": "MSTR",
        "executed_at": executed,
        "created_at": created,
        "size": "1", "price": "22.00", "option_chain_id": "MSTR270115C00095000",
        "volume": "1", "trade_id": "0", "canceled": "f", "exchange": "XPHO",
    }


def _silver_tape_rows() -> list[dict[str, str]]:
    """A tiny hand-computed tape: chain A (equity) across two minutes with a canceled
    off-market bust, and chain B (etf) in one minute. Non-canceled size sums to 16."""
    def row(**over: str) -> dict[str, str]:
        base = {c: "" for c in EXPECTED_COLUMNS} | {
            "id": "019fb85e-0ff4-7953-aec8-a0ad1c0c757d",
            "created_at": "2026-07-31 13:30:00.052358+00",
            "canceled": "f", "trade_id": "0", "exchange": "XPHO",
            "nbbo_bid": "0.0", "nbbo_ask": "0.0", "underlying_price": "100.0",
            "implied_volatility": "0.5", "delta": "0.5", "gamma": "0.1",
            "theta": "-0.2", "vega": "0.3", "rho": "0.05", "theo": "10.0",
            "open_interest": "500", "ask_vol": "0", "bid_vol": "0",
            "mid_vol": "0", "no_side_vol": "0", "multi_vol": "0",
        }
        return base | over

    a = {"underlying_symbol": "MSTR", "option_chain_id": "MSTR270115C00095000",
         "option_type": "call", "strike": "95.0", "expiry": "2027-01-15",
         "tags": "{ask_side,bullish}"}
    b = {"underlying_symbol": "SPY", "option_chain_id": "SPY270115C00500000",
         "option_type": "call", "strike": "500.0", "expiry": "2027-01-15",
         "tags": "{ask_side,etf}"}
    return [
        row(**a, executed_at="2026-07-31 13:30:00.001000+00", price="10.0", size="2",
            premium="2000.0", volume="2", ask_vol="2", nbbo_bid="9.9", nbbo_ask="10.1",
            underlying_price="100.0"),
        row(**a, executed_at="2026-07-31 13:30:00.002000+00", price="12.0", size="3",
            premium="3600.0", volume="5", ask_vol="2", bid_vol="3", nbbo_bid="11.9",
            nbbo_ask="12.1", underlying_price="101.0"),
        row(**a, executed_at="2026-07-31 13:30:00.003000+00", price="50.0", size="1",
            premium="5000.0", volume="6", ask_vol="2", bid_vol="3", no_side_vol="1",
            canceled="t", nbbo_bid="11.9", nbbo_ask="12.1", underlying_price="101.0"),
        row(**a, executed_at="2026-07-31 13:31:00.001000+00", price="13.0", size="4",
            premium="5200.0", volume="10", ask_vol="6", bid_vol="3", no_side_vol="1",
            nbbo_bid="12.9", nbbo_ask="13.1", underlying_price="102.0"),
        row(**b, executed_at="2026-07-31 13:30:00.001500+00", price="4.0", size="7",
            premium="2800.0", volume="7", ask_vol="7", nbbo_bid="3.9", nbbo_ask="4.1",
            underlying_price="500.0"),
    ]


def _screen_tape_rows() -> list[dict[str, str]]:
    """A hand-computed screener tape (see the SC1 selftest). Under the test criteria
    (min_premium=1000), one detect chain first clears every gate on its SECOND print;
    one single-print chain fails exactly one gate each; one chain clears each gate on a
    different print but never all at once; and one chain clears the real $500K defaults.
    volume / ask_vol / multi_vol are given as the running-cumulative counters."""
    far, near = "2027-06-17", "2026-08-21"   # far: dte>181 from 2026-07-31; near: <181
    t1 = "2026-07-31 13:30:00.001000+00"
    t2 = "2026-07-31 13:30:00.002000+00"

    def base(chain: str, t: str, **over: str) -> dict[str, str]:
        row = {c: "" for c in EXPECTED_COLUMNS} | {
            "id": "019fb85e-0ff4-7953-aec8-a0ad1c0c757d",
            "created_at": "2026-07-31 13:30:00.000000+00",
            "canceled": "f", "trade_id": "0", "exchange": "XPHO",
            "option_chain_id": chain, "underlying_symbol": chain, "executed_at": t,
            "option_type": "call", "expiry": far, "strike": "110.0",
            "underlying_price": "100.0", "open_interest": "10",
            "tags": "{ask_side,bullish}", "report_flags": "{}", "multi_vol": "0",
        }
        return row | over

    def good(chain: str, **over: str) -> dict[str, str]:
        # A single print that clears every gate under the test criteria; `over` wins.
        fields = {"size": "20", "volume": "20", "ask_vol": "18", "multi_vol": "1",
                  "premium": "1400"} | over
        return base(chain, t1, **fields)

    return [
        base("DTC", t1, size="8", volume="8", ask_vol="8", premium="600", price="0.60"),
        base("DTC", t2, size="12", volume="20", ask_vol="18", multi_vol="1", premium="800",
             price="0.75"),
        good("PUTX", option_type="put"),
        good("ETFX", tags="{ask_side,etf}"),
        good("IDXX", tags="{mid_side,neutral,index}"),
        good("SDTE", expiry=near),
        good("ITMX", strike="50.0"),
        good("OOIZ", open_interest="0"),
        good("VOIL", open_interest="100"),
        good("ASKL", ask_vol="10"),
        good("MULT", multi_vol="5"),
        good("FLOR", report_flags="{futures_floor}"),
        good("AVGH", premium="120000"),
        good("PREL", premium="500"),
        base("NVSM", t1, size="5", volume="5", ask_vol="5", premium="300", open_interest="1"),
        base("NVSM", t2, size="15", volume="20", ask_vol="5", premium="1200", open_interest="1"),
        base("REAL", t1, size="200", volume="200", ask_vol="180", premium="600000",
             open_interest="100"),
    ]


def selftest() -> int:
    import tempfile

    checks: list[tuple[str, bool, str]] = []

    def ok(name: str, cond: bool, detail: str = "") -> None:
        checks.append((name, bool(cond), detail))

    # -- Calendar: the holiday TABLE ------------------------------------------
    years = sorted(MARKET_HOLIDAYS)
    ok("holiday table years are contiguous",
       years == list(range(years[0], years[-1] + 1)), f"got {years}")
    for y in years:
        hs = MARKET_HOLIDAYS[y]
        ok(f"no {y} holiday falls on a weekend", all(d.weekday() < 5 for d in hs))
        ok(f"every {y} holiday is dated within {y}", all(d.year == y for d in hs))
        ok(f"{y} has a plausible closure count ({len(hs)})", 9 <= len(hs) <= 11)
    ok("2026-07-03 (observed July 4) is a holiday", date(2026, 7, 3) in market_holidays(2026))
    ok("an ad-hoc closure is carried (Carter, 2025-01-09)",
       date(2025, 1, 9) in market_holidays(2025))
    ok("weekends are not trading days", not is_trading_day(date(2026, 7, 4)))
    ok("a normal weekday is a trading day", is_trading_day(date(2026, 7, 31)))
    ok("a holiday is not a trading day", not is_trading_day(date(2026, 12, 25)))
    try:
        market_holidays(max(years) + 1)
        ok("a year past the table raises", False, "no exception")
    except FatalError as e:
        ok("a year past the table raises FatalError", True)
        ok("that failure names the NYSE source and the year",
           "nyse.com" in (e.help or "") and str(max(years) + 1) in (e.help or ""))

    # -- Trading-day enumeration ----------------------------------------------
    week = trading_days(date(2026, 7, 27), date(2026, 7, 31))
    ok("a full trading week enumerates 5 days", len(week) == 5, f"got {len(week)}")
    span = trading_days(date(2026, 7, 1), date(2026, 7, 10))
    ok("July 1-10 2026 excludes the July 3 observed holiday and weekends",
       date(2026, 7, 3) not in span and date(2026, 7, 4) not in span
       and date(2026, 7, 5) not in span)
    ok("an inverted range is empty", trading_days(date(2026, 7, 31), date(2026, 7, 1)) == [])
    ok("next_trading_day skips the weekend",
       next_trading_day(date(2026, 7, 31)) == date(2026, 8, 3))
    ok("previous_trading_day is inclusive on a session",
       previous_trading_day(date(2026, 7, 31)) == date(2026, 7, 31))

    # -- most_recent_available_date around the 20:00 ET boundary --------------
    before = datetime(2026, 7, 31, 19, 0, tzinfo=EASTERN)
    after = datetime(2026, 7, 31, 20, 30, tzinfo=EASTERN)
    ok("before 20:00 ET, today's tape is not yet available",
       most_recent_available_date(before) == date(2026, 7, 30))
    ok("after 20:00 ET on a session, today's tape is available",
       most_recent_available_date(after) == date(2026, 7, 31))
    sunday = datetime(2026, 8, 2, 21, 0, tzinfo=EASTERN)
    ok("on a weekend, the latest available is the prior Friday",
       most_recent_available_date(sunday) == date(2026, 7, 31))

    # -- Historic-window boundary: the 403 that is NOT a failure --------------
    ok("the fixture routes to the historic boundary, not auth",
       classify_403(_BOUNDARY_FIXTURE, {}) == "historic_boundary")
    earliest, lookback = parse_boundary(_BOUNDARY_FIXTURE)
    ok("the boundary parse recovers the earliest date",
       earliest == date(2026, 3, 23), f"got {earliest}")
    ok("the boundary parse recovers the lookback", lookback == 90, f"got {lookback}")
    ok("an egress 403 is classified as egress, not auth",
       classify_403("Host not in allowlist: api.unusualwhales.com",
                    {"x-deny-reason": "host_not_allowed"}) == "egress")
    ok("a Cloudflare 403 is classified as cloudflare, not auth",
       classify_403("cloudflare 1010 access denied", {}) == "cloudflare")
    ok("a plain forbidden 403 is classified as auth",
       classify_403("forbidden", {}) == "auth")
    _e_hist = _raises_boundary(_BOUNDARY_FIXTURE, {}, date(2025, 12, 31))
    ok("the boundary 403 raises with an actionable help field",
       _e_hist is not None and bool(_e_hist.help))
    ok("the boundary help surfaces the dev@ historic path",
       _e_hist is not None and DEV_HISTORIC_EMAIL in (_e_hist.help or ""))
    ok("parse_boundary degrades gracefully on reworded text",
       parse_boundary("no dates here") == (None, None))

    # -- Response sniff -------------------------------------------------------
    ok("the zip magic is recognized", looks_like_zip(b"PK\x03\x04rest"))
    ok("a JSON body is not mistaken for a zip", not looks_like_zip(b'{"code":"x"}'))
    ok("an empty body is not a zip", not looks_like_zip(b""))

    # -- Headers --------------------------------------------------------------
    h = build_headers("test-key")
    ok("the API key reaches the Authorization header", h["Authorization"] == "Bearer test-key")
    ok("a non-default User-Agent is sent", h.get("User-Agent", "") != "" and "python" not in
       h["User-Agent"].lower())
    ok("UW client attribution is 100003", h["UW-CLIENT-API-ID"] == "100003")
    ok("the module-level attribution constant is 100003", UW_CLIENT_API_ID == "100003")

    # -- Expected schema ------------------------------------------------------
    ok("the tape schema has 40 columns", len(EXPECTED_COLUMNS) == 40)
    ok("both timestamp columns are in the schema",
       all(c in EXPECTED_COLUMNS for c in TIMESTAMP_COLUMNS))
    ok("the schema has no duplicate columns", len(set(EXPECTED_COLUMNS)) == 40)

    # -- Bronze validation gate (pure) ----------------------------------------
    good_src = SourceMetrics(rows=100, empty_tokens={"executed_at": 0, "created_at": 2})
    good_bronze = BronzeMetrics(
        rows=100, columns=EXPECTED_COLUMNS,
        null_counts={"executed_at": 0, "created_at": 2},
        dtypes={c: BRONZE_TIMESTAMP_DTYPE for c in TIMESTAMP_COLUMNS})
    ok("a faithful conversion passes the gate", validate_bronze(good_src, good_bronze) == [])
    row_mismatch = BronzeMetrics(rows=99, columns=EXPECTED_COLUMNS,
                                 null_counts={"executed_at": 0, "created_at": 2},
                                 dtypes={c: BRONZE_TIMESTAMP_DTYPE for c in TIMESTAMP_COLUMNS})
    ok("a row-count mismatch fails the gate", validate_bronze(good_src, row_mismatch) != [])
    new_null = BronzeMetrics(rows=100, columns=EXPECTED_COLUMNS,
                             null_counts={"executed_at": 1, "created_at": 2},
                             dtypes={c: BRONZE_TIMESTAMP_DTYPE for c in TIMESTAMP_COLUMNS})
    ok("a new timestamp null fails the gate (no silent coercion)",
       validate_bronze(good_src, new_null) != [])
    wrong_cols = BronzeMetrics(rows=100, columns=EXPECTED_COLUMNS[:-1],
                               null_counts={"executed_at": 0, "created_at": 2},
                               dtypes={c: BRONZE_TIMESTAMP_DTYPE for c in TIMESTAMP_COLUMNS})
    ok("a dropped column fails the gate", validate_bronze(good_src, wrong_cols) != [])
    wrong_dtype = BronzeMetrics(rows=100, columns=EXPECTED_COLUMNS,
                                null_counts={"executed_at": 0, "created_at": 2},
                                dtypes={"executed_at": pl.String, "created_at": BRONZE_TIMESTAMP_DTYPE})
    ok("an un-typed timestamp fails the gate", validate_bronze(good_src, wrong_dtype) != [])

    # -- End-to-end conversion on a synthetic 40-column tape ------------------
    with tempfile.TemporaryDirectory() as td:
        lake = Path(td) / "lake"
        good_rows = [
            _base_tape_row("2026-07-31 13:30:00.003764+00", "2026-07-31 13:30:00.052358+00"),
            _base_tape_row("2026-07-31 13:30:00.004945+00", "2026-07-31 13:30:00.057561+00"),
            _base_tape_row("2026-07-31 13:30:00.008749+00", ""),  # legitimately empty created_at
        ]
        csv_ok = work_dir(lake) / "good.csv"
        csv_ok.parent.mkdir(parents=True, exist_ok=True)
        csv_ok.write_text(_synthetic_tape_csv(good_rows), encoding="utf-8")
        src = source_metrics(csv_ok)
        ok("source_metrics counts rows", src.rows == 3, f"got {src.rows}")
        ok("source_metrics counts the empty created_at token",
           src.empty_tokens["created_at"] == 1, f"got {src.empty_tokens}")
        out_ok = bronze_path(lake, date(2026, 7, 31))
        write_bronze_parquet(csv_ok, out_ok)
        bm = bronze_metrics(out_ok)
        ok("the round-trip preserves all 40 columns", bm.columns == EXPECTED_COLUMNS)
        ok("the round-trip preserves the row count", bm.rows == 3, f"got {bm.rows}")
        ok("timestamps are typed Datetime[us, UTC]",
           bm.dtypes["executed_at"] == BRONZE_TIMESTAMP_DTYPE)
        ok("a legitimately empty timestamp stays null without tripping the gate",
           validate_bronze(src, bm) == [], f"got {validate_bronze(src, bm)}")

        bad_rows = [
            _base_tape_row("2026-07-31 13:30:00.003764+00", "2026-07-31 13:30:00.052358+00"),
            _base_tape_row("not-a-timestamp", "2026-07-31 13:30:00.057561+00"),
        ]
        csv_bad = work_dir(lake) / "bad.csv"
        csv_bad.write_text(_synthetic_tape_csv(bad_rows), encoding="utf-8")
        src_bad = source_metrics(csv_bad)
        out_bad = bronze_path(lake, date(2026, 7, 30))
        write_bronze_parquet(csv_bad, out_bad)
        bm_bad = bronze_metrics(out_bad)
        ok("a corrupted timestamp trips the no-new-nulls gate",
           validate_bronze(src_bad, bm_bad) != [])

    # -- A JSON error body saved as .zip is rejected with the boundary remedy --
    with tempfile.TemporaryDirectory() as td:
        fake = Path(td) / "2025-12-31_full_tape.zip"
        fake.write_text(_BOUNDARY_FIXTURE, encoding="utf-8")
        _e = _raises_fatal_get(lambda: extract_csv(fake, Path(td)))
        ok("a JSON error body saved as .zip is rejected, not parsed as a zip",
           _e is not None)
        ok("that rejection surfaces the historic-access remedy",
           _e is not None and DEV_HISTORIC_EMAIL in (_e.help or ""))

    # -- Disk estimate math ---------------------------------------------------
    with tempfile.TemporaryDirectory() as td:
        est = disk_estimate(Path(td) / "empty", 10)
        ok("the estimate uses the fallback anchor when the lake is empty",
           est.per_day_parquet == PARQUET_BYTES_PER_DAY_ESTIMATE)
        ok("steady-state total scales with day count",
           est.steady_state_total == PARQUET_BYTES_PER_DAY_ESTIMATE * 10)
        ok("peak transient includes zip + CSV + parquet",
           est.peak_transient == ZIP_BYTES_PER_DAY + CSV_BYTES_PER_DAY + est.per_day_parquet)

    # -- .env parser ----------------------------------------------------------
    pv = parse_dotenv_value
    ok("plain KEY=VALUE is read", pv("UW_API_KEY=abc123", "UW_API_KEY") == "abc123")
    ok("a quoted value is unquoted", pv('UW_API_KEY="abc123"', "UW_API_KEY") == "abc123")
    ok("an export prefix is stripped", pv("export UW_API_KEY=abc123", "UW_API_KEY") == "abc123")
    ok("surrounding whitespace is ignored", pv("  UW_API_KEY = abc123  ", "UW_API_KEY") == "abc123")
    ok("a missing key returns None", pv("OTHER=1\n", "UW_API_KEY") is None)
    ok("an empty value returns None", pv("UW_API_KEY=", "UW_API_KEY") is None)
    ok("a # inside the value is preserved", pv("UW_API_KEY=ab#c123", "UW_API_KEY") == "ab#c123")
    ok("the .env parser is name-agnostic (reads UW_API_TOKEN too)",
       pv("UW_API_TOKEN=tok123", "UW_API_TOKEN") == "tok123")

    # -- Key resolution accepts both UW_API_KEY and UW_API_TOKEN --------------
    ok("UW_API_KEY and UW_API_TOKEN are both accepted names",
       set(API_KEY_ENV_NAMES) == {"UW_API_KEY", "UW_API_TOKEN"})
    ok("resolution finds a UW_API_KEY", _select_key({"UW_API_KEY": "k"}.get) == "k")
    ok("resolution finds a UW_API_TOKEN when only it is present",
       _select_key({"UW_API_TOKEN": "t"}.get) == "t")
    ok("UW_API_KEY wins when both are present",
       _select_key({"UW_API_KEY": "k", "UW_API_TOKEN": "t"}.get) == "k")
    ok("resolution returns None when neither is present", _select_key({}.get) is None)

    # -- TOON emitter ---------------------------------------------------------
    ok("a plain scalar is unquoted", _toon_scalar("MSTR") == "MSTR")
    ok("a value with a comma is quoted", _toon_scalar("a,b") == '"a,b"')
    ok("a value with a colon is quoted", _toon_scalar("a:b") == '"a:b"')
    ok("an empty value is quoted", _toon_scalar("") == '""')
    ok("an embedded quote is doubled", _toon_scalar('a"b') == '"a""b"')
    ok("None renders as an empty quoted value", _toon_scalar(None) == '""')

    # -- human_bytes ----------------------------------------------------------
    ok("bytes under 1K render as B", human_bytes(512) == "512 B")
    ok("a gigabyte renders as GB", human_bytes(1_500_000_000).endswith("GB"))

    # -- ProgressMeter throttling ---------------------------------------------
    def _capture_stderr(fn) -> str:
        buf = io.StringIO()
        saved = sys.stderr
        sys.stderr = buf
        try:
            fn()
        finally:
            sys.stderr = saved
        return buf.getvalue()

    def _drive_meter(isatty: bool, clock: Callable[[], float]) -> None:
        m = ProgressMeter("2026-07-31", 1000, isatty=isatty, clock=clock)
        for b in range(0, 1001, 100):
            m.update(b)
        m.done(1000)

    non_tty = [ln for ln in _capture_stderr(
        lambda: _drive_meter(False, lambda: 0.0)).splitlines() if ln]
    ok("non-tty progress collapses 11 updates to 4 checkpoint lines",
       len(non_tty) == 4, f"got {len(non_tty)}")
    ok("non-tty progress ends at 100%", non_tty[-1].endswith("(100%)"))
    ok("non-tty progress never spams per update", len(non_tty) < 11)

    frozen = _capture_stderr(lambda: _drive_meter(True, lambda: 0.0))
    ok("tty progress redraws with a carriage return", "\r" in frozen)
    ok("tty progress prints exactly one newline (from done)", frozen.count("\n") == 1)

    unknown_total = ProgressMeter("d", 0, isatty=False)
    got = _capture_stderr(lambda: (unknown_total.update(500), unknown_total.done(500)))
    ok("an unknown total shows bytes without a misleading percent",
       "%" not in got and "500 B" in got)

    # -- Bronze path layout (offline) -----------------------------------------
    _blk = Path("some_lake")
    ok("bronze parquet lives under bronze/full-tape",
       bronze_dir(_blk) == _blk / "bronze" / "full-tape")
    ok("a bronze day parquet lands in the full-tape dataset dir",
       bronze_path(_blk, date(2026, 7, 31))
       == _blk / "bronze" / "full-tape" / "2026-07-31.parquet")

    # -- Silver path helpers and coverage scan (offline) ----------------------
    _lk = Path("some_lake")
    ok("silver bars live under silver/option-contracts-1m",
       silver_bars_dir(_lk) == _lk / "silver" / "option-contracts-1m")
    ok("a silver partition uses the Hive date= layout",
       silver_partition_dir(_lk, date(2026, 7, 31))
       == _lk / "silver" / "option-contracts-1m" / "date=2026-07-31")
    ok("a silver partition file is bars.parquet",
       silver_partition_path(_lk, date(2026, 7, 31)).name == "bars.parquet")
    ok("a well-formed partition dir name parses to its date",
       _parse_silver_partition_date("date=2026-07-31") == date(2026, 7, 31))
    ok("a bronze parquet name is not a silver partition",
       _parse_silver_partition_date("2026-07-31.parquet") is None)
    ok("a malformed partition dir name parses to None",
       _parse_silver_partition_date("date=not-a-date") is None)

    miss, orph = silver_coverage(
        [date(2026, 7, 27), date(2026, 7, 28), date(2026, 7, 29)], [date(2026, 7, 28)])
    ok("coverage flags bronze dates with no silver as missing",
       miss == [date(2026, 7, 27), date(2026, 7, 29)], f"got {miss}")
    ok("coverage reports no orphans when silver is a subset of bronze", orph == [], f"got {orph}")
    _m2, orph2 = silver_coverage([date(2026, 7, 27)], [date(2026, 7, 28)])
    ok("coverage flags a silver date with no bronze as an orphan",
       orph2 == [date(2026, 7, 28)], f"got {orph2}")

    with tempfile.TemporaryDirectory() as td:
        lake = Path(td) / "lake"
        ok("an empty lake has zero silver dates", present_silver_dates(lake) == {})
        part = silver_partition_path(lake, date(2026, 7, 31))
        part.parent.mkdir(parents=True, exist_ok=True)
        part.write_bytes(b"PAR1-stand-in-bytes")
        found = present_silver_dates(lake)
        ok("present_silver_dates finds a committed partition",
           set(found) == {date(2026, 7, 31)}, f"got {set(found)}")
        ok("present_silver_dates reports the bars.parquet byte size",
           found[date(2026, 7, 31)] == part.stat().st_size)
        silver_partition_dir(lake, date(2026, 7, 30)).mkdir(parents=True, exist_ok=True)
        ok("a partition dir with no bars file is not counted present",
           date(2026, 7, 30) not in present_silver_dates(lake))

    # -- Silver bar builder and validation gate (offline) ---------------------
    ok("the silver schema has 33 columns", len(SILVER_COLUMNS) == 33)
    ok("the silver schema has no duplicate columns", len(set(SILVER_COLUMNS)) == 33)
    ok("every silver source column exists in the bronze schema",
       all(c in EXPECTED_COLUMNS for c in SILVER_SOURCE_COLUMNS))

    with tempfile.TemporaryDirectory() as td:
        lake = Path(td) / "lake"
        csv_s = work_dir(lake) / "silver_src.csv"
        csv_s.parent.mkdir(parents=True, exist_ok=True)
        csv_s.write_text(_synthetic_tape_csv(_silver_tape_rows()), encoding="utf-8")
        bronze_s = bronze_path(lake, date(2026, 7, 31))
        write_bronze_parquet(csv_s, bronze_s)

        src_vol = source_noncanceled_volume(bronze_s)
        ok("source non-canceled volume sums size over kept trades", src_vol == 16, f"got {src_vol}")

        bars = build_bars(bronze_s)
        ok("bars carry the exact 33-column schema in order",
           tuple(bars.columns) == SILVER_COLUMNS)
        ok("one bar per (chain, minute): 2 chains -> 3 bars", bars.height == 3, f"got {bars.height}")
        ok("minute_utc is Datetime[us, UTC]", bars.schema["minute_utc"] == SILVER_MINUTE_UTC_DTYPE)
        ok("minute_et is Datetime[us, America/New_York]",
           bars.schema["minute_et"] == SILVER_MINUTE_ET_DTYPE)
        ok("expiry is tightened to Date", bars.schema["expiry"] == pl.Date)

        a_rows = bars.filter(pl.col("option_chain_id") == "MSTR270115C00095000").sort("minute_utc")
        a1 = a_rows.row(0, named=True)
        a2 = a_rows.row(1, named=True)
        ok("open is the first non-canceled print", a1["open"] == 10.0, f"got {a1['open']}")
        ok("high excludes the canceled off-market bust (50.0)", a1["high"] == 12.0, f"got {a1['high']}")
        ok("low is the minute minimum", a1["low"] == 10.0, f"got {a1['low']}")
        ok("close is the last non-canceled print", a1["close"] == 12.0, f"got {a1['close']}")
        ok("volume is sum(size) over non-canceled trades", a1["volume"] == 5, f"got {a1['volume']}")
        ok("trade_count counts non-canceled prints", a1["trade_count"] == 2, f"got {a1['trade_count']}")
        ok("premium sums dollar premium", a1["premium"] == 5600.0, f"got {a1['premium']}")
        ok("ask_volume de-cumulates the ask counter (first minute = raw)",
           a1["ask_volume"] == 2, f"got {a1['ask_volume']}")
        ok("bid_volume de-cumulates the bid counter", a1["bid_volume"] == 3, f"got {a1['bid_volume']}")
        ok("no_side_volume includes the canceled trade's counter contribution",
           a1["no_side_volume"] == 1, f"got {a1['no_side_volume']}")
        ok("bid_close/ask_close snapshot the last non-canceled quote",
           a1["bid_close"] == 11.9 and a1["ask_close"] == 12.1)
        ok("underlying_open/close snapshot first/last underlying_price",
           a1["underlying_open"] == 100.0 and a1["underlying_close"] == 101.0)
        ok("the second minute's ask_volume is the cross-minute delta (6 - 2)",
           a2["ask_volume"] == 4, f"got {a2['ask_volume']}")

        types = dict(zip(bars["option_chain_id"], bars["security_type"]))
        ok("an equity chain (no etf/index tag) is security_type equity",
           types["MSTR270115C00095000"] == "equity")
        ok("an etf-tagged chain is security_type etf", types["SPY270115C00500000"] == "etf")

        ok("a faithful bar set passes the gate", validate_silver(bars, src_vol) == [],
           f"got {validate_silver(bars, src_vol)}")
        ok("a volume-reconciliation mismatch fails the gate",
           validate_silver(bars, src_vol + 1) != [])
        dup = bars.vstack(bars.head(1))
        ok("a duplicate grain fails the gate even when volume still reconciles",
           validate_silver(dup, int(dup["volume"].sum())) != [])
        ok("an OHLC bound violation fails the gate",
           validate_silver(bars.with_columns(pl.lit(0.0).alias("high")), src_vol) != [])
        ok("a trade_count below 1 fails the gate",
           validate_silver(bars.with_columns(pl.lit(0, dtype=pl.Int64).alias("trade_count")),
                           src_vol) != [])
        ok("a bad security_type fails the gate",
           validate_silver(bars.with_columns(pl.lit("bogus").alias("security_type")), src_vol) != [])
        ok("a tz-stripped minute_utc fails the gate",
           validate_silver(bars.with_columns(pl.col("minute_utc").dt.replace_time_zone(None)),
                           src_vol) != [])
        ok("a missing column fails the gate", validate_silver(bars.drop("vwap"), src_vol) != [])

        bad_rows = _silver_tape_rows()
        bad_rows[0] = bad_rows[0] | {"canceled": "x"}
        csv_bad = work_dir(lake) / "silver_bad.csv"
        csv_bad.write_text(_synthetic_tape_csv(bad_rows), encoding="utf-8")
        bronze_bad = bronze_path(lake, date(2026, 7, 30))
        write_bronze_parquet(csv_bad, bronze_bad)
        _e_dom = _raises_fatal_get(lambda: build_bars(bronze_bad))
        ok("a canceled token outside {t, f} trips the domain guard", _e_dom is not None)

    # -- Silver disk estimate + incremental build (offline) -------------------
    with tempfile.TemporaryDirectory() as td:
        est = silver_disk_estimate(Path(td) / "empty", 8)
        ok("the silver estimate uses the anchor when no silver files exist",
           est.per_day_bars == SILVER_BYTES_PER_DAY_ESTIMATE)
        ok("silver steady-state total scales with day count",
           est.steady_state_total == SILVER_BYTES_PER_DAY_ESTIMATE * 8)

    with tempfile.TemporaryDirectory() as td:
        lake = Path(td) / "lake"
        csv_s = work_dir(lake) / "s.csv"
        csv_s.parent.mkdir(parents=True, exist_ok=True)
        csv_s.write_text(_synthetic_tape_csv(_silver_tape_rows()), encoding="utf-8")
        d1 = date(2026, 7, 31)
        write_bronze_parquet(csv_s, bronze_path(lake, d1))

        res = build_silver_one(lake, d1)
        ok("build_silver_one commits a partition of the expected bar count",
           res is not None and res.bars == 3, f"got {res}")
        ok("the committed partition is discoverable by the coverage scan",
           set(present_silver_dates(lake)) == {d1})
        ok("no .tmp working file is left beside the committed partition",
           not (silver_partition_dir(lake, d1) / (SILVER_BARS_FILE + ".tmp")).exists())
        committed = pl.read_parquet(silver_partition_path(lake, d1))
        ok("the committed bars reconcile to the source non-canceled volume",
           int(committed["volume"].sum()) == source_noncanceled_volume(bronze_path(lake, d1)))
        ok("the committed partition carries the exact 33-column schema",
           tuple(committed.columns) == SILVER_COLUMNS)
        ok("re-building an existing partition is an idempotent no-op",
           build_silver_one(lake, d1) is None)

        d2 = date(2026, 7, 30)
        ok("building a date with no bronze parquet is a no-op (None)",
           build_silver_one(lake, d2) is None)
        ok("a no-bronze date produces no silver partition",
           d2 not in present_silver_dates(lake))
        est2 = silver_disk_estimate(lake, 5)
        ok("the silver estimate switches to the measured average once files exist",
           "measured" in est2.bars_anchor)

    # -- Screener: pure screen + gate (offline) -------------------------------
    ok("the screener output schema has 19 columns", len(SCREEN_COLUMNS) == 19,
       f"got {len(SCREEN_COLUMNS)}")
    ok("the screener output schema has no duplicate columns",
       len(set(SCREEN_COLUMNS)) == len(SCREEN_COLUMNS))
    ok("detected_price is in the screener output schema",
       "detected_price" in SCREEN_COLUMNS)
    ok("a single-date screen result path is named for that date",
       screen_result_path(Path("lake"), date(2026, 7, 27), None).name
       == "screen_2026-07-27.csv")
    ok("a range screen result path carries both endpoints",
       screen_result_path(Path("lake"), date(2026, 7, 27), date(2026, 7, 31)).name
       == "screen_2026-07-27_2026-07-31.csv")
    _dc = ScreenCriteria()
    ok("the default criteria are the illustrative long-dated call filter",
       _dc.min_premium == 500_000.0 and _dc.min_dte == 181 and _dc.min_otm_pct == -0.12
       and _dc.option_type == "call" and _dc.security_types == ("equity",))
    _sec = (pl.DataFrame({"tags": ["{ask_side,etf}", "{x,index}", "{ask_side,bullish}"]})
            .select(security_type_expr())["security_type"].to_list())
    ok("security_type_expr classifies etf / index / equity",
       _sec == ["etf", "index", "equity"], f"got {_sec}")

    def approx(a: object, b: float) -> bool:
        return abs(float(a) - b) < 1e-6  # type: ignore[arg-type]

    with tempfile.TemporaryDirectory() as td:
        lake = Path(td) / "lake"
        csv_sc = work_dir(lake) / "screen_src.csv"
        csv_sc.parent.mkdir(parents=True, exist_ok=True)
        csv_sc.write_text(_synthetic_tape_csv(_screen_tape_rows()), encoding="utf-8")
        bronze_sc = bronze_path(lake, date(2026, 7, 31))
        write_bronze_parquet(csv_sc, bronze_sc)
        session = date(2026, 7, 31)

        res = screen_bronze(bronze_sc, ScreenCriteria(min_premium=1000.0), session)
        hits = set(res["option_chain_id"].to_list())
        ok("the detect chain is flagged", "DTC" in hits, f"got {sorted(hits)}")
        excluded = {"PUTX", "ETFX", "IDXX", "SDTE", "ITMX", "OOIZ", "VOIL",
                    "ASKL", "MULT", "FLOR", "AVGH", "PREL"}
        ok("every single-gate-failing chain is excluded",
           excluded.isdisjoint(hits), f"leaked {sorted(excluded & hits)}")
        ok("a chain that never clears all gates at once is not detected",
           "NVSM" not in hits)

        d = res.filter(pl.col("option_chain_id") == "DTC").row(0, named=True)
        ok("detection is the second print (moment all gates first hold)",
           d["detected_at"].microsecond == 2000, f"got {d['detected_at']}")
        ok("detected cum_premium is the running sum at detection",
           approx(d["cum_premium"], 1400), f"got {d['cum_premium']}")
        ok("detected volume is the native cumulative counter", d["volume"] == 20)
        ok("detected vol_oi_ratio", approx(d["vol_oi_ratio"], 2.0))
        ok("detected ask_pct comes from the native ask counter", approx(d["ask_pct"], 0.9))
        ok("detected multi_pct comes from the native multi counter",
           approx(d["multi_pct"], 0.05))
        ok("detected floor_pct is zero without floor prints", approx(d["floor_pct"], 0.0))
        ok("detected avg_price is cum_premium/volume/100", approx(d["avg_price"], 0.7))
        ok("detected otm_pct is strike/spot - 1", approx(d["otm_pct"], 0.1))
        ok("dte is measured from the session date",
           d["dte"] == (date(2027, 6, 17) - session).days, f"got {d['dte']}")
        ok("expiry is tightened to Date", d["expiry"] == date(2027, 6, 17))
        ok("the detected contract is an equity call",
           d["security_type"] == "equity" and d["option_type"] == "call")
        ok("detected_price is the moment-of-detection print's own price",
           approx(d["detected_price"], 0.75), f"got {d['detected_price']}")

        screen_csv = screens_dir(lake) / "roundtrip.csv"
        write_screen_csv(res, screen_csv)
        rt = read_screen_csv(screen_csv)
        ok("read_screen_csv restores detected_at as Datetime[us, UTC]",
           rt["detected_at"].dtype == SILVER_MINUTE_UTC_DTYPE)
        ok("read_screen_csv restores expiry as a Date", rt["expiry"].dtype == pl.Date)
        rt_dtc = rt.filter(pl.col("option_chain_id") == "DTC").row(0, named=True)
        ok("the screen CSV round trip preserves detected_at to the microsecond",
           rt_dtc["detected_at"] == d["detected_at"], f"got {rt_dtc['detected_at']}")
        ok("the screen CSV round trip preserves expiry as the same Date",
           rt_dtc["expiry"] == date(2027, 6, 17))
        ok("the screen CSV round trip preserves detected_price",
           approx(rt_dtc["detected_price"], 0.75))

        res_real = screen_bronze(bronze_sc, ScreenCriteria(), session)
        real_hits = set(res_real["option_chain_id"].to_list())
        ok("the $500K-clearing chain passes the real defaults", "REAL" in real_hits)
        ok("the detect chain is dropped by the real $500K premium floor",
           "DTC" not in real_hits, f"got {sorted(real_hits)}")
        rr = res_real.filter(pl.col("option_chain_id") == "REAL").row(0, named=True)
        ok("the real-defaults contract reconciles cum_premium and avg_price",
           approx(rr["cum_premium"], 600000) and approx(rr["avg_price"], 30.0))
        prem_order = res_real["cum_premium"].to_list()
        ok("the screener result is sorted by cum_premium descending",
           prem_order == sorted(prem_order, reverse=True))

    # -- Forward performance: pure metrics over synthetic silver (offline) -----
    ok("FORWARD_COLUMNS is the input, silver-metric, and expiry columns",
       FORWARD_COLUMNS == FORWARD_INPUT_COLUMNS + FORWARD_METRIC_COLUMNS + FORWARD_EXPIRY_COLUMNS
       and len(set(FORWARD_COLUMNS)) == len(FORWARD_COLUMNS))
    ok("every forward input column is available from a screen result",
       all(c in SCREEN_COLUMNS for c in FORWARD_INPUT_COLUMNS))

    def _utc(col: str) -> pl.Expr:
        return pl.col(col).str.to_datetime(time_unit="us", time_zone="UTC")

    fdet = pl.DataFrame({
        "underlying_symbol": ["AAA", "BBB"],
        "option_chain_id": ["AAA", "BBB"],
        "option_type": ["call", "put"],
        "strike": [100.0, 200.0],
        "expiry": [date(2027, 1, 15), date(2027, 1, 15)],
        "dte": [200, 200],
        "detected_at": ["2026-07-27T13:35:00.500000", "2026-07-28T15:00:00.000000"],
        "detected_price": [5.0, 9.0],
        "avg_price": [4.8, 8.9],
    }).with_columns(_utc("detected_at"))

    fbars = pl.DataFrame({
        "option_chain_id": ["AAA", "AAA", "AAA", "AAA"],
        "minute_utc": ["2026-07-27T13:35:00", "2026-07-27T13:36:00",
                       "2026-07-27T13:40:00", "2026-07-28T14:00:00"],
        "low": [1.0, 2.0, 3.0, 2.5],
        "high": [9.0, 6.0, 7.0, 8.0],
        "close": [5.0, 4.0, 4.5, 6.0],
        "date": [date(2026, 7, 27), date(2026, 7, 27), date(2026, 7, 27), date(2026, 7, 28)],
    }).with_columns(_utc("minute_utc"))

    fm = forward_metrics(fbars.lazy(), fdet)
    ra = fm.filter(pl.col("option_chain_id") == "AAA").row(0, named=True)
    rb = fm.filter(pl.col("option_chain_id") == "BBB").row(0, named=True)
    ok("min_after excludes the detection-minute bar (no pre-detection leak)",
       approx(ra["min_after"], 2.0), f"got {ra['min_after']}")
    ok("max_after includes a later-day forward bar",
       approx(ra["max_after"], 8.0), f"got {ra['max_after']}")
    ok("latest_after is the last forward bar's close",
       approx(ra["latest_after"], 6.0), f"got {ra['latest_after']}")
    ok("forward_bars counts only bars strictly after the detection minute",
       ra["forward_bars"] == 3, f"got {ra['forward_bars']}")
    ok("last_forward_minute is the max forward minute (later day)",
       ra["last_forward_minute"].strftime("%Y-%m-%d %H:%M") == "2026-07-28 14:00",
       f"got {ra['last_forward_minute']}")
    ok("a contract with no forward bars keeps a row with null prices and 0 bars",
       rb["forward_bars"] == 0 and rb["min_after"] is None and rb["latest_after"] is None)
    ok("forward_metrics echoes the detection context and drops the work column",
       ra["detected_price"] == 5.0 and ra["underlying_symbol"] == "AAA"
       and "detection_minute" not in fm.columns)

    fm_none = forward_metrics(None, fdet)
    ok("with no silver present, every contract has null prices and 0 forward bars",
       fm_none["forward_bars"].to_list() == [0, 0]
       and fm_none["min_after"].null_count() == 2)

    # -- Forward performance: theoretical-at-expiry (offline, injected fetch) --
    ok("parse_ohlc_close returns the regular-hours close, not pre/post market",
       approx(parse_ohlc_close(_OHLC_FIXTURE, date(2026, 7, 21)), 327.74),
       f"got {parse_ohlc_close(_OHLC_FIXTURE, date(2026, 7, 21))}")
    ok("parse_ohlc_close filters by date to the right regular-hours row",
       approx(parse_ohlc_close(_OHLC_FIXTURE, date(2026, 7, 22)), 325.89))
    ok("parse_ohlc_close returns None for a date not in the response",
       parse_ohlc_close(_OHLC_FIXTURE, date(2026, 7, 20)) is None)
    ok("parse_ohlc_close returns None on a malformed body",
       parse_ohlc_close("not json", date(2026, 7, 21)) is None)
    ok("intrinsic of an in-the-money call is S - K",
       approx(intrinsic_at_expiry("call", 320.0, 327.74), 7.74))
    ok("intrinsic of an out-of-the-money call is 0",
       approx(intrinsic_at_expiry("call", 330.0, 327.74), 0.0))
    ok("intrinsic of an in-the-money put is K - S",
       approx(intrinsic_at_expiry("put", 330.0, 327.74), 2.26))
    ok("intrinsic of an out-of-the-money put is 0",
       approx(intrinsic_at_expiry("put", 320.0, 327.74), 0.0))
    ok("an unknown option_type raises a structured error",
       isinstance(_raises_fatal_get(lambda: intrinsic_at_expiry("x", 1.0, 2.0)), FatalError))

    theo_calls: list[tuple[str, date]] = []

    def _stub_fetch(ticker: str, exp: date) -> float | None:
        theo_calls.append((ticker, exp))
        return {("AAPL", date(2026, 7, 21)): 327.74}.get((ticker, exp))

    theo_frame = pl.DataFrame({
        "underlying_symbol": ["AAPL", "AAPL", "MSTR", "NVDA"],
        "expiry": [date(2026, 7, 21), date(2026, 7, 21), date(2026, 7, 21), date(2027, 1, 15)],
        "option_type": ["call", "put", "call", "call"],
        "strike": [320.0, 330.0, 500.0, 100.0],
    })
    theo = with_theo_at_expiry(theo_frame, date(2026, 8, 4), _stub_fetch)
    tv = theo["theo_at_expiry"].to_list()
    ok("an expired ITM call is priced to its intrinsic at expiry", approx(tv[0], 7.74),
       f"got {tv[0]}")
    ok("an expired ITM put is priced to its intrinsic at expiry", approx(tv[1], 2.26))
    ok("an expired contract with no settle price stays null (MSTR)", tv[2] is None)
    ok("a not-yet-expired contract is never priced at expiry", tv[3] is None)
    ok("the expired flag is set exactly for contracts past their expiry",
       theo["expired"].to_list() == [True, True, True, False])
    ok("the underlying close is fetched once per unique (ticker, expiry)",
       theo_calls.count(("AAPL", date(2026, 7, 21))) == 1
       and len(theo_calls) == 2, f"got {theo_calls}")

    # -- Forward performance: durable --out CSV (offline) ---------------------
    with tempfile.TemporaryDirectory() as td:
        fwd_out = Path(td) / "forward.csv"
        fwrite = pl.DataFrame({
            "option_chain_id": ["AAA", "BBB"],
            "expiry": [date(2027, 1, 15), date(2027, 1, 15)],
            "detected_at": ["2026-07-27T13:35:00.500000", "2026-07-28T15:00:00.000000"],
            "last_forward_minute": ["2026-07-31T19:59:00.000000", None],
            "forward_bars": [29, 0],
            "theo_at_expiry": [None, None],
        }).with_columns(
            _utc("detected_at"),
            pl.col("last_forward_minute").str.to_datetime(time_unit="us", time_zone="UTC"),
        )
        write_forward_csv(fwrite, fwd_out)
        back = pl.read_csv(fwd_out).with_columns(
            pl.col("detected_at").str.to_datetime(time_unit="us", time_zone="UTC"),
            pl.col("last_forward_minute").str.to_datetime(time_unit="us", time_zone="UTC"),
            pl.col("expiry").str.to_date(),
        )
        ba = back.filter(pl.col("option_chain_id") == "AAA").row(0, named=True)
        bb = back.filter(pl.col("option_chain_id") == "BBB").row(0, named=True)
        ok("write_forward_csv preserves detected_at to the microsecond",
           ba["detected_at"] == fwrite.filter(pl.col("option_chain_id") == "AAA")
           .row(0, named=True)["detected_at"])
        ok("write_forward_csv preserves last_forward_minute",
           ba["last_forward_minute"].strftime("%Y-%m-%d %H:%M") == "2026-07-31 19:59")
        ok("write_forward_csv leaves a null last_forward_minute blank",
           bb["last_forward_minute"] is None)
        ok("write_forward_csv writes expiry as a parseable Date",
           back["expiry"].dtype == pl.Date)

    # -- Report ---------------------------------------------------------------
    failed = [c for c in checks if not c[1]]
    for name, passed, detail in checks:
        if not passed:
            print(f"FAIL  {name}" + (f"  [{detail}]" if detail else ""))
    print(f"\nselftest: {len(checks) - len(failed)}/{len(checks)} checks passed")
    if failed:
        print("\nDO NOT RUN A BUILD. This file did not transcribe correctly, or a "
              "constant changed. Re-copy it from the Skill and re-run --selftest.")
        return 1
    print("All checks passed with zero API calls. Safe to build.")
    return 0


def _raises_fatal_get(fn) -> FatalError | None:
    try:
        fn()
        return None
    except FatalError as e:
        return e


def _raises_boundary(body: str, headers: dict[str, str], d: date) -> FatalError | None:
    try:
        _raise_403(body, headers, d)
        return None
    except FatalError as e:
        return e


if __name__ == "__main__":
    sys.exit(main())
```
