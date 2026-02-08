const path = require('path');

function parseNumberEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseListEnv(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = String(value)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : fallback;
}

function parseRawListEnv(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : fallback;
}

function parseBooleanEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

const config = {
  port: parseNumberEnv(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  mongoUri: process.env.MONGODB_URI || process.env.MONGO_URI || '',
  mongoDbName: process.env.MONGODB_DB || process.env.MONGO_DB_NAME || '',
  mongoServerSelectionTimeoutMs: parseNumberEnv(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS, 10000),
  mongoTlsInsecure: parseBooleanEnv(process.env.MONGODB_TLS_INSECURE, false),
  mongoTlsSecureProtocol: process.env.MONGODB_TLS_SECURE_PROTOCOL || '',
  mongoFamily: parseNumberEnv(process.env.MONGODB_FAMILY, 0),
  dataFilePath: process.env.DATA_FILE_PATH || path.join(__dirname, '..', 'data', 'db.json'),
  symbolMasterFilePath: process.env.SYMBOL_MASTER_FILE_PATH || path.join(__dirname, '..', 'data', 'symbol_master.json'),
  salesSnapshotFilePath: process.env.SALES_SNAPSHOT_FILE_PATH || path.join(__dirname, '..', 'data', 'daily_sales.json'),
  symbolMasterRefreshMs: parseNumberEnv(process.env.SYMBOL_MASTER_REFRESH_MS, 24 * 60 * 60 * 1000),
  symbolMasterDailyCron: process.env.SYMBOL_MASTER_DAILY_CRON || '10 8 * * *',
  symbolMasterCronTimezone: process.env.SYMBOL_MASTER_CRON_TIMEZONE || 'Asia/Kolkata',
  symbolMasterSearchLimit: parseNumberEnv(process.env.SYMBOL_MASTER_SEARCH_LIMIT, 12),
  symbolMasterRequestTimeoutMs: parseNumberEnv(process.env.SYMBOL_MASTER_REQUEST_TIMEOUT_MS, 30000),
  salesSnapshotEnabled: parseBooleanEnv(process.env.SALES_SNAPSHOT_ENABLED, true),
  salesSnapshotDailyCron: process.env.SALES_SNAPSHOT_DAILY_CRON || '0 0 * * *',
  salesSnapshotCronTimezone: process.env.SALES_SNAPSHOT_CRON_TIMEZONE || 'Asia/Kolkata',
  salesSnapshotScope: process.env.SALES_SNAPSHOT_SCOPE || 'watchlist',
  salesSnapshotMaxSymbolsPerRun: parseNumberEnv(process.env.SALES_SNAPSHOT_MAX_SYMBOLS_PER_RUN, 0),
  salesSnapshotConcurrency: parseNumberEnv(process.env.SALES_SNAPSHOT_CONCURRENCY, 2),
  salesSnapshotThrottleMs: parseNumberEnv(process.env.SALES_SNAPSHOT_THROTTLE_MS, 120),
  salesSnapshotQuarterLimit: parseNumberEnv(process.env.SALES_SNAPSHOT_QUARTER_LIMIT, 6),
  salesSnapshotRunOnStartup: parseBooleanEnv(process.env.SALES_SNAPSHOT_RUN_ON_STARTUP, false),
  watchlistQuoteCacheMaxAgeMs: parseNumberEnv(process.env.WATCHLIST_QUOTE_CACHE_MAX_AGE_MS, 24 * 60 * 60 * 1000),
  symbolMasterNseCsvUrls: parseRawListEnv(
    process.env.SYMBOL_MASTER_NSE_CSV_URLS,
    [
      'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv',
      'https://archives.nseindia.com/content/equities/EQUITY_L.csv',
    ],
  ),
  symbolMasterIiflCsvUrl: process.env.SYMBOL_MASTER_IIFL_CSV_URL || 'https://content.indiainfoline.com/IIFLTT/Scripmaster.csv',
  marketCacheTtlMs: parseNumberEnv(process.env.MARKET_CACHE_TTL_MS, 60 * 1000),
  newsCacheTtlMs: parseNumberEnv(process.env.NEWS_CACHE_TTL_MS, 10 * 60 * 1000),
  eventsCacheTtlMs: parseNumberEnv(process.env.EVENTS_CACHE_TTL_MS, 30 * 60 * 1000),
  feedMaxItems: parseNumberEnv(process.env.FEED_MAX_ITEMS, 1000),
  newsApiKey: process.env.NEWS_API_KEY || '',
  newsApiBaseUrl: process.env.NEWS_API_BASE_URL || 'https://newsapi.org/v2/everything',
  googleNewsRssBaseUrl: process.env.GOOGLE_NEWS_RSS_BASE_URL || 'https://news.google.com/rss/search',
  googleNewsRssLanguage: process.env.GOOGLE_NEWS_RSS_LANGUAGE || 'en',
  googleNewsRssRegion: process.env.GOOGLE_NEWS_RSS_REGION || 'IN',
  googleNewsLookbackDays: parseNumberEnv(process.env.GOOGLE_NEWS_LOOKBACK_DAYS, 7),
  twitterSearchRssUrl: process.env.TWITTER_SEARCH_RSS_URL || '',
  marketDataProviderOrder: parseListEnv(process.env.MARKET_DATA_PROVIDER_ORDER, ['nseindia', 'bseindia', 'tradingview', 'yahoo', 'screener', 'twelvedata']),
  tradingViewScanUrl: process.env.TRADINGVIEW_SCAN_URL || 'https://scanner.tradingview.com/india/scan',
  twelveDataApiKey: process.env.TWELVE_DATA_API_KEY || '',
  twelveDataBaseUrl: process.env.TWELVE_DATA_BASE_URL || 'https://api.twelvedata.com',
  nseCookieTtlMs: parseNumberEnv(process.env.NSE_COOKIE_TTL_MS, 5 * 60 * 1000),
  alphaVantageApiKey: process.env.ALPHA_VANTAGE_API_KEY || '',
  alphaVantageBaseUrl: process.env.ALPHA_VANTAGE_BASE_URL || 'https://www.alphavantage.co/query',
  marketDataDebug: parseBooleanEnv(process.env.MARKET_DATA_DEBUG, false),
};

module.exports = { config };
