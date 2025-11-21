const { MongoClient, ServerApiVersion } = require('mongodb');
const logger = require('./logger');

const uri = process.env.MONGODB_URI || '';
const dbName = process.env.MONGODB_DB_NAME || 'mailtester';

let client;
let db;

async function connectMongo() {
  if (db) {
    return;
  }
  if (!uri) {
    throw new Error('MONGODB_URI is not configured');
  }
  client = new MongoClient(uri, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true
    }
  });
  await client.connect();
  db = client.db(dbName);
  logger.info({ msg: 'Connected to MongoDB', dbName });
}

function getDb() {
  if (!db) {
    throw new Error('MongoDB has not been initialised. Call connectMongo() first.');
  }
  return db;
}

function getKeysCollection() {
  return getDb().collection('keys');
}

async function disconnectMongo() {
  if (client) {
    await client.close();
    client = undefined;
    db = undefined;
    logger.info({ msg: 'MongoDB connection closed' });
  }
}

module.exports = {
  connectMongo,
  disconnectMongo,
  getDb,
  getKeysCollection
};
