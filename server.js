const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const initSqlJs = require('sql.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.disable('etag');
app.use((req, res, next) => { res.set('Cache-Control', 'no-store, no-cache, must-revalidate'); next(); });
// Serve static files from 'public' subfolder if it exists, otherwise from root
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false }));
app.use(express.static(__dirname, { etag: false, lastModified: false }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health check (responds even if DB hasn't initialized yet)
app.get('/api/health', (req, res) => res.json({ status: 'ok', dbReady: !!db }));

// File upload config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// Logo upload config
const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'logos');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `logo-${Date.now()}-${file.originalname}`);
  }
});
const logoUpload = multer({ storage: logoStorage, limits: { fileSize: 5 * 1024 * 1024 } });

// CSV import upload
const csvStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'imports');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `import-${Date.now()}-${file.originalname}`);
  }
});
const csvUpload = multer({ storage: csvStorage, limits: { fileSize: 20 * 1024 * 1024 } });

let db;

// Simple session store (demo only)
const sessions = {};

async function initDB() {
  const SQL = await initSqlJs({
    locateFile: file => path.join(__dirname, 'node_modules', 'sql.js', 'dist', file)
  });
  db = new SQL.Database();

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'client',
      client_name TEXT DEFAULT '',
      email TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'Backlog',
      priority TEXT DEFAULT 'Medium',
      estimated_hours REAL DEFAULT 0,
      actual_hours REAL DEFAULT 0,
      approval_status TEXT DEFAULT 'Pending',
      assignee TEXT DEFAULT '',
      client TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      due_date TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      sort_order INTEGER DEFAULT 0,
      column_order INTEGER DEFAULT 0,
      completed_date TEXT DEFAULT ''
    )
  `);

  // Add completed_date column if it doesn't exist (migration for existing DBs)
  try { db.run('ALTER TABLE tickets ADD COLUMN completed_date TEXT DEFAULT ""'); } catch(e) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      mime_type TEXT DEFAULT '',
      uploaded_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      author TEXT DEFAULT 'User',
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS dashboard_layouts (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'default',
      layout TEXT DEFAULT '[]',
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY,
      ticket_id TEXT,
      action TEXT NOT NULL,
      details TEXT DEFAULT '',
      user_name TEXT DEFAULT 'System',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS client_branding (
      id TEXT PRIMARY KEY,
      client_name TEXT NOT NULL UNIQUE,
      logo_filename TEXT DEFAULT '',
      primary_color TEXT DEFAULT '#6c5ce7',
      secondary_color TEXT DEFAULT '#a29bfe',
      accent_color TEXT DEFAULT '#00b894',
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS team_members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT DEFAULT '',
      role TEXT DEFAULT '',
      avatar_color TEXT DEFAULT '#6c5ce7',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS custom_statuses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT DEFAULT '#6b6b80',
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Add Slack columns to client_branding if they don't exist
  try { db.run('ALTER TABLE client_branding ADD COLUMN slack_webhook_url TEXT DEFAULT ""'); } catch(e) {}
  try { db.run('ALTER TABLE client_branding ADD COLUMN slack_channel_name TEXT DEFAULT ""'); } catch(e) {}

  // Seed users and data
  const count = db.exec("SELECT COUNT(*) as c FROM users");
  if (count[0].values[0][0] === 0) {
    seedUsers();
    seedData();
    seedBranding();
    seedTeamMembers();
    seedStatuses();
  }

  console.log('Database initialized');
}

// ============ SLACK NOTIFICATION HELPER ============
async function notifySlack(clientName, message) {
  try {
    const branding = getRow('SELECT slack_webhook_url, slack_channel_name FROM client_branding WHERE client_name = ?', [clientName]);
    if (!branding || !branding.slack_webhook_url) return;

    const payload = JSON.stringify({ text: message });
    const https = require('https');
    const url = new URL(branding.slack_webhook_url);

    return new Promise((resolve) => {
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', (err) => { console.error('Slack notification error:', err.message); resolve(); });
      req.write(payload);
      req.end();
    });
  } catch (err) {
    console.error('Slack notification error:', err.message);
  }
}

function seedUsers() {
  const users = [
    { username: 'admin', password: 'fluid2026', name: 'Admin', role: 'admin', client_name: '', email: 'admin@devtrack.io' },
    { username: 'Acme Corp', password: 'Acme Corp', name: 'Acme Corp', role: 'client', client_name: 'Acme Corp', email: 'contact@acmecorp.com' },
    { username: 'TechStart Inc', password: 'TechStart Inc', name: 'TechStart Inc', role: 'client', client_name: 'TechStart Inc', email: 'team@techstart.io' },
    { username: 'Global Media', password: 'Global Media', name: 'Global Media', role: 'client', client_name: 'Global Media', email: 'dev@globalmedia.com' },
    { username: 'FinServe LLC', password: 'FinServe LLC', name: 'FinServe LLC', role: 'client', client_name: 'FinServe LLC', email: 'ops@finserve.com' },
  ];
  users.forEach(u => {
    db.run('INSERT INTO users (id, username, password, name, role, client_name, email) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuidv4(), u.username, u.password, u.name, u.role, u.client_name, u.email]);
  });
}

function seedBranding() {
  const brandings = [
    { client_name: 'Acme Corp', primary_color: '#e74c3c', secondary_color: '#c0392b', accent_color: '#f39c12' },
    { client_name: 'TechStart Inc', primary_color: '#3498db', secondary_color: '#2980b9', accent_color: '#2ecc71' },
    { client_name: 'Global Media', primary_color: '#9b59b6', secondary_color: '#8e44ad', accent_color: '#1abc9c' },
    { client_name: 'FinServe LLC', primary_color: '#2c3e50', secondary_color: '#34495e', accent_color: '#f1c40f' },
  ];
  brandings.forEach(b => {
    db.run('INSERT INTO client_branding (id, client_name, primary_color, secondary_color, accent_color) VALUES (?, ?, ?, ?, ?)',
      [uuidv4(), b.client_name, b.primary_color, b.secondary_color, b.accent_color]);
  });
}

function seedData() {
  const statuses = ['Backlog', 'To Do', 'In Progress', 'Review', 'Done'];
  const priorities = ['Low', 'Medium', 'High', 'Urgent'];
  const approvals = ['Pending', 'Approved', 'Rejected', 'Changes Requested'];
  const clients = ['Acme Corp', 'TechStart Inc', 'Global Media', 'FinServe LLC'];
  const assignees = ['Alex Chen', 'Sarah Kim', 'James Wilson', 'Maria Garcia', 'David Lee'];

  const sampleTickets = [
    { title: 'Build user authentication module', desc: 'Implement OAuth2 login with Google and GitHub providers, including session management and role-based access control.', est: 24, act: 18 },
    { title: 'Design landing page mockup', desc: 'Create responsive landing page design with hero section, features grid, testimonials, and CTA sections.', est: 16, act: 0 },
    { title: 'API integration — Payment gateway', desc: 'Integrate Stripe payment processing with webhook handling for subscriptions and one-time payments.', est: 40, act: 32 },
    { title: 'Database schema migration', desc: 'Migrate legacy MySQL schema to PostgreSQL with data integrity validation and rollback plan.', est: 12, act: 12 },
    { title: 'Mobile responsive overhaul', desc: 'Refactor all existing pages for mobile-first responsive design with breakpoints at 320px, 768px, and 1024px.', est: 32, act: 8 },
    { title: 'Setup CI/CD pipeline', desc: 'Configure GitHub Actions with automated testing, linting, staging deployment, and production release workflow.', est: 8, act: 6 },
    { title: 'Custom reporting dashboard', desc: 'Build analytics dashboard with Chart.js showing revenue, user engagement, and conversion funnels.', est: 48, act: 0 },
    { title: 'Email notification system', desc: 'Implement transactional email system using SendGrid with templates for welcome, reset, and notification emails.', est: 20, act: 15 },
    { title: 'Search and filter functionality', desc: 'Add Elasticsearch-powered full-text search with faceted filtering across products, articles, and users.', est: 28, act: 20 },
    { title: 'Performance optimization audit', desc: 'Conduct Lighthouse audit and optimize Core Web Vitals including LCP, FID, and CLS metrics.', est: 16, act: 16 },
    { title: 'Third-party API documentation', desc: 'Write comprehensive API docs using OpenAPI 3.0 spec with interactive Swagger UI and code examples.', est: 12, act: 4 },
    { title: 'User onboarding flow', desc: 'Design and implement step-by-step onboarding wizard with progress tracking and skip functionality.', est: 24, act: 0 },
  ];

  sampleTickets.forEach((t, i) => {
    const id = uuidv4();
    const status = statuses[i % statuses.length];
    const priority = priorities[i % priorities.length];
    const approval = status === 'Done' ? 'Approved' : approvals[i % approvals.length];
    const client = clients[i % clients.length];
    const assignee = assignees[i % assignees.length];
    const daysOffset = Math.floor(Math.random() * 30) - 5;
    const dueDate = new Date(Date.now() + daysOffset * 86400000).toISOString().split('T')[0];
    const tags = JSON.stringify([['Frontend', 'Backend', 'Design', 'DevOps', 'QA'][i % 5]]);

    db.run(
      `INSERT INTO tickets (id, title, description, status, priority, estimated_hours, actual_hours, approval_status, assignee, client, tags, due_date, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, t.title, t.desc, status, priority, t.est, t.act, approval, assignee, client, tags, dueDate, i]
    );
  });
}

