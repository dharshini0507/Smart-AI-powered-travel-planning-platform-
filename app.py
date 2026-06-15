
import os
import json
import sqlite3
from datetime import datetime, timedelta
from contextlib import closing

from flask import Flask, request, jsonify
from flask_cors import CORS
import jwt
from dotenv import load_dotenv

# Optional Gemini
USE_GEMINI = True
try:
    import google.generativeai as genai
except Exception:
    USE_GEMINI = False

load_dotenv()
SECRET = os.getenv("JWT_SECRET", "devsecret")
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "")
DB_PATH = os.path.join(os.path.dirname(__file__), "database.db")

app = Flask(__name__)
CORS(app)

# ----------------- DB -----------------
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with closing(get_db()) as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS users(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            email TEXT UNIQUE,
            password TEXT,
            is_admin INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS trips(
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
        );
        """)
        db.commit()
    # Ensure default admin
    with get_db() as db:
        row = db.execute("SELECT id FROM users WHERE email=?",( "admin@aitrip.app",)).fetchone()
        if not row:
            db.execute("INSERT INTO users(name,email,password,is_admin) VALUES(?,?,?,1)",
                       ("Admin","admin@aitrip.app","admin123"))
            db.commit()

# ----------------- Auth helpers -----------------
def token_for(user_row):
    payload = {
        "id": user_row["id"],
        "name": user_row["name"],
        "email": user_row["email"],
        "is_admin": user_row["is_admin"],
        "exp": datetime.utcnow() + timedelta(days=7)
    }
    return jwt.encode(payload, SECRET, algorithm="HS256")

def auth_required(fn):
    from functools import wraps
    @wraps(fn)
    def wrapper(*args, **kwargs):
        auth = request.headers.get("Authorization","")
        if not auth.startswith("Bearer "):
            return jsonify({"error":"auth required"}), 401
        token = auth.split(" ",1)[1]
        try:
            data = jwt.decode(token, SECRET, algorithms=["HS256"])
        except Exception:
            return jsonify({"error":"invalid token"}), 401
        request.user = data
        return fn(*args, **kwargs)
    return wrapper

# ----------------- Routes -----------------
@app.route("/health")
def health():
    return {"ok": True}

# Auth
@app.post("/auth/signup")
def signup():
    data = request.json or {}
    name = (data.get("name") or "").strip()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    if not (name and email and password):
        return {"error":"missing fields"}, 400
    try:
        with get_db() as db:
            db.execute("INSERT INTO users(name,email,password) VALUES(?,?,?)",(name,email,password))
            user = db.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    except sqlite3.IntegrityError:
        return {"error":"email exists"}, 400
    token = token_for(user)
    return jsonify({"token": token, "user":{"id":user["id"],"name":user["name"],"email":user["email"],"is_admin":user["is_admin"]}})

@app.post("/auth/login")
def login():
    data = request.json or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    with get_db() as db:
        user = db.execute("SELECT * FROM users WHERE email=? AND password=?", (email,password)).fetchone()
    if not user:
        return {"error":"invalid credentials"}, 401
    token = token_for(user)
    return jsonify({"token": token, "user":{"id":user["id"],"name":user["name"],"email":user["email"],"is_admin":user["is_admin"]}})

@app.post("/admin/login")
def admin_login():
    data = request.json or {}
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    with get_db() as db:
        user = db.execute("SELECT * FROM users WHERE email=? AND password=? AND is_admin=1", (email,password)).fetchone()
    if not user:
        return {"error":"invalid admin credentials"}, 401
    token = token_for(user)
    return jsonify({"token": token, "user":{"id":user["id"],"name":user["name"],"email":user["email"],"is_admin":user["is_admin"]}})

# AI plan (Gemini 2.5 Flash)
def build_prompt(payload):
    return f"""
Create a {payload['days']}-day trip plan from {payload['origin']} to {payload['destination']} ({payload['country']})
Dates: {payload['start_date']} to {payload['end_date']}. Budget: {payload['budget']} INR. Interests: {payload['interests']}.
Return JSON with keys:
summary, days:[{{day,title,morning,afternoon,evening}}]. Keep it concise and specific for India users.
"""

def make_plan(payload):
    if not (USE_GEMINI and GOOGLE_API_KEY):
        # fallback
        days = []
        for i in range(1, int(payload["days"])+1):
            days.append({"day":i,"title":f"Explore {payload['destination']}",
                         "morning":"Local breakfast & landmark",
                         "afternoon":"Museum/market",
                         "evening":"Viewpoint & dinner"})
        return {"summary": f"{payload['destination']} {payload['days']}-day plan", "days": days}
    genai.configure(api_key=GOOGLE_API_KEY)
    model = genai.GenerativeModel("gemini-2.5-flash")
    resp = model.generate_content(build_prompt(payload))
    txt = resp.text.strip()
    import re, json
    m = re.search(r'\{.*\}', txt, re.DOTALL)
    if m: txt = m.group(0)
    try:
        return json.loads(txt)
    except Exception:
        return {"summary":"Trip plan", "days":[{"day":1,"title":"Sightseeing","morning":"Old town","afternoon":"Museum","evening":"Dinner"}]}

@app.post("/ai/plan")
@auth_required
def ai_plan():
    data = request.json or {}
    payload = {
        "country": data.get("country","India"),
        "origin": data.get("origin",""),
        "destination": data.get("destination",""),
        "start_date": data.get("start_date",""),
        "end_date": data.get("end_date",""),
        "days": int(data.get("days") or 3),
        "interests": data.get("interests",""),
        "budget": int(data.get("budget") or 0)
    }
    plan = make_plan(payload)
    # Also attach origin/destination to plan for map page
    plan["origin"] = payload["origin"]; plan["destination"] = payload["destination"]
    return jsonify({"plan": plan})

# Trips
@app.post("/trips")
@auth_required
def create_trip():
    data = request.json or {}
    title = data.get("title") or f"{data.get('destination','Trip')}"
    origin = data.get("origin","")
    destination = data.get("destination","")
    start_date = data.get("start_date","")
    end_date = data.get("end_date","")
    budget = int(data.get("budget") or 0)
    plan = data.get("plan") or {}
    with get_db() as db:
        cur = db.execute("""INSERT INTO trips(user_id,title,origin,destination,start_date,end_date,budget,plan_json)
                            VALUES(?,?,?,?,?,?,?,?)""",
                         (request.user["id"], title, origin, destination, start_date, end_date, budget, json.dumps(plan, ensure_ascii=False)))
        trip_id = cur.lastrowid
        db.commit()
    return jsonify({"id": trip_id})

@app.get("/trips")
@auth_required
def list_trips():
    with get_db() as db:
        rows = db.execute("""SELECT id,title,origin,destination,start_date,end_date,budget
                             FROM trips WHERE user_id=? ORDER BY created_at DESC""", (request.user["id"],)).fetchall()
    trips = [dict(r) for r in rows]
    return jsonify({"trips": trips})

@app.get("/trips/<int:trip_id>")
@auth_required
def get_trip(trip_id):
    with get_db() as db:
        row = db.execute("""SELECT title,origin,destination,start_date,end_date,budget,plan_json
                            FROM trips WHERE id=? AND user_id=?""", (trip_id, request.user["id"])).fetchone()
    if not row:
        return {"error":"not found"}, 404
    return jsonify({
        "title": row["title"],
        "origin": row["origin"],
        "destination": row["destination"],
        "start_date": row["start_date"],
        "end_date": row["end_date"],
        "budget": row["budget"],
        "plan": json.loads(row["plan_json"] or "{}")
    })

# Admin metrics (for AdminDashboard.jsx)
@app.get("/admin/metrics")
@auth_required
def admin_metrics():
    if not request.user.get("is_admin"):
        return {"error":"forbidden"}, 403
    with get_db() as db:
        tcount, revenue = db.execute("SELECT COUNT(*), COALESCE(SUM(budget),0) FROM trips").fetchone()
        top = db.execute("""SELECT destination, COUNT(*) c FROM trips 
                            GROUP BY destination ORDER BY c DESC LIMIT 8""").fetchall()
        top_cities = [{"city": r["destination"] or "Unknown", "count": r["c"]} for r in top]
        upcoming_rows = db.execute("""SELECT u.name as user, t.title, t.destination, t.start_date 
                                      FROM trips t JOIN users u ON u.id=t.user_id 
                                      ORDER BY t.start_date DESC LIMIT 10""").fetchall()
        upcoming = [dict(r) for r in upcoming_rows]
        users = db.execute("""SELECT name, email, COUNT(t.id) trips 
                              FROM users u LEFT JOIN trips t ON t.user_id=u.id
                              GROUP BY u.id ORDER BY trips DESC LIMIT 10""").fetchall()
        user_summary = [{"name": r["name"], "email": r["email"], "trips": r["trips"]} for r in users]
    return jsonify({
        "stats": {"total_trips": tcount, "revenue": revenue, "top_city": (top_cities[0]["city"] if top_cities else "—")},
        "top_cities": top_cities,
        "upcoming": upcoming,
        "user_summary": user_summary
    })

if __name__ == "__main__":
    init_db()
    app.run(host="127.0.0.1", port=5000, debug=True)
