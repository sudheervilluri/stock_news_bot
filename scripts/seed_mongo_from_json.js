const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) {
    return null;
  }
  return JSON.parse(raw);
}

function chunk(items, size) {
  const safeSize = Math.max(Number(size) || 1, 1);
  const list = Array.isArray(items) ? items : [];
  const chunks = [];
  for (let index = 0; index < list.length; index += safeSize) {
    chunks.push(list.slice(index, index + safeSize));
  }
  return chunks;
}

function getWorkspacePath(...segments) {
  return path.join(__dirname, '..', ...segments);
}

function listJsonFilesInDir(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map((entry) => path.join(dirPath, entry.name));
  } catch (_error) {
    return [];
  }
}

function getMongoEnv() {
  return {
    uri: 'mongodb+srv://sudheervilluri_db_user:5KYG9iIyalSQ1dIw@cluster0.jinz8vz.mongodb.net/?appName=Cluster0&retryWrites=true&w=majority',
    dbName: 'myDatabase',
    serverSelectionTimeoutMs: Math.max(Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS) || 10000, 1000),
    tlsInsecure: String(process.env.MONGODB_TLS_INSECURE || '').trim().toLowerCase() === 'true',
    secureProtocol: String(process.env.MONGODB_TLS_SECURE_PROTOCOL || '').trim(),
    family: Number(process.env.MONGODB_FAMILY || 0),
  };
}

async function createIndexWithFallback(collection, indexSpec, options, label) {
  try {
    await collection.createIndex(indexSpec, options);
    return;
  } catch (error) {
    console.warn(`[seed] index create failed (${label}): ${error?.message || error}`);
  }

  if (options && options.unique) {
    try {
      await collection.createIndex(indexSpec);
    } catch (error) {
      console.warn(`[seed] index fallback failed (${label}): ${error?.message || error}`);
    }
  }
}

async function bulkUpsertByKey(collection, docs, keyField) {
  const list = Array.isArray(docs) ? docs : [];
  if (list.length === 0) {
    return { matched: 0, upserted: 0, modified: 0 };
  }

  const ops = list
    .filter((doc) => doc && typeof doc === 'object' && doc[keyField])
    .map((doc) => ({
      updateOne: {
        filter: { [keyField]: doc[keyField] },
        update: { $set: doc },
        upsert: true,
      },
    }));

  let matched = 0;
  let upserted = 0;
  let modified = 0;

  for (const opsChunk of chunk(ops, 1000)) {
    // ordered:false keeps going when a single row fails (common in mixed dumps)
    // eslint-disable-next-line no-await-in-loop
    const result = await collection.bulkWrite(opsChunk, { ordered: false });
    matched += Number(result.matchedCount || 0);
    upserted += Number(result.upsertedCount || 0);
    modified += Number(result.modifiedCount || 0);
  }

  return { matched, upserted, modified };
}