function seedTeamMembers() {
  const members = [
    { name: 'Alex Chen', email: 'alex@devtrack.io', role: 'Developer', avatar_color: '#6c5ce7' },
    { name: 'Sarah Kim', email: 'sarah@devtrack.io', role: 'Designer', avatar_color: '#e17055' },
    { name: 'James Wilson', email: 'james@devtrack.io', role: 'Developer', avatar_color: '#00b894' },
    { name: 'Maria Garcia', email: 'maria@devtrack.io', role: 'Project Manager', avatar_color: '#fdcb6e' },
    { name: 'David Lee', email: 'david@devtrack.io', role: 'QA Engineer', avatar_color: '#74b9ff' },
  ];
  members.forEach(m => {
    db.run('INSERT INTO team_members (id, name, email, role, avatar_color) VALUES (?, ?, ?, ?, ?)',
      [uuidv4(), m.name, m.email, m.role, m.avatar_color]);
  });
}

function seedStatuses() {
  const statuses = [
    { name: 'Backlog', color: '#6b6b80', sort_order: 0 },
    { name: 'To Do', color: '#74b9ff', sort_order: 1 },
    { name: 'In Progress', color: '#fdcb6e', sort_order: 2 },
    { name: 'Review', color: '#fd79a8', sort_order: 3 },
    { name: 'Done', color: '#00b894', sort_order: 4 },
  ];
  statuses.forEach(s => {
    db.run('INSERT INTO custom_statuses (id, name, color, sort_order) VALUES (?, ?, ?, ?)',
      [uuidv4(), s.name, s.color, s.sort_order]);
  });
}

// Helper to get rows as objects
function allRows(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getRow(sql, params = []) {
  const rows = allRows(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

// ============ AUTH ENDPOINTS ============

// Login with username/password — no user list endpoint (clients shouldn't see each other)
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = getRow('SELECT * FROM users WHERE username = ? AND password = ?', [username, password]);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });

  const token = uuidv4();
  sessions[token] = { userId: user.id, role: user.role, client_name: user.client_name, name: user.name };
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, client_name: user.client_name, email: user.email } });
});

app.get('/api/auth/me', (req, res) => {
  const token = req.headers['x-auth-token'];
  const session = sessions[token];
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const user = getRow('SELECT id, name, role, client_name, email FROM users WHERE id = ?', [session.userId]);
  if (!user) return res.status(401).json({ error: 'User not found' });
  res.json(user);
});

// Auth middleware — attaches session info to req
function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'];
  const session = sessions[token];
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  req.session = session;
  next();
}

