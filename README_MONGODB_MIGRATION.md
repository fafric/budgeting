# Budgeting App - MongoDB Migration

This budgeting application has been migrated from SQLite to MongoDB for Vercel deployment.

## Changes Made

1. **Database**: Replaced SQLite with MongoDB
2. **Dependencies**: Removed `better-sqlite3`, added `mongodb`
3. **Environment**: Updated `.env` to use `MONGODB_URI` instead of `DB_PATH`
4. **Code**: Converted all SQL queries to MongoDB operations

## Setup for Vercel Deployment

### 1. Install Dependencies
```bash
npm install
```

### 2. MongoDB Setup
You need a MongoDB database. For Vercel deployment, you can use:
- MongoDB Atlas (free tier available)
- Or any MongoDB provider

### 3. Environment Variables
Set these environment variables in Vercel:

```
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/budgeting?retryWrites=true&w=majority
SESSION_SECRET=your-secure-random-session-secret
```

### 4. Vercel Configuration
Create a `vercel.json` file in your project root:

```json
{
  "version": 2,
  "builds": [
    {
      "src": "server.js",
      "use": "@vercel/node"
    }
  ],
  "routes": [
    {
      "src": "/(.*)",
      "dest": "server.js"
    }
  ]
}
```

### 5. Deploy to Vercel
```bash
npm install -g vercel
vercel
```

Follow the prompts to deploy your application.

## Local Development

For local development with MongoDB:

1. Install MongoDB locally or use MongoDB Atlas
2. Update `.env` with your local MongoDB URI
3. Run: `npm run dev`

## Database Schema

The MongoDB collections are:
- `users`: User accounts
- `income`: Income entries
- `expenses`: Expense entries  
- `budgets`: Budget entries
- `goals`: Savings goals
- `bills`: Bill tracking

All collections use `user_id` to associate records with users.