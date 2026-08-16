require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Config from env ----
const SE_TAX_RATE = parseFloat(process.env.SE_TAX_RATE || '0.153');
const SE_TAXABLE_FRACTION = parseFloat(process.env.SE_TAXABLE_FRACTION || '0.9235');
const FEDERAL_RATE = parseFloat(process.env.FEDERAL_RATE || '0.12');
const STATE_RATE = parseFloat(process.env.STATE_RATE || '0.0425');
const MILEAGE_RATE = parseFloat(process.env.MILEAGE_RATE || '0.76');

// ---- Ensure data/uploads dirs exist ----
const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ---- Database setup ----
const db = new Database(path.join(dataDir, 'rover.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER,
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

// ---- Migration: ensure job_id column exists on older databases ----
const entryCols = db.prepare("PRAGMA table_info(entries)").all().map(c => c.name);
if (!entryCols.includes('job_id')) {
  db.exec(`ALTER TABLE entries ADD COLUMN job_id INTEGER`);
}

// ---- Seed: ensure a "Rover" job exists, and backfill any orphaned entries to it ----
let roverJob = db.prepare(`SELECT * FROM jobs WHERE name = 'Rover'`).get();
if (!roverJob) {
  const result = db.prepare(`INSERT INTO jobs (name) VALUES ('Rover')`).run();
  roverJob = { id: result.lastInsertRowid, name: 'Rover' };
}
db.prepare(`UPDATE entries SET job_id = ? WHERE job_id IS NULL`).run(roverJob.id);

// ---- Middleware ----
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 } // 30 days
}));

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

// ---- Job routes ----
app.get('/api/jobs', (req, res) => {
  const jobs = db.prepare('SELECT * FROM jobs ORDER BY created_at ASC').all();
  res.json(jobs);
});

app.post('/api/jobs', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Job name is required' });
  const existing = db.prepare('SELECT * FROM jobs WHERE name = ?').get(name);
  if (existing) return res.status(409).json({ error: 'A job with that name already exists' });
  const result = db.prepare('INSERT INTO jobs (name) VALUES (?)').run(name);
  res.json({ id: result.lastInsertRowid, name });
});

app.delete('/api/jobs/:id', (req, res) => {
  const jobId = req.params.id;
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.name === 'Rover') return res.status(400).json({ error: 'The Rover tab cannot be deleted' });

  // Delete receipt files tied to this job's entries first
  const entries = db.prepare('SELECT * FROM entries WHERE job_id = ?').all(jobId);
  entries.forEach(e => {
    if (e.receipt_path) {
      const filePath = path.join(__dirname, e.receipt_path);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  });
  db.prepare('DELETE FROM entries WHERE job_id = ?').run(jobId);
  db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
  res.json({ ok: true });
});

// ---- Entry routes ----
// job_id query param: a specific job's id, or 'all' / omitted for every job combined
app.get('/api/entries', (req, res) => {
  const { job_id } = req.query;
  let rows;
  if (job_id && job_id !== 'all') {
    rows = db.prepare('SELECT * FROM entries WHERE job_id = ? ORDER BY entry_date DESC, id DESC').all(job_id);
  } else {
    rows = db.prepare('SELECT * FROM entries ORDER BY entry_date DESC, id DESC').all();
  }
  res.json(rows);
});