// Admin-only middleware
function adminOnly(req, res, next) {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// Helper: apply client scoping to ticket queries
function clientScope(session) {
  if (session.role === 'admin') return { where: '', params: [] };
  return { where: ' AND client = ?', params: [session.client_name] };
}

// ============ TICKET ENDPOINTS ============

app.get('/api/tickets', authMiddleware, (req, res) => {
  const scope = clientScope(req.session);
  let sql = 'SELECT * FROM tickets WHERE 1=1' + scope.where;
  const params = [...scope.params];

  if (req.query.status) { sql += ' AND status = ?'; params.push(req.query.status); }
  if (req.query.priority) { sql += ' AND priority = ?'; params.push(req.query.priority); }
  if (req.query.client && req.session.role === 'admin') { sql += ' AND client = ?'; params.push(req.query.client); }
  if (req.query.assignee) { sql += ' AND assignee = ?'; params.push(req.query.assignee); }
  if (req.query.search) {
    sql += ' AND (title LIKE ? OR description LIKE ?)';
    params.push(`%${req.query.search}%`, `%${req.query.search}%`);
  }

  sql += ' ORDER BY sort_order ASC, created_at DESC';

  const tickets = allRows(sql, params);
  tickets.forEach(t => {
    t.attachments = allRows('SELECT * FROM attachments WHERE ticket_id = ?', [t.id]);
    t.tags = JSON.parse(t.tags || '[]');
  });
  res.json(tickets);
});

app.get('/api/tickets/:id', authMiddleware, (req, res) => {
  const scope = clientScope(req.session);
  const ticket = getRow('SELECT * FROM tickets WHERE id = ?' + scope.where, [req.params.id, ...scope.params]);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  ticket.attachments = allRows('SELECT * FROM attachments WHERE ticket_id = ?', [ticket.id]);
  ticket.comments = allRows('SELECT * FROM comments WHERE ticket_id = ? ORDER BY created_at DESC', [ticket.id]);
  ticket.activity = allRows('SELECT * FROM activity_log WHERE ticket_id = ? ORDER BY created_at DESC LIMIT 20', [ticket.id]);
  ticket.tags = JSON.parse(ticket.tags || '[]');
  res.json(ticket);
});

app.post('/api/tickets', authMiddleware, (req, res) => {
  const id = uuidv4();
  let { title, description, status, priority, estimated_hours, assignee, client, tags, due_date } = req.body;

  // Clients can only create tickets for their own company
  if (req.session.role === 'client') {
    client = req.session.client_name;
  }

  db.run(
    `INSERT INTO tickets (id, title, description, status, priority, estimated_hours, assignee, client, tags, due_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, title, description || '', status || 'Backlog', priority || 'Medium',
     estimated_hours || 0, assignee || '', client || '', JSON.stringify(tags || []), due_date || '']
  );

  db.run('INSERT INTO activity_log (id, ticket_id, action, details, user_name) VALUES (?, ?, ?, ?, ?)',
    [uuidv4(), id, 'created', `Ticket "${title}" created`, req.session.name]);

  const ticket = getRow('SELECT * FROM tickets WHERE id = ?', [id]);
  ticket.tags = JSON.parse(ticket.tags || '[]');
  ticket.attachments = [];
  res.status(201).json(ticket);

  // Slack notification — new ticket
  if (client) {
    notifySlack(client, `:ticket: *New Ticket Created*\n>*${title}*\n>Priority: ${priority || 'Medium'} · Status: ${status || 'Backlog'}\n>Created by: ${req.session.name}${description ? `\n>${description.substring(0, 200)}${description.length > 200 ? '...' : ''}` : ''}`);
  }
});

app.put('/api/tickets/:id', authMiddleware, (req, res) => {
  const scope = clientScope(req.session);
  const ticket = getRow('SELECT * FROM tickets WHERE id = ?' + scope.where, [req.params.id, ...scope.params]);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const fields = ['title', 'description', 'status', 'priority', 'estimated_hours', 'actual_hours',
                   'approval_status', 'assignee', 'client', 'due_date', 'sort_order', 'column_order'];

  // Clients can't reassign tickets to other companies
  if (req.session.role === 'client') {
    delete req.body.client;
  }

  const changes = [];
  fields.forEach(field => {
    if (req.body[field] !== undefined) {
      const val = req.body[field];
      const oldVal = ticket[field];
      db.run(`UPDATE tickets SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`, [val, req.params.id]);

      if (field === 'status' && val !== ticket.status) {
        // Auto-set completed_date when status changes to Done; clear it if moved out of Done
        if (val === 'Done') {
          db.run(`UPDATE tickets SET completed_date = datetime('now') WHERE id = ?`, [req.params.id]);
        } else if (ticket.status === 'Done') {
          db.run(`UPDATE tickets SET completed_date = '' WHERE id = ?`, [req.params.id]);
        }
        db.run('INSERT INTO activity_log (id, ticket_id, action, details, user_name) VALUES (?, ?, ?, ?, ?)',
          [uuidv4(), req.params.id, 'status_changed', `Status changed from "${ticket.status}" to "${val}"`, req.session.name]);
        changes.push(`Status: ${oldVal} → ${val}`);
      }
      if (field === 'approval_status' && val !== ticket.approval_status) {
        db.run('INSERT INTO activity_log (id, ticket_id, action, details, user_name) VALUES (?, ?, ?, ?, ?)',
          [uuidv4(), req.params.id, 'approval_changed', `Approval changed from "${ticket.approval_status}" to "${val}"`, req.session.name]);
        changes.push(`Approval: ${oldVal || 'None'} → ${val}`);
      }
      if (field === 'priority' && val !== oldVal) changes.push(`Priority: ${oldVal} → ${val}`);
      if (field === 'assignee' && val !== oldVal) changes.push(`Assignee: ${oldVal || 'Unassigned'} → ${val || 'Unassigned'}`);
      if (field === 'title' && val !== oldVal) changes.push(`Title renamed`);
      if (field === 'due_date' && val !== oldVal) changes.push(`Due date: ${val || 'Removed'}`);
    }
  });

  if (req.body.tags !== undefined) {
    db.run(`UPDATE tickets SET tags = ?, updated_at = datetime('now') WHERE id = ?`,
      [JSON.stringify(req.body.tags), req.params.id]);
  }

  const updated = getRow('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
  updated.attachments = allRows('SELECT * FROM attachments WHERE ticket_id = ?', [updated.id]);
  updated.tags = JSON.parse(updated.tags || '[]');
  res.json(updated);

  // Slack notification — ticket updated (only for meaningful changes, skip reordering)
  if (changes.length > 0 && ticket.client) {
    notifySlack(ticket.client, `:pencil2: *Ticket Updated*\n>*${ticket.title}*\n>${changes.join('\n>')}\n>Updated by: ${req.session.name}`);
  }
});

app.put('/api/tickets/bulk/update', authMiddleware, (req, res) => {
  const { updates } = req.body;
  if (!Array.isArray(updates)) return res.status(400).json({ error: 'updates array required' });

  updates.forEach(u => {
    const sets = [];
    const vals = [];
    if (u.status !== undefined) { sets.push('status = ?'); vals.push(u.status); }
    if (u.sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(u.sort_order); }
    if (u.column_order !== undefined) { sets.push('column_order = ?'); vals.push(u.column_order); }
    if (sets.length > 0) {
      sets.push("updated_at = datetime('now')");
      vals.push(u.id);
      db.run(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`, vals);
    }
  });

  res.json({ success: true });
});

