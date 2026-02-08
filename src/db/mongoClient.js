const { MongoClient } = require('mongodb');
const { config } = require('../config');

let client = null;
let db = null;
let connectPromise = null;
let lastError = '';
let failureCount = 0;
let disabledUntilMs = 0;

function isMongoEnabled() {
  return Boolean(config.mongoUri) && Date.now() >= disabledUntilMs;
}

function calculateBackoffMs(nextFailureCount) {
  const baseMs = 30 * 1000;
  const maxMs = 10 * 60 * 1000;
  const exponent = Math.min(Math.max(nextFailureCount - 1, 0), 5);
  return Math.min(baseMs * (2 ** exponent), maxMs);
}

async function getDb() {
  if (!config.mongoUri) {
    return null;
  }

  if (Date.now() < disabledUntilMs) {
    return null;
  }

  if (db) {
    return db;
  }

  if (!connectPromise) {
    const timeoutMs = Math.max(Number(config.mongoServerSelectionTimeoutMs) || 10000, 1000);
    const mongoOptions = {
      serverSelectionTimeoutMS: timeoutMs,
      // Connection pool settings
      maxPoolSize: 10,
      minPoolSize: 1,
      // Additional timeouts
      connectTimeoutMS: 15000,
      socketTimeoutMS: 15000,
    };

    if ([4, 6].includes(Number(config.mongoFamily))) {
      mongoOptions.family = Number(config.mongoFamily);
    }

    if (config.mongoTlsInsecure) {
      mongoOptions.tlsInsecure = true;
    }

    if (config.mongoTlsSecureProtocol) {
      mongoOptions.secureProtocol = String(config.mongoTlsSecureProtocol);
    }

    connectPromise = MongoClient.connect(config.mongoUri, mongoOptions)
      .then((connectedClient) => {
        client = connectedClient;
        const dbName = String(config.mongoDbName || '').trim();
        db = client.db(dbName || undefined);
        lastError = '';
        failureCount = 0;
        disabledUntilMs = 0;
        console.log('[mongo] connected');
        return db;
      })
      .catch((error) => {
        lastError = error?.message || String(error);
        failureCount = Math.min(failureCount + 1, 6);
        const backoffMs = calculateBackoffMs(failureCount);
        disabledUntilMs = Date.now() + backoffMs;
        connectPromise = null;
        client = null;
        db = null;
        console.warn(
          `[mongo] connection failed; using JSON fallback (retry in ${Math.round(backoffMs / 1000)}s) (${lastError})`,
        );
        return null;
      });
  }

  return connectPromise;
}

async function createIndexWithFallback(collection, indexSpec, options, label) {
  try {
    await collection.createIndex(indexSpec, options);
    return;
  } catch (error) {
    console.warn(`[mongo] index create failed (${label}): ${error?.message || error}`);
  }

  if (options && options.unique) {
    try {
      await collection.createIndex(indexSpec);
    } catch (error) {
      console.warn(`[mongo] index fallback failed (${label}): ${error?.message || error}`);
    }
  }
}

async function ensureMongoIndexes() {
  const database = await getDb();
  if (!database) {
    return;
  }

  await Promise.allSettled([
    createIndexWithFallback(database.collection('users'), { username: 1 }, { unique: true }, 'users.username'),
    createIndexWithFallback(database.collection('symbol_master'), { symbol: 1 }, { unique: true }, 'symbol_master.symbol'),
    createIndexWithFallback(database.collection('sales_snapshots'), { symbol: 1 }, { unique: true }, 'sales_snapshots.symbol'),
  ]);
}

async function closeMongo() {
  if (client) {
    await client.close();
  }
  client = null;
  db = null;
  connectPromise = null;
  lastError = '';
  failureCount = 0;
  disabledUntilMs = 0;
}

function getMongoStatus() {
  const now = Date.now();
  return {
    configured: Boolean(config.mongoUri),
    enabled: isMongoEnabled(),
    connected: Boolean(db),
    disabled: now < disabledUntilMs,
    nextRetryAt: disabledUntilMs ? new Date(disabledUntilMs).toISOString() : '',
    failureCount,
    lastError,
  };
}

module.exports = {
  getDb,
  isMongoEnabled,
  ensureMongoIndexes,
  closeMongo,
  getMongoStatus,
};
