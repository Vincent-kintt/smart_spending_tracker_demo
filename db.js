const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

// Get the MongoDB connection string from environment variables
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
// Connect to MongoDB
async function connectToDB() {
  try {
    console.log('Attempting to connect to MongoDB...');
    const client = await MongoClient.connect(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 45000
    });
    
    console.log('Connected successfully to MongoDB server');
    const db = client.db('demo');
    console.log('Using database: demo');
    
    // Store client for potential later use (closing connections etc.)
    db.client = client;
    return db;
  } catch (error) {
    console.error('MongoDB connection error:', error);
    throw error;
  }
}

module.exports = { connectToDB, ObjectId };