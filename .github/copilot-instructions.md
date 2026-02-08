# Stock News Bot - AI Agent Instructions

## Project Overview
A Node.js Express application that monitors stock market data and news. It displays stock information, fetches real-time stock news, and shows upcoming earnings reports. The app uses two different external APIs (Alpha Vantage and TwelveData) for market data analysis.

## Architecture

### Dual Server Pattern
- **server.js** (Main): Express server with web UI, managing stock watchlist and news display
- **server2.js** (Secondary): RSI (Relative Strength Index) analyzer using TwelveData API with rate-limit handling (60s pause every 8 requests)

### Data Flow
1. Client adds stocks via web form → stored in `stocks.json`
2. `/fetch-news` endpoint triggers dual API calls:
   - Alpha Vantage SYMBOL_SEARCH → stock metadata
   - Alpha Vantage EARNINGS → EPS data
3. Results rendered in EJS template with sidebar for earnings

### External APIs
- **Alpha Vantage**: Stock symbol search, earnings data (hardcoded key in server.js)
- **TwelveData**: RSI analysis (server2.js, key: `5ebd3faa2ddf4b668eb00e207d1f8fe3`)
- Both require API key management and rate-limit awareness

## Key Files & Patterns

| File | Purpose | Key Pattern |
|------|---------|-------------|
| [server.js](server.js#L75-L79) | Main Express app | `readStocks()/writeStocks()` handles persistent stock list in JSON |
| [stocks.json](stocks.json) | Stock watchlist persistence | Simple array format: `["AFFLE", "TCS"]` |
| [views/index.ejs](views/index.ejs#L44-L60) | Web UI | EJS loops over `stocks`, `news`, `upcomingResults` variables |
| [server2.js](server2.js#L23-L36) | RSI analyzer | Fetch wrapper with rate-limit pause (8-request batches) |

## Critical Workflows

### Adding/Deleting Stocks
- Form submissions POST to `/add-stock` or `/delete-stock`
- Always `.trim().toUpperCase()` stock symbols
- Writes directly to `stocks.json` file
- Redirects to `/` after mutations

### Fetching Stock Data
- `/fetch-news` uses `Promise.all()` to parallelize API calls
- Maps Alpha Vantage response objects to flat arrays
- Error handling logs to console, returns empty array
- **Important**: `getStockNews()` actually performs SYMBOL_SEARCH (metadata), not news articles—naming is misleading

### Scheduled Tasks
- [server.js line 134](server.js#L134-L137): `cron.schedule('0 * * * *')` runs hourly
- Calls `fetchAndDisplayNews()` which logs to console only (no persistent storage)

## Development Notes

### Setup & Running
```bash
npm install
node server.js          # Runs main app on PORT 3000 (or env override)
node server2.js         # Separate RSI analysis script
```

### API Key Management
- **SECURITY ISSUE**: API keys hardcoded in source files
- Alpha Vantage: `afd29b83f17141c199d46d7641381289` (server.js)
- TwelveData: `5ebd3faa2ddf4b668eb00e207d1f8fe3` (server2.js)
- Future refactor: Move to `.env` file with `dotenv` package

### Common Pitfalls
1. **Missing Bootstrap CSS**: UI relies on CDN (views/index.ejs line 8)—offline usage requires local Bootstrap
2. **No error UI**: API errors logged to console; users see empty results silently
3. **Rate limiting**: TwelveData enforces strict limits; server2.js handles it, but server.js doesn't batch requests
4. **Naming confusion**: `getStockNews()` function name misleads—it returns symbol metadata, not news articles

## Testing & Debugging
- No test suite defined (`package.json` test script returns error)
- Console logs are primary debug mechanism—check terminal when `/fetch-news` returns empty results
- Stock data persisted in plain JSON (no validation); malformed entries break the app

## Template Variables (EJS)
The `index` view expects exactly this object structure:
```javascript
{ 
  news: [], 
  stocks: ["AFFLE", "TCS"], 
  upcomingResults: [{ stock: "X", date: "YYYY-MM-DD", reportedEPS: "n", estimatedEPS: "n" }]
}
```
All three properties must be present or EJS loops will fail.
