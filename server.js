require('dotenv').config();
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/budgeting';

const client = new MongoClient(MONGODB_URI);
const clientPromise = client.connect();

const defaultDbName = (() => {
  try {
    const parsed = new URL(MONGODB_URI);
    return parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.slice(1) : 'budgeting';
  } catch {
    return 'budgeting';
  }
})();

let db;

async function connectToMongoDB() {
  try {
    await clientPromise;
    db = client.db(defaultDbName);
    console.log('Connected to MongoDB');
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
    process.exit(1);
  }
}

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const sessionStore = MongoStore.create({
  clientPromise,
  dbName: defaultDbName,
  collectionName: 'sessions',
  stringify: false,
  ttl: 14 * 24 * 60 * 60
});

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'change-this-secret-now',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many login or signup attempts. Try again later.'
});

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.formatMoney = (value) => Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function isPositive(value) {
  return !Number.isNaN(Number(value)) && Number(value) > 0;
}

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function getCurrentPeriod() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;
  return { year, month, monthKey };
}

function getLastMonths(count) {
  const out = [];
  const now = new Date();
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

async function getBudgetOverview(userId) {
  const { year, month, monthKey } = getCurrentPeriod();

  const monthlyBudgets = await db.collection('budgets').find({
    user_id: userId,
    type: 'monthly',
    year: year,
    month: month
  }).toArray();

  const yearlyBudgets = await db.collection('budgets').find({
    user_id: userId,
    type: 'yearly',
    year: year
  }).toArray();

  const monthlyExpenses = await db.collection('expenses').aggregate([
    {
      $match: {
        user_id: userId,
        date: { $regex: `^${monthKey}` }
      }
    },
    {
      $group: {
        _id: '$category',
        spent: { $sum: '$amount' }
      }
    }
  ]).toArray();

  const yearlyExpenses = await db.collection('expenses').aggregate([
    {
      $match: {
        user_id: userId,
        date: { $regex: `^${year}` }
      }
    },
    {
      $group: {
        _id: '$category',
        spent: { $sum: '$amount' }
      }
    }
  ]).toArray();

  const expenseMapMonthly = Object.fromEntries(monthlyExpenses.map(e => [e._id, e.spent]));
  const expenseMapYearly = Object.fromEntries(yearlyExpenses.map(e => [e._id, e.spent]));

  const monthly = monthlyBudgets.map(budget => ({
    ...budget,
    spent: expenseMapMonthly[budget.category] || 0,
    type: 'monthly',
    period: monthKey
  }));

  const yearly = yearlyBudgets.map(budget => ({
    ...budget,
    spent: expenseMapYearly[budget.category] || 0,
    type: 'yearly',
    period: String(year)
  }));

  return [...monthly, ...yearly];
}

async function getDashboardData(userId) {
  const { monthKey } = getCurrentPeriod();

  const totalIncome = await db.collection('income').aggregate([
    { $match: { user_id: userId } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]).toArray().then(result => result[0]?.total || 0);

  const totalExpenses = await db.collection('expenses').aggregate([
    { $match: { user_id: userId } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]).toArray().then(result => result[0]?.total || 0);

  const monthIncome = await db.collection('income').aggregate([
    { $match: { user_id: userId, date: { $regex: `^${monthKey}` } } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]).toArray().then(result => result[0]?.total || 0);

  const monthExpenses = await db.collection('expenses').aggregate([
    { $match: { user_id: userId, date: { $regex: `^${monthKey}` } } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]).toArray().then(result => result[0]?.total || 0);

  const savings = await db.collection('goals').aggregate([
    { $match: { user_id: userId } },
    {
      $group: {
        _id: null,
        saved: { $sum: '$current_amount' },
        target: { $sum: '$target_amount' }
      }
    }
  ]).toArray().then(result => result[0] || { saved: 0, target: 0 });

  const upcomingBills = await db.collection('bills').find({
    user_id: userId,
    status: 'unpaid',
    due_date: {
      $gte: new Date().toISOString().slice(0, 10),
      $lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    }
  }).sort({ due_date: 1, _id: -1 }).limit(10).toArray();

  const recentIncome = await db.collection('income').find({ user_id: userId })
    .sort({ date: -1, _id: -1 }).limit(8).toArray()
    .then(items => items.map(item => ({
      date: item.date,
      kind: 'Income',
      label: item.source,
      category: item.category,
      amount: item.amount
    })));

  const recentExpenses = await db.collection('expenses').find({ user_id: userId })
    .sort({ date: -1, _id: -1 }).limit(8).toArray()
    .then(items => items.map(item => ({
      date: item.date,
      kind: 'Expense',
      label: item.subcategory || item.note || item.category,
      category: item.category,
      amount: item.amount * -1
    })));

  const recentTransactions = [...recentIncome, ...recentExpenses]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 8);

  const budgetOverview = await getBudgetOverview(userId);

  return {
    totalIncome,
    totalExpenses,
    balance: totalIncome - totalExpenses,
    monthIncome,
    monthExpenses,
    savings,
    upcomingBills,
    recentTransactions,
    budgetOverview
  };
}

app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  return res.redirect('/login');
});

app.get('/register', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  res.render('register', { error: null });
});

app.post('/register', authLimiter, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!name || !isValidEmail(email) || password.length < 8) {
    return res.render('register', {
      error: 'Enter a name, a valid email, and a password with at least 8 characters.'
    });
  }

  try {
    const existing = await db.collection('users').findOne({ email });
    if (existing) {
      return res.render('register', { error: 'That email is already registered.' });
    }

    const passwordHash = bcrypt.hashSync(password, 12);
    const result = await db.collection('users').insertOne({
      name,
      email,
      password_hash: passwordHash,
      created_at: new Date()
    });

    req.session.regenerate((err) => {
      if (err) {
        return res.render('register', { error: 'Could not start session. Try again.' });
      }
      req.session.user = {
        id: result.insertedId.toString(),
        name,
        email
      };
      return res.redirect('/dashboard');
    });
  } catch (error) {
    console.error('Registration error:', error);
    return res.render('register', { error: 'Registration failed. Try again.' });
  }
});

