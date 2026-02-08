const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { config } = require('../config');
const { normalizeIndianSymbol } = require('../utils/symbols');
const { getSymbolMasterItems } = require('./symbolMasterService');
const { getQuarterlyFinancials } = require('./marketDataService');

const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 8;
const MIN_LIMIT = 1;
const MAX_LIMIT = 8;
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
  const configured = toNumber(config.salesSnapshotQuarterLimit, 6);
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

function ensureSnapshotDir() {
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
    if (!fs.existsSync(config.salesSnapshotFilePath)) {
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
    ensureSnapshotDir();
    fs.writeFileSync(config.salesSnapshotFilePath, JSON.stringify(snapshot, null, 2));
  } catch (error) {
    state.lastError = `sales-snapshot-save:${error.message}`;
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

function hasAnyValue(values) {
  return Array.isArray(values) && values.some((value) => Number.isFinite(Number(value)));
}

function buildSalesRecord(symbolItem, financials, snapshotDate, capturedAt) {
  const rows = Array.isArray(financials?.rows) ? financials.rows : [];
  const sales = getSeriesFromRows(rows, 'sales');
  const pat = getSeriesFromRows(rows, 'pat');
  const salesQoq = getSeriesFromRows(rows, 'sales_qoq');
  const salesYoy = getSeriesFromRows(rows, 'sales_yoy');
  const patQoq = getSeriesFromRows(rows, 'pat_qoq');
  const patYoy = getSeriesFromRows(rows, 'pat_yoy');
  const hasData = hasAnyValue(sales) || hasAnyValue(pat);

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
    sales,
    pat,
    salesQoq,
    salesYoy,
    patQoq,
    patYoy,
  };
}

function getTargetSymbolItems() {
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

  const sorted = Array.from(deduped.values()).sort((left, right) => left.symbol.localeCompare(right.symbol, undefined, {
    numeric: true,
    sensitivity: 'base',
  }));

  const maxSymbols = getMaxSymbolsPerRun();
  if (maxSymbols > 0) {
    return sorted.slice(0, maxSymbols);
  }

  return sorted;
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
  const symbols = getTargetSymbolItems();

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
          nextRecords[symbolItem.symbol] = record;
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
      saveSnapshotToDisk(nextSnapshot);
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
      saveSnapshotToDisk(state.snapshot);
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

function initializeDailySalesSnapshot() {
  if (initialized) {
    return getDailySalesSnapshotStatus();
  }

  state.snapshot = loadSnapshotFromDisk();
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
  stopDailySalesSnapshot,
};
