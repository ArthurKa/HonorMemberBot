'use strict';

const { MongoClient } = require('mongodb');
const config = require('config');

const mongoUrl = config.get('mongodb');
const dbName = config.get('db');
let client;
let db;
let collections;

function checkCollection(db, colName) {
  if(!collections.includes(colName)) {
    throw new Error(`There is no such collection as "${colName}" in ${dbName}`);
  }
}

async function dbModule(collectionName) {
  if(db == null) {
    client = await MongoClient.connect(mongoUrl, { useNewUrlParser: true, useUnifiedTopology: true });
    db = client.db(dbName);
    collections = (await db.listCollections().toArray()).map(e => e.name);
  }
  if(collections[collectionName] == null) {
    checkCollection(db, collectionName);
    collections[collectionName] = db.collection(collectionName);
  }
  return collections[collectionName];
}
dbModule.close = function() {
  db = null;
  return client.close();
}
dbModule.count = async function(userID, collection) {
  return (await this(collection)).find({ userID }).count();
}

module.exports = dbModule;
