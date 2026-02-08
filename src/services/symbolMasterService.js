const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cron = require('node-cron');
const { config } = require('../config');
const { getDb, isMongoEnabled } = require('../db/mongoClient');
const { normalizeIndianSymbol, stripExchangeSuffix } = require('../utils/symbols');

const MIN_REFRESH_MS = 60 * 60 * 1000;
const DEFAULT_REFRESH_MS = 24 * 60 * 60 * 1000;
const SEARCH_LIMIT_MAX = 50;

const requestHeaders = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/csv,text/plain,application/octet-stream,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
};

let state = {
  items: [],
  bySymbol: new Map(),
  lastRefreshAt: '',
  nextRefreshAt: '',
  sourceSummary: {
    totalSymbols: 0,
    nseSymbols: 0,
    bseSymbols: 0,
    errors: [],
  },
  lastError: '',
};

let refreshPromise = null;
let refreshTimer = null;
let refreshTask = null;
let initialized = false;

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getRefreshIntervalMs() {
  return Math.max(toNumber(config.symbolMasterRefreshMs, DEFAULT_REFRESH_MS), MIN_REFRESH_MS);
}

function getDailyCronExpression() {
  return String(config.symbolMasterDailyCron || '').trim();
}

function getCronTimezone() {
  const timezone = String(config.symbolMasterCronTimezone || '').trim();
  return timezone || 'Asia/Kolkata';
}

