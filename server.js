const express = require('express');
const fs = require('fs');
const path = require('path');
const {
  getWatchlist,
  getWatchlistEntries,
  addToWatchlist,
  removeFromWatchlist,
  setWatchlistLiveData,
  setAllWatchlistLiveData,
  updateWatchlistQuoteCaches,
  getPortfolio,
  addPortfolioPosition,
  updatePortfolioPosition,
  deletePortfolioPosition,
  readDb,
} = require('./src/store');
const {
  getQuotes,
  getMarketDetails,
  getQuarterlyFinancials,
  calculatePortfolioAnalytics,
  runScreener,
} = require('./src/services/marketDataService');
const {
  initializeDailySalesSnapshot,
  refreshDailySalesSnapshot,
  getDailySalesSnapshotStatus,
  getDailySalesForSymbol,
  stopDailySalesSnapshot,
} = require('./src/services/dailySalesService');
const { getWatchlistNewsPage } = require('./src/services/newsService');
const { getUpcomingCorporateEvents } = require('./src/services/eventsService');
const {
  initializeSymbolMaster,
  refreshSymbolMaster,
  searchSymbols,
  resolveSymbolQuery,
  getSymbolMasterStatus,
  stopSymbolMasterRefresh,
} = require('./src/services/symbolMasterService');
const { config } = require('./src/config');
const { normalizeIndianSymbol } = require('./src/utils/symbols');

