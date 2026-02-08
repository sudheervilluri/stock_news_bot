# Sales Snapshot Refresh Guide

## Overview

`requestSalesSnapshotRefreshIfNeeded()` is a **smart refresh function** that automatically triggers sales data refresh when needed. It checks if refresh is actually required before running.

## How It Works

### Function Signature
```javascript
function requestSalesSnapshotRefreshIfNeeded(symbols, options = {})
```

### Parameters
- **symbols**: Array of stock symbols to check (e.g., `['RELIANCE', 'TCS', 'INFY']`)
- **options**: Object with optional configuration
  - `reason`: String describing why refresh was triggered (e.g., 'watchlist-refresh', 'auto-miss')
  - `minIntervalMs`: Minimum time between auto-refreshes (default: 30 minutes)

### Return Value
- **true**: Refresh was triggered
- **false**: Refresh was skipped (already running, not enabled, or data fresh)

---

## When Does It Trigger a Refresh?

The refresh is **skipped** if ANY of these are true:
```javascript
1. config.salesSnapshotEnabled === false  // Feature disabled in config
2. state.running === true                 // Already refreshing
3. runPromise exists                      // Previous refresh still in progress
4. !hasMissingSalesRecords(symbols)       // All symbols have recent data
5. Time since last auto-refresh < minIntervalMs  // Too soon (default 30 min)
```

Otherwise, it **triggers** `refreshDailySalesSnapshot()`

---

## Usage in Current Code

### 1. In Watchlist Refresh (server.js:250)
```javascript
if (forceRefresh) {
  requestSalesSnapshotRefreshIfNeeded(
    entries.map((entry) => entry.symbol),
    { reason: 'watchlist-refresh' },  // When user manually refreshes watchlist
  );
}
```

### 2. Via API Endpoint (server.js:389)
```javascript
app.post('/api/sales/refresh', async (_req, res, next) => {
  try {
    refreshDailySalesSnapshot({ reason: 'api' }).catch((error) => {
      console.error('[sales] refresh run failed:', error.message);
    });
    res.status(202).json({ ok: true, ...getDailySalesSnapshotStatus() });
  } catch (error) {
    next(error);
  }
});
```

---

## How to Refresh Sales Data

### Option 1: Via API Endpoint (Recommended)
**Immediate refresh without waiting:**
```bash
# Trigger background refresh
curl -X POST http://localhost:3000/api/sales/refresh

# Response (202 Accepted - refresh happening in background)
{
  "ok": true,
  "schedulerMode": "enabled",
  "running": true,
  "totalSymbols": 42,
  "processed": 5,
  "success": 4,
  "failed": 1
}
```

### Option 2: Check Sales Status
```bash
curl http://localhost:3000/api/sales/status

# Response
{
  "schedulerMode": "enabled",
  "enabled": true,
  "running": true,
  "totalStoredSymbols": 42,
  "lastRefreshAt": "2026-02-08T10:30:00Z",
  "nextRefreshAt": "2026-02-08T21:30:00Z",
  ...
}
```

### Option 3: Get Sales for Specific Stock
```bash
curl http://localhost:3000/api/sales/RELIANCE.NS

# Response
{
  "symbol": "RELIANCE.NS",
  "companyName": "Reliance Industries",
  "snapshotDate": "2026-02-08",
  "quarterLabels": ["Q3 FY25", "Q2 FY25", "Q1 FY25", ...],
  "sales": [50000, 48000, 46000, ...],
  "pat": [8000, 7800, 7500, ...],
  "salesQoq": [4.2, 4.3, ...],
  "salesYoy": [10.5, 12.1, ...]
}
```

---

## Configuration

### Enable/Disable Sales Snapshot
In `.env` file:
```bash
# Enable sales snapshot collection
SALES_SNAPSHOT_ENABLED=true

# Scheduled refresh time (cron format, IST)
SALES_SNAPSHOT_DAILY_CRON=21 * * * *  # Every hour at :21
SALES_SNAPSHOT_CRON_TIMEZONE=Asia/Kolkata

# Performance tuning
SALES_SNAPSHOT_CONCURRENCY=2          # Parallel requests
SALES_SNAPSHOT_THROTTLE_MS=120        # Delay between requests
SALES_SNAPSHOT_QUARTER_LIMIT=10       # Quarters to fetch
SALES_SNAPSHOT_MAX_SYMBOLS_PER_RUN=0  # 0 = all symbols
```

---

## Refresh Triggers

### Automatic (Scheduled)
```javascript
// Runs daily at configured time (default: 9:21 AM IST)
SALES_SNAPSHOT_DAILY_CRON=21 * * * *
```

### Manual (When Needed)
```javascript
// Triggered when:
1. User clicks "Refresh quotes" on watchlist
2. API call to POST /api/sales/refresh
3. Auto-refresh if symbols missing sales data (30 min min interval)
```

### Smart (On Watchlist Refresh)
```javascript
if (forceRefresh) {
  // Only triggers if:
  // - Sales snapshot enabled
  // - Not already running
  // - At least one symbol missing sales data
  // - At least 30 minutes since last auto-refresh
  requestSalesSnapshotRefreshIfNeeded(symbols, { 
    reason: 'watchlist-refresh' 
  });
}
```

