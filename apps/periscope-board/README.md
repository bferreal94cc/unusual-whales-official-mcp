# Periscope board

A local positioning board for SPY, XSP or any other Unusual Whales ticker: options flow,
market tide, gamma exposure and dark-pool prints for the last three sessions and the next
five expiries.

The point of running it as a server rather than a static page: **your API key stays on the
server side.** The browser talks to `localhost`, the server talks to Unusual Whales. Swap
the key in one file and restart — nothing else changes.

## Run it

```bash
cd apps/periscope-board
cp .env.example .env         # then put your key in UW_API_KEY
npm start                    # http://localhost:8787
```

No dependencies, no build step, no lockfile. Node 20 or newer is the only requirement.

To swap keys later, edit `.env` and restart. A key set in the real environment wins over
the file, so this also works:

```bash
UW_API_KEY=your_other_key npm start
```

If `apps/periscope-board/.env` doesn't exist the server falls back to the repository root
`.env`, so one key can serve both this board and the MCP server.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `UW_API_KEY` | *required* | Your Unusual Whales key. Never sent to the browser. |
| `UW_TRANSPORT` | `mcp` | `mcp` calls the hosted MCP server; `rest` calls the REST API directly. Same data either way. |
| `TICKERS` | `SPY,XSP` | Comma-separated. The first one leads: it drives the tide chart, dark pool and session dates. |
| `PORT` | `8787` | Listen port. |
| `CACHE_TTL` | `300` | Seconds to hold a built board in memory. Every refresh costs ~40 API calls, so don't drop this far. |
| `UW_ENV_FILE` | — | Load the env file from somewhere else entirely. |

## Endpoints

| Route | Returns |
|---|---|
| `GET /` | The board. |
| `GET /api/board` | The whole payload as JSON. `?refresh=1` forces a rebuild, `?tickers=SPY,QQQ` overrides the default set. |
| `GET /api/health` | Whether a key is loaded, which env file it came from, which transport is active, cache age. |

`/api/board` is the whole contract — point anything you like at it.

## How a board gets built

`src/aggregate.mjs` resolves the last three sessions from the greek-exposure history (no
market calendar needed), then fans out ~40 calls at five in flight and folds the responses
into one payload:

- **Flow** — whole-session totals from strike-level flow, the forward expiries from
  flow-per-expiry, and block-size trades walked page by page (each page caps at 50 rows).
- **Tide** — the lead ticker's ETF tide beside the whole-market tide, downsampled to
  five-minute steps.
- **Gamma** — by expiry per session, by strike for the latest session, and 22 sessions of
  whole-chain history.
- **Dark pool** — prints of $5M notional and up, bucketed by price level.

## Deploying it

It's one Node process with no state beyond an in-memory cache, so anything that runs Node
will host it. Set `UW_API_KEY` as a secret in the platform's own config rather than shipping
a `.env`:

```bash
# any box
PORT=8080 UW_API_KEY=… node server.mjs

# docker
docker run --rm -p 8080:8080 -e PORT=8080 -e UW_API_KEY=… \
  -v "$PWD:/app" -w /app node:22-alpine node server.mjs
```

Two things to sort out before it faces anything but your own machine: the server has **no
authentication**, so anyone who can reach the port can spend your API quota, and the cache
is per-process, so multiple instances each pay for their own refreshes. Behind a private
network or an authenticating proxy, neither matters.

## What it is not

Decision support. There is no position tracking, no order routing, and no execution logic
anywhere in it.