app.post('/api/entries', upload.single('receipt'), (req, res) => {
  const { job_id, type, entry_date, description, amount, miles, category } = req.body;
  if (!job_id || !type || !entry_date) return res.status(400).json({ error: 'job_id, type and entry_date are required' });

  const receiptPath = req.file ? '/uploads/' + req.file.filename : null;

  const stmt = db.prepare(`
    INSERT INTO entries (job_id, type, entry_date, description, amount, miles, category, receipt_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    job_id,
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

// ---- Summary calculation helper (shared by /api/summary and PDF export) ----
// job_id: specific job id, or null/undefined/'all' for every job combined
function computeSummary(job_id, year) {
  const jobFilter = (job_id && job_id !== 'all') ? `AND job_id = ${parseInt(job_id, 10)}` : '';
  // parseInt above is safe: job_id always comes from our own job IDs (integers), never used in raw string concatenation with user text

  const income = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM entries WHERE type = 'income' ${jobFilter} ${year ? `AND entry_date LIKE ?` : ''}`)
    .get(...(year ? [`${year}%`] : [])).total;

  const expenses = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM entries WHERE type = 'expense' ${jobFilter} ${year ? `AND entry_date LIKE ?` : ''}`)
    .get(...(year ? [`${year}%`] : [])).total;

  const miles = db.prepare(`SELECT COALESCE(SUM(miles),0) as total FROM entries WHERE type = 'mileage' ${jobFilter} ${year ? `AND entry_date LIKE ?` : ''}`)
    .get(...(year ? [`${year}%`] : [])).total;

  const mileageDeduction = miles * MILEAGE_RATE;
  const netProfit = Math.max(0, income - expenses - mileageDeduction);

  const seTaxable = netProfit * SE_TAXABLE_FRACTION;
  const seTax = seTaxable * SE_TAX_RATE;
  const federalTax = netProfit * FEDERAL_RATE;
  const stateTax = netProfit * STATE_RATE;
  const totalTax = seTax + federalTax + stateTax;

  return {
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
  };
}

// ---- Tax summary route ----
app.get('/api/summary', (req, res) => {
  res.json(computeSummary(req.query.job_id, req.query.year));
});

// ---- Export: transactions + tax breakdown PDF ----
app.get('/api/export/transactions', (req, res) => {
  const { year, job_id } = req.query;
  const jobFilter = (job_id && job_id !== 'all') ? `AND job_id = ${parseInt(job_id, 10)}` : '';
  const entries = year
    ? db.prepare(`SELECT * FROM entries WHERE 1=1 ${jobFilter} AND entry_date LIKE ? ORDER BY entry_date ASC`).all(`${year}%`)
    : db.prepare(`SELECT * FROM entries WHERE 1=1 ${jobFilter} ORDER BY entry_date ASC`).all();
  const summary = computeSummary(job_id, year);

  let jobLabel = 'All Jobs';
  if (job_id && job_id !== 'all') {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job_id);
    if (job) jobLabel = job.name;
  }

  const filename = `${jobLabel.replace(/\s+/g, '-').toLowerCase()}-tax-report${year ? '-' + year : ''}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
  doc.pipe(res);

  // Title
  doc.fontSize(20).fillColor('#2a8a5f').text(`${jobLabel} Income & Tax Report`, { align: 'left' });
  doc.fontSize(10).fillColor('#777').text(`${year ? 'Tax Year: ' + year : 'All Years'}  •  Generated ${new Date().toLocaleDateString()}`);
  doc.moveDown(1.5);

  // Tax summary box
  doc.fontSize(14).fillColor('#2b2b2b').text('Tax Summary', { underline: true });
  doc.moveDown(0.5);
  doc.fontSize(11).fillColor('#2b2b2b');
  const summaryLines = [
    [`Total Income`, `$${summary.income.toFixed(2)}`],
    [`Total Expenses`, `$${summary.expenses.toFixed(2)}`],
    [`Total Miles`, `${summary.miles} mi`],
    [`Mileage Deduction (@ $${summary.rates.mileageRate}/mi)`, `$${summary.mileageDeduction.toFixed(2)}`],
    [`Net Profit`, `$${summary.netProfit.toFixed(2)}`],
    [``, ``],
    [`Self-Employment Tax (${(summary.rates.seTaxRate * 100).toFixed(1)}%)`, `$${summary.seTax.toFixed(2)}`],
    [`Federal Income Tax (${(summary.rates.federalRate * 100).toFixed(1)}%)`, `$${summary.federalTax.toFixed(2)}`],
    [`Michigan State Tax (${(summary.rates.stateRate * 100).toFixed(2)}%)`, `$${summary.stateTax.toFixed(2)}`],
    [`Total Estimated Tax`, `$${summary.totalTax.toFixed(2)}`],
    [`Estimated Quarterly Payment`, `$${summary.quarterlyPayment.toFixed(2)}`],
  ];
  summaryLines.forEach(([label, value]) => {
    if (!label) { doc.moveDown(0.3); return; }
    doc.text(label, { continued: true, width: 350 });
    doc.text(value, { align: 'right' });
  });

  doc.moveDown(0.5);
  doc.fontSize(9).fillColor('#b8860b').text(
    summary.quarterlyRequired
      ? 'Quarterly estimated payments are likely required (total est. tax is $1,000 or more).'
      : 'Below the $1,000 threshold — quarterly payments are likely not required at this income level.'
  );
  if (jobLabel !== 'All Jobs') {
    doc.fontSize(8).fillColor('#777').text('Note: IRS self-employment tax thresholds apply to your combined income across all side jobs, not each one individually. Check the "All Jobs" report for your true overall obligation.');
  }
  doc.fillColor('#2b2b2b');
  doc.moveDown(1.5);

  // Transactions table
  doc.fontSize(14).text('All Transactions', { underline: true });
  doc.moveDown(0.5);

  const colX = { date: 50, type: 105, desc: 165, category: 340, amount: 440, miles: 500 };
  doc.fontSize(9).fillColor('#777');
  doc.text('Date', colX.date, doc.y, { continued: false });
  doc.text('Type', colX.type, doc.y - 11);
  doc.text('Description', colX.desc, doc.y - 11);
  doc.text('Category', colX.category, doc.y - 11);
  doc.text('Amount', colX.amount, doc.y - 11);
  doc.text('Miles', colX.miles, doc.y - 11);
  doc.moveDown(0.3);
  doc.moveTo(50, doc.y).lineTo(560, doc.y).strokeColor('#e2ddd3').stroke();
  doc.moveDown(0.3);

  doc.fontSize(9).fillColor('#2b2b2b');
  entries.forEach(e => {
    if (doc.y > 700) {
      doc.addPage();
    }
    const rowY = doc.y;
    doc.text(e.entry_date, colX.date, rowY, { width: 50 });
    doc.text(e.type, colX.type, rowY, { width: 55 });
    doc.text((e.description || '').slice(0, 40), colX.desc, rowY, { width: 170 });
    doc.text(e.category || '', colX.category, rowY, { width: 95 });
    doc.text(e.type === 'mileage' ? '—' : `$${e.amount.toFixed(2)}`, colX.amount, rowY, { width: 55 });
    doc.text(e.type === 'mileage' ? String(e.miles) : '—', colX.miles, rowY, { width: 40 });
    doc.moveDown(0.6);
  });

  doc.end();
});