async function main() {
  const mongo = getMongoEnv();
  if (!mongo.uri) {
    console.error('Missing MONGODB_URI (or MONGO_URI).');
    process.exitCode = 1;
    return;
  }

  const options = {
    serverSelectionTimeoutMS: mongo.serverSelectionTimeoutMs,
  };

  if (mongo.tlsInsecure) {
    options.tlsInsecure = true;
  }

  if (mongo.secureProtocol) {
    options.secureProtocol = mongo.secureProtocol;
  }

  if ([4, 6].includes(mongo.family)) {
    options.family = mongo.family;
  }

  const client = await MongoClient.connect(mongo.uri, options);
  const db = client.db(mongo.dbName || undefined);

  try {
    await Promise.allSettled([
      createIndexWithFallback(db.collection('users'), { username: 1 }, { unique: true }, 'users.username'),
      createIndexWithFallback(db.collection('symbol_master'), { symbol: 1 }, { unique: true }, 'symbol_master.symbol'),
      createIndexWithFallback(db.collection('sales_snapshots'), { symbol: 1 }, { unique: true }, 'sales_snapshots.symbol'),
    ]);

    const dataDirPath = process.env.DATA_DIR
      ? path.resolve(process.cwd(), process.env.DATA_DIR)
      : getWorkspacePath('data');
    const discoveredDataJsonFiles = listJsonFilesInDir(dataDirPath)
      .map((filePath) => path.resolve(filePath))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));

    const dataFilePath = process.env.DATA_FILE_PATH
      ? path.resolve(process.cwd(), process.env.DATA_FILE_PATH)
      : getWorkspacePath('data', 'db.json');
    const usersFilePath = getWorkspacePath('data', 'users.json');
    const symbolMasterFilePath = process.env.SYMBOL_MASTER_FILE_PATH
      ? path.resolve(process.cwd(), process.env.SYMBOL_MASTER_FILE_PATH)
      : getWorkspacePath('data', 'symbol_master.json');
    const salesSnapshotFilePath = process.env.SALES_SNAPSHOT_FILE_PATH
      ? path.resolve(process.cwd(), process.env.SALES_SNAPSHOT_FILE_PATH)
      : getWorkspacePath('data', 'daily_sales.json');

    const appState = readJsonFile(dataFilePath);
    if (appState) {
      await db.collection('app_state').updateOne(
        { _id: 'app' },
        { $set: appState },
        { upsert: true },
      );
      console.log(`[seed] app_state ok (${path.relative(process.cwd(), dataFilePath)})`);
    } else {
      console.log(`[seed] app_state skipped (missing/empty: ${path.relative(process.cwd(), dataFilePath)})`);
    }

    const usersJson = readJsonFile(usersFilePath);
    if (usersJson && Array.isArray(usersJson.users)) {
      const result = await bulkUpsertByKey(db.collection('users'), usersJson.users, 'username');
      console.log(`[seed] users ok (upserted=${result.upserted} matched=${result.matched} modified=${result.modified})`);
    } else {
      console.log('[seed] users skipped (missing/invalid data/users.json)');
    }

    const symbolMasterJson = readJsonFile(symbolMasterFilePath);
    if (symbolMasterJson && Array.isArray(symbolMasterJson.items)) {
      const result = await bulkUpsertByKey(db.collection('symbol_master'), symbolMasterJson.items, 'symbol');
      await db.collection('symbol_master_meta').updateOne(
        { _id: 'meta' },
        {
          $set: {
            updatedAt: String(symbolMasterJson.updatedAt || ''),
            summary: symbolMasterJson.summary || {},
          },
        },
        { upsert: true },
      );
      console.log(`[seed] symbol_master ok (upserted=${result.upserted} matched=${result.matched} modified=${result.modified})`);
    } else {
      console.log(`[seed] symbol_master skipped (missing/invalid: ${path.relative(process.cwd(), symbolMasterFilePath)})`);
    }

    const salesSnapshotJson = readJsonFile(salesSnapshotFilePath);
    if (salesSnapshotJson && salesSnapshotJson.symbols && typeof salesSnapshotJson.symbols === 'object') {
      const records = Object.values(salesSnapshotJson.symbols);
      const result = await bulkUpsertByKey(db.collection('sales_snapshots'), records, 'symbol');
      await db.collection('sales_snapshot_meta').updateOne(
        { _id: 'meta' },
        {
          $set: {
            updatedAt: String(salesSnapshotJson.updatedAt || ''),
            run: salesSnapshotJson.run || {},
          },
        },
        { upsert: true },
      );
      console.log(`[seed] sales_snapshots ok (upserted=${result.upserted} matched=${result.matched} modified=${result.modified})`);
    } else {
      console.log(`[seed] sales_snapshots skipped (missing/invalid: ${path.relative(process.cwd(), salesSnapshotFilePath)})`);
    }

    const maxBytes = Math.max(Number(process.env.DATA_FILES_MAX_BYTES) || 1_000_000, 0);

    for (const filePath of discoveredDataJsonFiles) {
      const relativePath = path.relative(process.cwd(), filePath);
      const fileStats = fs.statSync(filePath);
      const fileSizeBytes = Number(fileStats.size || 0);
      const filename = path.basename(filePath);

      if (maxBytes > 0 && fileSizeBytes > maxBytes) {
        // eslint-disable-next-line no-await-in-loop
        await db.collection('data_files').updateOne(
          { _id: filename },
          {
            $set: {
              filename,
              relativePath,
              updatedAt: new Date().toISOString(),
              contentTruncated: true,
              contentBytes: fileSizeBytes,
            },
          },
          { upsert: true },
        );
        console.log(
          `[seed] data_files meta ok (${relativePath}) (skipped content: ${fileSizeBytes} bytes > ${maxBytes})`,
        );
        // eslint-disable-next-line no-continue
        continue;
      }

      const parsed = readJsonFile(filePath);
      if (parsed === null) {
        // eslint-disable-next-line no-continue
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      await db.collection('data_files').updateOne(
        { _id: filename },
        {
          $set: {
            filename,
            relativePath,
            updatedAt: new Date().toISOString(),
            content: parsed,
            contentTruncated: false,
            contentBytes: fileSizeBytes,
          },
        },
        { upsert: true },
      );
      console.log(`[seed] data_files ok (${relativePath})`);
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error('[seed] failed:', error?.message || error);
  process.exitCode = 1;
});
