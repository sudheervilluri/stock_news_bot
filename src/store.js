const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { config } = require('./config');
const { getDb, isMongoEnabled } = require('./db/mongoClient');
const { normalizeIndianSymbol } = require('./utils/symbols');

const DASHBOARD_PAGE_KEYS = Object.freeze([
  'watchlist',
  'portfolio',
  'screener',
  'feed',
  'events',
]);

const defaultDb = {
  watchlist: ['RELIANCE.NS', 'TCS.NS', 'INFY.NS'],
  portfolio: [],
  profile: {
    displayName: 'Admin',
    contactName: 'Admin',
    enabledPages: [...DASHBOARD_PAGE_KEYS],
    updatedAt: new Date().toISOString(),
  },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

let writeQueue = Promise.resolve();
let cachedDb = null;
let storeInitialized = false;

function ensureDir(filePath) {
  if (!filePath) return;
  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toEpochMs(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return 0;
  }

  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function normalizeIsoTimestamp(value, fallbackIso) {
  const ms = toEpochMs(value);
  if (ms <= 0) {
    return fallbackIso;
  }
  return new Date(ms).toISOString();
}

function cloneCachedQuote(rawQuote, symbol) {
  if (!isPlainObject(rawQuote)) {
    return null;
  }

  return {
    ...rawQuote,
    symbol,
  };
}

function normalizeWatchlistEntry(rawEntry, nowIso) {
  if (typeof rawEntry === 'string') {
    const symbol = normalizeIndianSymbol(rawEntry);
    if (!symbol) {
      return null;
    }

    return {
      symbol,
      liveData: false,
      cachedQuote: null,
      cachedAt: '',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  }

  if (!isPlainObject(rawEntry)) {
    return null;
  }

  const symbol = normalizeIndianSymbol(rawEntry.symbol);
  if (!symbol) {
    return null;
  }

  const cachedQuote = cloneCachedQuote(rawEntry.cachedQuote, symbol);
  const cachedAtDefault = cachedQuote ? nowIso : '';

  return {
    symbol,
    liveData: Boolean(rawEntry.liveData),
    cachedQuote,
    cachedAt: cachedQuote
      ? normalizeIsoTimestamp(rawEntry.cachedAt, cachedAtDefault)
      : '',
    createdAt: normalizeIsoTimestamp(rawEntry.createdAt, nowIso),
    updatedAt: normalizeIsoTimestamp(rawEntry.updatedAt, nowIso),
  };
}

function mergeWatchlistEntries(existing, incoming, nowIso) {
  const existingCachedAtMs = toEpochMs(existing.cachedAt);
  const incomingCachedAtMs = toEpochMs(incoming.cachedAt);

  const useIncomingCachedQuote = incoming.cachedQuote && incomingCachedAtMs >= existingCachedAtMs;
  const cachedQuote = useIncomingCachedQuote ? incoming.cachedQuote : existing.cachedQuote;
  const cachedAt = cachedQuote
    ? (useIncomingCachedQuote ? incoming.cachedAt : existing.cachedAt)
    : '';

  return {
    symbol: existing.symbol,
    liveData: Boolean(existing.liveData || incoming.liveData),
    cachedQuote,
    cachedAt,
    createdAt: normalizeIsoTimestamp(existing.createdAt, normalizeIsoTimestamp(incoming.createdAt, nowIso)),
    updatedAt: normalizeIsoTimestamp(
      Math.max(toEpochMs(existing.updatedAt), toEpochMs(incoming.updatedAt)) > 0
        ? new Date(Math.max(toEpochMs(existing.updatedAt), toEpochMs(incoming.updatedAt))).toISOString()
        : nowIso,
      nowIso,
    ),
  };
}

function normalizeWatchlistCollection(rawWatchlist) {
  const nowIso = new Date().toISOString();
  const entries = Array.isArray(rawWatchlist) ? rawWatchlist : [];
  const merged = new Map();

  for (const rawEntry of entries) {
    const normalizedEntry = normalizeWatchlistEntry(rawEntry, nowIso);
    if (!normalizedEntry) {
      continue;
    }

    const existing = merged.get(normalizedEntry.symbol);
    if (!existing) {
      merged.set(normalizedEntry.symbol, normalizedEntry);
      continue;
    }

    merged.set(
      normalizedEntry.symbol,
      mergeWatchlistEntries(existing, normalizedEntry, nowIso),
    );
  }

  return Array.from(merged.values());
}

function normalizeProfileSettings(rawProfile, nowIso) {
  const profile = isPlainObject(rawProfile) ? rawProfile : {};
  const displayNameRaw = String(profile.displayName || '').trim();
  const contactNameRaw = String(profile.contactName || '').trim();
  const enabledRaw = Array.isArray(profile.enabledPages) ? profile.enabledPages : [];
  const allowed = new Set(DASHBOARD_PAGE_KEYS);
  const enabledPages = Array.from(new Set(
    enabledRaw
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((item) => allowed.has(item)),
  ));

  return {
    displayName: displayNameRaw || 'Admin',
    contactName: contactNameRaw || 'Admin',
    enabledPages: enabledPages.length > 0 ? enabledPages : [...DASHBOARD_PAGE_KEYS],
    updatedAt: normalizeIsoTimestamp(profile.updatedAt, nowIso),
  };
}

function getWatchlistSymbolsFromEntries(entries) {
  return (entries || [])
    .map((entry) => normalizeIndianSymbol(entry?.symbol))
    .filter(Boolean);
}

function migrateLegacyStocks() {
  const legacyPath = path.join(__dirname, '..', 'stocks.json');
  if (!fs.existsSync(legacyPath)) {
    return null;
  }

  const parsed = safeParseJson(fs.readFileSync(legacyPath, 'utf-8'));
  if (!Array.isArray(parsed)) {
    return null;
  }

  const symbols = parsed
    .map((symbol) => normalizeIndianSymbol(symbol))
    .filter(Boolean);

  return Array.from(new Set(symbols));
}

function ensureDbFile() {
  if (!config.dataFilePath) return;
  ensureDir(config.dataFilePath);
  if (!fs.existsSync(config.dataFilePath)) {
    const migratedWatchlist = migrateLegacyStocks();
    const initialDb = {
      ...defaultDb,
      watchlist: migratedWatchlist && migratedWatchlist.length > 0
        ? migratedWatchlist
        : defaultDb.watchlist,
    };

    fs.writeFileSync(config.dataFilePath, JSON.stringify(initialDb, null, 2));
  }
}

function normalizeDbShape(db) {
  const nowIso = new Date().toISOString();
  return {
    watchlist: normalizeWatchlistCollection(
      Array.isArray(db.watchlist) && db.watchlist.length > 0
        ? db.watchlist
        : defaultDb.watchlist,
    ),
    portfolio: Array.isArray(db.portfolio)
      ? db.portfolio
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          id: item.id || randomUUID(),
          symbol: normalizeIndianSymbol(item.symbol),
          quantity: Number(item.quantity || 0),
          avgPrice: Number(item.avgPrice || 0),
          notes: item.notes || '',
          createdAt: item.createdAt || new Date().toISOString(),
          updatedAt: item.updatedAt || new Date().toISOString(),
        }))
        .filter((item) => item.symbol && item.quantity > 0)
      : [],
    profile: normalizeProfileSettings(db.profile, nowIso),
    createdAt: db.createdAt || nowIso,
    updatedAt: nowIso,
  };
}