// ---- Export: all receipts bundled into one PDF ----
app.get('/api/export/receipts', (req, res) => {
  const { year, job_id } = req.query;
  const jobFilter = (job_id && job_id !== 'all') ? `AND job_id = ${parseInt(job_id, 10)}` : '';
  const entries = year
    ? db.prepare(`SELECT * FROM entries WHERE receipt_path IS NOT NULL ${jobFilter} AND entry_date LIKE ? ORDER BY entry_date ASC`).all(`${year}%`)
    : db.prepare(`SELECT * FROM entries WHERE receipt_path IS NOT NULL ${jobFilter} ORDER BY entry_date ASC`).all();

  let jobLabel = 'all-jobs';
  if (job_id && job_id !== 'all') {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job_id);
    if (job) jobLabel = job.name.replace(/\s+/g, '-').toLowerCase();
  }

  const filename = `${jobLabel}-receipts${year ? '-' + year : ''}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ margin: 40, size: 'LETTER' });
  doc.pipe(res);

  if (entries.length === 0) {
    doc.fontSize(14).text('No receipts found for this selection.');
    doc.end();
    return;
  }

  const imageExt = /\.(jpe?g|png|webp)$/i;

  entries.forEach((e, i) => {
    if (i > 0) doc.addPage();

    doc.fontSize(12).fillColor('#2b2b2b').text(
      `${e.entry_date}  •  ${e.description || '(no description)'}  •  $${e.amount ? e.amount.toFixed(2) : '0.00'}`
    );
    doc.moveDown(0.5);

    const filePath = path.join(__dirname, e.receipt_path);

    if (imageExt.test(e.receipt_path) && fs.existsSync(filePath)) {
      try {
        doc.image(filePath, {
          fit: [500, 600],
          align: 'center'
        });
      } catch (err) {
        doc.fontSize(10).fillColor('#c0392b').text(`(Could not embed image: ${err.message})`);
      }
    } else if (fs.existsSync(filePath)) {
      doc.fontSize(10).fillColor('#777').text(
        `Receipt is a non-image file (${path.basename(e.receipt_path)}) and could not be embedded directly. Find it in your uploads folder.`
      );
    } else {
      doc.fontSize(10).fillColor('#c0392b').text('(Receipt file not found on server)');
    }
  });

  doc.end();
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
