"""Read-only Unusual Whales REST adapter. Secret never reaches browser markup."""
import os
import requests

API_ROOT = "https://api.unusualwhales.com"

class UWError(RuntimeError):
    pass


def fetch(path: str, *, token: str | None = None, params: dict | None = None):
    key = token or os.environ.get("UNUSUAL_WHALES_API_KEY", "")
    if not key:
        raise UWError("Missing UNUSUAL_WHALES_API_KEY in server-side secrets")
    if not path.startswith("/api/") or ".." in path:
        raise UWError("Invalid API path")
    try:
        response = requests.get(
            API_ROOT + path,
            params=params,
            headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
            timeout=18,
        )
        response.raise_for_status()
        return response.json()
    except requests.HTTPError as e:
        code = e.response.status_code if e.response is not None else "unknown"
        raise UWError(f"Unusual Whales returned HTTP {code}; check key, plan, and rate limits") from None
    except requests.RequestException:
        raise UWError("Unable to reach Unusual Whales; retry or inspect network") from None


def market_snapshot(ticker: str, token: str):
    ticker = ticker.upper()
    if ticker not in ("SPY", "QQQ", "XSP", "IWM"):
        raise UWError("Unsupported watchlist symbol")
    endpoints = {
        "daily_ohlc": (f"/api/stock/{ticker}/ohlc/1d", {"timeframe": "1M", "limit": 31}),
        "flow_ticks": (f"/api/stock/{ticker}/net-prem-ticks", {}),
        "gex_oi": (f"/api/stock/{ticker}/gex-levels", {"source": "oi"}),
        "gex_volume": (f"/api/stock/{ticker}/gex-levels", {"source": "vol"}),
    }
    result = {}
    for label, (path, params) in endpoints.items():
        try:
            result[label] = {"status": "ok", "payload": fetch(path, token=token, params=params)}
        except UWError as e:
            result[label] = {"status": "unavailable", "error": str(e)}
    return result


def payload_rows(payload):
    """Unwrap known API envelopes, without treating arbitrary dicts as tables."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        data = payload.get("data")
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            for key in ("data", "result", "ticks"):
                if isinstance(data.get(key), list):
                    return data[key]
    return []