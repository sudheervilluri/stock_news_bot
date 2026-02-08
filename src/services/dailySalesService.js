const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { config } = require('../config');
const { getDb, isMongoEnabled } = require('../db/mongoClient');
const { normalizeIndianSymbol, stripExchangeSuffix } = require('../utils/symbols');
const { getWatchlist } = require('../store');
const { getSymbolMasterItems } = require('./symbolMasterService');
const { getQuarterlyFinancials } = require('./marketDataService');

const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 8;
const MIN_LIMIT = 1;
const MAX_LIMIT = 8;
const AUTO_REFRESH_MIN_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_RUN_STATE = Object.freeze({
  status: 'idle',
  reason: '',
  startedAt: '',
  finishedAt: '',
  totalSymbols: 0,
  processed: 0,
  success: 0,
  failed: 0,
});

let initialized = false;
let schedulerTask = null;
let runPromise = null;
let lastAutoRefreshAt = 0;
let state = {
  snapshot: createDefaultSnapshot(),
  schedulerMode: 'disabled',
  schedulerExpression: '',
  schedulerTimezone: '',
  running: false,
  lastError: '',
};

function createDefaultSnapshot() {
  return {
    version: 1,
    updatedAt: '',
    run: { ...DEFAULT_RUN_STATE },
    symbols: {},
  };
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms) {
  const waitMs = Math.max(toNumber(ms, 0), 0);
  if (waitMs <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, waitMs);
  });
}

function getQuarterLimit() {
  const configured = toNumber(config.salesSnapshotQuarterLimit, 10);
  return Math.min(Math.max(configured, MIN_LIMIT), MAX_LIMIT);
}

function getConcurrency() {
  const configured = toNumber(config.salesSnapshotConcurrency, 2);
  return Math.min(Math.max(configured, MIN_CONCURRENCY), MAX_CONCURRENCY);
}

function getThrottleMs() {
  return Math.max(toNumber(config.salesSnapshotThrottleMs, 120), 0);
}

function getMaxSymbolsPerRun() {
  return Math.max(toNumber(config.salesSnapshotMaxSymbolsPerRun, 0), 0);
}

function getSnapshotScope() {
  const scope = String(config.salesSnapshotScope || 'watchlist').trim().toLowerCase();
  return scope === 'all' ? 'all' : 'watchlist';
}

let symbolMasterSymbolIndex = null;

function buildSymbolMasterSymbolIndex() {
  if (symbolMasterSymbolIndex) {
    return symbolMasterSymbolIndex;
  }

  const index = new Map();
  const items = getSymbolMasterItems({ exchange: 'all' }) || [];
  for (const item of items) {
    const symbol = normalizeIndianSymbol(item.symbol);
    if (!symbol || index.has(symbol)) {
      continue;
    }
    index.set(symbol, {
      symbol,
      exchange: String(item.exchange || ''),
      companyName: String(item.companyName || ''),
    });
  }

  symbolMasterSymbolIndex = index;
  return index;
}