app.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  res.render('login', { error: null });
});

app.post('/login', authLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  try {
    const user = await db.collection('users').findOne({ email });
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.render('login', { error: 'Invalid email or password.' });
    }

    req.session.regenerate((err) => {
      if (err) {
        return res.render('login', { error: 'Could not start session. Try again.' });
      }
      req.session.user = {
        id: user._id.toString(),
        name: user.name,
        email: user.email
      };
      return res.redirect('/dashboard');
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.render('login', { error: 'Login failed. Try again.' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/login');
  });
});

app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const data = await getDashboardData(req.session.user.id);
    res.render('dashboard', data);
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).send('Internal server error');
  }
});

app.get('/income', requireAuth, async (req, res) => {
  try {
    const items = await db.collection('income').find({ user_id: req.session.user.id })
      .sort({ date: -1, _id: -1 }).toArray();

    res.render('income', {
      items,
      error: null,
      today: getToday()
    });
  } catch (error) {
    console.error('Income GET error:', error);
    res.status(500).send('Internal server error');
  }
});

app.post('/income', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const source = String(req.body.source || '').trim();
  const category = String(req.body.category || '').trim();
  const amount = Number(req.body.amount);
  const date = String(req.body.date || '').trim();
  const note = String(req.body.note || '').trim();

  if (!source || !category || !isPositive(amount) || !isValidDate(date)) {
    try {
      const items = await db.collection('income').find({ user_id: userId })
        .sort({ date: -1, _id: -1 }).toArray();
      return res.render('income', {
        items,
        error: 'Enter source, category, a positive amount, and a valid date.',
        today: getToday()
      });
    } catch (error) {
      console.error('Income POST validation error:', error);
      return res.status(500).send('Internal server error');
    }
  }

  try {
    await db.collection('income').insertOne({
      user_id: userId,
      source,
      category,
      amount,
      date,
      note,
      created_at: new Date()
    });
    res.redirect('/income');
  } catch (error) {
    console.error('Income POST error:', error);
    res.status(500).send('Internal server error');
  }
});