function readDbFromDisk() {
  if (!config.dataFilePath) {
    return normalizeDbShape(defaultDb);
  }
  ensureDbFile();
  const raw = fs.readFileSync(config.dataFilePath, 'utf-8');
  const parsed = safeParseJson(raw);

  if (!parsed) {
    return normalizeDbShape(defaultDb);
  }

  return normalizeDbShape(parsed);
}

async function readDbFromMongo() {
  const db = await getDb();
  if (!db) {
    return null;
  }

  const doc = await db.collection('app_state').findOne({ _id: 'app' });
  if (!doc) {
    return null;
  }

  const { _id, ...rest } = doc;
  return normalizeDbShape(rest);
}

async function initializeStore() {
  if (storeInitialized) {
    return cachedDb || normalizeDbShape(defaultDb);
  }

  if (isMongoEnabled()) {
    const mongoDb = await getDb();
    // If Mongo is enabled but connection fails, getDb returns null.
    // Fallback to disk if configured.
    if (!mongoDb) {
      console.warn('[store] Mongo enabled but connection failed. Falling back to local file.');
      cachedDb = readDbFromDisk();
      storeInitialized = true;
      return cachedDb;
    }

    const collection = mongoDb.collection('app_state');
    const existing = await collection.findOne({ _id: 'app' });
    if (existing) {
      const { _id, ...rest } = existing;
      cachedDb = normalizeDbShape(rest);
    } else {
      // Initial seed for new DB
      cachedDb = normalizeDbShape(defaultDb);
      await collection.updateOne(
        { _id: 'app' },
        { $set: cachedDb },
        { upsert: true },
      );
    }
  } else {
    cachedDb = readDbFromDisk();
  }

  storeInitialized = true;
  return cachedDb;
}

function readDb() {
  if (!storeInitialized) {
    if (!isMongoEnabled()) {
      cachedDb = readDbFromDisk();
      storeInitialized = true;
      return cachedDb;
    }
    throw new Error('Storage not initialized. Call initializeStore() first.');
  }

  return cachedDb || normalizeDbShape(defaultDb);
}

