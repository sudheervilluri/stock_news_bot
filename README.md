# Indian Stock Tracker (Node + React)

A full-stack starter for tracking Indian stocks with:
- Watchlist management
- Watchlist live toggle + persisted quote cache (fast mode)
- Daily symbol master refresh (NSE + BSE) for autocomplete
- Portfolio tracker with P&L analytics
- Screener filters
- Watchlist-based news feed
- Feed aggregation from Google News RSS + optional Twitter/X RSS + optional NewsAPI
- Day-wise upcoming calendar for results and concalls (watchlist/portfolio)
- Technicals in watchlist: `EMA 50`, `EMA 200`, `30-week MA` cycle stage
- Local JSON persistence (`data/db.json`)

## Tech stack
- Backend: Node.js + Express
- Frontend: React (served directly from `public/`)
- Storage: local JSON file
- Market data: provider chain (`nseindia -> bseindia -> tradingview -> yahoo -> screener fallback`)

## Quick start
1. Install dependencies (already present in this repo):
```bash
npm install
```
2. Configure environment:
```bash
cp .env.example .env
```
Recommended default order for Indian stocks: `nseindia,bseindia,tradingview,yahoo`.
For BSE/SME numeric scrip codes (example: `543928.BO`), `bseindia` is used first and `screener` is auto-used as a last-resort fallback.
For richer fundamentals, add `TWELVE_DATA_API_KEY` in `.env`.
Alpha Vantage is optional but its free tier is usually not reliable for NSE/BSE symbols.
3. Run server:
```bash
npm start
```
(`npm start` and `npm run doctor` automatically read `.env` when present.)
For auto-reload during development:
```bash
npm run dev
```
This restarts backend on server-code changes and auto-refreshes browser on `public/` changes.
If startup is unclear, run:
```bash
npm run doctor
```
For provider-level logs on quote fetches, set `MARKET_DATA_DEBUG=true` in `.env`.
4. Open:
- `http://localhost:3000`

## Project structure
- `server.js` - API server + static frontend hosting
- `src/store.js` - local persistence and business-safe writes
- `src/services/marketDataService.js` - quote data + portfolio analytics + screener
- `src/services/newsService.js` - watchlist news feed
- `src/services/eventsService.js` - upcoming results/concall calendar
- `src/services/symbolMasterService.js` - NSE/BSE symbol universe + autocomplete resolution
- `src/services/dailySalesService.js` - daily sales/PAT snapshot refresh for symbol-master universe
- `public/index.html` - React app shell
- `public/app.js` - dashboard logic
- `public/styles.css` - responsive UI styling
- `data/db.json` - persisted watchlist/portfolio data

## API overview
- `GET /api/health`
- `GET /api/watchlist`
- `POST /api/watchlist` `{ symbol }`
- `PATCH /api/watchlist/live` `{ liveData: true|false }` (table-level toggle)
- `PATCH /api/watchlist/:symbol/live` `{ liveData: true|false }`
- `POST /api/watchlist/refresh` (force refresh cached watchlist quotes)
- `DELETE /api/watchlist/:symbol`
- `GET /api/portfolio`
- `POST /api/portfolio` `{ symbol, quantity, avgPrice }`
- `PATCH /api/portfolio/:id`
- `DELETE /api/portfolio/:id`
- `GET /api/feed`
- `GET /api/feed?limit=10&cursor=<cursor>`
- `GET /api/feed/news?limit=10&cursor=<cursor>`
- `GET /api/symbols/search?q=reliance&limit=12&exchange=all`
- `POST /api/symbols/refresh`
- `GET /api/sales/status`
- `POST /api/sales/refresh`
- `GET /api/sales/:symbol`
- `GET /api/events?scope=all|watchlist|portfolio&type=all|results|concall&days=45`
- `GET /api/market/snapshot?symbols=RELIANCE.NS,TCS.NS`
- `GET /api/market/details/:symbol`
- `GET /api/screener?minChangePct=1&minVolume=1000000`

## Notes
- Symbols are normalized intelligently:
  - Alphanumeric (ex: `RELIANCE`) defaults to NSE (`RELIANCE.NS`)
  - 5/6-digit numeric codes (ex: `543928`) default to BSE (`543928.BO`)
  - Screener URLs are accepted directly (ex: `https://www.screener.in/company/543928/consolidated/`)
