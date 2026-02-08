const { MongoClient } = require('mongodb');
const path = require('path');
const fs = require('fs');

// Load environment variables
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    const envConfig = require('dotenv').parse(fs.readFileSync(envPath));
    for (const k in envConfig) {
        process.env[k] = envConfig[k];
    }
}

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'stock_news_bot';

if (!uri) {
    console.error('Error: MONGODB_URI not found in environment.');
    process.exit(1);
}

async function verify() {
    console.log(`Configured URI: ${uri.replace(/:([^:@]+)@/, ':****@')}`);
    console.log(`Configured DB: ${dbName}`);

    const options = {
        serverSelectionTimeoutMS: Math.max(Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS) || 5000, 1000),
    };

    if (String(process.env.MONGODB_TLS_INSECURE || '').trim().toLowerCase() === 'true') {
        options.tlsInsecure = true;
    }

    if (process.env.MONGODB_TLS_SECURE_PROTOCOL) {
        options.secureProtocol = String(process.env.MONGODB_TLS_SECURE_PROTOCOL);
    }

    if ([4, 6].includes(Number(process.env.MONGODB_FAMILY || 0))) {
        options.family = Number(process.env.MONGODB_FAMILY);
    }

    const client = new MongoClient(uri, options);

    try {
        console.log('Connecting to MongoDB...');
        await client.connect();
        console.log('Connected successfully.');

        const db = client.db(dbName);

        const collections = ['app_state', 'users', 'sales_snapshots', 'symbol_master'];
        const results = {};

        for (const name of collections) {
            const count = await db.collection(name).countDocuments();
            results[name] = count;
            console.log(`Collection '${name}': ${count} documents`);
        }

        // Check specifically for app_state content (watchlist)
        const appState = await db.collection('app_state').findOne({ _id: 'app' });
        if (appState) {
            console.log(`\nApp State found. Watchlist length: ${appState.watchlist?.length || 0}`);
            console.log(`Last Updated: ${appState.updatedAt}`);
        } else {
            console.log('\nApp State document ({ _id: "app" }) NOT found.');
        }

        const dbJsonFile = await db.collection('data_files').findOne(
            { _id: 'db.json' },
            { projection: { filename: 1, updatedAt: 1, contentBytes: 1, contentTruncated: 1 } },
        );
        if (dbJsonFile) {
            console.log(
                `\nData file 'db.json' found. bytes=${dbJsonFile.contentBytes || 0} truncated=${Boolean(dbJsonFile.contentTruncated)}`,
            );
            console.log(`Updated At: ${dbJsonFile.updatedAt || ''}`);
        } else {
            console.log('\nData file document ({ _id: "db.json" }) NOT found in data_files.');
        }

    } catch (error) {
        console.error('Verification failed:', error.message);
    } finally {
        await client.close();
    }
}

verify();
