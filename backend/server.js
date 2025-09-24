// backend/server.js
const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const DB_FILE = path.join(__dirname, "scheduler.db");
const SLOT_MINUTES = 30;
const DAYS = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const COACH_CODE = "1234";

function minToLabel(min){
  const h = Math.floor(min/60);
  const m = min % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${m.toString().padStart(2,"0")} ${ampm}`;
}
function slotLabel(day, min){ return `${day} ${minToLabel(min)}`; }

const db = new sqlite3.Database(DB_FILE);
db.serialize(() => {
  db.run("PRAGMA foreign_keys = ON;");
  db.run(`CREATE TABLE IF NOT EXISTS athletes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS unavailabilities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    athlete_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    slot_min INTEGER NOT NULL,
    FOREIGN KEY(athlete_id) REFERENCES athletes(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_unavail_unique ON unavailabilities(athlete_id, day, slot_min)`);
});

// --- ATHLETES ---
app.get("/api/athletes", (req,res) => {
  db.all("SELECT id, name FROM athletes ORDER BY id", (err, rows) => {
    if(err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post("/api/athletes", (req,res) => {
  const { name } = req.body;
  if(!name) return res.status(400).json({ error: "name required" });
  db.run("INSERT INTO athletes (name) VALUES (?)", [name], function(err){
    if(err) return res.status(500).json({ error: err.message });
    res.status(201).json({ id: this.lastID, name });
  });
});

app.put("/api/athletes/:id", (req,res) => {
  const id = Number(req.params.id);
  const { name } = req.body;
  if(!name) return res.status(400).json({ error: "name required" });
  db.run("UPDATE athletes SET name = ? WHERE id = ?", [name, id], function(err){
    if(err) return res.status(500).json({ error: err.message });
    res.json({ id, name });
  });
});

app.delete("/api/athletes/:id", (req,res) => {
  const id = Number(req.params.id);
  db.run("DELETE FROM athletes WHERE id = ?", [id], function(err){
    if(err) return res.status(500).json({ error: err.message });
    res.status(204).end();
  });
});

// --- UNAVAILABILITIES ---
// return raw stored slots {id, day, slot_min}
app.get("/api/athletes/:id/unavailability", (req,res) => {
  const id = Number(req.params.id);
  db.all("SELECT id, day, slot_min FROM unavailabilities WHERE athlete_id = ? ORDER BY day, slot_min", [id], (err, rows) => {
    if(err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// add contiguous range: expands into 30-min slots (from_min inclusive, to_min exclusive)
app.post("/api/athletes/:id/unavailability", (req,res) => {
  const id = Number(req.params.id);
  const { day, from_min, to_min } = req.body;
  if(!DAYS.includes(day)) return res.status(400).json({ error: "invalid day" });
  if(typeof from_min !== "number" || typeof to_min !== "number") return res.status(400).json({ error: "from_min and to_min required" });
  if(to_min <= from_min) return res.status(400).json({ error: "to_min must be greater than from_min" });

  db.serialize(() => {
    const del = db.prepare("DELETE FROM unavailabilities WHERE athlete_id = ? AND day = ? AND slot_min >= ? AND slot_min < ?");
    del.run(id, day, from_min, to_min);
    del.finalize();

    const ins = db.prepare("INSERT OR IGNORE INTO unavailabilities (athlete_id, day, slot_min) VALUES (?, ?, ?)");
    for(let m = from_min; m < to_min; m += SLOT_MINUTES){
      ins.run(id, day, m);
    }
    ins.finalize();

    res.status(201).json({ message: "saved" });
  });
});

// delete a single stored slot by id
app.delete("/api/athletes/:id/unavailability/:entryId", (req,res) => {
  const id = Number(req.params.id);
  const entryId = Number(req.params.entryId);
  db.run("DELETE FROM unavailabilities WHERE id = ? AND athlete_id = ?", [entryId, id], function(err){
    if(err) return res.status(500).json({ error: err.message });
    res.status(204).end();
  });
});

// clear all for athlete
app.delete("/api/athletes/:id/unavailability", (req,res) => {
  const id = Number(req.params.id);
  db.run("DELETE FROM unavailabilities WHERE athlete_id = ?", [id], function(err){
    if(err) return res.status(500).json({ error: err.message });
    res.status(204).end();
  });
});

// --- COACH LOGIN ---
app.post("/api/coach-login", (req,res) => {
  const { code } = req.body;
  if(code === COACH_CODE) res.json({ success: true });
  else res.status(403).json({ error: "invalid code" });
});

// --- OPTIMIZE ---
// Request body: { start_min, end_min, days: [ 'Mon',...'] }
// Returns { totalAthletes, results_by_percent: [...], results_by_day: { Mon: [...], ... } }
app.post("/api/optimize", (req,res) => {
  const start_min = typeof req.body.start_min === "number" ? req.body.start_min : 6*60;
  const end_min = typeof req.body.end_min === "number" ? req.body.end_min : 22*60;
  const slot_resolution = 30;
  const days = Array.isArray(req.body.days) && req.body.days.length ? req.body.days : DAYS;
  if(end_min <= start_min) return res.status(400).json({ error: "invalid time range" });

  db.get("SELECT COUNT(*) AS cnt FROM athletes", (err,row) => {
    if(err) return res.status(500).json({ error: err.message });
    const totalAthletes = row.cnt;
    if(totalAthletes === 0) return res.status(400).json({ error: "no athletes registered" });

    const slotMap = {};
    for(const d of days){
      for(let m = start_min; m < end_min; m += slot_resolution){
        const key = `${d}|${m}`;
        slotMap[key] = { day: d, slot_min: m, unavailable: 0 };
      }
    }

    const placeholders = days.map(()=>"?").join(",");
    const sql = `
      SELECT day, slot_min, COUNT(DISTINCT athlete_id) AS cnt
      FROM unavailabilities
      WHERE day IN (${placeholders}) AND slot_min >= ? AND slot_min < ?
      GROUP BY day, slot_min
    `;
    const params = [...days, start_min, end_min];
    db.all(sql, params, (err2, rows) => {
      if(err2) return res.status(500).json({ error: err2.message });
      for(const r of rows){
        const key = `${r.day}|${r.slot_min}`;
        if(slotMap[key]) slotMap[key].unavailable = r.cnt;
      }

      const flat = Object.values(slotMap).map(s => {
        const available = totalAthletes - s.unavailable;
        const percentage = Math.round((available / totalAthletes) * 10000) / 100; // two decimals
        return {
          day: s.day,
          slot_min: s.slot_min,
          label: slotLabel(s.day, s.slot_min),
          available_count: available,
          percentage
        };
      });

      // global sort by percentage desc, then time asc
      const results_by_percent = flat.slice().sort((a,b) => {
        if(b.percentage !== a.percentage) return b.percentage - a.percentage;
        if(b.available_count !== a.available_count) return b.available_count - a.available_count;
        if(a.day !== b.day) return DAYS.indexOf(a.day) - DAYS.indexOf(b.day);
        return a.slot_min - b.slot_min;
      });

      // grouped by day, each day sorted by percentage desc
      const results_by_day = {};
      for(const d of DAYS) results_by_day[d] = [];
      for(const s of flat) results_by_day[s.day].push(s);
      for(const d of DAYS) results_by_day[d].sort((a,b) => {
        if(b.percentage !== a.percentage) return b.percentage - a.percentage;
        return a.slot_min - b.slot_min;
      });

      res.json({ totalAthletes, results_by_percent, results_by_day });
    });
  });
});

const PORT = process.env.PORT || 5000;

// Serve frontend build
app.use(express.static(path.join(__dirname, "../frontend/build")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/build", "index.html"));
});

// Serve frontend build
app.use(express.static(path.join(__dirname, "build")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "build", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Backend running on port ${PORT}`);
});