function normalizeHeader(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSearchText(value) {
  return normalizeText(value).toUpperCase();
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      const nextChar = line[index + 1];
      if (inQuotes && nextChar === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells.map((cell) => normalizeText(cell));
}

function buildHeaderIndexMap(headerCells) {
  const map = new Map();
  for (let index = 0; index < headerCells.length; index += 1) {
    map.set(normalizeHeader(headerCells[index]), index);
  }
  return map;
}

function readCsvCell(rowCells, headerMap, candidates) {
  for (const candidate of candidates) {
    const idx = headerMap.get(normalizeHeader(candidate));
    if (idx === undefined) {
      continue;
    }
    return normalizeText(rowCells[idx]);
  }
  return '';
}

function makeMasterItem(symbolInput, companyNameInput, source) {
  const symbol = normalizeIndianSymbol(symbolInput);
  if (!symbol || (!symbol.endsWith('.NS') && !symbol.endsWith('.BO'))) {
    return null;
  }

  const baseSymbol = stripExchangeSuffix(symbol);
  if (!baseSymbol) {
    return null;
  }

  const exchange = symbol.endsWith('.BO') ? 'BSE' : 'NSE';
  const companyName = normalizeText(companyNameInput) || baseSymbol;

  return {
    symbol,
    baseSymbol,
    companyName,
    exchange,
    source: source || 'unknown',
    symbolUpper: symbol.toUpperCase(),
    baseUpper: baseSymbol.toUpperCase(),
    companyUpper: companyName.toUpperCase(),
  };
}

function scoreCompanyName(companyName, baseSymbol) {
  const normalizedName = normalizeText(companyName);
  if (!normalizedName) {
    return 0;
  }

  let score = Math.min(normalizedName.length, 120);
  if (normalizedName.toUpperCase() !== String(baseSymbol || '').toUpperCase()) {
    score += 40;
  }
  if (/\s/.test(normalizedName)) {
    score += 10;
  }
  return score;
}

function sourcePriority(source) {
  const normalized = String(source || '').toLowerCase();
  if (normalized === 'nse-official') {
    return 4;
  }
  if (normalized === 'iifl') {
    return 3;
  }
  if (normalized === 'disk') {
    return 2;
  }
  return 1;
}

function dedupeItems(items) {
  const map = new Map();

  for (const item of items || []) {
    if (!item || !item.symbol) {
      continue;
    }

    const existing = map.get(item.symbol);
    if (!existing) {
      map.set(item.symbol, item);
      continue;
    }

    const existingScore = scoreCompanyName(existing.companyName, existing.baseSymbol);
    const nextScore = scoreCompanyName(item.companyName, item.baseSymbol);

    if (nextScore > existingScore) {
      map.set(item.symbol, item);
      continue;
    }

    if (nextScore === existingScore && sourcePriority(item.source) > sourcePriority(existing.source)) {
      map.set(item.symbol, item);
    }
  }

  return Array.from(map.values())
    .sort((left, right) => left.symbol.localeCompare(right.symbol, undefined, {
      numeric: true,
      sensitivity: 'base',
    }));
}

function buildBySymbolIndex(items) {
  const map = new Map();
  for (const item of items || []) {
    map.set(item.symbol, item);
  }
  return map;
}

function buildSourceSummary(items) {
  const list = Array.isArray(items) ? items : [];
  return {
    totalSymbols: list.length,
    nseSymbols: list.filter((item) => item.exchange === 'NSE').length,
    bseSymbols: list.filter((item) => item.exchange === 'BSE').length,
    errors: [],
  };
}

function toPersistedItem(item) {
  return {
    symbol: item.symbol,
    baseSymbol: item.baseSymbol,
    companyName: item.companyName,
    exchange: item.exchange,
    source: item.source,
  };
}

function fromPersistedItem(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  return makeMasterItem(item.symbol, item.companyName, item.source || 'disk');
}

function ensureSymbolMasterFileDir() {
  const filePath = config.symbolMasterFilePath;
  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function loadFromDisk() {
  try {
    if (!fs.existsSync(config.symbolMasterFilePath)) {
      return false;
    }

    const raw = fs.readFileSync(config.symbolMasterFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed.items)
      ? parsed.items.map((item) => fromPersistedItem(item)).filter(Boolean)
      : [];
    const deduped = dedupeItems(items);

    if (deduped.length === 0) {
      return false;
    }

    state = {
      ...state,
      items: deduped,
      bySymbol: buildBySymbolIndex(deduped),
      lastRefreshAt: String(parsed.updatedAt || parsed.lastRefreshAt || ''),
      sourceSummary: {
        ...buildSourceSummary(deduped),
      },
      lastError: '',
    };
    return true;
  } catch (error) {
    state.lastError = `disk-load:${error.message}`;
    return false;
  }
}

function persistToDisk(items, summary) {
  try {
    ensureSymbolMasterFileDir();
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      summary: summary || {},
      items: items.map((item) => toPersistedItem(item)),
    };

    fs.writeFileSync(config.symbolMasterFilePath, JSON.stringify(payload, null, 2));
  } catch (error) {
    state.lastError = `disk-save:${error.message}`;
  }
}

async function persistToMongo(items, summary) {
  if (!isMongoEnabled()) {
    return;
  }

  try {
    const db = await getDb();
    if (!db) {
      return;
    }

    const collection = db.collection('symbol_master');
    await collection.deleteMany({});
    if (items.length > 0) {
      await collection.insertMany(items.map((item) => toPersistedItem(item)), { ordered: false });
    }

    await db.collection('symbol_master_meta').updateOne(
      { _id: 'meta' },
      {
        $set: {
          updatedAt: new Date().toISOString(),
          summary: summary || buildSourceSummary(items),
        },
      },
      { upsert: true },
    );
  } catch (error) {
    state.lastError = `mongo-save:${error.message}`;
  }
}

async function loadFromMongo() {
  if (!isMongoEnabled()) {
    return false;
  }

  try {
    const db = await getDb();
    if (!db) {
      return false;
    }

    const collection = db.collection('symbol_master');
    const items = await collection.find({}).toArray();

    const deduped = dedupeItems(items.map((item) => fromPersistedItem(item)).filter(Boolean));
    if (deduped.length === 0) {
      return false;
    }

    const meta = await db.collection('symbol_master_meta').findOne({ _id: 'meta' });
    state = {
      ...state,
      items: deduped,
      bySymbol: buildBySymbolIndex(deduped),
      lastRefreshAt: String(meta?.updatedAt || ''),
      sourceSummary: meta?.summary || buildSourceSummary(deduped),
      lastError: '',
    };
    return true;
  } catch (error) {
    state.lastError = `mongo-load:${error.message}`;
    return false;
  }
}

async function persistToStore(items, summary) {
  if (isMongoEnabled()) {
    await persistToMongo(items, summary);
  } else {
    persistToDisk(items, summary);
  }
}

async function fetchText(url) {
  const response = await axios.get(url, {
    timeout: Math.max(toNumber(config.symbolMasterRequestTimeoutMs, 30000), 5000),
    responseType: 'text',
    headers: requestHeaders,
    validateStatus: (status) => status >= 200 && status < 300,
  });

  return String(response.data || '');
}

function parseNseCsv(csvText) {
  const lines = String(csvText || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line && line.trim());

  if (lines.length <= 1) {
    return [];
  }

  const headerCells = parseCsvLine(lines[0]);
  const headerMap = buildHeaderIndexMap(headerCells);

  const items = [];
  for (let index = 1; index < lines.length; index += 1) {
    const rowCells = parseCsvLine(lines[index]);
    const symbolRaw = readCsvCell(rowCells, headerMap, ['SYMBOL', 'Security Id', 'Ticker']);
    const companyName = readCsvCell(rowCells, headerMap, ['NAME OF COMPANY', 'Company Name', 'Security Name', 'NAME']);
    const series = readCsvCell(rowCells, headerMap, ['SERIES']);

    const symbolToken = String(symbolRaw || '').toUpperCase().replace(/\s+/g, '');
    if (!symbolToken || !companyName) {
      continue;
    }

    if (!/^[A-Z0-9][A-Z0-9._-]{0,24}$/.test(symbolToken)) {
      continue;
    }

    // Ignore obvious debt/non-equity series when present.
    const blockedSeries = new Set(['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9']);
    if (series && blockedSeries.has(series.toUpperCase())) {
      continue;
    }

    const item = makeMasterItem(`${symbolToken}.NS`, companyName, 'nse-official');
    if (item) {
      items.push(item);
    }
  }

  return items;
}

async function fetchNseItems() {
  const urls = Array.isArray(config.symbolMasterNseCsvUrls) ? config.symbolMasterNseCsvUrls : [];
  let lastError = null;

  for (const url of urls) {
    try {
      const csvText = await fetchText(url);
      const parsed = parseNseCsv(csvText);
      if (parsed.length > 0) {
        return parsed;
      }
      lastError = new Error('nse-empty-csv');
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`nse-master-unavailable:${lastError ? lastError.message : 'no-url'}`);
}

function parseIiflCsv(csvText) {
  const lines = String(csvText || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line && line.trim());

  if (lines.length <= 1) {
    return { nseItems: [], bseItems: [] };
  }

  const headerCells = parseCsvLine(lines[0]);
  const headerMap = buildHeaderIndexMap(headerCells);

  const nseItems = [];
  const bseItems = [];

  for (let index = 1; index < lines.length; index += 1) {
    const rowCells = parseCsvLine(lines[index]);

    const exch = readCsvCell(rowCells, headerMap, ['Exch', 'Exchange']).toUpperCase();
    const exchType = readCsvCell(rowCells, headerMap, ['ExchType', 'ExchangeType', 'InstrumentType']).toUpperCase();
    const symbolRaw = readCsvCell(rowCells, headerMap, ['TradingSymbol', 'Symbol', 'Name']);
    const companyNameRaw = readCsvCell(rowCells, headerMap, ['FullName', 'CompanyName', 'SecurityName', 'Description', 'Name']);

    if (!exch || !['N', 'NSE', 'B', 'BSE'].includes(exch)) {
      continue;
    }

    if (exchType && exchType !== 'C') {
      continue;
    }

    if (exch === 'B' || exch === 'BSE') {
      const scripCodeRaw = readCsvCell(rowCells, headerMap, ['ScripCode', 'SecurityCode', 'Code', 'Token']) || symbolRaw;
      const codeMatch = String(scripCodeRaw || '').match(/\d{5,6}/);
      if (!codeMatch) {
        continue;
      }

      const item = makeMasterItem(`${codeMatch[0]}.BO`, companyNameRaw || codeMatch[0], 'iifl');
      if (item) {
        bseItems.push(item);
      }
      continue;
    }

    const symbolToken = String(symbolRaw || '').toUpperCase().replace(/\s+/g, '');
    if (!symbolToken || /^\d+$/.test(symbolToken)) {
      continue;
    }

    if (!/^[A-Z0-9][A-Z0-9._-]{0,24}$/.test(symbolToken)) {
      continue;
    }

    const item = makeMasterItem(`${symbolToken}.NS`, companyNameRaw || symbolToken, 'iifl');
    if (item) {
      nseItems.push(item);
    }
  }

  return {
    nseItems,
    bseItems,
  };
}

async function fetchIiflItems() {
  if (!config.symbolMasterIiflCsvUrl) {
    return { nseItems: [], bseItems: [] };
  }

  const csvText = await fetchText(config.symbolMasterIiflCsvUrl);
  return parseIiflCsv(csvText);
}

function scheduleNextRefresh() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  const intervalMs = getRefreshIntervalMs();
  state.nextRefreshAt = new Date(Date.now() + intervalMs).toISOString();

  refreshTimer = setTimeout(() => {
    refreshSymbolMaster({ reason: 'scheduled' })
      .catch((error) => {
        state.lastError = `refresh:${error.message}`;
      })
      .finally(() => {
        scheduleNextRefresh();
      });
  }, intervalMs);

  if (typeof refreshTimer.unref === 'function') {
    refreshTimer.unref();
  }
}

function scheduleRefreshJob() {
  if (refreshTask) {
    refreshTask.stop();
    refreshTask = null;
  }

  const cronExpression = getDailyCronExpression();
  if (!cronExpression || !cron.validate(cronExpression)) {
    if (cronExpression) {
      state.lastError = `symbol-cron-invalid:${cronExpression}; using interval fallback`;
    }
    scheduleNextRefresh();
    return;
  }

  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  const timezone = getCronTimezone();
  state.nextRefreshAt = new Date(Date.now() + getRefreshIntervalMs()).toISOString();

  refreshTask = cron.schedule(cronExpression, () => {
    state.nextRefreshAt = new Date(Date.now() + getRefreshIntervalMs()).toISOString();
    refreshSymbolMaster({ reason: 'scheduled-cron' })
      .catch((error) => {
        state.lastError = `refresh:${error.message}`;
      });
  }, {
    scheduled: true,
    timezone,
  });
}

function getSymbolMasterStatus() {
  const cronExpression = getDailyCronExpression();
  const cronEnabled = Boolean(cronExpression && cron.validate(cronExpression));
  return {
    totalSymbols: state.items.length,
    nseSymbols: state.sourceSummary.nseSymbols || 0,
    bseSymbols: state.sourceSummary.bseSymbols || 0,
    lastRefreshAt: state.lastRefreshAt,
    nextRefreshAt: state.nextRefreshAt,
    errors: state.sourceSummary.errors || [],
    lastError: state.lastError || '',
    schedulerMode: cronEnabled ? 'cron' : 'interval',
    schedulerExpression: cronEnabled ? cronExpression : '',
    schedulerTimezone: cronEnabled ? getCronTimezone() : '',
  };
}

function getSymbolMasterItems(options = {}) {
  const exchangeRaw = String(options.exchange || 'all').trim().toUpperCase();
  const exchangeFilter = ['NSE', 'BSE'].includes(exchangeRaw) ? exchangeRaw : 'ALL';

  const selected = exchangeFilter === 'ALL'
    ? state.items
    : state.items.filter((item) => item.exchange === exchangeFilter);

  return selected.map((item) => ({
    symbol: item.symbol,
    baseSymbol: item.baseSymbol,
    companyName: item.companyName,
    exchange: item.exchange,
    source: item.source,
  }));
}

async function refreshSymbolMaster(options = {}) {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const errors = [];
    let nseOfficialItems = [];
    let iiflItems = { nseItems: [], bseItems: [] };

    try {
      nseOfficialItems = await fetchNseItems();
    } catch (error) {
      errors.push(`nse:${error.message}`);
    }

    try {
      iiflItems = await fetchIiflItems();
    } catch (error) {
      errors.push(`iifl:${error.message}`);
    }

    const combined = dedupeItems([
      ...nseOfficialItems,
      ...iiflItems.nseItems,
      ...iiflItems.bseItems,
    ]);

    if (combined.length === 0) {
      if (state.items.length > 0) {
        state.sourceSummary = {
          ...state.sourceSummary,
          errors,
        };
        state.lastError = `refresh-empty:${errors.join(' | ')}`;
        return getSymbolMasterStatus();
      }

      throw new Error(`symbol-master-empty:${errors.join(' | ') || 'all-providers-failed'}`);
    }

    const nseCount = combined.filter((item) => item.exchange === 'NSE').length;
    const bseCount = combined.filter((item) => item.exchange === 'BSE').length;

    state = {
      ...state,
      items: combined,
      bySymbol: buildBySymbolIndex(combined),
      lastRefreshAt: new Date().toISOString(),
      sourceSummary: {
        totalSymbols: combined.length,
        nseSymbols: nseCount,
        bseSymbols: bseCount,
        errors,
        reason: String(options.reason || 'manual'),
      },
      lastError: '',
      nextRefreshAt: new Date(Date.now() + getRefreshIntervalMs()).toISOString(),
    };

    await persistToStore(combined, state.sourceSummary);

    return getSymbolMasterStatus();
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function initializeSymbolMaster() {
  if (initialized) {
    return getSymbolMasterStatus();
  }

  const loaded = await loadFromMongo();
  if (!loaded) {
    loadFromDisk();
  }
  scheduleRefreshJob();
  refreshSymbolMaster({ reason: 'startup' }).catch((error) => {
    state.lastError = `startup:${error.message}`;
  });

  initialized = true;
  return getSymbolMasterStatus();
}

function searchSymbols(queryInput, options = {}) {
  const query = normalizeText(queryInput);
  if (!query) {
    return [];
  }

  const defaultLimit = Math.max(toNumber(config.symbolMasterSearchLimit, 12), 1);
  const limit = Math.min(Math.max(toNumber(options.limit, defaultLimit), 1), SEARCH_LIMIT_MAX);
  const exchangeRaw = String(options.exchange || 'all').trim().toUpperCase();
  const exchangeFilter = ['NSE', 'BSE'].includes(exchangeRaw) ? exchangeRaw : 'ALL';

  const normalizedQuery = normalizeSearchText(query);
  const compactQuery = normalizedQuery.replace(/\s+/g, '');
  const numericQuery = /^\d{3,}$/.test(compactQuery);

  const ranked = [];
  for (const item of state.items) {
    if (exchangeFilter !== 'ALL' && item.exchange !== exchangeFilter) {
      continue;
    }

    let score = 0;

    if (item.symbolUpper === compactQuery || item.symbolUpper === `${compactQuery}.NS` || item.symbolUpper === `${compactQuery}.BO`) {
      score = 140;
    } else if (item.baseUpper === compactQuery) {
      score = 130;
    } else if (item.baseUpper.startsWith(compactQuery)) {
      score = 110;
    } else if (item.companyUpper.startsWith(normalizedQuery)) {
      score = 95;
    } else if (item.symbolUpper.includes(compactQuery)) {
      score = 85;
    } else if (item.companyUpper.includes(normalizedQuery)) {
      score = 70;
    } else {
      continue;
    }

    if (numericQuery && item.exchange === 'BSE') {
      score += 20;
    }

    if (!numericQuery && item.exchange === 'NSE') {
      score += 5;
    }

    ranked.push({ item, score });
  }

  ranked.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    if (left.item.exchange !== right.item.exchange) {
      if (numericQuery) {
        return left.item.exchange === 'BSE' ? -1 : 1;
      }
      return left.item.exchange === 'NSE' ? -1 : 1;
    }

    return left.item.symbol.localeCompare(right.item.symbol, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });

  return ranked.slice(0, limit).map(({ item }) => ({
    symbol: item.symbol,
    baseSymbol: item.baseSymbol,
    companyName: item.companyName,
    exchange: item.exchange,
  }));
}

function resolveSymbolQuery(input) {
  const raw = normalizeText(input);
  if (!raw) {
    return '';
  }

  const normalized = normalizeIndianSymbol(raw);
  if (!normalized) {
    return '';
  }

  if (state.bySymbol.has(normalized)) {
    return normalized;
  }

  const hasSymbolShape = /screener\.in\/company\/\d{5,6}/i.test(raw)
    || /^[A-Za-z0-9_.-]+(?:\.(?:NS|NSE|BO|BSE))?$/i.test(raw);
  if (hasSymbolShape) {
    return normalized;
  }

  const matches = searchSymbols(raw, { limit: 1 });
  if (matches.length > 0) {
    return matches[0].symbol;
  }

  // If this looks like a company name but no match exists, reject it.
  if (/\s/.test(raw)) {
    return '';
  }

  return normalized;
}

function stopSymbolMasterRefresh() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (refreshTask) {
    refreshTask.stop();
    refreshTask = null;
  }
}

module.exports = {
  initializeSymbolMaster,
  refreshSymbolMaster,
  searchSymbols,
  resolveSymbolQuery,
  getSymbolMasterItems,
  getSymbolMasterStatus,
  stopSymbolMasterRefresh,
};
