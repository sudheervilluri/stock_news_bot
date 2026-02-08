const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { getDb, isMongoEnabled } = require('../db/mongoClient');

const USERS_FILE = path.join(__dirname, '..', '..', 'data', 'users.json');

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

function readUsersFromDisk() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = fs.readFileSync(USERS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error reading users file:', error);
  }
  return { users: [] };
}

function writeUsersToDisk(data) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('Error writing users file:', error);
  }
}

async function seedUsersToMongo(users) {
  const db = await getDb();
  if (!db) {
    return;
  }

  if (!Array.isArray(users) || users.length === 0) {
    return;
  }

  const normalized = users.map((user) => normalizeUser(user)).filter(Boolean);
  if (normalized.length === 0) {
    return;
  }

  await db.collection('users').deleteMany({});
  await db.collection('users').insertMany(normalized, { ordered: false });
}

async function readUsers() {
  if (!isMongoEnabled()) {
    return readUsersFromDisk();
  }

  try {
    const db = await getDb();
    const users = await db.collection('users').find({}).toArray();
    if (users.length === 0) {
      const disk = readUsersFromDisk();
      await seedUsersToMongo(disk.users || []);
      return disk;
    }

    return { users: users.map((user) => normalizeUser(user)).filter(Boolean) };
  } catch (error) {
    console.error('Error reading users from MongoDB:', error);
    return readUsersFromDisk();
  }
}

async function writeUsers(data) {
  if (!isMongoEnabled()) {
    writeUsersToDisk(data);
    return;
  }

  try {
    await seedUsersToMongo(data.users || []);
  } catch (error) {
    console.error('Error writing users to MongoDB:', error);
    writeUsersToDisk(data);
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
  if (isMongoEnabled()) {
    try {
      const db = await getDb();
      const result = await db.collection('users').findOneAndUpdate(
        { username },
        { $set: { preferences: { ...preferences } } },
        { returnDocument: 'after' },
      );

      if (result.value) {
        return normalizeUser(result.value);
      }
    } catch (error) {
      console.error('Error updating preferences in MongoDB:', error);
    }
  }

  const data = await readUsers();
  const user = data.users.find((item) => item.username === username);
  if (!user) {
    return null;
  }

  user.preferences = { ...user.preferences, ...preferences };
  await writeUsers(data);
  return user;
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

module.exports = {
  readUsers,
  writeUsers,
  getUserByUsername,
  verifyPassword,
  hashPassword,
  updateUserPreferences,
  getUserPreferences,
};
