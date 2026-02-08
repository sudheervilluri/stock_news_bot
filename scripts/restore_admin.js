const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const envPath = path.resolve(__dirname, '..', '.env');
console.log('Loading .env from:', envPath);
require('dotenv').config({ path: envPath });

const uri = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/stock_news_bot';
console.log('Using URI:', uri);

if (!uri) {
    console.log('Available MONGO keys:', Object.keys(process.env).filter(k => k.includes('MONGO')));
    console.error('MONGODB_URI Not found in environment and no default set');
    process.exit(1);
}

const client = new MongoClient(uri);

async function run() {
    try {
        await client.connect();
        const db = client.db(process.env.MONGODB_DB || 'stock_news_bot');
        const users = db.collection('users');

        const adminUser = {
            username: 'admin',
            password: bcrypt.hashSync('admin', 10), // Default password 'admin'
            preferences: {
                watchlist: true,
                portfolio: true,
                screener: true,
                news: true,
                earnings: true,
                darkMode: false,
            },
        };

        const result = await users.updateOne(
            { username: 'admin' },
            { $set: adminUser },
            { upsert: true }
        );

        console.log('Admin user restored/created:', result);
    } finally {
        await client.close();
    }
}

run().catch(console.dir);