app.post('/income/:id/delete', requireAuth, async (req, res) => {
  try {
    await db.collection('income').deleteOne({
      _id: new ObjectId(req.params.id),
      user_id: req.session.user.id
    });
    res.redirect('/income');
  } catch (error) {
    console.error('Income DELETE error:', error);
    res.status(500).send('Internal server error');
  }
});

app.get('/expenses', requireAuth, async (req, res) => {
  try {
    const items = await db.collection('expenses').find({ user_id: req.session.user.id })
      .sort({ date: -1, _id: -1 }).toArray();

    res.render('expenses', {
      items,
      error: null,
      today: getToday()
    });
  } catch (error) {
    console.error('Expenses GET error:', error);
    res.status(500).send('Internal server error');
  }
});

app.post('/expenses', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const category = String(req.body.category || '').trim();
  const subcategory = String(req.body.subcategory || '').trim();
  const amount = Number(req.body.amount);
  const date = String(req.body.date || '').trim();
  const note = String(req.body.note || '').trim();

  if (!category || !isPositive(amount) || !isValidDate(date)) {
    try {
      const items = await db.collection('expenses').find({ user_id: userId })
        .sort({ date: -1, _id: -1 }).toArray();
      return res.render('expenses', {
        items,
        error: 'Enter category, a positive amount, and a valid date.',
        today: getToday()
      });
    } catch (error) {
      console.error('Expenses POST validation error:', error);
      return res.status(500).send('Internal server error');
    }
  }

  try {
    await db.collection('expenses').insertOne({
      user_id: userId,
      category,
      subcategory,
      amount,
      date,
      note,
      created_at: new Date()
    });
    res.redirect('/expenses');
  } catch (error) {
    console.error('Expenses POST error:', error);
    res.status(500).send('Internal server error');
  }
});

app.post('/expenses/:id/delete', requireAuth, async (req, res) => {
  try {
    await db.collection('expenses').deleteOne({
      _id: new ObjectId(req.params.id),
      user_id: req.session.user.id
    });
    res.redirect('/expenses');
  } catch (error) {
    console.error('Expenses DELETE error:', error);
    res.status(500).send('Internal server error');
  }
});

app.get('/budgets', requireAuth, async (req, res) => {
  try {
    const items = await db.collection('budgets').find({ user_id: req.session.user.id })
      .sort({ year: -1, month: -1, _id: -1 }).toArray();

    res.render('budgets', {
      items,
      error: null,
      currentYear: new Date().getFullYear(),
      currentMonth: new Date().getMonth() + 1
    });
  } catch (error) {
    console.error('Budgets GET error:', error);
    res.status(500).send('Internal server error');
  }
});

app.post('/budgets', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const type = String(req.body.type || '').trim();
  const category = String(req.body.category || '').trim();
  const amount = Number(req.body.amount);
  const year = Number(req.body.year);
  const month = req.body.month ? Number(req.body.month) : null;

  const validType = type === 'monthly' || type === 'yearly';
  const validYear = Number.isInteger(year) && year >= 2000 && year <= 2100;
  const validMonth = type === 'yearly' || (Number.isInteger(month) && month >= 1 && month <= 12);

  if (!validType || !category || !isPositive(amount) || !validYear || !validMonth) {
    try {
      const items = await db.collection('budgets').find({ user_id: userId })
        .sort({ year: -1, month: -1, _id: -1 }).toArray();
      return res.render('budgets', {
        items,
        error: 'Enter a valid type, category, amount, year, and month for monthly budgets.',
        currentYear: new Date().getFullYear(),
        currentMonth: new Date().getMonth() + 1
      });
    } catch (error) {
      console.error('Budgets POST validation error:', error);
      return res.status(500).send('Internal server error');
    }
  }

  try {
    await db.collection('budgets').insertOne({
      user_id: userId,
      type,
      category,
      amount,
      year,
      month: type === 'yearly' ? null : month,
      created_at: new Date()
    });
    res.redirect('/budgets');
  } catch (error) {
    console.error('Budgets POST error:', error);
    res.status(500).send('Internal server error');
  }
});