app.delete('/api/tickets/:id', authMiddleware, (req, res) => {
  const scope = clientScope(req.session);
  const ticket = getRow('SELECT * FROM tickets WHERE id = ?' + scope.where, [req.params.id, ...scope.params]);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  db.run('DELETE FROM attachments WHERE ticket_id = ?', [req.params.id]);
  db.run('DELETE FROM comments WHERE ticket_id = ?', [req.params.id]);
  db.run('DELETE FROM activity_log WHERE ticket_id = ?', [req.params.id]);
  db.run('DELETE FROM tickets WHERE id = ?', [req.params.id]);
  res.json({ success: true });

  // Slack notification — ticket deleted
  if (ticket.client) {
    notifySlack(ticket.client, `:wastebasket: *Ticket Deleted*\n>*${ticket.title}*\n>Deleted by: ${req.session.name}`);
  }
});

// ============ ATTACHMENTS ============

app.post('/api/tickets/:id/attachments', authMiddleware, upload.array('files', 10), (req, res) => {
  const ticketId = req.params.id;
  const attachments = [];

  (req.files || []).forEach(file => {
    const id = uuidv4();
    db.run(
      'INSERT INTO attachments (id, ticket_id, filename, original_name, file_size, mime_type) VALUES (?, ?, ?, ?, ?, ?)',
      [id, ticketId, file.filename, file.originalname, file.size, file.mimetype]
    );
    attachments.push({ id, ticket_id: ticketId, filename: file.filename, original_name: file.originalname, file_size: file.size, mime_type: file.mimetype });
  });

  db.run('INSERT INTO activity_log (id, ticket_id, action, details, user_name) VALUES (?, ?, ?, ?, ?)',
    [uuidv4(), ticketId, 'attachment_added', `${attachments.length} file(s) attached`, req.session.name]);

  res.json(attachments);

  // Slack notification — attachment added
  const ticket = getRow('SELECT title, client FROM tickets WHERE id = ?', [ticketId]);
  if (ticket && ticket.client) {
    const fileNames = attachments.map(a => a.original_name).join(', ');
    notifySlack(ticket.client, `:paperclip: *File${attachments.length > 1 ? 's' : ''} Attached to "${ticket.title}"*\n>${fileNames}\n>Uploaded by: ${req.session.name}`);
  }
});

app.delete('/api/attachments/:id', authMiddleware, (req, res) => {
  const att = getRow('SELECT * FROM attachments WHERE id = ?', [req.params.id]);
  if (att) {
    const filepath = path.join(__dirname, 'uploads', att.filename);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    db.run('DELETE FROM attachments WHERE id = ?', [req.params.id]);
  }
  res.json({ success: true });
});

// ============ COMMENTS ============

app.get('/api/tickets/:id/comments', authMiddleware, (req, res) => {
  const comments = allRows('SELECT * FROM comments WHERE ticket_id = ? ORDER BY created_at DESC', [req.params.id]);
  res.json(comments);
});

app.post('/api/tickets/:id/comments', authMiddleware, (req, res) => {
  const id = uuidv4();
  const author = req.session.name || 'User';
  db.run('INSERT INTO comments (id, ticket_id, author, content) VALUES (?, ?, ?, ?)',
    [id, req.params.id, author, req.body.content]);
  const comment = getRow('SELECT * FROM comments WHERE id = ?', [id]);
  res.status(201).json(comment);

  // Slack notification — new comment
  const ticket = getRow('SELECT title, client FROM tickets WHERE id = ?', [req.params.id]);
  if (ticket && ticket.client) {
    const preview = req.body.content.substring(0, 200) + (req.body.content.length > 200 ? '...' : '');
    notifySlack(ticket.client, `:speech_balloon: *New Comment on "${ticket.title}"*\n>_${author}_: ${preview}`);
  }
});

// ============ DASHBOARD LAYOUT ============

app.get('/api/dashboard/layout', authMiddleware, (req, res) => {
  const key = req.session.role === 'admin' ? 'admin' : `client_${req.session.client_name}`;
  const layout = getRow('SELECT * FROM dashboard_layouts WHERE user_id = ?', [key]);
  if (layout) {
    layout.layout = JSON.parse(layout.layout);
    res.json(layout);
  } else {
    res.json({ layout: [] });
  }
});

app.put('/api/dashboard/layout', authMiddleware, (req, res) => {
  const key = req.session.role === 'admin' ? 'admin' : `client_${req.session.client_name}`;
  const existing = getRow('SELECT * FROM dashboard_layouts WHERE user_id = ?', [key]);
  if (existing) {
    db.run("UPDATE dashboard_layouts SET layout = ?, updated_at = datetime('now') WHERE user_id = ?",
      [JSON.stringify(req.body.layout), key]);
  } else {
    db.run('INSERT INTO dashboard_layouts (id, user_id, layout) VALUES (?, ?, ?)',
      [uuidv4(), key, JSON.stringify(req.body.layout)]);
  }
  res.json({ success: true });
});

// ============ STATS ============

app.get('/api/stats', authMiddleware, (req, res) => {
  const scope = clientScope(req.session);
  const whereBase = '1=1' + scope.where;
  const p = scope.params;

  const total = allRows(`SELECT COUNT(*) as c FROM tickets WHERE ${whereBase}`, p)[0].c;
  const byStatus = allRows(`SELECT status, COUNT(*) as count FROM tickets WHERE ${whereBase} GROUP BY status`, p);
  const byPriority = allRows(`SELECT priority, COUNT(*) as count FROM tickets WHERE ${whereBase} GROUP BY priority`, p);
  const byApproval = allRows(`SELECT approval_status, COUNT(*) as count FROM tickets WHERE ${whereBase} GROUP BY approval_status`, p);
  const totalEstimated = allRows(`SELECT SUM(estimated_hours) as total FROM tickets WHERE ${whereBase}`, p)[0].total || 0;
  const totalActual = allRows(`SELECT SUM(actual_hours) as total FROM tickets WHERE ${whereBase}`, p)[0].total || 0;
  const overdue = allRows(`SELECT COUNT(*) as c FROM tickets WHERE ${whereBase} AND due_date < date('now') AND status != 'Done'`, p)[0].c;

  const result = { total, byStatus, byPriority, byApproval, totalEstimated, totalActual, overdue };

  // Only include byClient for admins
  if (req.session.role === 'admin') {
    result.byClient = allRows('SELECT client, COUNT(*) as count FROM tickets WHERE client != "" GROUP BY client');
  }

  res.json(result);
});