const app = express();
const startupTime = new Date().toISOString();
const isDevAutoReloadEnabled = process.env.NODE_ENV !== 'production';
const devReloadClients = new Set();
let devWatcher = null;
const WATCHLIST_TECHNICAL_RETRY_MS = 30 * 60 * 1000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function parseBooleanLike(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

function parseCachedAtMs(entry) {
  const ms = Date.parse(String(entry?.cachedAt || '').trim());
  return Number.isFinite(ms) ? ms : 0;
}

function hasMissingWatchlistTechnicals(entry) {
  const quote = entry?.cachedQuote;
  if (!quote || typeof quote !== 'object') {
    return false;
  }

  const missingEma50 = quote.ema50 === null || quote.ema50 === undefined || quote.ema50 === '';
  const missingEma200 = quote.ema200 === null || quote.ema200 === undefined || quote.ema200 === '';
  return missingEma50 || missingEma200;
}

function hasTechnicalEnrichmentTrace(entry) {
  const traces = Array.isArray(entry?.cachedQuote?.providerTrace)
    ? entry.cachedQuote.providerTrace
    : [];
  return traces.some((item) => String(item || '').startsWith('technicals:'));
}

function shouldRefreshWatchlistEntry(entry, nowMs = Date.now()) {
  if (!entry?.symbol) {
    return false;
  }

  if (entry.liveData) {
    return true;
  }

  if (!entry.cachedQuote) {
    return true;
  }

  if (hasMissingWatchlistTechnicals(entry)) {
    const cachedAtMs = parseCachedAtMs(entry);
    if (!hasTechnicalEnrichmentTrace(entry)) {
      return true;
    }
    if (cachedAtMs <= 0) {
      return true;
    }
    if ((nowMs - cachedAtMs) > WATCHLIST_TECHNICAL_RETRY_MS) {
      return true;
    }
  }

  const cachedAtMs = parseCachedAtMs(entry);
  if (cachedAtMs <= 0) {
    return true;
  }

  return (nowMs - cachedAtMs) > Math.max(Number(config.watchlistQuoteCacheMaxAgeMs) || (24 * 60 * 60 * 1000), 60 * 1000);
}

function decorateCachedQuote(entry) {
  const cached = entry?.cachedQuote;
  if (!cached || typeof cached !== 'object') {
    return null;
  }

  const cachedAtMs = parseCachedAtMs(entry);
  const ageMinutes = cachedAtMs > 0 ? Math.max(0, Math.floor((Date.now() - cachedAtMs) / 60000)) : 0;
  const providerTrace = Array.isArray(cached.providerTrace) ? [...cached.providerTrace] : [];
  providerTrace.push(`watchlist-cache:${ageMinutes}m`);

  return {
    ...cached,
    symbol: entry.symbol,
    source: cached.source ? `${cached.source}:cache` : 'cache',
    dataStatus: 'cached',
    providerTrace,
    watchlistCachedAt: entry.cachedAt || '',
    watchlistLiveData: Boolean(entry.liveData),
  };
}

function decorateLiveQuote(quote, entry, cachedAt) {
  return {
    ...quote,
    watchlistCachedAt: cachedAt || '',
    watchlistLiveData: Boolean(entry?.liveData),
  };
}

async function getWatchlistSnapshot(options = {}) {
  const forceRefresh = Boolean(options.forceRefresh);
  const nowMs = Date.now();
  const initialEntries = await getWatchlistEntries();
  const symbolsToFetch = initialEntries
    .filter((entry) => forceRefresh || shouldRefreshWatchlistEntry(entry, nowMs))
    .map((entry) => entry.symbol);

  let fetchedAtIso = '';
  let fetchedQuotes = [];
  let entries = initialEntries;

  if (symbolsToFetch.length > 0) {
    fetchedAtIso = new Date().toISOString();
    fetchedQuotes = await getQuotes(symbolsToFetch);
    entries = await updateWatchlistQuoteCaches(
      fetchedQuotes.map((quote) => ({
        symbol: quote.symbol,
        quote,
        cachedAt: fetchedAtIso,
      })),
    );
  }

  const fetchedMap = new Map((fetchedQuotes || []).map((quote) => [quote.symbol, quote]));
  const quotes = [];
  for (const entry of entries) {
    const fetched = fetchedMap.get(entry.symbol);
    if (fetched) {
      quotes.push(decorateLiveQuote(fetched, entry, fetchedAtIso));
      continue;
    }

    const cached = decorateCachedQuote(entry);
    if (cached) {
      quotes.push(cached);
    }
  }

  return {
    watchlist: entries.map((entry) => entry.symbol),
    watchlistEntries: entries,
    quotes,
  };
}

function emitDevReload(reason, file) {
  const payload = JSON.stringify({
    reason: reason || 'change',
    file: file || '',
    at: new Date().toISOString(),
  });

  for (const client of devReloadClients) {
    client.write(`event: reload\ndata: ${payload}\n\n`);
  }
}

function setupDevAutoReloadWatcher() {
  if (!isDevAutoReloadEnabled) {
    return;
  }

  const watchDir = path.join(__dirname, 'public');
  try {
    devWatcher = fs.watch(watchDir, { recursive: true }, (eventType, fileName) => {
      emitDevReload(eventType, fileName || '');
    });

    devWatcher.on('error', (error) => {
      console.error('[dev] auto-reload watcher error:', error.message);
    });

    console.log(`[dev] auto-reload watching ${watchDir}`);
  } catch (error) {
    console.error('[dev] auto-reload unavailable:', error.message);
  }
}

app.get('/__dev/reload', (req, res) => {
  if (!isDevAutoReloadEnabled) {
    res.status(404).end();
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('event: ready\ndata: {"ok":true}\n\n');

  devReloadClients.add(res);
  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    devReloadClients.delete(res);
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'stock-news-bot',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/symbols/search', (req, res, next) => {
  try {
    const query = String(req.query.q || '').trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || config.symbolMasterSearchLimit, 1), 50);
    const exchange = String(req.query.exchange || 'all').trim().toLowerCase();
    const items = query ? searchSymbols(query, { limit, exchange }) : [];
    const status = getSymbolMasterStatus();

    res.json({
      query,
      count: items.length,
      items,
      totalSymbols: status.totalSymbols,
      lastRefreshAt: status.lastRefreshAt,
      nextRefreshAt: status.nextRefreshAt,
      errors: status.errors,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/symbols/refresh', async (_req, res, next) => {
  try {
    const status = await refreshSymbolMaster({ reason: 'api' });
    res.json({ ok: true, ...status });
  } catch (error) {
    next(error);
  }
});

app.get('/api/sales/status', (_req, res) => {
  res.json(getDailySalesSnapshotStatus());
});

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

app.get('/api/sales/:symbol', (req, res, next) => {
  try {
    const symbol = normalizeIndianSymbol(req.params.symbol);
    if (!symbol) {
      throw new Error('Invalid stock symbol.');
    }

    const record = getDailySalesForSymbol(symbol);
    if (!record) {
      res.status(404).json({
        error: `No sales snapshot found for ${symbol}`,
        symbol,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json(record);
  } catch (error) {
    next(error);
  }
});

app.get('/api/watchlist', async (_req, res, next) => {
  try {
    const snapshot = await getWatchlistSnapshot();
    res.json(snapshot);
  } catch (error) {
    next(error);
  }
});

app.post('/api/watchlist', async (req, res, next) => {
  try {
    const input = String(req.body.symbol || '').trim();
    const symbol = resolveSymbolQuery(input);
    if (!symbol) {
      throw new Error(`Could not resolve symbol from input: ${input || 'empty'}`);
    }

    const requestedLiveData = parseBooleanLike(req.body.liveData, false);
    await addToWatchlist(symbol, { liveData: requestedLiveData });
    const snapshot = await getWatchlistSnapshot();

    res.status(201).json({ ...snapshot, resolvedSymbol: symbol });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/watchlist/:symbol/live', async (req, res, next) => {
  try {
    if (req.body.liveData === undefined) {
      throw new Error('liveData is required.');
    }

    const symbol = normalizeIndianSymbol(req.params.symbol);
    if (!symbol) {
      throw new Error('Invalid stock symbol.');
    }

    const liveData = parseBooleanLike(req.body.liveData, false);
    await setWatchlistLiveData(symbol, liveData);
    const snapshot = await getWatchlistSnapshot();

    res.json({
      ...snapshot,
      updatedSymbol: symbol,
      liveData,
    });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/watchlist/live', async (req, res, next) => {
  try {
    if (req.body.liveData === undefined) {
      throw new Error('liveData is required.');
    }

    const liveData = parseBooleanLike(req.body.liveData, false);
    await setAllWatchlistLiveData(liveData);
    const snapshot = await getWatchlistSnapshot();

    res.json({
      ...snapshot,
      liveData,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/watchlist/refresh', async (_req, res, next) => {
  try {
    const snapshot = await getWatchlistSnapshot({ forceRefresh: true });
    res.json({
      ...snapshot,
      refreshedAt: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/watchlist/:symbol', async (req, res, next) => {
  try {
    await removeFromWatchlist(req.params.symbol);
    const snapshot = await getWatchlistSnapshot();
    res.json(snapshot);
  } catch (error) {
    next(error);
  }
});

app.get('/api/portfolio', async (_req, res, next) => {
  try {
    const portfolio = await getPortfolio();
    const quotes = await getQuotes(portfolio.map((position) => position.symbol));
    const analytics = calculatePortfolioAnalytics(portfolio, quotes);

    res.json(analytics);
  } catch (error) {
    next(error);
  }
});

app.post('/api/portfolio', async (req, res, next) => {
  try {
    const portfolio = await addPortfolioPosition(req.body);
    const quotes = await getQuotes(portfolio.map((position) => position.symbol));
    const analytics = calculatePortfolioAnalytics(portfolio, quotes);

    res.status(201).json(analytics);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/portfolio/:id', async (req, res, next) => {
  try {
    const portfolio = await updatePortfolioPosition(req.params.id, req.body);
    const quotes = await getQuotes(portfolio.map((position) => position.symbol));
    const analytics = calculatePortfolioAnalytics(portfolio, quotes);

    res.json(analytics);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/portfolio/:id', async (req, res, next) => {
  try {
    const portfolio = await deletePortfolioPosition(req.params.id);
    const quotes = await getQuotes(portfolio.map((position) => position.symbol));
    const analytics = calculatePortfolioAnalytics(portfolio, quotes);

    res.json(analytics);
  } catch (error) {
    next(error);
  }
});

app.get('/api/feed', async (req, res, next) => {
  try {
    const snapshot = await getWatchlistSnapshot();
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 10);
    const cursor = String(req.query.cursor || '').trim();
    const newsPage = await getWatchlistNewsPage(snapshot.watchlist, { limit, cursor });

    res.json({
      ...snapshot,
      ...newsPage,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/feed/news', async (req, res, next) => {
  try {
    const watchlist = await getWatchlist();
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 10);
    const cursor = String(req.query.cursor || '').trim();
    const newsPage = await getWatchlistNewsPage(watchlist, { limit, cursor });

    res.json({
      watchlist,
      ...newsPage,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/events', async (req, res, next) => {
  try {
    const requestedScope = String(req.query.scope || 'all').trim().toLowerCase();
    const scope = ['watchlist', 'portfolio', 'all'].includes(requestedScope) ? requestedScope : 'all';
    const daysAhead = Math.min(Math.max(Number(req.query.days) || 45, 1), 180);
    const typeFilter = String(req.query.type || 'all').trim().toLowerCase();

    const [watchlist, portfolio] = await Promise.all([
      getWatchlist(),
      getPortfolio(),
    ]);
    const portfolioSymbols = portfolio.map((position) => position.symbol);

    let symbols = [];
    if (scope === 'watchlist') {
      symbols = watchlist;
    } else if (scope === 'portfolio') {
      symbols = portfolioSymbols;
    } else {
      symbols = Array.from(new Set([...watchlist, ...portfolioSymbols]));
    }

    const calendar = await getUpcomingCorporateEvents(symbols, {
      daysAhead,
      typeFilter,
    });

    res.json({
      scope,
      ...calendar,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/market/snapshot', async (req, res, next) => {
  try {
    const symbols = String(req.query.symbols || '')
      .split(',')
      .map((item) => normalizeIndianSymbol(item))
      .filter(Boolean);

    const targetSymbols = symbols.length > 0 ? symbols : await getWatchlist();
    const quotes = await getQuotes(targetSymbols);

    res.json({ symbols: targetSymbols, quotes });
  } catch (error) {
    next(error);
  }
});

app.get('/api/market/details/:symbol', async (req, res, next) => {
  try {
    const details = await getMarketDetails(req.params.symbol);
    res.json(details);
  } catch (error) {
    next(error);
  }
});

app.get('/api/market/financials/:symbol', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 6, 1), 8);
    const forceRefresh = parseBooleanLike(req.query.refresh, false)
      || parseBooleanLike(req.query.forceRefresh, false)
      || parseBooleanLike(req.query.force, false);
    const financials = await getQuarterlyFinancials(req.params.symbol, { limit, forceRefresh });
    res.json(financials);
  } catch (error) {
    next(error);
  }
});

app.get('/api/screener', async (req, res, next) => {
  try {
    const snapshot = await getWatchlistSnapshot();
    const quotes = snapshot.quotes || [];
    const screened = runScreener(quotes, req.query);

    res.json({
      total: quotes.length,
      matched: screened.length,
      filters: req.query,
      results: screened,
      watchlistEntries: snapshot.watchlistEntries,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/db', (_req, res) => {
  // Convenience route for local inspection during development.
  res.json(readDb());
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, _req, res, _next) => {
  const status = /not found/i.test(error.message) ? 404 : 400;

  res.status(status).json({
    error: error.message || 'Unexpected error',
    timestamp: new Date().toISOString(),
  });
});

function printBootBanner() {
  const effectiveProviders = Array.from(new Set(
    (config.marketDataProviderOrder || []).filter(Boolean),
  ));
  if (!effectiveProviders.includes('bseindia')) {
    const nseIndex = effectiveProviders.indexOf('nseindia');
    if (nseIndex >= 0) {
      effectiveProviders.splice(nseIndex + 1, 0, 'bseindia');
    } else {
      effectiveProviders.unshift('bseindia');
    }
  }
  if (!effectiveProviders.includes('screener')) {
    effectiveProviders.push('screener');
  }

  console.log(`[boot] ${startupTime} starting stock tracker`);
  console.log(`[boot] node=${process.version} pid=${process.pid}`);
  console.log(`[boot] cwd=${process.cwd()}`);
  console.log(`[boot] host=${config.host} port=${config.port} dataFile=${config.dataFilePath}`);
  console.log(`[boot] marketProviders=${effectiveProviders.join(' -> ')}`);
  const providerKeys = [];
  if (effectiveProviders.includes('twelvedata')) {
    providerKeys.push(`twelveDataKey=${config.twelveDataApiKey ? 'configured' : 'missing'}`);
  }
  if (effectiveProviders.includes('alphavantage')) {
    providerKeys.push(`alphaVantageKey=${config.alphaVantageApiKey ? 'configured' : 'missing'}`);
  }
  if (providerKeys.length > 0) {
    console.log(`[boot] ${providerKeys.join(' ')}`);
  }
}

function bootstrapStorage() {
  try {
    const db = readDb();
    console.log(`[boot] storage ok (watchlist=${db.watchlist.length}, portfolio=${db.portfolio.length})`);
  } catch (error) {
    console.error('[boot] storage init failed:', error);
    process.exit(1);
  }
}

printBootBanner();
bootstrapStorage();
const symbolMasterStatus = initializeSymbolMaster();
console.log(
  `[boot] symbolMaster loaded=${symbolMasterStatus.totalSymbols} lastRefresh=${symbolMasterStatus.lastRefreshAt || 'never'} scheduler=${symbolMasterStatus.schedulerMode}${symbolMasterStatus.schedulerExpression ? `(${symbolMasterStatus.schedulerExpression} ${symbolMasterStatus.schedulerTimezone})` : ''}`,
);
const salesSnapshotStatus = initializeDailySalesSnapshot();
console.log(
  `[boot] salesSnapshot stored=${salesSnapshotStatus.totalStoredSymbols} scheduler=${salesSnapshotStatus.schedulerMode}${salesSnapshotStatus.schedulerExpression ? `(${salesSnapshotStatus.schedulerExpression} ${salesSnapshotStatus.schedulerTimezone})` : ''} enabled=${salesSnapshotStatus.enabled ? 'yes' : 'no'}`,
);

const server = app.listen(config.port, config.host, () => {
  console.log(`[boot] listening on http://${config.host}:${config.port}`);
  setupDevAutoReloadWatcher();
});

server.on('error', (error) => {
  console.error('[boot] listen error:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[process] uncaughtException:', error);
  process.exit(1);
});

process.on('SIGTERM', () => {
  if (devWatcher) {
    devWatcher.close();
  }
  stopSymbolMasterRefresh();
  stopDailySalesSnapshot();
});
