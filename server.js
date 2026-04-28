require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'budget.db');
const sessionDir = process.env.SESSION_DIR || path.join(__dirname, 'data', 'sessions');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
fs.mkdirSync(sessionDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS income (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  date TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  category TEXT NOT NULL,
  subcategory TEXT DEFAULT '',
  amount REAL NOT NULL,
  date TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('monthly', 'yearly')),
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  target_amount REAL NOT NULL,
  current_amount REAL NOT NULL DEFAULT 0,
  target_date TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK(status IN ('unpaid', 'paid')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new FileStore({
    path: sessionDir,
    retries: 0
  }),
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

function getBudgetOverview(userId) {
  const { year, month, monthKey } = getCurrentPeriod();

  const monthly = db.prepare(`
    SELECT
      b.id,
      b.category,
      b.amount,
      COALESCE(SUM(e.amount), 0) AS spent
    FROM budgets b
    LEFT JOIN expenses e
      ON e.user_id = b.user_id
      AND e.category = b.category
      AND substr(e.date, 1, 7) = ?
    WHERE b.user_id = ?
      AND b.type = 'monthly'
      AND b.year = ?
      AND b.month = ?
    GROUP BY b.id
    ORDER BY b.category
  `).all(monthKey, userId, year, month).map(row => ({
    ...row,
    type: 'monthly',
    period: monthKey
  }));

  const yearly = db.prepare(`
    SELECT
      b.id,
      b.category,
      b.amount,
      COALESCE(SUM(e.amount), 0) AS spent
    FROM budgets b
    LEFT JOIN expenses e
      ON e.user_id = b.user_id
      AND e.category = b.category
      AND substr(e.date, 1, 4) = ?
    WHERE b.user_id = ?
      AND b.type = 'yearly'
      AND b.year = ?
    GROUP BY b.id
    ORDER BY b.category
  `).all(String(year), userId, year).map(row => ({
    ...row,
    type: 'yearly',
    period: String(year)
  }));

  return [...monthly, ...yearly];
}

function getDashboardData(userId) {
  const { monthKey } = getCurrentPeriod();

  const totalIncome = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM income
    WHERE user_id = ?
  `).get(userId).total;

  const totalExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM expenses
    WHERE user_id = ?
  `).get(userId).total;

  const monthIncome = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM income
    WHERE user_id = ? AND substr(date, 1, 7) = ?
  `).get(userId, monthKey).total;

  const monthExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM expenses
    WHERE user_id = ? AND substr(date, 1, 7) = ?
  `).get(userId, monthKey).total;

  const savings = db.prepare(`
    SELECT
      COALESCE(SUM(current_amount), 0) AS saved,
      COALESCE(SUM(target_amount), 0) AS target
    FROM goals
    WHERE user_id = ?
  `).get(userId);

  const upcomingBills = db.prepare(`
    SELECT *
    FROM bills
    WHERE user_id = ?
      AND status = 'unpaid'
      AND due_date >= date('now')
      AND due_date <= date('now', '+30 day')
    ORDER BY due_date ASC, id DESC
    LIMIT 10
  `).all(userId);

  const recentTransactions = db.prepare(`
    SELECT *
    FROM (
      SELECT
        date,
        'Income' AS kind,
        source AS label,
        category,
        amount AS amount
      FROM income
      WHERE user_id = ?

      UNION ALL

      SELECT
        date,
        'Expense' AS kind,
        CASE
          WHEN COALESCE(subcategory, '') <> '' THEN subcategory
          WHEN COALESCE(note, '') <> '' THEN note
          ELSE category
        END AS label,
        category,
        amount * -1 AS amount
      FROM expenses
      WHERE user_id = ?
    )
    ORDER BY date DESC
    LIMIT 8
  `).all(userId, userId);

  const budgetOverview = getBudgetOverview(userId);

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

app.post('/register', authLimiter, (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!name || !isValidEmail(email) || password.length < 8) {
    return res.render('register', {
      error: 'Enter a name, a valid email, and a password with at least 8 characters.'
    });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.render('register', { error: 'That email is already registered.' });
  }

  const passwordHash = bcrypt.hashSync(password, 12);
  const info = db.prepare(`
    INSERT INTO users (name, email, password_hash)
    VALUES (?, ?, ?)
  `).run(name, email, passwordHash);

  req.session.regenerate((err) => {
    if (err) {
      return res.render('register', { error: 'Could not start session. Try again.' });
    }
    req.session.user = {
      id: Number(info.lastInsertRowid),
      name,
      email
    };
    return res.redirect('/dashboard');
  });
});