// ============ TIME TRACKING REPORT (Admin only) ============

app.get('/api/reports/time-tracking', authMiddleware, adminOnly, (req, res) => {
  const { client, startDate, endDate, completedStart, completedEnd } = req.query;
  let where = '1=1';
  const params = [];

  if (client) { where += ' AND t.client = ?'; params.push(client); }
  if (startDate) { where += ' AND t.created_at >= ?'; params.push(startDate); }
  if (endDate) { where += " AND t.created_at <= ? || ' 23:59:59'"; params.push(endDate); }
  if (completedStart) { where += ' AND t.completed_date >= ?'; params.push(completedStart); }
  if (completedEnd) { where += " AND t.completed_date <= ? || ' 23:59:59'"; params.push(completedEnd); }

  const tickets = allRows(`
    SELECT t.id, t.title, t.client, t.status, t.priority, t.assignee,
           t.estimated_hours, t.actual_hours, t.created_at, t.completed_date, t.due_date
    FROM tickets t
    WHERE ${where}
    ORDER BY t.created_at DESC
  `, params);

  // Summary stats
  const totalEstimated = tickets.reduce((sum, t) => sum + (t.estimated_hours || 0), 0);
  const totalActual = tickets.reduce((sum, t) => sum + (t.actual_hours || 0), 0);
  const completedTickets = tickets.filter(t => t.status === 'Done');
  const completedEstimated = completedTickets.reduce((sum, t) => sum + (t.estimated_hours || 0), 0);
  const completedActual = completedTickets.reduce((sum, t) => sum + (t.actual_hours || 0), 0);

  // By client breakdown
  const byClient = {};
  tickets.forEach(t => {
    const c = t.client || 'Unassigned';
    if (!byClient[c]) byClient[c] = { client: c, tickets: 0, estimated: 0, actual: 0, completed: 0 };
    byClient[c].tickets++;
    byClient[c].estimated += t.estimated_hours || 0;
    byClient[c].actual += t.actual_hours || 0;
    if (t.status === 'Done') byClient[c].completed++;
  });

  // By assignee breakdown
  const byAssignee = {};
  tickets.forEach(t => {
    const a = t.assignee || 'Unassigned';
    if (!byAssignee[a]) byAssignee[a] = { assignee: a, tickets: 0, estimated: 0, actual: 0, completed: 0 };
    byAssignee[a].tickets++;
    byAssignee[a].estimated += t.estimated_hours || 0;
    byAssignee[a].actual += t.actual_hours || 0;
    if (t.status === 'Done') byAssignee[a].completed++;
  });

  res.json({
    tickets,
    summary: { total: tickets.length, totalEstimated, totalActual, completedTickets: completedTickets.length, completedEstimated, completedActual },
    byClient: Object.values(byClient),
    byAssignee: Object.values(byAssignee)
  });
});

// ============ CLIENT BRANDING (Admin only) ============

app.get('/api/branding', authMiddleware, (req, res) => {
  if (req.session.role === 'admin') {
    // Admin gets all branding
    const brandings = allRows('SELECT * FROM client_branding ORDER BY client_name ASC');
    res.json(brandings);
  } else {
    // Client gets only their branding
    const branding = getRow('SELECT * FROM client_branding WHERE client_name = ?', [req.session.client_name]);
    res.json(branding || { primary_color: '#6c5ce7', secondary_color: '#a29bfe', accent_color: '#00b894' });
  }
});

app.put('/api/branding/:clientName', authMiddleware, adminOnly, (req, res) => {
  const clientName = decodeURIComponent(req.params.clientName);
  const { primary_color, secondary_color, accent_color } = req.body;

  const existing = getRow('SELECT * FROM client_branding WHERE client_name = ?', [clientName]);
  if (existing) {
    db.run("UPDATE client_branding SET primary_color = ?, secondary_color = ?, accent_color = ?, updated_at = datetime('now') WHERE client_name = ?",
      [primary_color || existing.primary_color, secondary_color || existing.secondary_color, accent_color || existing.accent_color, clientName]);
  } else {
    db.run('INSERT INTO client_branding (id, client_name, primary_color, secondary_color, accent_color) VALUES (?, ?, ?, ?, ?)',
      [uuidv4(), clientName, primary_color || '#6c5ce7', secondary_color || '#a29bfe', accent_color || '#00b894']);
  }

  const updated = getRow('SELECT * FROM client_branding WHERE client_name = ?', [clientName]);
  res.json(updated);
});

// Logo upload
app.post('/api/branding/:clientName/logo', authMiddleware, adminOnly, logoUpload.single('logo'), (req, res) => {
  const clientName = decodeURIComponent(req.params.clientName);
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // Delete old logo if exists
  const existing = getRow('SELECT * FROM client_branding WHERE client_name = ?', [clientName]);
  if (existing && existing.logo_filename) {
    const oldPath = path.join(__dirname, 'uploads', 'logos', existing.logo_filename);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }

  if (existing) {
    db.run("UPDATE client_branding SET logo_filename = ?, updated_at = datetime('now') WHERE client_name = ?",
      [req.file.filename, clientName]);
  } else {
    db.run('INSERT INTO client_branding (id, client_name, logo_filename) VALUES (?, ?, ?)',
      [uuidv4(), clientName, req.file.filename]);
  }

  res.json({ logo_filename: req.file.filename, logo_url: `/uploads/logos/${req.file.filename}` });
});

// ============ SLACK INTEGRATION ============

app.put('/api/slack/:clientName', authMiddleware, adminOnly, (req, res) => {
  const clientName = decodeURIComponent(req.params.clientName);
  const { slack_webhook_url, slack_channel_name } = req.body;

  const existing = getRow('SELECT * FROM client_branding WHERE client_name = ?', [clientName]);
  if (existing) {
    db.run("UPDATE client_branding SET slack_webhook_url = ?, slack_channel_name = ?, updated_at = datetime('now') WHERE client_name = ?",
      [slack_webhook_url || '', slack_channel_name || '', clientName]);
  } else {
    db.run('INSERT INTO client_branding (id, client_name, slack_webhook_url, slack_channel_name) VALUES (?, ?, ?, ?)',
      [uuidv4(), clientName, slack_webhook_url || '', slack_channel_name || '']);
  }

  const updated = getRow('SELECT * FROM client_branding WHERE client_name = ?', [clientName]);
  res.json(updated);
});

