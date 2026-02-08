# Quick Reference: Sales Snapshot Refresh

## TL;DR

**To refresh sales data:**
```bash
# Via API
POST /api/sales/refresh

# Check status
GET /api/sales/status

# Get specific stock sales
GET /api/sales/RELIANCE.NS
```

---

## Function Reference

### `requestSalesSnapshotRefreshIfNeeded(symbols, options)`

**Smart refresh** - Only refreshes if needed
```javascript
requestSalesSnapshotRefreshIfNeeded(
  ['RELIANCE', 'TCS', 'INFY'],  // Symbols to check
  { reason: 'watchlist-refresh' }  // Optional: reason
)
```

**Returns**: `true` if started, `false` if skipped

### `refreshDailySalesSnapshot(options)`

**Force refresh** - Always refreshes (non-blocking)
```javascript
refreshDailySalesSnapshot({ reason: 'manual' })
```

**Returns**: `Promise<void>`

---

## Use Cases

### 1. User Clicks "Refresh Quotes"
```javascript
// Already implemented in watchlist refresh endpoint
requestSalesSnapshotRefreshIfNeeded(symbols, {
  reason: 'watchlist-refresh'
});
// ✅ Smart - only refreshes if needed
```

### 2. Manual Sales Refresh
```javascript
// Via API endpoint /api/sales/refresh
refreshDailySalesSnapshot({ reason: 'manual' })
  .then(() => console.log('Done'))
  .catch((err) => console.error('Failed:', err));
// ✅ Force refresh, non-blocking
```

### 3. Background Refresh (Scheduled)
```javascript
// Runs daily at configured time (default: 21 * * * * = every hour at :21)
// SALES_SNAPSHOT_DAILY_CRON=21 * * * *
// ✅ Automatic, scheduled, non-blocking
```

---

## Configuration Quick Keys

```bash
# Feature control
SALES_SNAPSHOT_ENABLED=true              # On/off

# Scheduling (cron format, IST timezone)
SALES_SNAPSHOT_DAILY_CRON=21 * * * *    # Every hour at :21
SALES_SNAPSHOT_CRON_TIMEZONE=Asia/Kolkata

# Performance
SALES_SNAPSHOT_CONCURRENCY=2             # Parallel requests
SALES_SNAPSHOT_THROTTLE_MS=120           # Delay between requests
SALES_SNAPSHOT_QUARTER_LIMIT=10          # Quarters to fetch
SALES_SNAPSHOT_MAX_SYMBOLS_PER_RUN=0     # 0 = all
```

---

## Status Check

```bash
# See what's happening
curl http://localhost:3000/api/sales/status

# Key fields
{
  "running": boolean,       // Is refresh in progress?
  "enabled": boolean,       // Feature enabled?
  "totalStoredSymbols": 42, // How many stocks tracked?
  "processed": 10,          // Progress so far
  "success": 9,             // Successful
  "failed": 1               // Failed
}
```

---

## Performance Settings

| Goal | Setting |
|------|---------|
| **Faster** | `CONCURRENCY=4, THROTTLE_MS=50` |
| **Balanced** | `CONCURRENCY=2, THROTTLE_MS=120` (default) |
| **Conservative** | `CONCURRENCY=1, THROTTLE_MS=200` |

---

## Response Handling

### ✅ Refresh Started
```json
{ "ok": true, "running": true }
```

### ❌ Already Running
```json
{ "ok": true, "running": false }  // Will skip
```

### ❌ Not Enabled
Check: `SALES_SNAPSHOT_ENABLED=true`

### ❌ Error
Check server logs: `[sales]` messages

---

## Server Logs to Watch

```
[sales] refresh run started: 42 symbols
[sales] refresh run progress: 15/42 (14 success, 1 failed)
[sales] refresh run completed: 14/42 success in 125 seconds
```

---

## Files

- **Implementation**: `src/services/dailySalesService.js`
- **API Routes**: `server.js` lines 389-408
- **Full Guide**: `SALES_SNAPSHOT_GUIDE.md`
- **Config**: `.env` - Search for `SALES_SNAPSHOT`

---

## Quick Commands

```bash
# Trigger refresh
curl -X POST http://localhost:3000/api/sales/refresh

# Check status
curl http://localhost:3000/api/sales/status

# Get stock sales data
curl http://localhost:3000/api/sales/RELIANCE.NS

# Check logs (in app)
cat server logs | grep "\[sales\]"
```

---

## Key Points

✅ **Smart**: `requestSalesSnapshotRefreshIfNeeded()` only refreshes if needed
✅ **Fast**: Non-blocking background refresh  
✅ **Scheduled**: Automatic daily refresh (configurable)
✅ **Manual**: Can force refresh anytime via API
✅ **Monitored**: Status endpoint shows progress
✅ **Configurable**: Adjust concurrency, throttle, quarters

---

## Example Flow

```
User clicks "Refresh Quotes"
    ↓
Watchlist refresh triggered
    ↓
requestSalesSnapshotRefreshIfNeeded() called
    ↓
Checks: Is enabled? Not running? Missing data? 30 min passed?
    ↓
If YES to all: Start background refresh ✅
If NO to any: Skip ⏭️
    ↓
Background job fetches quarterly data
    ↓
MongoDB updated with new sales figures
    ↓
User sees updated sales data on next reload
```
