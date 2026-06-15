const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const path = require('path');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const SECRET = process.env.JWT_SECRET || 'devsecret';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

const DB_PATH = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(DB_PATH);

// Initialize DB
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT UNIQUE,
    password TEXT,
    is_admin INTEGER DEFAULT 0
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS trips(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    title TEXT,
    origin TEXT,
    destination TEXT,
    start_date TEXT,
    end_date TEXT,
    budget INTEGER DEFAULT 0,
    plan_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  // Ensure default admin
  db.get("SELECT id FROM users WHERE email=?", ["admin@aitrip.app"], (err, row) => {
    if (!row) {
      db.run("INSERT INTO users(name,email,password,is_admin) VALUES(?,?,?,1)",
        ["Admin", "admin@aitrip.app", "admin123"]);
    }
  });
});

// Helper for DB queries
function runQuery(query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function getQuery(query, params = []) {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function allQuery(query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Auth Middleware
function authRequired(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'auth required' });
  }
  const token = auth.split(' ')[1];
  try {
    const data = jwt.verify(token, SECRET);
    req.user = data;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid token' });
  }
}

function tokenFor(user) {
  const payload = {
    id: user.id,
    name: user.name,
    email: user.email,
    is_admin: user.is_admin
  };
  return jwt.sign(payload, SECRET, { expiresIn: '7d' });
}

// Routes
app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/auth/signup', async (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  if (!name || !email || !password) return res.status(400).json({ error: 'missing fields' });

  try {
    await runQuery("INSERT INTO users(name,email,password) VALUES(?,?,?)", [name, email, password]);
    const user = await getQuery("SELECT * FROM users WHERE email=?", [email]);
    const token = tokenFor(user);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, is_admin: user.is_admin } });
  } catch (e) {
    if (e.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'email exists' });
    }
    res.status(500).json({ error: e.message });
  }
});

app.post('/auth/login', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const user = await getQuery("SELECT * FROM users WHERE email=? AND password=?", [email, password]);
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  const token = tokenFor(user);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, is_admin: user.is_admin } });
});

app.post('/admin/login', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const user = await getQuery("SELECT * FROM users WHERE email=? AND password=? AND is_admin=1", [email, password]);
  if (!user) return res.status(401).json({ error: 'invalid admin credentials' });
  const token = tokenFor(user);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, is_admin: user.is_admin } });
});

// AI Plan
const buildPrompt = (p) => `
You are an elite, highly professional travel concierge. Create a comprehensive, spectacular ${p.days}-day trip plan from ${p.origin} to ${p.destination} (${p.country}).
Dates: ${p.start_date} to ${p.end_date}. Budget: ${p.budget} INR. Interests: ${p.interests}.

CRITICAL INSTRUCTIONS:
- Provide deeply engaging, detailed, and descriptive paragraphs for every activity.
- Include precise, real-world location names, famous landmarks, and highly specific restaurant/hotel recommendations.
- Emphasize rich cultural insights, exact transit advice, and hidden gems.
- The output MUST be strictly valid JSON matching this exact schema:
{
  "summary": "A captivating, multi-sentence overview of the trip emphasizing the unique atmosphere and professional planning.",
  "budget_breakdown": {
    "accommodation": "Detailed Cost Estimate (INR)",
    "food": "Detailed Cost Estimate (INR)",
    "transport": "Detailed Cost Estimate (INR)",
    "activities": "Detailed Cost Estimate (INR)"
  },
  "packing_list": ["Specific Item 1 with reason", "Specific Item 2 with reason", "Specific Item 3 with reason", "Specific Item 4 with reason"],
  "days": [
    {
      "day": 1,
      "title": "A highly descriptive, creative theme for the day",
      "morning": { "activity": "A vivid, multi-sentence description of the morning activity, including exact locations, atmospheric details, and what makes it special.", "cost_estimate": "INR X", "insider_tip": "A deeply specific, expert tip (e.g., 'Stand on the left side of the ferry for the best views', 'Order the secret off-menu item')." },
      "afternoon": { "activity": "A vivid, multi-sentence description of the afternoon activity.", "cost_estimate": "INR X", "insider_tip": "A deeply specific expert tip." },
      "evening": { "activity": "A vivid, multi-sentence description of the evening activity.", "cost_estimate": "INR X", "insider_tip": "A deeply specific expert tip." }
    }
  ],
  "cultural_tips": ["In-depth Tip 1", "In-depth Tip 2", "In-depth Tip 3"],
  "hotels": ["Premium Hotel 1 with location/vibe", "Boutique Hotel 2 with location/vibe"],
  "restaurants": ["Top Restaurant 1 (Cuisine/Dish)", "Top Restaurant 2 (Cuisine/Dish)"]
}
`;

