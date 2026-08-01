require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Config from env ----
const SE_TAX_RATE = parseFloat(process.env.SE_TAX_RATE || '0.153');
const SE_TAXABLE_FRACTION = parseFloat(process.env.SE_TAXABLE_FRACTION || '0.9235');
const FEDERAL_RATE = parseFloat(process.env.FEDERAL_RATE || '0.12');
const STATE_RATE = parseFloat(process.env.STATE_RATE || '0.0425');
const MILEAGE_RATE = parseFloat(process.env.MILEAGE_RATE || '0.67');

// ---- Ensure data/uploads dirs exist ----
const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ---- Database setup ----
const db = new Database(path.join(dataDir, 'rover.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,          -- 'income' | 'expense' | 'mileage'
    entry_date TEXT NOT NULL,
    description TEXT,
    amount REAL DEFAULT 0,       -- dollar amount (income/expense) or 0 for mileage
    miles REAL DEFAULT 0,        -- miles (mileage entries only)
    category TEXT,
    receipt_path TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// ---- Middleware ----
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 } // 30 days
}));

// Serve uploaded receipts only to authenticated users (mounted after auth check below)
function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  return res.redirect('/login.html');
}

// ---- File upload config ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|pdf|heic|webp/i;
    if (allowed.test(path.extname(file.originalname))) return cb(null, true);
    cb(new Error('Only image or PDF receipts are allowed'));
  }
});

// ---- Auth routes ----
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  const hash = process.env.APP_PASSWORD_HASH;
  if (!hash) return res.status(500).json({ error: 'Server not configured. Set APP_PASSWORD_HASH in .env' });
  if (bcrypt.compareSync(password || '', hash)) {
    req.session.loggedIn = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Incorrect password' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ loggedIn: !!(req.session && req.session.loggedIn) });
});

// ---- Protect everything below this point ----
app.use('/uploads', requireAuth, express.static(uploadsDir));
app.use('/api', requireAuth);

// ---- Entry routes ----
app.get('/api/entries', (req, res) => {
  const rows = db.prepare('SELECT * FROM entries ORDER BY entry_date DESC, id DESC').all();
  res.json(rows);
});

app.post('/api/entries', upload.single('receipt'), (req, res) => {
  const { type, entry_date, description, amount, miles, category } = req.body;
  if (!type || !entry_date) return res.status(400).json({ error: 'type and entry_date are required' });

  const receiptPath = req.file ? '/uploads/' + req.file.filename : null;

  const stmt = db.prepare(`
    INSERT INTO entries (type, entry_date, description, amount, miles, category, receipt_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    type,
    entry_date,
    description || '',
    parseFloat(amount) || 0,
    parseFloat(miles) || 0,
    category || '',
    receiptPath
  );
  res.json({ id: result.lastInsertRowid });
});

app.delete('/api/entries/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(req.params.id);
  if (row && row.receipt_path) {
    const filePath = path.join(__dirname, row.receipt_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  db.prepare('DELETE FROM entries WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Tax summary route ----
app.get('/api/summary', (req, res) => {
  const { year } = req.query;
  const yearFilter = year ? `WHERE entry_date LIKE '${year}%'` : '';

  const income = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM entries WHERE type = 'income' ${year ? `AND entry_date LIKE ?` : ''}`)
    .get(...(year ? [`${year}%`] : [])).total;

  const expenses = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM entries WHERE type = 'expense' ${year ? `AND entry_date LIKE ?` : ''}`)
    .get(...(year ? [`${year}%`] : [])).total;

  const miles = db.prepare(`SELECT COALESCE(SUM(miles),0) as total FROM entries WHERE type = 'mileage' ${year ? `AND entry_date LIKE ?` : ''}`)
    .get(...(year ? [`${year}%`] : [])).total;

  const mileageDeduction = miles * MILEAGE_RATE;
  const netProfit = Math.max(0, income - expenses - mileageDeduction);

  const seTaxable = netProfit * SE_TAXABLE_FRACTION;
  const seTax = seTaxable * SE_TAX_RATE;
  const federalTax = netProfit * FEDERAL_RATE;
  const stateTax = netProfit * STATE_RATE;
  const totalTax = seTax + federalTax + stateTax;

  res.json({
    income: round2(income),
    expenses: round2(expenses),
    miles: round2(miles),
    mileageDeduction: round2(mileageDeduction),
    netProfit: round2(netProfit),
    seTax: round2(seTax),
    federalTax: round2(federalTax),
    stateTax: round2(stateTax),
    totalTax: round2(totalTax),
    quarterlyPayment: round2(totalTax / 4),
    quarterlyRequired: totalTax >= 1000,
    rates: {
      seTaxRate: SE_TAX_RATE,
      federalRate: FEDERAL_RATE,
      stateRate: STATE_RATE,
      mileageRate: MILEAGE_RATE
    }
  });
});

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---- Static files (frontend) — login.html always accessible, rest protected ----
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.listen(PORT, () => {
  console.log(`Rover Tracker running on port ${PORT}`);
});