app.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  res.render('login', { error: null });
});

app.post('/login', authLimiter, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('login', { error: 'Invalid email or password.' });
  }

  req.session.regenerate((err) => {
    if (err) {
      return res.render('login', { error: 'Could not start session. Try again.' });
    }
    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email
    };
    return res.redirect('/dashboard');
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/login');
  });
});

app.get('/dashboard', requireAuth, (req, res) => {
  res.render('dashboard', {
    ...getDashboardData(req.session.user.id)
  });
});

app.get('/income', requireAuth, (req, res) => {
  const items = db.prepare(`
    SELECT *
    FROM income
    WHERE user_id = ?
    ORDER BY date DESC, id DESC
  `).all(req.session.user.id);

  res.render('income', {
    items,
    error: null,
    today: getToday()
  });
});

app.post('/income', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const source = String(req.body.source || '').trim();
  const category = String(req.body.category || '').trim();
  const amount = Number(req.body.amount);
  const date = String(req.body.date || '').trim();
  const note = String(req.body.note || '').trim();

  if (!source || !category || !isPositive(amount) || !isValidDate(date)) {
    const items = db.prepare('SELECT * FROM income WHERE user_id = ? ORDER BY date DESC, id DESC').all(userId);
    return res.render('income', {
      items,
      error: 'Enter source, category, a positive amount, and a valid date.',
      today: getToday()
    });
  }

  db.prepare(`
    INSERT INTO income (user_id, source, category, amount, date, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, source, category, amount, date, note);

  res.redirect('/income');
});

app.post('/income/:id/delete', requireAuth, (req, res) => {
  db.prepare('DELETE FROM income WHERE id = ? AND user_id = ?').run(req.params.id, req.session.user.id);
  res.redirect('/income');
});

app.get('/expenses', requireAuth, (req, res) => {
  const items = db.prepare(`
    SELECT *
    FROM expenses
    WHERE user_id = ?
    ORDER BY date DESC, id DESC
  `).all(req.session.user.id);

  res.render('expenses', {
    items,
    error: null,
    today: getToday()
  });
});

app.post('/expenses', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const category = String(req.body.category || '').trim();
  const subcategory = String(req.body.subcategory || '').trim();
  const amount = Number(req.body.amount);
  const date = String(req.body.date || '').trim();
  const note = String(req.body.note || '').trim();

  if (!category || !isPositive(amount) || !isValidDate(date)) {
    const items = db.prepare('SELECT * FROM expenses WHERE user_id = ? ORDER BY date DESC, id DESC').all(userId);
    return res.render('expenses', {
      items,
      error: 'Enter category, a positive amount, and a valid date.',
      today: getToday()
    });
  }

  db.prepare(`
    INSERT INTO expenses (user_id, category, subcategory, amount, date, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, category, subcategory, amount, date, note);

  res.redirect('/expenses');
});

app.post('/expenses/:id/delete', requireAuth, (req, res) => {
  db.prepare('DELETE FROM expenses WHERE id = ? AND user_id = ?').run(req.params.id, req.session.user.id);
  res.redirect('/expenses');
});

app.get('/budgets', requireAuth, (req, res) => {
  const items = db.prepare(`
    SELECT *
    FROM budgets
    WHERE user_id = ?
    ORDER BY year DESC, month DESC, id DESC
  `).all(req.session.user.id);

  res.render('budgets', {
    items,
    error: null,
    currentYear: new Date().getFullYear(),
    currentMonth: new Date().getMonth() + 1
  });
});