function ensureSnapshotDir() {
  if (!config.salesSnapshotFilePath) return;
  const filePath = config.salesSnapshotFilePath;
  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function normalizeRunState(rawRun) {
  const run = rawRun && typeof rawRun === 'object' ? rawRun : {};
  return {
    status: String(run.status || DEFAULT_RUN_STATE.status),
    reason: String(run.reason || ''),
    startedAt: String(run.startedAt || ''),
    finishedAt: String(run.finishedAt || ''),
    totalSymbols: Math.max(toNumber(run.totalSymbols, 0), 0),
    processed: Math.max(toNumber(run.processed, 0), 0),
    success: Math.max(toNumber(run.success, 0), 0),
    failed: Math.max(toNumber(run.failed, 0), 0),
  };
}

function normalizeSymbolRecord(symbol, rawRecord) {
  const normalizedSymbol = normalizeIndianSymbol(symbol);
  if (!normalizedSymbol || !rawRecord || typeof rawRecord !== 'object') {
    return null;
  }

  const quarterLabels = Array.isArray(rawRecord.quarterLabels)
    ? rawRecord.quarterLabels.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const asNumberArray = (value) => (
    Array.isArray(value)
      ? value.map((item) => {
        const parsed = Number(item);
        return Number.isFinite(parsed) ? parsed : null;
      })
      : []
  );

  return {
    symbol: normalizedSymbol,
    companyName: String(rawRecord.companyName || ''),
    exchange: String(rawRecord.exchange || ''),
    snapshotDate: String(rawRecord.snapshotDate || ''),
    capturedAt: String(rawRecord.capturedAt || ''),
    source: String(rawRecord.source || ''),
    dataStatus: String(rawRecord.dataStatus || 'unavailable'),
    message: String(rawRecord.message || ''),
    quarterLabels,
    rows: normalizeRows(rawRecord.rows),
    sales: asNumberArray(rawRecord.sales),
    pat: asNumberArray(rawRecord.pat),
    salesQoq: asNumberArray(rawRecord.salesQoq),
    salesYoy: asNumberArray(rawRecord.salesYoy),
    patQoq: asNumberArray(rawRecord.patQoq),
    patYoy: asNumberArray(rawRecord.patYoy),
  };
}

function normalizeSnapshot(rawSnapshot) {
  if (!rawSnapshot || typeof rawSnapshot !== 'object') {
    return createDefaultSnapshot();
  }

  const symbols = {};
  const rawSymbols = rawSnapshot.symbols && typeof rawSnapshot.symbols === 'object'
    ? rawSnapshot.symbols
    : {};
  for (const [symbol, record] of Object.entries(rawSymbols)) {
    const normalized = normalizeSymbolRecord(symbol, record);
    if (normalized) {
      symbols[normalized.symbol] = normalized;
    }
  }

  return {
    version: 1,
    updatedAt: String(rawSnapshot.updatedAt || ''),
    run: normalizeRunState(rawSnapshot.run),
    symbols,
  };
}

function loadSnapshotFromDisk() {
  try {
    if (!config.salesSnapshotFilePath || !fs.existsSync(config.salesSnapshotFilePath)) {
      return createDefaultSnapshot();
    }

    const raw = fs.readFileSync(config.salesSnapshotFilePath, 'utf8');
    return normalizeSnapshot(JSON.parse(raw));
  } catch (error) {
    state.lastError = `sales-snapshot-load:${error.message}`;
    return createDefaultSnapshot();
  }
}

function saveSnapshotToDisk(snapshot) {
  try {
    if (!config.salesSnapshotFilePath) return;
    ensureSnapshotDir();
    fs.writeFileSync(config.salesSnapshotFilePath, JSON.stringify(snapshot, null, 2));
  } catch (error) {
    state.lastError = `sales-snapshot-save:${error.message}`;
  }
}

async function loadSnapshotFromMongo() {
  if (!isMongoEnabled()) {
    return null;
  }

  try {
    const db = await getDb();
    if (!db) {
      return null;
    }

    const [meta, records] = await Promise.all([
      db.collection('sales_snapshot_meta').findOne({ _id: 'meta' }),
      db.collection('sales_snapshots').find({}).toArray(),
    ]);

    if (!meta && records.length === 0) {
      return null;
    }

    const symbols = {};
    for (const record of records) {
      const normalized = normalizeSymbolRecord(record.symbol, record);
      if (normalized) {
        symbols[normalized.symbol] = normalized;
      }
    }

    return normalizeSnapshot({
      updatedAt: meta?.updatedAt || '',
      run: meta?.run || {},
      symbols,
    });
  } catch (error) {
    state.lastError = `sales-snapshot-mongo-load:${error.message}`;
    return null;
  }
}

async function saveSnapshotToMongo(snapshot) {
  if (!isMongoEnabled()) {
    return;
  }

  try {
    const db = await getDb();
    if (!db) {
      return;
    }

    const records = Object.values(snapshot.symbols || {});
    if (records.length > 0) {
      const ops = records.map((record) => ({
        updateOne: {
          filter: { symbol: record.symbol },
          update: { $set: record },
          upsert: true,
        },
      }));
      await db.collection('sales_snapshots').bulkWrite(ops, { ordered: false });
    }

    await db.collection('sales_snapshot_meta').updateOne(
      { _id: 'meta' },
      { $set: { updatedAt: snapshot.updatedAt || '', run: snapshot.run || {} } },
      { upsert: true },
    );
  } catch (error) {
    state.lastError = `sales-snapshot-mongo-save:${error.message}`;
  }
}

async function loadSnapshotFromStore() {
  if (isMongoEnabled()) {
    // Strict MongoDB only
    return loadSnapshotFromMongo();
  }

  return loadSnapshotFromDisk();
}

async function saveSnapshotToStore(snapshot) {
  if (isMongoEnabled()) {
    await saveSnapshotToMongo(snapshot);
  } else {
    saveSnapshotToDisk(snapshot);
  }
}

function getSeriesFromRows(rows, key) {
  const row = (rows || []).find((item) => String(item?.key || '').toLowerCase() === String(key).toLowerCase());
  const values = Array.isArray(row?.values) ? row.values : [];
  return values.map((value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  });
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .map((row) => {
      if (!row || typeof row !== 'object') {
        return null;
      }
      const key = String(row.key || row.label || '').trim();
      const label = String(row.label || row.key || '').trim();
      if (!key && !label) {
        return null;
      }
      const values = Array.isArray(row.values)
        ? row.values.map((value) => {
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        })
        : [];
      return {
        key: key || label,
        label: label || key,
        kind: String(row.kind || ''),
        values,
      };
    })
    .filter(Boolean);
}

function hasAnyValue(values) {
  return Array.isArray(values) && values.some((value) => Number.isFinite(Number(value)));
}

function buildSalesRecord(symbolItem, financials, snapshotDate, capturedAt) {
  const rawRows = Array.isArray(financials?.rows) ? financials.rows : [];
  const sales = getSeriesFromRows(rawRows, 'sales');
  const pat = getSeriesFromRows(rawRows, 'pat');
  const salesQoq = getSeriesFromRows(rawRows, 'sales_qoq');
  const salesYoy = getSeriesFromRows(rawRows, 'sales_yoy');
  const patQoq = getSeriesFromRows(rawRows, 'pat_qoq');
  const patYoy = getSeriesFromRows(rawRows, 'pat_yoy');
  const rows = normalizeRows(rawRows);
  const hasData = rows.length > 0 || hasAnyValue(sales) || hasAnyValue(pat);

  return {
    symbol: symbolItem.symbol,
    companyName: financials?.companyName || symbolItem.companyName || '',
    exchange: symbolItem.exchange || '',
    snapshotDate,
    capturedAt,
    source: String(financials?.source || 'screener'),
    dataStatus: hasData ? 'available' : String(financials?.dataStatus || 'unavailable'),
    message: String(financials?.message || ''),
    quarterLabels: Array.isArray(financials?.quarterLabels) ? financials.quarterLabels : [],
    rows,
    sales,
    pat,
    salesQoq,
    salesYoy,
    patQoq,
    patYoy,
  };
}

async function buildWatchlistSymbolItems() {
  const watchlist = await getWatchlist();
  const list = Array.isArray(watchlist) ? watchlist : [];
  const index = buildSymbolMasterSymbolIndex();
  const deduped = new Map();

  for (const rawSymbol of list) {
    const symbol = normalizeIndianSymbol(rawSymbol);
    if (!symbol || deduped.has(symbol)) {
      continue;
    }

    const masterItem = index.get(symbol);
    const exchange = String(masterItem?.exchange || (symbol.endsWith('.BO') ? 'BSE' : 'NSE'));
    const companyName = String(masterItem?.companyName || stripExchangeSuffix(symbol));

    deduped.set(symbol, { symbol, exchange, companyName });
  }

  return Array.from(deduped.values()).sort((left, right) => left.symbol.localeCompare(right.symbol, undefined, {
    numeric: true,
    sensitivity: 'base',
  }));
}

function buildAllSymbolItems() {
  const items = getSymbolMasterItems({ exchange: 'all' })
    .map((item) => ({
      symbol: normalizeIndianSymbol(item.symbol),
      exchange: String(item.exchange || ''),
      companyName: String(item.companyName || ''),
    }))
    .filter((item) => Boolean(item.symbol));

  const deduped = new Map();
  for (const item of items) {
    if (!deduped.has(item.symbol)) {
      deduped.set(item.symbol, item);
    }
  }

  return Array.from(deduped.values()).sort((left, right) => left.symbol.localeCompare(right.symbol, undefined, {
    numeric: true,
    sensitivity: 'base',
  }));
}

async function getTargetSymbolItems() {
  const scope = getSnapshotScope();
  const items = scope === 'watchlist' ? await buildWatchlistSymbolItems() : buildAllSymbolItems();
  const maxSymbols = getMaxSymbolsPerRun();
  if (maxSymbols > 0) {
    return items.slice(0, maxSymbols);
  }

  return items;
}

async function refreshDailySalesSnapshot(options = {}) {
  if (runPromise) {
    return runPromise;
  }

  const reason = String(options.reason || 'manual');
  const quarterLimit = getQuarterLimit();
  const concurrency = getConcurrency();
  const throttleMs = getThrottleMs();
  const startedAt = new Date();
  const startedAtIso = startedAt.toISOString();
  const snapshotDate = startedAtIso.slice(0, 10);
  const symbols = await getTargetSymbolItems();

  state.running = true;
  state.snapshot = {
    ...state.snapshot,
    run: {
      status: 'running',
      reason,
      startedAt: startedAtIso,
      finishedAt: '',
      totalSymbols: symbols.length,
      processed: 0,
      success: 0,
      failed: 0,
    },
  };

  runPromise = (async () => {
    const nextRecords = {};
    let cursor = 0;
    let processed = 0;
    let success = 0;
    let failed = 0;

    const worker = async () => {
      while (true) {
        const currentIndex = cursor;
        cursor += 1;
        if (currentIndex >= symbols.length) {
          return;
        }

        const symbolItem = symbols[currentIndex];
        const capturedAt = new Date().toISOString();

        try {
          const financials = await getQuarterlyFinancials(symbolItem.symbol, { limit: quarterLimit });
          const record = buildSalesRecord(symbolItem, financials, snapshotDate, capturedAt);
          const existing = state.snapshot.symbols?.[symbolItem.symbol];
          const preserveExisting = existing
            && existing.dataStatus === 'available'
            && Array.isArray(existing.rows)
            && existing.rows.length > 0
            && record.dataStatus !== 'available';

          nextRecords[symbolItem.symbol] = preserveExisting ? existing : record;
          if (record.dataStatus === 'available') {
            success += 1;
          } else {
            failed += 1;
          }
        } catch (error) {
          failed += 1;
          nextRecords[symbolItem.symbol] = {
            symbol: symbolItem.symbol,
            companyName: symbolItem.companyName,
            exchange: symbolItem.exchange,
            snapshotDate,
            capturedAt,
            source: 'screener',
            dataStatus: 'error',
            message: String(error?.message || 'unknown error'),
            quarterLabels: [],
            rows: [],
            sales: [],
            pat: [],
            salesQoq: [],
            salesYoy: [],
            patQoq: [],
            patYoy: [],
          };
        }

        processed += 1;
        state.snapshot = {
          ...state.snapshot,
          run: {
            ...state.snapshot.run,
            processed,
            success,
            failed,
          },
        };

        if (throttleMs > 0) {
          await sleep(throttleMs);
        }
      }
    };

    try {
      const workerCount = Math.min(concurrency, Math.max(symbols.length, 1));
      await Promise.all(Array.from({ length: workerCount }, () => worker()));

      const finishedAtIso = new Date().toISOString();
      const mergedSymbols = {
        ...(state.snapshot.symbols || {}),
        ...nextRecords,
      };

      const nextSnapshot = {
        version: 1,
        updatedAt: finishedAtIso,
        run: {
          status: 'completed',
          reason,
          startedAt: startedAtIso,
          finishedAt: finishedAtIso,
          totalSymbols: symbols.length,
          processed,
          success,
          failed,
        },
        symbols: mergedSymbols,
      };

      state.snapshot = nextSnapshot;
      state.lastError = '';
      await saveSnapshotToStore(nextSnapshot);
      return getDailySalesSnapshotStatus();
    } catch (error) {
      const failedAtIso = new Date().toISOString();
      state.lastError = `sales-snapshot-run:${error.message}`;
      state.snapshot = {
        ...state.snapshot,
        updatedAt: failedAtIso,
        run: {
          status: 'failed',
          reason,
          startedAt: startedAtIso,
          finishedAt: failedAtIso,
          totalSymbols: symbols.length,
          processed,
          success,
          failed,
        },
      };
      await saveSnapshotToStore(state.snapshot);
      return getDailySalesSnapshotStatus();
    } finally {
      runPromise = null;
      state.running = false;
    }
  })();

  return runPromise;
}

function getDailySalesSnapshotStatus() {
  const totalStoredSymbols = Object.keys(state.snapshot.symbols || {}).length;
  return {
    enabled: Boolean(config.salesSnapshotEnabled),
    scope: getSnapshotScope(),
    schedulerMode: state.schedulerMode,
    schedulerExpression: state.schedulerExpression,
    schedulerTimezone: state.schedulerTimezone,
    running: state.running,
    updatedAt: state.snapshot.updatedAt || '',
    totalStoredSymbols,
    run: normalizeRunState(state.snapshot.run),
    lastError: state.lastError || '',
  };
}

function getDailySalesForSymbol(symbolInput) {
  const symbol = normalizeIndianSymbol(symbolInput);
  if (!symbol) {
    throw new Error('Invalid stock symbol.');
  }

  return state.snapshot.symbols?.[symbol] || null;
}

function hasMissingSalesRecords(symbols) {
  const list = Array.isArray(symbols) ? symbols : [];
  for (const rawSymbol of list) {
    const symbol = normalizeIndianSymbol(rawSymbol);
    if (!symbol) {
      continue;
    }
    const record = state.snapshot.symbols?.[symbol];
    if (!record || record.dataStatus !== 'available') {
      return true;
    }
  }
  return false;
}

function requestSalesSnapshotRefreshIfNeeded(symbols, options = {}) {
  if (!config.salesSnapshotEnabled || state.running || runPromise) {
    return false;
  }

  if (!hasMissingSalesRecords(symbols)) {
    return false;
  }

  const nowMs = Date.now();
  const minIntervalMs = Math.max(toNumber(options.minIntervalMs, AUTO_REFRESH_MIN_INTERVAL_MS), 0);
  if (minIntervalMs > 0 && (nowMs - lastAutoRefreshAt) < minIntervalMs) {
    return false;
  }

  lastAutoRefreshAt = nowMs;
  refreshDailySalesSnapshot({ reason: String(options.reason || 'auto-miss') })
    .catch((error) => {
      state.lastError = `sales-snapshot-auto:${error.message}`;
    });
  return true;
}

function scheduleDailySnapshotJob() {
  if (schedulerTask) {
    schedulerTask.stop();
    schedulerTask = null;
  }

  if (!config.salesSnapshotEnabled) {
    state.schedulerMode = 'disabled';
    state.schedulerExpression = '';
    state.schedulerTimezone = '';
    return;
  }

  const cronExpression = String(config.salesSnapshotDailyCron || '').trim();
  if (!cronExpression || !cron.validate(cronExpression)) {
    state.schedulerMode = 'disabled';
    state.schedulerExpression = cronExpression;
    state.schedulerTimezone = String(config.salesSnapshotCronTimezone || 'Asia/Kolkata');
    state.lastError = `sales-snapshot-cron-invalid:${cronExpression || 'empty'}`;
    return;
  }

  const timezone = String(config.salesSnapshotCronTimezone || 'Asia/Kolkata');
  schedulerTask = cron.schedule(cronExpression, () => {
    refreshDailySalesSnapshot({ reason: 'scheduled-cron' })
      .catch((error) => {
        state.lastError = `sales-snapshot-cron-run:${error.message}`;
      });
  }, {
    scheduled: true,
    timezone,
  });

  state.schedulerMode = 'cron';
  state.schedulerExpression = cronExpression;
  state.schedulerTimezone = timezone;
}

async function initializeDailySalesSnapshot() {
  if (initialized) {
    return getDailySalesSnapshotStatus();
  }

  state.snapshot = await loadSnapshotFromStore();
  scheduleDailySnapshotJob();

  if (config.salesSnapshotEnabled && config.salesSnapshotRunOnStartup) {
    setTimeout(() => {
      refreshDailySalesSnapshot({ reason: 'startup' })
        .catch((error) => {
          state.lastError = `sales-snapshot-startup:${error.message}`;
        });
    }, 1200);
  }

  initialized = true;
  return getDailySalesSnapshotStatus();
}

function stopDailySalesSnapshot() {
  if (schedulerTask) {
    schedulerTask.stop();
    schedulerTask = null;
  }
}

module.exports = {
  initializeDailySalesSnapshot,
  refreshDailySalesSnapshot,
  getDailySalesSnapshotStatus,
  getDailySalesForSymbol,
  requestSalesSnapshotRefreshIfNeeded,
  stopDailySalesSnapshot,
};
