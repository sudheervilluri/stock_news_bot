const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const USERS_FILE = path.join(__dirname, '..', 'data', 'users.json');

function readUsers() {
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

function writeUsers(data) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('Error writing users file:', error);
  }
}

function getUserByUsername(username) {
  const data = readUsers();
  return data.users.find(u => u.username === username);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function updateUserPreferences(username, preferences) {
  const data = readUsers();
  const user = data.users.find(u => u.username === username);
  if (user) {
    user.preferences = { ...user.preferences, ...preferences };
    writeUsers(data);
    return user;
  }
  return null;
}

function getUserPreferences(username) {
  const user = getUserByUsername(username);
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