app.post('/budgets', requireAuth, (req, res) => {
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
    const items = db.prepare('SELECT * FROM budgets WHERE user_id = ? ORDER BY year DESC, month DESC, id DESC').all(userId);
    return res.render('budgets', {
      items,
      error: 'Enter a valid type, category, amount, year, and month for monthly budgets.',
      currentYear: new Date().getFullYear(),
      currentMonth: new Date().getMonth() + 1
    });
  }

  db.prepare(`
    INSERT INTO budgets (user_id, type, category, amount, year, month)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, type, category, amount, year, type === 'yearly' ? null : month);

  res.redirect('/budgets');
});

app.post('/budgets/:id/delete', requireAuth, (req, res) => {
  db.prepare('DELETE FROM budgets WHERE id = ? AND user_id = ?').run(req.params.id, req.session.user.id);
  res.redirect('/budgets');
});

app.get('/goals', requireAuth, (req, res) => {
  const items = db.prepare(`
    SELECT *
    FROM goals
    WHERE user_id = ?
    ORDER BY id DESC
  `).all(req.session.user.id);

  res.render('goals', {
    items,
    error: null
  });
});

app.post('/goals', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const name = String(req.body.name || '').trim();
  const targetAmount = Number(req.body.target_amount);
  const currentAmount = Number(req.body.current_amount || 0);
  const targetDate = String(req.body.target_date || '').trim();

  if (!name || !isPositive(targetAmount) || Number.isNaN(currentAmount) || currentAmount < 0 || (targetDate && !isValidDate(targetDate))) {
    const items = db.prepare('SELECT * FROM goals WHERE user_id = ? ORDER BY id DESC').all(userId);
    return res.render('goals', {
      items,
      error: 'Enter a goal name, valid target amount, valid current amount, and valid target date if used.'
    });
  }

  db.prepare(`
    INSERT INTO goals (user_id, name, target_amount, current_amount, target_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, name, targetAmount, currentAmount, targetDate || null);

  res.redirect('/goals');
});

app.post('/goals/:id/add', requireAuth, (req, res) => {
  const amount = Number(req.body.amount);
  if (isPositive(amount)) {
    db.prepare(`
      UPDATE goals
      SET current_amount = current_amount + ?
      WHERE id = ? AND user_id = ?
    `).run(amount, req.params.id, req.session.user.id);
  }
  res.redirect('/goals');
});

app.post('/goals/:id/delete', requireAuth, (req, res) => {
  db.prepare('DELETE FROM goals WHERE id = ? AND user_id = ?').run(req.params.id, req.session.user.id);
  res.redirect('/goals');
});

app.get('/bills', requireAuth, (req, res) => {
  const items = db.prepare(`
    SELECT *
    FROM bills
    WHERE user_id = ?
    ORDER BY due_date ASC, id DESC
  `).all(req.session.user.id);

  res.render('bills', {
    items,
    error: null,
    today: getToday()
  });
});

app.post('/bills', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const name = String(req.body.name || '').trim();
  const category = String(req.body.category || '').trim();
  const amount = Number(req.body.amount);
  const dueDate = String(req.body.due_date || '').trim();

  if (!name || !category || !isPositive(amount) || !isValidDate(dueDate)) {
    const items = db.prepare('SELECT * FROM bills WHERE user_id = ? ORDER BY due_date ASC, id DESC').all(userId);
    return res.render('bills', {
      items,
      error: 'Enter bill name, category, positive amount, and valid due date.',
      today: getToday()
    });
  }

  db.prepare(`
    INSERT INTO bills (user_id, name, category, amount, due_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, name, category, amount, dueDate);

  res.redirect('/bills');
});

app.post('/bills/:id/toggle', requireAuth, (req, res) => {
  const bill = db.prepare('SELECT status FROM bills WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.id);
  if (bill) {
    const nextStatus = bill.status === 'paid' ? 'unpaid' : 'paid';
    db.prepare('UPDATE bills SET status = ? WHERE id = ? AND user_id = ?').run(nextStatus, req.params.id, req.session.user.id);
  }
  res.redirect('/bills');
});

app.post('/bills/:id/delete', requireAuth, (req, res) => {
  db.prepare('DELETE FROM bills WHERE id = ? AND user_id = ?').run(req.params.id, req.session.user.id);
  res.redirect('/bills');
});

app.get('/reports', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const { monthKey } = getCurrentPeriod();

  const spendingByCategory = db.prepare(`
    SELECT category, COALESCE(SUM(amount), 0) AS total
    FROM expenses
    WHERE user_id = ? AND substr(date, 1, 7) = ?
    GROUP BY category
    ORDER BY total DESC
  `).all(userId, monthKey);

  const incomeRows = db.prepare(`
    SELECT substr(date, 1, 7) AS month, COALESCE(SUM(amount), 0) AS total
    FROM income
    WHERE user_id = ?
    GROUP BY substr(date, 1, 7)
    ORDER BY month
  `).all(userId);

  const expenseRows = db.prepare(`
    SELECT substr(date, 1, 7) AS month, COALESCE(SUM(amount), 0) AS total
    FROM expenses
    WHERE user_id = ?
    GROUP BY substr(date, 1, 7)
    ORDER BY month
  `).all(userId);

  const goalRows = db.prepare(`
    SELECT name, current_amount, target_amount
    FROM goals
    WHERE user_id = ?
    ORDER BY id DESC
  `).all(userId);

  const budgetOverview = getBudgetOverview(userId);
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
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