---

## Monitoring Refresh Progress

### Check Status
```javascript
// Server endpoint
GET /api/sales/status

// Returns
{
  "running": true,
  "totalSymbols": 42,
  "processed": 15,      // Symbols processed so far
  "success": 14,        // Successful fetches
  "failed": 1,          // Failed fetches
  "status": "running",
  "reason": "api",
  "startedAt": "2026-02-08T10:30:00Z"
}
```

### Server Logs
```
[sales] refresh run started: 42 symbols
[sales] refresh run progress: 15/42 (14 success, 1 failed)
[sales] refresh run completed: 14/42 success, 1 failed in 125 seconds
```

---

## Performance Considerations

### Throttling
```javascript
// Default: 120ms between requests to avoid rate limiting
SALES_SNAPSHOT_THROTTLE_MS=120

// For faster refresh:
SALES_SNAPSHOT_THROTTLE_MS=50     // Faster but risk rate-limit
// For slower (conservative):
SALES_SNAPSHOT_THROTTLE_MS=200    // Safer
```

### Concurrency
```javascript
// Default: 2 parallel requests
SALES_SNAPSHOT_CONCURRENCY=2

// For faster refresh:
SALES_SNAPSHOT_CONCURRENCY=4      // More parallel requests
// For slower (conservative):
SALES_SNAPSHOT_CONCURRENCY=1      // One at a time
```

### Quarters to Fetch
```javascript
// Default: 10 quarters (2.5 years of data)
SALES_SNAPSHOT_QUARTER_LIMIT=10

// For less data:
SALES_SNAPSHOT_QUARTER_LIMIT=4     // Only 1 year
// For more data:
SALES_SNAPSHOT_QUARTER_LIMIT=20    // 5 years
```

---

## Optimization Tips

### 1. Fast Refresh for Watchlist
```javascript
// Current implementation (optimized):
// 1. Return cached data immediately (< 100ms)
// 2. Refresh sales in background if needed
// 3. Sales data updates silently

requestSalesSnapshotRefreshIfNeeded(symbols, {
  reason: 'watchlist-refresh',
  minIntervalMs: 30 * 60 * 1000  // Don't refresh more than once per 30 min
});
```

### 2. Skip Unnecessary Refreshes
The function already checks:
```javascript
// Only refresh if:
// 1. Feature enabled
// 2. Not already running
// 3. Missing sales data for at least one symbol
// 4. Enough time passed since last refresh

if (!hasMissingSalesRecords(symbols)) {
  return false;  // Skip if all have recent data
}
```

### 3. Batch Refresh
```javascript
// Refresh all watchlist symbols at once
const allSymbols = entries.map((e) => e.symbol);
requestSalesSnapshotRefreshIfNeeded(allSymbols, {
  reason: 'batch-refresh',
  minIntervalMs: 60 * 60 * 1000  // Once per hour max
});
```

---

## API Responses

### Refresh Triggered Successfully
```json
{
  "ok": true,
  "schedulerMode": "enabled",
  "running": true,
  "totalSymbols": 42,
  "processed": 0,
  "success": 0,
  "failed": 0,
  "status": "running",
  "reason": "api"
}
```

### Refresh Skipped (Not Needed)
```json
{
  "ok": true,
  "schedulerMode": "enabled",
  "running": false,
  "totalSymbols": 42,
  "processed": 42,
  "success": 42,
  "failed": 0,
  "status": "idle"
}
```

### Error
```json
{
  "error": "Sales snapshot disabled",
  "timestamp": "2026-02-08T10:30:00Z"
}
```

---

## Troubleshooting

### Sales Data Not Updating
```bash
# 1. Check if enabled
curl http://localhost:3000/api/sales/status
# Look for "enabled": true

# 2. Check if refresh is running
# "running": true or "running": false

# 3. Force immediate refresh
curl -X POST http://localhost:3000/api/sales/refresh

# 4. Check server logs for errors
# [sales] ... messages
```

### Refresh Too Slow
```bash
# Increase concurrency
SALES_SNAPSHOT_CONCURRENCY=4

# Decrease throttle
SALES_SNAPSHOT_THROTTLE_MS=50

# Reduce quarters needed
SALES_SNAPSHOT_QUARTER_LIMIT=4
```

### Refresh Takes Too Long
```bash
# Reduce max symbols per run
SALES_SNAPSHOT_MAX_SYMBOLS_PER_RUN=10

# Or increase throttle for stability
SALES_SNAPSHOT_THROTTLE_MS=200
```

---

## Summary

| Aspect | Details |
|--------|---------|
| **What** | Fetches quarterly sales data for watchlist stocks |
| **When** | Scheduled daily + manual refresh + auto on watchlist refresh |
| **How** | Parallel requests with throttling (configurable) |
| **Where** | `/api/sales/:symbol` endpoint |
| **Smart** | Only refreshes if data missing, not already running |
| **Fast** | Background refresh doesn't block user |
| **Status** | `/api/sales/status` shows progress |

**Example**: User refreshes watchlist → Function checks if sales data needed → If yes, starts background refresh → User sees data immediately → Sales update silently in background → Data persists to MongoDB ✅
