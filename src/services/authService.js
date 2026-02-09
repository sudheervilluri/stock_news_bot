const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { getDb, isMongoEnabled } = require('../db/mongoClient');

const USERS_FILE_PATH = path.join(__dirname, '../../data/users.json');

function ensureDataDir() {
  const dir = path.dirname(USERS_FILE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

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
  let users = [];
  if (isMongoEnabled()) {
    try {
      const db = await getDb();
      if (db) {
        users = await db.collection('users').find({}).toArray();
        return { users: users.map((user) => normalizeUser(user)).filter(Boolean) };
      }
    } catch (error) {
      console.error('Error reading users from MongoDB:', error);
    }
  }

  // Fallback to disk
  try {
    if (fs.existsSync(USERS_FILE_PATH)) {
      const raw = fs.readFileSync(USERS_FILE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      users = Array.isArray(parsed.users) ? parsed.users : [];
    }
  } catch (error) {
    console.error('Error reading users from disk:', error);
  }

  return { users: users.map((user) => normalizeUser(user)).filter(Boolean) };
}

async function writeUsers(data) {
  if (isMongoEnabled()) {
    // We don't support full write logic here for Mongo yet (handled by separate updates)
    // But if we did, we'd do it here.
  }

  // Always write to disk as backup/primary if mongo disabled
  try {
    ensureDataDir();
    fs.writeFileSync(USERS_FILE_PATH, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error writing users to disk:', error);
  }
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
  let updatedUser = null;

  if (isMongoEnabled()) {
    try {
      const db = await getDb();
      if (db) {
        const result = await db.collection('users').findOneAndUpdate(
          { username },
          { $set: { preferences: { ...preferences } } },
          { returnDocument: 'after' }
        );

        if (result) {
          updatedUser = normalizeUser(result);
        }
      }
    } catch (error) {
      console.error('Error updating preferences in MongoDB:', error);
    }
  }

  // Also update disk (fallback or sync)
  try {
    const data = await readUsers(); // Reads from disk if mongo failed or whatever
    // Re-read strictly from disk to ensure we invoke disk logic? 
    // Actually readUsers handles fallback. If mongo succeeded, we got mongo users.
    // If mongo failed, we got disk users.

    // Check if we need to update disk
    let diskUsers = [];
    if (fs.existsSync(USERS_FILE_PATH)) {
      const raw = fs.readFileSync(USERS_FILE_PATH, 'utf8');
      diskUsers = JSON.parse(raw).users || [];
    }

    const index = diskUsers.findIndex((u) => u.username === username);
    if (index >= 0) {
      diskUsers[index].preferences = { ...preferences };
      ensureDataDir();
      fs.writeFileSync(USERS_FILE_PATH, JSON.stringify({ users: diskUsers }, null, 2));

      if (!updatedUser) {
        updatedUser = normalizeUser(diskUsers[index]);
      }
    }
  } catch (error) {
    console.error('Error updating preferences on disk:', error);
  }

  return updatedUser;
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

  if (isMongoEnabled()) {
    try {
      const db = await getDb();
      if (db) {
        const users = db.collection('users');
        const existing = await users.findOne({ username: 'admin' });
        if (!existing) {
          console.log('[auth] Creating default admin user in Mongo...');
          await users.insertOne(adminUser);
        }
      }
    } catch (error) {
      console.error('[auth] Failed to ensure default admin in Mongo:', error);
    }
  }

  // Ensure in disk as well
  try {
    let diskUsers = [];
    if (fs.existsSync(USERS_FILE_PATH)) {
      const raw = fs.readFileSync(USERS_FILE_PATH, 'utf8');
      diskUsers = JSON.parse(raw).users || [];
    }

    const existing = diskUsers.find(u => u.username === 'admin');
    if (!existing) {
      console.log('[auth] Creating default admin user on disk...');
      diskUsers.push(adminUser);
      ensureDataDir();
      fs.writeFileSync(USERS_FILE_PATH, JSON.stringify({ users: diskUsers }, null, 2));
    }
  } catch (error) {
    console.error('[auth] Failed to ensure default admin on disk:', error);
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