function writeDb(updater) {
  writeQueue = writeQueue.then(async () => {
    const mongoEnabled = isMongoEnabled();
    const current = cachedDb || (mongoEnabled
      ? (await readDbFromMongo()) || normalizeDbShape(defaultDb)
      : readDbFromDisk());

    const next = typeof updater === 'function' ? updater(current) : updater;
    const normalized = normalizeDbShape({
      ...next,
      updatedAt: new Date().toISOString(),
    });

    cachedDb = normalized;

    if (mongoEnabled) {
      const mongoDb = await getDb();
      if (mongoDb) {
        await mongoDb.collection('app_state').updateOne(
          { _id: 'app' },
          { $set: normalized },
          { upsert: true },
        );
      } else {
        // Fallback write if Mongo enabled but down
        if (config.dataFilePath) {
          try {
            ensureDir(config.dataFilePath);
            fs.writeFileSync(config.dataFilePath, JSON.stringify(normalized, null, 2));
          } catch (err) {
            console.error('[store] Failed to write fallback file:', err.message);
          }
        }
      }
    } else {
      // Mongo disabled, write to disk
      if (config.dataFilePath) {
        try {
          ensureDir(config.dataFilePath);
          fs.writeFileSync(config.dataFilePath, JSON.stringify(normalized, null, 2));
        } catch (err) {
          console.error('[store] Failed to write file:', err.message);
        }
      }
    }

    return normalized;
  });

  return writeQueue;
}

async function getWatchlistEntries() {
  return readDb().watchlist;
}

async function getWatchlist() {
  return getWatchlistSymbolsFromEntries(readDb().watchlist);
}