app.post('/budgets/:id/delete', requireAuth, async (req, res) => {
  try {
    await db.collection('budgets').deleteOne({
      _id: new ObjectId(req.params.id),
      user_id: req.session.user.id
    });
    res.redirect('/budgets');
  } catch (error) {
    console.error('Budgets DELETE error:', error);
    res.status(500).send('Internal server error');
  }
});

app.get('/goals', requireAuth, async (req, res) => {
  try {
    const items = await db.collection('goals').find({ user_id: req.session.user.id })
      .sort({ _id: -1 }).toArray();

    res.render('goals', {
      items,
      error: null
    });
  } catch (error) {
    console.error('Goals GET error:', error);
    res.status(500).send('Internal server error');
  }
});

app.post('/goals', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const name = String(req.body.name || '').trim();
  const targetAmount = Number(req.body.target_amount);
  const currentAmount = Number(req.body.current_amount || 0);
  const targetDate = String(req.body.target_date || '').trim();

  if (!name || !isPositive(targetAmount) || Number.isNaN(currentAmount) || currentAmount < 0 || (targetDate && !isValidDate(targetDate))) {
    try {
      const items = await db.collection('goals').find({ user_id: userId })
        .sort({ _id: -1 }).toArray();
      return res.render('goals', {
        items,
        error: 'Enter a goal name, valid target amount, valid current amount, and valid target date if used.'
      });
    } catch (error) {
      console.error('Goals POST validation error:', error);
      return res.status(500).send('Internal server error');
    }
  }

  try {
    await db.collection('goals').insertOne({
      user_id: userId,
      name,
      target_amount: targetAmount,
      current_amount: currentAmount,
      target_date: targetDate || null,
      created_at: new Date()
    });
    res.redirect('/goals');
  } catch (error) {
    console.error('Goals POST error:', error);
    res.status(500).send('Internal server error');
  }
});

app.post('/goals/:id/add', requireAuth, async (req, res) => {
  const amount = Number(req.body.amount);
  if (isPositive(amount)) {
    try {
      await db.collection('goals').updateOne(
        { _id: new ObjectId(req.params.id), user_id: req.session.user.id },
        { $inc: { current_amount: amount } }
      );
    } catch (error) {
      console.error('Goals ADD error:', error);
    }
  }
  res.redirect('/goals');
});

app.post('/goals/:id/delete', requireAuth, async (req, res) => {
  try {
    await db.collection('goals').deleteOne({
      _id: new ObjectId(req.params.id),
      user_id: req.session.user.id
    });
    res.redirect('/goals');
  } catch (error) {
    console.error('Goals DELETE error:', error);
    res.status(500).send('Internal server error');
  }
});

app.get('/bills', requireAuth, async (req, res) => {
  try {
    const items = await db.collection('bills').find({ user_id: req.session.user.id })
      .sort({ due_date: 1, _id: -1 }).toArray();

    res.render('bills', {
      items,
      error: null,
      today: getToday()
    });
  } catch (error) {
    console.error('Bills GET error:', error);
    res.status(500).send('Internal server error');
  }
});

