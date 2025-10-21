// backend/server.js
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const path = require("path");

const app = express();
app.use(cors({
  origin: "https://practice-scheduler.onrender.com"
}));
app.use(express.json());

const SLOT_MINUTES = 30;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const COACH_CODE = "1234";

// --- DATABASE CONNECTION ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS athletes (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS unavailabilities (
      id SERIAL PRIMARY KEY,
      athlete_id INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      slot_min INTEGER NOT NULL,
      UNIQUE(athlete_id, day, slot_min)
    )
  `);
}
initDb().then(() => console.log("✅ Database initialized")).catch(console.error);

// --- HELPERS ---
function minToLabel(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${m.toString().padStart(2, "0")} ${ampm}`;
}
function slotLabel(day, min) {
  return `${day} ${minToLabel(min)}`;
}

// --- ATHLETES ---
app.get("/api/athletes", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name FROM athletes ORDER BY id");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/athletes", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    const result = await pool.query("INSERT INTO athletes (name) VALUES ($1) RETURNING id, name", [name]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/athletes/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    await pool.query("UPDATE athletes SET name = $1 WHERE id = $2", [name, id]);
    res.json({ id, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/athletes/:id", async (req, res) => {
  const id = Number(req.params.id);
  try {
    await pool.query("DELETE FROM athletes WHERE id = $1", [id]);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- UNAVAILABILITIES ---
app.get("/api/athletes/:id/unavailability", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const result = await pool.query(
      "SELECT id, day, slot_min FROM unavailabilities WHERE athlete_id = $1 ORDER BY day, slot_min",
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/athletes/:id/unavailability", async (req, res) => {
  const id = Number(req.params.id);
  const { day, from_min, to_min } = req.body;
  if (!DAYS.includes(day)) return res.status(400).json({ error: "invalid day" });
  if (typeof from_min !== "number" || typeof to_min !== "number")
    return res.status(400).json({ error: "from_min and to_min required" });
  if (to_min <= from_min) return res.status(400).json({ error: "to_min must be greater than from_min" });

  try {
    await pool.query(
      "DELETE FROM unavailabilities WHERE athlete_id = $1 AND day = $2 AND slot_min >= $3 AND slot_min < $4",
      [id, day, from_min, to_min]
    );

    const insertPromises = [];
    for (let m = from_min; m < to_min; m += SLOT_MINUTES) {
      insertPromises.push(
        pool.query(
          "INSERT INTO unavailabilities (athlete_id, day, slot_min) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
          [id, day, m]
        )
      );
    }
    await Promise.all(insertPromises);
    res.status(201).json({ message: "saved" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/athletes/:id/unavailability/:entryId", async (req, res) => {
  const id = Number(req.params.id);
  const entryId = Number(req.params.entryId);
  try {
    await pool.query("DELETE FROM unavailabilities WHERE id = $1 AND athlete_id = $2", [entryId, id]);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/athletes/:id/unavailability", async (req, res) => {
  const id = Number(req.params.id);
  try {
    await pool.query("DELETE FROM unavailabilities WHERE athlete_id = $1", [id]);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- COACH LOGIN ---
app.post("/api/coach-login", (req, res) => {
  const { code } = req.body;
  if (code === COACH_CODE) res.json({ success: true });
  else res.status(403).json({ error: "invalid code" });
});

// --- OPTIMIZE ---
app.post("/api/optimize", async (req, res) => {
  const start_min = typeof req.body.start_min === "number" ? req.body.start_min : 6 * 60;
  const end_min = typeof req.body.end_min === "number" ? req.body.end_min : 22 * 60;
  const slot_resolution = 30;
  const days = Array.isArray(req.body.days) && req.body.days.length ? req.body.days : DAYS;
  if (end_min <= start_min) return res.status(400).json({ error: "invalid time range" });

  try {
    const countResult = await pool.query("SELECT COUNT(*) AS cnt FROM athletes");
    const totalAthletes = Number(countResult.rows[0].cnt);
    if (totalAthletes === 0) return res.status(400).json({ error: "no athletes registered" });

    const slotMap = {};
    for (const d of days) {
      for (let m = start_min; m < end_min; m += slot_resolution) {
        const key = `${d}|${m}`;
        slotMap[key] = { day: d, slot_min: m, unavailable: 0 };
      }
    }

    const placeholders = days.map((_, i) => `$${i + 1}`).join(",");
    const sql = `
      SELECT day, slot_min, COUNT(DISTINCT athlete_id) AS cnt
      FROM unavailabilities
      WHERE day IN (${placeholders}) AND slot_min >= $${days.length + 1} AND slot_min < $${days.length + 2}
      GROUP BY day, slot_min
    `;
    const params = [...days, start_min, end_min];
    const data = await pool.query(sql, params);

    for (const r of data.rows) {
      const key = `${r.day}|${r.slot_min}`;
      if (slotMap[key]) slotMap[key].unavailable = r.cnt;
    }

    const flat = Object.values(slotMap).map((s) => {
      const available = totalAthletes - s.unavailable;
      const percentage = Math.round((available / totalAthletes) * 10000) / 100;
      return {
        day: s.day,
        slot_min: s.slot_min,
        label: slotLabel(s.day, s.slot_min),
        available_count: available,
        percentage,
      };
    });

    const results_by_percent = flat.slice().sort((a, b) => {
      if (b.percentage !== a.percentage) return b.percentage - a.percentage;
      if (b.available_count !== a.available_count) return b.available_count - a.available_count;
      if (a.day !== b.day) return DAYS.indexOf(a.day) - DAYS.indexOf(b.day);
      return a.slot_min - b.slot_min;
    });

    const results_by_day = {};
    for (const d of DAYS) results_by_day[d] = [];
    for (const s of flat) results_by_day[s.day].push(s);
    for (const d of DAYS)
      results_by_day[d].sort((a, b) => (b.percentage !== a.percentage ? b.percentage - a.percentage : a.slot_min - b.slot_min));

    res.json({ totalAthletes, results_by_percent, results_by_day });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- SERVE FRONTEND ---
const PORT = process.env.PORT || 5000;
app.use(express.static(path.join(__dirname, "build")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "build", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => console.log(`✅ Backend running on port ${PORT}`));
