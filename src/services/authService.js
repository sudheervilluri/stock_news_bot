const bcrypt = require('bcryptjs');
const { getDb, isMongoEnabled } = require('../db/mongoClient');

function normalizeUser(user) {
  if (!user || typeof user !== 'object') {
    return null;
  }

  const { _id, ...rest } = user;
  return {
    ...rest,
    preferences: rest.preferences || {
      watchlist: true,
      portfolio: true,
      screener: true,
      news: true,
      earnings: true,
      darkMode: false,
    },
  };
}





async function readUsers() {
  if (!isMongoEnabled()) {
    return { users: [] };
  }

  try {
    const db = await getDb();
    if (!db) return { users: [] };
    const users = await db.collection('users').find({}).toArray();
    return { users: users.map((user) => normalizeUser(user)).filter(Boolean) };
  } catch (error) {
    console.error('Error reading users from MongoDB:', error);
    return { users: [] };
  }
}

async function writeUsers(data) {
  // Read-only from code perspective, usually; or implementing user management later.
  // For now, removing disk write.
  console.warn('writeUsers called but disk write is disabled.');
}

async function getUserByUsername(username) {
  const data = await readUsers();
  return data.users.find((user) => user.username === username);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

async function updateUserPreferences(username, preferences) {
  if (isMongoEnabled()) {
    try {
      const db = await getDb();
      const result = await db.collection('users').findOneAndUpdate(
        { username },
        { $set: { preferences: { ...preferences } } },
        { returnDocument: 'after' }
      );

      if (result) {
        return normalizeUser(result);
      }
    } catch (error) {
      console.error('Error updating preferences in MongoDB:', error);
    }
  }
  return null;
}

async function getUserPreferences(username) {
  const user = await getUserByUsername(username);
  if (user) {
    return user.preferences || {
      watchlist: true,
      portfolio: true,
      screener: true,
      news: true,
      earnings: true,
      darkMode: false,
    };
  }
  return {
    watchlist: true,
    portfolio: true,
    screener: true,
    news: true,
    earnings: true,
    darkMode: false,
  };
}

async function ensureDefaultAdmin() {
  if (!isMongoEnabled()) {
    console.log('[auth] Mongo disabled, skipping default admin check.');
    return;
  }

  try {
    const db = await getDb();
    if (!db) return;

    const users = db.collection('users');
    const existing = await users.findOne({ username: 'admin' });
    if (existing) {
      console.log('[auth] Default admin user already exists.');
      return;
    }

    console.log('[auth] Creating default admin user...');
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

    await users.insertOne(adminUser);
    console.log('[auth] Default admin user created successfully.');
  } catch (error) {
    console.error('[auth] Failed to ensure default admin:', error);
  }
}

module.exports = {
  readUsers,
  writeUsers,
  getUserByUsername,
  verifyPassword,
  hashPassword,
  updateUserPreferences,
  getUserPreferences,
  ensureDefaultAdmin,
};