app.post('/bills', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const name = String(req.body.name || '').trim();
  const category = String(req.body.category || '').trim();
  const amount = Number(req.body.amount);
  const dueDate = String(req.body.due_date || '').trim();

  if (!name || !category || !isPositive(amount) || !isValidDate(dueDate)) {
    try {
      const items = await db.collection('bills').find({ user_id: userId })
        .sort({ due_date: 1, _id: -1 }).toArray();
      return res.render('bills', {
        items,
        error: 'Enter bill name, category, positive amount, and valid due date.',
        today: getToday()
      });
    } catch (error) {
      console.error('Bills POST validation error:', error);
      return res.status(500).send('Internal server error');
    }
  }

  try {
    await db.collection('bills').insertOne({
      user_id: userId,
      name,
      category,
      amount,
      due_date: dueDate,
      status: 'unpaid',
      created_at: new Date()
    });
    res.redirect('/bills');
  } catch (error) {
    console.error('Bills POST error:', error);
    res.status(500).send('Internal server error');
  }
});

app.post('/bills/:id/toggle', requireAuth, async (req, res) => {
  try {
    const bill = await db.collection('bills').findOne({
      _id: new ObjectId(req.params.id),
      user_id: req.session.user.id
    });
    if (bill) {
      const nextStatus = bill.status === 'paid' ? 'unpaid' : 'paid';
      await db.collection('bills').updateOne(
        { _id: new ObjectId(req.params.id), user_id: req.session.user.id },
        { $set: { status: nextStatus } }
      );
    }
    res.redirect('/bills');
  } catch (error) {
    console.error('Bills TOGGLE error:', error);
    res.status(500).send('Internal server error');
  }
});

app.post('/bills/:id/delete', requireAuth, async (req, res) => {
  try {
    await db.collection('bills').deleteOne({
      _id: new ObjectId(req.params.id),
      user_id: req.session.user.id
    });
    res.redirect('/bills');
  } catch (error) {
    console.error('Bills DELETE error:', error);
    res.status(500).send('Internal server error');
  }
});

app.get('/reports', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { monthKey } = getCurrentPeriod();

    const spendingByCategory = await db.collection('expenses').aggregate([
      { $match: { user_id: userId, date: { $regex: `^${monthKey}` } } },
      { $group: { _id: '$category', total: { $sum: '$amount' } } },
      { $sort: { total: -1 } }
    ]).toArray();

    const incomeRows = await db.collection('income').aggregate([
      { $match: { user_id: userId } },
      {
        $group: {
          _id: { $substr: ['$date', 0, 7] },
          total: { $sum: '$amount' }
        }
      },
      { $sort: { '_id': 1 } }
    ]).toArray().then(rows => rows.map(row => ({ month: row._id, total: row.total })));

    const expenseRows = await db.collection('expenses').aggregate([
      { $match: { user_id: userId } },
      {
        $group: {
          _id: { $substr: ['$date', 0, 7] },
          total: { $sum: '$amount' }
        }
      },
      { $sort: { '_id': 1 } }
    ]).toArray().then(rows => rows.map(row => ({ month: row._id, total: row.total })));

    const goalRows = await db.collection('goals').find({ user_id: userId })
      .sort({ _id: -1 }).toArray();

    const budgetOverview = await getBudgetOverview(userId);
    const months = getLastMonths(6);
    const incomeMap = Object.fromEntries(incomeRows.map(row => [row.month, Number(row.total)]));
    const expenseMap = Object.fromEntries(expenseRows.map(row => [row.month, Number(row.total)]));
    const monthlyTrend = months.map(month => ({
      month,
      income: incomeMap[month] || 0,
      expense: expenseMap[month] || 0
    }));

    res.render('reports', {
      spendingByCategory,
      monthlyTrend,
      goalRows,
      budgetOverview,
      monthKey
    });
  } catch (error) {
    console.error('Reports error:', error);
    res.status(500).send('Internal server error');
  }
});

async function startServer() {
  await connectToMongoDB();

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
