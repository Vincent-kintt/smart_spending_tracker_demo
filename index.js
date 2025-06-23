const express = require('express');
const axios = require('axios');
const path = require('path');
const multer = require('multer');
const { Binary } = require('mongodb');
require('dotenv').config();

const { connectToDB, ObjectId } = require('./db');

// Create Express app
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit per file
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// Define port
const PORT = process.env.PORT || 3000;

// OpenAI API details
const OPENAI_API_URL = 'https://openapi.monica.im/v1/chat/completions';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Serverless-friendly DB connection
let dbConnection = null;
async function getDB() {
  if (!dbConnection) {
    console.log('Connecting to MongoDB...');
    dbConnection = await connectToDB();
  }
  return dbConnection;
}

//Function to convert image buffer to base64
function imageToBase64(buffer, mimeType) {
  const base64 = buffer.toString('base64');
  return `data:${mimeType};base64,${base64}`;
}


//Function to fetch response from OpenAI API with image support
async function fetchFromOpenAI(userInput, images = []) {
  try {
    const systemPrompt = `You are a spending tracker assistant. Your task is to extract and format spending information from user messages and receipt images.

Instructions:
1. If a receipt image is provided, extract the total amount and categorize it
2. For receipts, look for TOTAL, SUBTOTAL, or the final amount
3. Identify the amount spent (numbers only)
4. Identify the spending category or activity based on items or store name
5. Output in the exact format: [amount], [category]
6. For multiple expenses, separate each with a semicolon: [amount1], [category1]; [amount2], [category2]

Rules:
- Extract only numerical values for the amount (remove currency symbols like $)
- Use simple, clear category names
- For receipts with multiple items, use the TOTAL amount and categorize based on majority of items
- If no amount is specified or found, respond with "Amount not specified"
- If no category is clear, use "miscellaneous"

Receipt Processing:
- Look for keywords like TOTAL, SUBTOTAL, AMOUNT DUE
- Extract the final amount to be paid
- Categorize based on store name or items purchased
- Common receipt categories: groceries, restaurant, shopping, gas, pharmacy

Examples:
- Receipt showing "TOTAL: $80.89" with food items → Output: 80.89, groceries
- Receipt from restaurant with "Total: 45.50" → Output: 45.50, restaurant
- Gas station receipt "TOTAL $40.00" → Output: 40, gas`;

    // Build messages array
    const messages = [
      { role: "system", content: systemPrompt }
    ];

    // If images are provided, create a message with image content
    if (images.length > 0) {
      const contentArray = [];
      
      // Add text if provided
      if (userInput && userInput !== 'Receipt image uploaded') {
        contentArray.push({
          type: "text",
          text: userInput
        });
      }
      
      // Add each image
      for (const image of images) {
        const base64Image = imageToBase64(image.buffer, image.mimetype);
        contentArray.push({
          type: "image_url",
          image_url: {
            url: base64Image,
            detail: "high"
          }
        });
      }
      // Add instruction to process the images
      contentArray.push({
        type: "text",
        text: "Please extract the total amount and category from the receipt image(s) above."
      });
      
      messages.push({
        role: "user",
        content: contentArray
      });
    } else {      // No images, just text
      messages.push({
        role: "user",
        content: userInput
      });
    }

    const payload = {
      model: "gpt-4o",
      messages: messages,
      temperature: 0.3,
      max_tokens: 500
    };

    const response = await axios.post(OPENAI_API_URL, payload, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    return response.data;
  } catch (error) {
    console.error('Error calling OpenAI API:', error.response?.data || error.message);
    throw error;
  }
}

async function saveImagesToDB(images) {
  try {
    // Get DB connection and collection for THIS request
    const db = await getDB();
    const imagesCollection = db.collection('images');
    
    const savedImages = [];
    
    for (const image of images) {
      const imageDoc = {
        filename: image.originalname,
        contentType: image.mimetype,
        data: new Binary(image.buffer),
        size: image.size,
        uploadedAt: new Date()
        };
        
      const result = await imagesCollection.insertOne(imageDoc);
      
      if (result.acknowledged) {
        savedImages.push({
          _id: result.insertedId,
          filename: image.originalname,
          size: image.size
      });
    }
    }
    
    return savedImages;
  } catch (error) {
    console.error('Error saving images to DB:', error);
    throw error;
  }
}


//Function to parse and save expenses to MongoDB
async function saveExpensesToDB(aiResponse, imageIds = []) {
  try {
    // Get DB connection and collection for THIS request
    const db = await getDB();
    const expensesCollection = db.collection('expenses');
    
    const responseText = typeof aiResponse === 'string' ? aiResponse : aiResponse.toString();

    if (responseText === "Amount not specified" || !responseText) {
      console.log('No valid expense data to save');
      return [];
    }
    
    const expenses = responseText.split(';').map(item => item.trim());
    const savedExpenses = [];
    
    for (let i = 0; i < expenses.length; i++) {
      const expense = expenses[i];
      // Updated regex to handle decimal amounts
      const match = expense.match(/(\d+(?:\.\d+)?),\s*(.+)/);
      
      if (match) {
        const amount = parseFloat(match[1]);
        const category = match[2].trim();
        
        // Create expense document
        const newExpense = {
          amount,
          category,
          createdAt: new Date()
        };
        
        // Add image references if available
        if (imageIds.length > 0) {
          // Distribute images across expenses or assign all to first expense
          newExpense.imageIds = i === 0 ? imageIds : [];
          newExpense.hasImage = i === 0 && imageIds.length > 0;
        }
        
        const result = await expensesCollection.insertOne(newExpense);
        
        if (result.acknowledged) {
          const savedExpense = { 
            _id: result.insertedId,
            ...newExpense 
          };
          console.log(`Saved to expenses collection:`, savedExpense);
          savedExpenses.push(savedExpense);
        }
      }
    }
    
    return savedExpenses;
  } catch (error) {
    console.error('Error saving expenses to DB:', error);
    throw error;
  }
}

app.post('/api/chat', upload.array('images', 5), async (req, res) => {
  try {
    const { message, uploadType } = req.body;
    const images = req.files || [];
    
    // If uploadType is 'image', save images
    if (uploadType === 'image') {
      if (images.length === 0) {
        return res.status(400).json({ error: 'No images provided' });
      }
      const savedImages = await saveImagesToDB(images);
      console.log(`Saved ${images.length} images to database`);
      
      // Return
      return res.json({
        success: true,
        savedImages,
        message: `Successfully uploaded ${images.length} image(s)`,
        uploadType: 'image'
      });
    }
    
    // For receipt processing (uploadType === 'receipt' or not specified)
    if (!message && images.length === 0) {
      return res.status(400).json({ error: 'Message or image is required' });
    }
    
    // Save images to database if any
    let savedImageIds = [];
    if (images.length > 0) {
      const savedImages = await saveImagesToDB(images);
      savedImageIds = savedImages.map(img => img._id);
      console.log(`Saved ${images.length} images to database for receipt processing`);
    }
    
    // Get AI response from OpenAI with images - ONLY for receipts
    console.log('Processing receipt with AI...');
    const response = await fetchFromOpenAI(
      message || 'Receipt image uploaded', 
      images
    );
    
    const aiContent = response.choices[0].message.content;
    console.log('AI Response:', aiContent);
    
    // Save expenses with image references
    const savedExpenses = await saveExpensesToDB(aiContent, savedImageIds);
    
    res.json({
      aiResponse: response,
      savedExpenses,
      uploadType: 'receipt'
    });
  } catch (error) {
    console.error('Error in /api/chat:', error);
    res.status(500).json({ 
      error: 'Failed to process request',
      details: error.message
    });
  }
});

//main HTML page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Only start the server if not in production (Vercel)
if (process.env.NODE_ENV !== 'production') {
  // Initialize database connection and start server
  async function startServer() {
    try {
      // Connect to the database
      await getDB();
      
      // Create indexes for better performance
      const db = await getDB();
      await db.collection('expenses').createIndex({ createdAt: -1 });
      await db.collection('images').createIndex({ uploadedAt: -1 });
      
      app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        console.log(`Open http://localhost:${PORT} in your browser to use the chatbot`);
      });
    } catch (error) {
      console.error('Failed to connect to the database:', error);
      process.exit(1);
    }
  }
  
startServer();
}

// Initialize DB on first load in production
getDB().then(() => {
  console.log('DB connection initialized for serverless environment');
}).catch(err => {
  console.error('Failed to initialize DB connection:', err);
});

module.exports = app;