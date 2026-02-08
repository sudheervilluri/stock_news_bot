# Quarterly Financial Data - Troubleshooting Guide

## Issue
You may see the message: **"Quarterly financial data is currently unavailable for this symbol"** when viewing stock details.

## Why This Happens

The app fetches quarterly financial data from **screener.in**, a popular Indian stock analysis website. This data may be unavailable for several reasons:

### 1. **Network Restrictions (Render/Hosted Environments)**
- Screener.in may block requests from cloud hosting providers
- Render's IP addresses might be rate-limited or blocked
- Network firewalls may restrict access to screener.in

### 2. **Website Structure Changes**
- Screener.in may have updated their HTML structure
- The parsing logic expects specific HTML elements that may have changed
- Regular maintenance updates can affect data extraction

### 3. **Rate Limiting**
- Screener.in may rate-limit rapid requests
- Multiple API calls in quick succession can trigger blocks
- Cache TTL is set to 6 hours to reduce repeated requests

### 4. **Stock Symbol Issues**
- Some stocks may not have quarterly financial data available on screener.in
- New IPOs may not have historical financial data yet
- Delisted or inactive stocks won't have data

## How the System Works

### Data Sources (In Order of Priority)
1. **NSE India** - National Stock Exchange (primary)
2. **BSE India** - Bombay Stock Exchange (secondary)
3. **TradingView** - Market data and technicals
4. **Yahoo Finance** - Quote and historical data
5. **Screener.in** - Indian stock fundamentals & quarterly data
6. **Twelve Data** - Additional market data

### Quarterly Financials Specifically
- Fetched exclusively from **screener.in**
- Cached for **6 hours** to reduce requests
- Unavailable results are NOT cached (immediate retries allowed)
- Includes metrics like: Revenue, Profit, EPS, Dividends, etc.

### Nightly Sales Snapshot Job
- A scheduled job captures quarterly sales metrics once per day (default **00:00 Asia/Kolkata**).
- Scope defaults to **watchlist symbols** so watchlist rows always have sales context.
- Snapshots are saved to MongoDB when configured (fallback `data/daily_sales.json`) for screening and reporting.
- If a watchlist row is missing sales data, the backend will trigger an automatic background refresh (rate-limited).
- The snapshot now stores full quarterly rows so it can serve as a fallback when screener.in is unreachable.
- Configure with:
  - `SALES_SNAPSHOT_SCOPE=watchlist|all`
  - `SALES_SNAPSHOT_DAILY_CRON="0 0 * * *"`

## Workarounds

### 1. **View Data on Screener.in Directly**
Visit screener.in directly to see if the data is available:
```
https://www.screener.in/company/{SYMBOL}/
```
Example: https://www.screener.in/company/TCS/

### 2. **Use Alternative Data Sources**
- Check NSE/BSE official websites for quarterly results
- Review company investor relations pages
- Use other financial APIs

### 3. **Check Browser Console**
Open browser DevTools (F12) → Console tab to see debug logs:
```
[auth] Login attempt for username: admin
[screener html failed for TCS at https://screener.in/company/TCS/ - timeout]
```

### 4. **Force Refresh**
Add `?refresh=true` to the financials API call:
```
/api/market/financials/TCS?refresh=true
```
This bypasses the 6-hour cache and forces a fresh fetch.

## Technical Details

### Cache Configuration
```javascript
QUARTERLY_FINANCIAL_CACHE_TTL_MS = 6 * 60 * 60 * 1000  // 6 hours
QUARTERLY_FINANCIAL_UNAVAILABLE_CACHE_TTL_MS = 0       // Don't cache misses
```

### Fetching Logic
1. Try to fetch HTML from screener.in
2. Parse quarterly financial table from HTML
3. Extract metrics and quarter labels
4. Cache successful results for 6 hours
5. Return error message if no data found

### Parsing Targets
Looks for:
- Section with `id="quarters"`
- Heading with text "Quarterly Results"
- Table containing quarterly metrics

## Solutions for Render Deployment

### Option 1: Use Alternative Data API
Integrate with a dedicated financial data API:
- **Alpha Vantage** - Has quarterly data (API key required)
- **Twelve Data** - Premium quarterly data endpoint
- **Finnhub** - Comprehensive fundamentals API
- **IEX Cloud** - High-quality financial data

### Option 2: Caching Layer
- Implement Redis caching for screener.in data
- Store parsed data in database for faster retrieval
- Pre-fetch popular stocks on a schedule

### Option 3: Local Data Source
- Maintain local database of quarterly financial data
- Update monthly with latest filings
- Fall back to cached data if screener.in unavailable

### Option 4: Proxy Service
- Use a proxy service to route requests through different IPs
- Can help bypass IP-based rate limiting
- Adds latency but may improve reliability

## Configuration

To enable debugging, set environment variable:
```bash
MARKET_DATA_DEBUG=true
```

This will log detailed information about data fetch attempts.

## Future Improvements

Planned enhancements:
1. [ ] Add support for multiple quarterly data sources
2. [ ] Implement database caching layer
3. [x] Create data sync scheduled job
4. [ ] Add fallback to Alpha Vantage quarterly data
5. [ ] Cache all successful fetches permanently
6. [ ] Pre-fetch data for top 500 stocks

## Contact & Support

If quarterly data is consistently unavailable:
1. Check screener.in manually to confirm data exists
2. Review error logs in browser console
3. Try force refresh: `?refresh=true&limit=6`
4. Check if stock symbol is correct (e.g., TCS vs TCS.NS)

---

**Last Updated**: February 8, 2026