- Watchlist input supports company-name add flow:
  - Type symbol, scrip code, Screener URL, or company name.
  - Backend resolves to canonical symbol using the locally cached symbol master.
  - Autocomplete suggestions come from `/api/symbols/search`.
- Watchlist caching behavior:
  - Each watchlist row stores `liveData` flag, cached quote snapshot, and `cachedAt`.
  - If `liveData=true`, backend fetches latest quote on each dashboard/feed refresh.
  - If `liveData=false`, backend serves cached quote until cache age crosses `WATCHLIST_QUOTE_CACHE_MAX_AGE_MS` (default 24h).
  - Once stale, backend refreshes and persists the new snapshot automatically.
  - Dashboard UI exposes table-level controls for `Live Data (All)`, `Refresh`, and shared `Last Updated`.
- Symbol master refresh:
  - Universe includes NSE + BSE symbols and company names.
  - Cache persists locally at `data/symbol_master.json`.
  - Daily scheduler runs by cron (`SYMBOL_MASTER_DAILY_CRON`) with timezone (`SYMBOL_MASTER_CRON_TIMEZONE`, default `Asia/Kolkata`).
  - If cron config is invalid, service falls back to interval refresh (`SYMBOL_MASTER_REFRESH_MS`, default 24h).
  - You can force refresh via `POST /api/symbols/refresh`.
- Daily sales snapshot refresh:
  - Pulls quarterly Sales/PAT series (plus QoQ/YoY growth) from Screener-backed financial parser for symbol-master stocks.
  - Snapshot persists locally at `data/daily_sales.json`.
  - Scheduler runs by cron (`SALES_SNAPSHOT_DAILY_CRON`) with timezone (`SALES_SNAPSHOT_CRON_TIMEZONE`).
  - Manual refresh endpoint: `POST /api/sales/refresh` (starts background run and returns immediately).
  - Per-symbol fetch endpoint: `GET /api/sales/:symbol`.
  - For large universes, tune `SALES_SNAPSHOT_MAX_SYMBOLS_PER_RUN`, `SALES_SNAPSHOT_CONCURRENCY`, and `SALES_SNAPSHOT_THROTTLE_MS`.
- Quarterly popup (`GET /api/market/financials/:symbol`) cache behavior:
  - Available quarterly rows are cached in-memory for 6 hours.
  - Unavailable results are not treated as fresh, so next open re-pulls Screener from web.
  - Fallback attempts alias symbols (NSE/BSE bridge) before returning unavailable.
- Watchlist quotes include derived technicals when chart history is available:
  - `EMA 50` and `EMA 200` from daily closes
  - If full history is short (for example new listings), EMAs are backfilled with a progressive EMA approximation instead of leaving blanks.
  - Stan Weinstein cycle stage from 30-week MA trend (`Accumulation`, `Markup`, `Distribution`, `Markdown`)
  - Technical source order: NSE historical (for `.NS`) / BSE historical (for `.BO`) -> symbol/alias bridge (TradingView + Yahoo daily series) -> Yahoo -> Screener (plus Screener alias bridge) -> Twelve Data -> Alpha Vantage.
- News falls back to local placeholder items when `NEWS_API_KEY` is missing.
- Feed sources:
  - Google News RSS (enabled by default)
  - Optional Twitter/X RSS search endpoint (`TWITTER_SEARCH_RSS_URL`, for example a Nitter RSS endpoint)
  - Optional NewsAPI (`NEWS_API_KEY`)
  - All sources are merged, deduplicated, and sorted by latest publish time.
  - Feed API supports cursor-based chunking (fixed `10` posts per request) for infinite scroll; use `nextCursor` from the previous response.
  - Total feed collection is capped at `1000` latest posts (configurable via `FEED_MAX_ITEMS`, max enforced `1000`).
- Events calendar is built from public Screener company documents/announcements and filtered for upcoming result/concall signals by date text.
- Market data uses live providers in order from `MARKET_DATA_PROVIDER_ORDER`.
- Each quote now includes `source`, `dataStatus`, and `providerTrace` for debugging provider failures.
- No synthetic/random prices are generated now. If all providers fail, quote status is marked `unavailable` or `stale`.
- Startup now prints `[boot]` diagnostics (host/port/storage) to make `npm start` troubleshooting explicit.
- `GET /api/market/details/:symbol` returns extra details (NSE fields + Twelve Data profile when available).