// Test Slack notification
app.post('/api/slack/:clientName/test', authMiddleware, adminOnly, async (req, res) => {
  const clientName = decodeURIComponent(req.params.clientName);
  try {
    await notifySlack(clientName, `:white_check_mark: *FluidTrack Connected!*\nSlack notifications are working for *${clientName}*.`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send test notification' });
  }
});

// ============ CLIENT MANAGEMENT (Admin only) ============

app.get('/api/clients', authMiddleware, adminOnly, (req, res) => {
  const users = allRows("SELECT id, username, name, client_name, email FROM users WHERE role = 'client' ORDER BY name ASC");
  const brandings = allRows('SELECT * FROM client_branding ORDER BY client_name ASC');

  // Group users by client_name to build company-level entries
  const companyMap = {};

  // First, add any branding-only companies (no users yet)
  brandings.forEach(b => {
    if (!companyMap[b.client_name]) {
      const ticketCount = allRows('SELECT COUNT(*) as c FROM tickets WHERE client = ?', [b.client_name])[0].c;
      companyMap[b.client_name] = {
        client_name: b.client_name,
        branding: b,
        ticketCount,
        logo_url: b.logo_filename ? `/uploads/logos/${b.logo_filename}` : null,
        users: [],
      };
    }
  });

  // Then add users grouped by company
  users.forEach(u => {
    const cn = u.client_name;
    if (!companyMap[cn]) {
      const branding = brandings.find(b => b.client_name === cn) || {};
      const ticketCount = allRows('SELECT COUNT(*) as c FROM tickets WHERE client = ?', [cn])[0].c;
      companyMap[cn] = {
        client_name: cn,
        branding,
        ticketCount,
        logo_url: branding.logo_filename ? `/uploads/logos/${branding.logo_filename}` : null,
        users: [],
      };
    }
    companyMap[cn].users.push(u);
  });

  res.json(Object.values(companyMap));
});

// Add new client company
app.post('/api/clients', authMiddleware, adminOnly, (req, res) => {
  const { name, email } = req.body;
  if (!name) return res.status(400).json({ error: 'Client name required' });

  // Check if this company name already has users
  const existing = getRow('SELECT * FROM users WHERE client_name = ? AND role = "client"', [name]);
  if (existing) return res.status(400).json({ error: 'Client already exists' });

  // Also check username collision
  const usernameConflict = getRow('SELECT * FROM users WHERE username = ?', [name]);
  if (usernameConflict) return res.status(400).json({ error: 'Username already taken' });

  const id = uuidv4();
  db.run('INSERT INTO users (id, username, password, name, role, client_name, email) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, name, name, name, 'client', name, email || '']);

  // Create default branding
  db.run('INSERT INTO client_branding (id, client_name) VALUES (?, ?)', [uuidv4(), name]);

  const user = getRow('SELECT id, username, name, client_name, email FROM users WHERE id = ?', [id]);
  res.status(201).json(user);
});

// Edit client company (rename, update email on primary user)
app.put('/api/clients/:id', authMiddleware, adminOnly, (req, res) => {
  const user = getRow('SELECT * FROM users WHERE id = ? AND role = "client"', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'Client not found' });

  const { name, email } = req.body;
  const oldName = user.client_name;

  if (name && name !== oldName) {
    // Check if new name conflicts with another company
    const conflict = getRow('SELECT * FROM users WHERE client_name = ? AND client_name != ?', [name, oldName]);
    if (conflict) return res.status(400).json({ error: 'A client with that name already exists' });

    // Update ALL users belonging to this company
    const companyUsers = allRows('SELECT id, username FROM users WHERE client_name = ? AND role = "client"', [oldName]);
    companyUsers.forEach(cu => {
      db.run('UPDATE users SET client_name = ? WHERE id = ?', [name, cu.id]);
      // Only rename the "primary" user (whose username matches the old company name)
      if (cu.username === oldName) {
        db.run('UPDATE users SET username = ?, password = ?, name = ? WHERE id = ?', [name, name, name, cu.id]);
      }
    });

    // Cascade: update tickets
    db.run('UPDATE tickets SET client = ? WHERE client = ?', [name, oldName]);

    // Cascade: update branding
    db.run('UPDATE client_branding SET client_name = ? WHERE client_name = ?', [name, oldName]);

    // Cascade: update active sessions
    for (const token of Object.keys(sessions)) {
      if (sessions[token].client_name === oldName) {
        sessions[token].client_name = name;
        if (sessions[token].name === oldName) sessions[token].name = name;
      }
    }
  }

  if (email !== undefined) {
    db.run('UPDATE users SET email = ? WHERE id = ?', [email, req.params.id]);
  }

  const updated = getRow('SELECT id, username, name, client_name, email FROM users WHERE id = ?', [req.params.id]);
  res.json(updated);
});

// Delete entire client company (all users, branding)
app.delete('/api/clients/:clientName', authMiddleware, adminOnly, (req, res) => {
  const clientName = decodeURIComponent(req.params.clientName);
  const companyUsers = allRows('SELECT * FROM users WHERE client_name = ? AND role = "client"', [clientName]);
  if (companyUsers.length === 0) return res.status(404).json({ error: 'Client not found' });

  // Remove branding
  db.run('DELETE FROM client_branding WHERE client_name = ?', [clientName]);
  // Remove all users for this company
  db.run('DELETE FROM users WHERE client_name = ? AND role = "client"', [clientName]);
  // Clean up sessions
  const userIds = new Set(companyUsers.map(u => u.id));
  for (const token of Object.keys(sessions)) {
    if (userIds.has(sessions[token].userId)) delete sessions[token];
  }

  res.json({ success: true });
});

// ============ CLIENT USERS (Admin only) ============

// List users for a specific company
app.get('/api/clients/:clientName/users', authMiddleware, adminOnly, (req, res) => {
  const clientName = decodeURIComponent(req.params.clientName);
  const users = allRows('SELECT id, username, name, client_name, email, created_at FROM users WHERE client_name = ? AND role = "client" ORDER BY created_at ASC', [clientName]);
  res.json(users);
});

// Add a user to a company
app.post('/api/clients/:clientName/users', authMiddleware, adminOnly, (req, res) => {
  const clientName = decodeURIComponent(req.params.clientName);
  const { username, password, name, email } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

  // Check username uniqueness
  const existing = getRow('SELECT * FROM users WHERE username = ?', [username]);
  if (existing) return res.status(400).json({ error: 'Username already taken' });

  const id = uuidv4();
  db.run('INSERT INTO users (id, username, password, name, role, client_name, email) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, username, password, name || username, 'client', clientName, email || '']);

  const user = getRow('SELECT id, username, name, client_name, email, created_at FROM users WHERE id = ?', [id]);
  res.status(201).json(user);
});

// Update a client user
app.put('/api/clients/users/:id', authMiddleware, adminOnly, (req, res) => {
  const user = getRow('SELECT * FROM users WHERE id = ? AND role = "client"', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { username, password, name, email } = req.body;

  if (username !== undefined && username !== user.username) {
    const conflict = getRow('SELECT * FROM users WHERE username = ? AND id != ?', [username, req.params.id]);
    if (conflict) return res.status(400).json({ error: 'Username already taken' });
    db.run('UPDATE users SET username = ? WHERE id = ?', [username, req.params.id]);
  }
  if (password !== undefined && password.trim()) {
    db.run('UPDATE users SET password = ? WHERE id = ?', [password, req.params.id]);
  }
  if (name !== undefined) db.run('UPDATE users SET name = ? WHERE id = ?', [name, req.params.id]);
  if (email !== undefined) db.run('UPDATE users SET email = ? WHERE id = ?', [email, req.params.id]);

  const updated = getRow('SELECT id, username, name, client_name, email, created_at FROM users WHERE id = ?', [req.params.id]);

  // Update active sessions for this user
  for (const token of Object.keys(sessions)) {
    if (sessions[token].userId === req.params.id) {
      if (name !== undefined) sessions[token].name = name;
    }
  }

  res.json(updated);
});

// Delete a client user
app.delete('/api/clients/users/:id', authMiddleware, adminOnly, (req, res) => {
  const user = getRow('SELECT * FROM users WHERE id = ? AND role = "client"', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.run('DELETE FROM users WHERE id = ?', [req.params.id]);

  // Clean up sessions
  for (const token of Object.keys(sessions)) {
    if (sessions[token].userId === req.params.id) delete sessions[token];
  }

  res.json({ success: true });
});

// ============ CSV/XLSX IMPORT (Admin only) ============

app.post('/api/import/:clientName', authMiddleware, adminOnly, csvUpload.single('file'), (req, res) => {
  const clientName = decodeURIComponent(req.params.clientName);
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const filePath = req.file.path;
  const ext = path.extname(req.file.originalname).toLowerCase();

  try {
    let rawContent = fs.readFileSync(filePath, 'utf-8');
    let rows = [];

    if (ext === '.csv') {
      rows = parseCSV(rawContent);
    } else if (ext === '.tsv') {
      rows = parseTSV(rawContent);
    } else {
      return res.status(400).json({ error: 'Unsupported file format. Use .csv or .tsv' });
    }

    if (rows.length === 0) return res.status(400).json({ error: 'No data found in file' });

    // Get headers (first row)
    const headers = rows[0].map(h => h.toLowerCase().trim());
    const dataRows = rows.slice(1).filter(r => r.some(cell => cell.trim()));

    // Auto-map columns
    const mapping = autoMapColumns(headers);

    let imported = 0;
    dataRows.forEach(row => {
      const ticket = {};
      ticket.id = uuidv4();
      ticket.title = getCellValue(row, mapping.title) || 'Untitled Import';
      ticket.description = getCellValue(row, mapping.description) || '';
      ticket.status = normalizeStatus(getCellValue(row, mapping.status));
      ticket.priority = normalizePriority(getCellValue(row, mapping.priority));
      ticket.estimated_hours = parseFloat(getCellValue(row, mapping.estimated_hours)) || 0;
      ticket.actual_hours = parseFloat(getCellValue(row, mapping.actual_hours)) || 0;
      ticket.assignee = getCellValue(row, mapping.assignee) || '';
      ticket.client = clientName;
      ticket.due_date = normalizeDate(getCellValue(row, mapping.due_date));
      ticket.approval_status = normalizeApproval(getCellValue(row, mapping.approval_status));
      ticket.tags = '[]';

      if (ticket.title && ticket.title !== 'Untitled Import') {
        db.run(
          `INSERT INTO tickets (id, title, description, status, priority, estimated_hours, actual_hours, approval_status, assignee, client, tags, due_date, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [ticket.id, ticket.title, ticket.description, ticket.status, ticket.priority,
           ticket.estimated_hours, ticket.actual_hours, ticket.approval_status, ticket.assignee,
           ticket.client, ticket.tags, ticket.due_date, imported]
        );
        imported++;
      }
    });

    db.run('INSERT INTO activity_log (id, ticket_id, action, details, user_name) VALUES (?, ?, ?, ?, ?)',
      [uuidv4(), null, 'import', `Imported ${imported} tickets for ${clientName} from ${req.file.originalname}`, req.session.name]);

    // Clean up uploaded file
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    res.json({ success: true, imported, total: dataRows.length, mapping, headers });
  } catch (err) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

// CSV parser (handles quoted fields)
function parseCSV(content) {
  const rows = [];
  let current = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"' && content[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { cell += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { current.push(cell); cell = ''; }
      else if (ch === '\n' || (ch === '\r' && content[i + 1] === '\n')) {
        current.push(cell); cell = ''; rows.push(current); current = [];
        if (ch === '\r') i++;
      } else { cell += ch; }
    }
  }
  if (cell || current.length) { current.push(cell); rows.push(current); }
  return rows;
}

function parseTSV(content) {
  return content.split('\n').filter(l => l.trim()).map(l => l.split('\t').map(c => c.trim()));
}

function autoMapColumns(headers) {
  const mapping = {};
  const maps = {
    title: ['title', 'name', 'task', 'item', 'issue', 'subject', 'ticket', 'task name', 'item name'],
    description: ['description', 'desc', 'details', 'body', 'content', 'notes', 'summary'],
    status: ['status', 'state', 'stage', 'column', 'group'],
    priority: ['priority', 'urgency', 'severity', 'importance'],
    estimated_hours: ['estimated hours', 'est hours', 'estimate', 'estimated', 'budget hours', 'planned hours', 'est.', 'hours estimate'],
    actual_hours: ['actual hours', 'actual', 'hours spent', 'time spent', 'logged hours', 'hours logged', 'tracked hours'],
    assignee: ['assignee', 'assigned to', 'owner', 'person', 'responsible', 'assigned', 'developer'],
    due_date: ['due date', 'due', 'deadline', 'target date', 'end date', 'date'],
    approval_status: ['approval', 'approval status', 'approved', 'sign off'],
  };

  for (const [field, keywords] of Object.entries(maps)) {
    const idx = headers.findIndex(h => keywords.includes(h));
    if (idx !== -1) mapping[field] = idx;
  }

  // Fallback: if no title found, use first column
  if (mapping.title === undefined && headers.length > 0) mapping.title = 0;

  return mapping;
}

function getCellValue(row, idx) {
  if (idx === undefined || idx === null || idx >= row.length) return '';
  return (row[idx] || '').trim();
}

function normalizeStatus(val) {
  if (!val) return 'Backlog';
  const v = val.toLowerCase();
  if (v.includes('done') || v.includes('complete') || v.includes('closed') || v.includes('resolved')) return 'Done';
  if (v.includes('progress') || v.includes('working') || v.includes('active')) return 'In Progress';
  if (v.includes('review') || v.includes('testing') || v.includes('qa')) return 'Review';
  if (v.includes('todo') || v.includes('to do') || v.includes('to-do') || v.includes('ready') || v.includes('planned')) return 'To Do';
  return 'Backlog';
}

function normalizePriority(val) {
  if (!val) return 'Medium';
  const v = val.toLowerCase();
  if (v.includes('urgent') || v.includes('critical') || v.includes('blocker')) return 'Urgent';
  if (v.includes('high')) return 'High';
  if (v.includes('low') || v.includes('minor')) return 'Low';
  return 'Medium';
}

function normalizeApproval(val) {
  if (!val) return 'Pending';
  const v = val.toLowerCase();
  if (v.includes('approved') || v.includes('yes') || v.includes('accepted')) return 'Approved';
  if (v.includes('rejected') || v.includes('no') || v.includes('denied')) return 'Rejected';
  if (v.includes('change')) return 'Changes Requested';
  return 'Pending';
}

function normalizeDate(val) {
  if (!val) return '';
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().split('T')[0];
  } catch { return ''; }
}

// ============ TEAM MEMBERS (Admin manages, all can read) ============

app.get('/api/team-members', authMiddleware, (req, res) => {
  const members = allRows('SELECT * FROM team_members ORDER BY name ASC');
  res.json(members);
});

app.post('/api/team-members', authMiddleware, adminOnly, (req, res) => {
  const { name, email, role, avatar_color } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  const id = uuidv4();
  db.run('INSERT INTO team_members (id, name, email, role, avatar_color) VALUES (?, ?, ?, ?, ?)',
    [id, name, email || '', role || '', avatar_color || '#6c5ce7']);
  const member = getRow('SELECT * FROM team_members WHERE id = ?', [id]);
  res.status(201).json(member);
});

app.put('/api/team-members/:id', authMiddleware, adminOnly, (req, res) => {
  const member = getRow('SELECT * FROM team_members WHERE id = ?', [req.params.id]);
  if (!member) return res.status(404).json({ error: 'Team member not found' });

  const { name, email, role, avatar_color } = req.body;
  if (name !== undefined) db.run('UPDATE team_members SET name = ? WHERE id = ?', [name, req.params.id]);
  if (email !== undefined) db.run('UPDATE team_members SET email = ? WHERE id = ?', [email, req.params.id]);
  if (role !== undefined) db.run('UPDATE team_members SET role = ? WHERE id = ?', [role, req.params.id]);
  if (avatar_color !== undefined) db.run('UPDATE team_members SET avatar_color = ? WHERE id = ?', [avatar_color, req.params.id]);

  const updated = getRow('SELECT * FROM team_members WHERE id = ?', [req.params.id]);
  res.json(updated);
});

app.delete('/api/team-members/:id', authMiddleware, adminOnly, (req, res) => {
  const member = getRow('SELECT * FROM team_members WHERE id = ?', [req.params.id]);
  if (!member) return res.status(404).json({ error: 'Team member not found' });
  db.run('DELETE FROM team_members WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// ============ CUSTOM STATUSES (Admin manages, all can read) ============

app.get('/api/statuses', authMiddleware, (req, res) => {
  const statuses = allRows('SELECT * FROM custom_statuses ORDER BY sort_order ASC');
  res.json(statuses);
});

app.post('/api/statuses', authMiddleware, adminOnly, (req, res) => {
  const { name, color, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: 'Status name required' });

  const existing = getRow('SELECT * FROM custom_statuses WHERE name = ?', [name]);
  if (existing) return res.status(400).json({ error: 'Status already exists' });

  const maxOrder = allRows('SELECT MAX(sort_order) as m FROM custom_statuses')[0].m || 0;
  const id = uuidv4();
  db.run('INSERT INTO custom_statuses (id, name, color, sort_order) VALUES (?, ?, ?, ?)',
    [id, name, color || '#6b6b80', sort_order !== undefined ? sort_order : maxOrder + 1]);
  const status = getRow('SELECT * FROM custom_statuses WHERE id = ?', [id]);
  res.status(201).json(status);
});

app.put('/api/statuses/:id', authMiddleware, adminOnly, (req, res) => {
  const status = getRow('SELECT * FROM custom_statuses WHERE id = ?', [req.params.id]);
  if (!status) return res.status(404).json({ error: 'Status not found' });

  const { name, color, sort_order } = req.body;
  if (name !== undefined) db.run('UPDATE custom_statuses SET name = ? WHERE id = ?', [name, req.params.id]);
  if (color !== undefined) db.run('UPDATE custom_statuses SET color = ? WHERE id = ?', [color, req.params.id]);
  if (sort_order !== undefined) db.run('UPDATE custom_statuses SET sort_order = ? WHERE id = ?', [sort_order, req.params.id]);

  const updated = getRow('SELECT * FROM custom_statuses WHERE id = ?', [req.params.id]);
  res.json(updated);
});

app.delete('/api/statuses/:id', authMiddleware, adminOnly, (req, res) => {
  const status = getRow('SELECT * FROM custom_statuses WHERE id = ?', [req.params.id]);
  if (!status) return res.status(404).json({ error: 'Status not found' });
  db.run('DELETE FROM custom_statuses WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

app.put('/api/statuses/reorder', authMiddleware, adminOnly, (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
  order.forEach((id, idx) => {
    db.run('UPDATE custom_statuses SET sort_order = ? WHERE id = ?', [idx, id]);
  });
  res.json({ success: true });
});

// ============ START ============

initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  🎫 Ticketing System running on port ${PORT}\n`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  // Start server anyway with error endpoint so Railway doesn't just serve static files
  app.get('/api/health', (req, res) => res.json({ error: 'DB init failed', message: err.message }));
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server started on port ${PORT} but DB init failed: ${err.message}`);
  });
});