async function addToWatchlist(symbolInput, options = {}) {
  const symbol = normalizeIndianSymbol(symbolInput);
  if (!symbol) {
    throw new Error('Invalid stock symbol.');
  }

  const hasRequestedLiveData = options.liveData !== undefined;
  const requestedLiveData = Boolean(options.liveData);

  const db = await writeDb((current) => {
    const existing = current.watchlist.find((entry) => entry.symbol === symbol);
    if (existing) {
      if (!hasRequestedLiveData || existing.liveData === requestedLiveData) {
        return current;
      }

      return {
        ...current,
        watchlist: current.watchlist.map((entry) => (
          entry.symbol === symbol
            ? {
              ...entry,
              liveData: requestedLiveData,
              updatedAt: new Date().toISOString(),
            }
            : entry
        )),
      };
    }

    return {
      ...current,
      watchlist: [
        ...current.watchlist,
        {
          symbol,
          liveData: hasRequestedLiveData ? requestedLiveData : false,
          cachedQuote: null,
          cachedAt: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    };
  });

  return getWatchlistSymbolsFromEntries(db.watchlist);
}

async function removeFromWatchlist(symbolInput) {
  const symbol = normalizeIndianSymbol(symbolInput);
  const db = await writeDb((current) => ({
    ...current,
    watchlist: current.watchlist.filter((entry) => entry.symbol !== symbol),
    portfolio: current.portfolio.filter((position) => position.symbol !== symbol),
  }));

  return getWatchlistSymbolsFromEntries(db.watchlist);
}

async function setWatchlistLiveData(symbolInput, liveData) {
  const symbol = normalizeIndianSymbol(symbolInput);
  if (!symbol) {
    throw new Error('Invalid stock symbol.');
  }

  const liveFlag = Boolean(liveData);
  const exists = readDb().watchlist.some((entry) => entry.symbol === symbol);
  if (!exists) {
    throw new Error(`Watchlist symbol not found: ${symbol}`);
  }

  const db = await writeDb((current) => {
    const nextWatchlist = current.watchlist.map((entry) => {
      if (entry.symbol !== symbol) {
        return entry;
      }

      return {
        ...entry,
        liveData: liveFlag,
        updatedAt: new Date().toISOString(),
      };
    });

    return {
      ...current,
      watchlist: nextWatchlist,
    };
  });

  return db.watchlist;
}

async function setAllWatchlistLiveData(liveData) {
  const liveFlag = Boolean(liveData);

  const db = await writeDb((current) => ({
    ...current,
    watchlist: current.watchlist.map((entry) => ({
      ...entry,
      liveData: liveFlag,
      updatedAt: new Date().toISOString(),
    })),
  }));

  return db.watchlist;
}

async function updateWatchlistQuoteCaches(records) {
  const updates = Array.isArray(records) ? records : [];
  if (updates.length === 0) {
    return getWatchlistEntries();
  }

  const updatesBySymbol = new Map();
  for (const record of updates) {
    const quote = isPlainObject(record?.quote) ? record.quote : record;
    const symbol = normalizeIndianSymbol(record?.symbol || quote?.symbol);
    if (!symbol || !isPlainObject(quote)) {
      continue;
    }

    const cachedAtIso = normalizeIsoTimestamp(record?.cachedAt || record?.fetchedAt, new Date().toISOString());
    updatesBySymbol.set(symbol, {
      symbol,
      cachedQuote: {
        ...quote,
        symbol,
      },
      cachedAt: cachedAtIso,
    });
  }

  if (updatesBySymbol.size === 0) {
    return getWatchlistEntries();
  }

  const db = await writeDb((current) => ({
    ...current,
    watchlist: current.watchlist.map((entry) => {
      const update = updatesBySymbol.get(entry.symbol);
      if (!update) {
        return entry;
      }

      return {
        ...entry,
        cachedQuote: update.cachedQuote,
        cachedAt: update.cachedAt,
        updatedAt: new Date().toISOString(),
      };
    }),
  }));

  return db.watchlist;
}

async function getPortfolio() {
  return readDb().portfolio;
}

function getDashboardPageKeys() {
  return [...DASHBOARD_PAGE_KEYS];
}

async function getProfileSettings() {
  return readDb().profile;
}

async function updateProfileSettings(input = {}) {
  const current = readDb().profile;
  const payload = {
    ...current,
    displayName: input.displayName !== undefined ? String(input.displayName || '').trim() : current.displayName,
    contactName: input.contactName !== undefined ? String(input.contactName || '').trim() : current.contactName,
    enabledPages: input.enabledPages !== undefined
      ? (Array.isArray(input.enabledPages) ? input.enabledPages : [])
      : current.enabledPages,
    updatedAt: new Date().toISOString(),
  };
  const normalizedProfile = normalizeProfileSettings(payload, new Date().toISOString());

  const db = await writeDb((currentDb) => ({
    ...currentDb,
    profile: normalizedProfile,
  }));

  return db.profile;
}

function validatePositionInput(input) {
  const symbol = normalizeIndianSymbol(input.symbol);
  const quantity = Number(input.quantity);
  const avgPrice = Number(input.avgPrice);

  if (!symbol) {
    throw new Error('Position requires a valid symbol.');
  }

  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('Quantity must be greater than zero.');
  }

  if (!Number.isFinite(avgPrice) || avgPrice <= 0) {
    throw new Error('Average price must be greater than zero.');
  }

  return {
    symbol,
    quantity,
    avgPrice,
    notes: String(input.notes || ''),
  };
}

async function addPortfolioPosition(input) {
  const parsed = validatePositionInput(input);

  const db = await writeDb((current) => {
    const existing = current.portfolio.find((item) => item.symbol === parsed.symbol);
    if (!existing) {
      return {
        ...current,
        portfolio: [
          ...current.portfolio,
          {
            id: randomUUID(),
            ...parsed,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      };
    }

    const totalQuantity = existing.quantity + parsed.quantity;
    const weightedAvgPrice = ((existing.quantity * existing.avgPrice) + (parsed.quantity * parsed.avgPrice)) / totalQuantity;

    return {
      ...current,
      portfolio: current.portfolio.map((item) => {
        if (item.symbol !== parsed.symbol) {
          return item;
        }

        return {
          ...item,
          quantity: Number(totalQuantity.toFixed(4)),
          avgPrice: Number(weightedAvgPrice.toFixed(4)),
          notes: parsed.notes || item.notes,
          updatedAt: new Date().toISOString(),
        };
      }),
    };
  });

  return db.portfolio;
}

async function updatePortfolioPosition(id, input) {
  const db = readDb();
  const existing = db.portfolio.find((position) => position.id === id);
  if (!existing) {
    throw new Error('Position not found.');
  }

  const payload = {
    symbol: existing.symbol,
    quantity: input.quantity ?? existing.quantity,
    avgPrice: input.avgPrice ?? existing.avgPrice,
    notes: input.notes ?? existing.notes,
  };
  const parsed = validatePositionInput(payload);

  const updatedDb = await writeDb((current) => ({
    ...current,
    portfolio: current.portfolio.map((position) => {
      if (position.id !== id) {
        return position;
      }

      return {
        ...position,
        ...parsed,
        updatedAt: new Date().toISOString(),
      };
    }),
  }));

  return updatedDb.portfolio;
}

async function deletePortfolioPosition(id) {
  const db = await writeDb((current) => ({
    ...current,
    portfolio: current.portfolio.filter((position) => position.id !== id),
  }));

  return db.portfolio;
}

module.exports = {
  initializeStore,
  readDb,
  writeDb,
  getWatchlist,
  getWatchlistEntries,
  addToWatchlist,
  removeFromWatchlist,
  setWatchlistLiveData,
  setAllWatchlistLiveData,
  updateWatchlistQuoteCaches,
  getPortfolio,
  getDashboardPageKeys,
  getProfileSettings,
  updateProfileSettings,
  addPortfolioPosition,
  updatePortfolioPosition,
  deletePortfolioPosition,
};