app.post('/ai/plan', authRequired, async (req, res) => {
  const p = {
    country: req.body.country || 'India',
    origin: req.body.origin || '',
    destination: req.body.destination || '',
    start_date: req.body.start_date || '',
    end_date: req.body.end_date || '',
    days: parseInt(req.body.days) || 3,
    interests: req.body.interests || '',
    budget: parseInt(req.body.budget) || 0
  };

  let plan;
  if (!OPENAI_API_KEY) {
    // Fallback if no key
    plan = { 
      summary: `${p.destination} ${p.days}-day plan (Mock Data - No API Key Provided)`, 
      budget_breakdown: { accommodation: "0", food: "0", transport: "0", activities: "0" },
      packing_list: ["Camera", "Sunscreen", "Comfortable Shoes"],
      days: Array.from({length: p.days}, (_, i) => ({
        day: i + 1,
        title: `Explore ${p.destination}`,
        morning: { activity: "Local breakfast & landmark", cost_estimate: "500", insider_tip: "Go early to avoid crowds" },
        afternoon: { activity: "Museum/market", cost_estimate: "1000", insider_tip: "Bargain at the market" },
        evening: { activity: "Viewpoint & dinner", cost_estimate: "1500", insider_tip: "Book dinner in advance" }
      })),
      cultural_tips: ["Respect local customs", "Learn basic greetings"],
      hotels: ["Standard Hotel"],
      restaurants: ["Local Cafe"]
    };
  } else {
    try {
      const openai = new OpenAI({ 
        apiKey: OPENAI_API_KEY,
        baseURL: 'https://integrate.api.nvidia.com/v1'
      });
      const response = await openai.chat.completions.create({
        model: "meta/llama-3.1-8b-instruct",
        messages: [
          { role: "system", content: "You are an expert JSON-only travel planner API. Only output valid JSON without markdown wrapping." },
          { role: "user", content: buildPrompt(p) }
        ],
        response_format: { type: "json_object" }
      });
      
      const text = response.choices[0].message.content;
      plan = JSON.parse(text);
    } catch (e) {
      console.error("OpenAI Error:", e);
      return res.status(500).json({ error: "Failed to generate plan from OpenAI." });
    }
  }

  plan.origin = p.origin;
  plan.destination = p.destination;
  res.json({ plan });
});

app.post('/trips', authRequired, async (req, res) => {
  const title = req.body.title || `${req.body.destination || 'Trip'}`;
  const origin = req.body.origin || '';
  const destination = req.body.destination || '';
  const start_date = req.body.start_date || '';
  const end_date = req.body.end_date || '';
  const budget = parseInt(req.body.budget) || 0;
  const plan = req.body.plan || {};

  try {
    const result = await runQuery(
      `INSERT INTO trips(user_id,title,origin,destination,start_date,end_date,budget,plan_json)
       VALUES(?,?,?,?,?,?,?,?)`,
      [req.user.id, title, origin, destination, start_date, end_date, budget, JSON.stringify(plan)]
    );
    res.json({ id: result.lastID });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/trips', authRequired, async (req, res) => {
  try {
    const trips = await allQuery(
      `SELECT id,title,origin,destination,start_date,end_date,budget
       FROM trips WHERE user_id=? ORDER BY created_at DESC`, [req.user.id]
    );
    res.json({ trips });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/trips/:id', authRequired, async (req, res) => {
  try {
    const row = await getQuery(
      `SELECT title,origin,destination,start_date,end_date,budget,plan_json
       FROM trips WHERE id=? AND user_id=?`, [req.params.id, req.user.id]
    );
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json({
      title: row.title,
      origin: row.origin,
      destination: row.destination,
      start_date: row.start_date,
      end_date: row.end_date,
      budget: row.budget,
      plan: JSON.parse(row.plan_json || '{}')
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/metrics', authRequired, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'forbidden' });
  try {
    const tcountRow = await getQuery("SELECT COUNT(*) as c, COALESCE(SUM(budget),0) as revenue FROM trips");
    const top = await allQuery("SELECT destination, COUNT(*) as c FROM trips GROUP BY destination ORDER BY c DESC LIMIT 8");
    const top_cities = top.map(r => ({ city: r.destination || 'Unknown', count: r.c }));
    const upcoming = await allQuery(`
      SELECT u.name as user, t.title, t.destination, t.start_date 
      FROM trips t JOIN users u ON u.id=t.user_id 
      ORDER BY t.start_date DESC LIMIT 10
    `);
    const users = await allQuery(`
      SELECT name, email, COUNT(t.id) as trips 
      FROM users u LEFT JOIN trips t ON t.user_id=u.id
      GROUP BY u.id ORDER BY trips DESC LIMIT 10
    `);

    res.json({
      stats: { total_trips: tcountRow.c, revenue: tcountRow.revenue, top_city: top_cities.length ? top_cities[0].city : '—' },
      top_cities,
      upcoming,
      user_summary: users
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
