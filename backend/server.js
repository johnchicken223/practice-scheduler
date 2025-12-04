console.log("DATABASE_URL:", JSON.stringify(process.env.DATABASE_URL));

// backend/server.js
import express from "express";
import cors from "cors";
import pg from "pg";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;
const { Pool } = pg;

// --- DATABASE CONNECTION ---
const connectionString = process.env.DATABASE_URL ? process.env.DATABASE_URL.trim() : undefined;
const pool = new pg.Pool({
  connectionString,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// --- CONSTANTS ---
const SLOT_MINUTES = 30;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const COACH_CODE = "1234";

// --- MIDDLEWARE ---
app.use(cors({
  origin: [
    "http://localhost:3000",
    "http://127.0.0.1:5173",
    "https://practice-scheduler.onrender.com",
    "https://practice-scheduler-1.onrender.com"   // <-- add this
  ],
  methods: ["GET", "POST", "PUT", "DELETE"],
}));
app.use(express.json());

// --- FRONTEND SERVE ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "build")));

// --- DATABASE INIT ---
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS athletes (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS unavailabilities (
      id SERIAL PRIMARY KEY,
      athlete_id INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      slot_min INTEGER NOT NULL,
      UNIQUE (athlete_id, day, slot_min)
    );
  `);
  console.log("✅ PostgreSQL connected & tables initialized");
}
initDb().catch(err => console.error("❌ DB init failed:", err));

// --- ATHLETES ---
app.get("/api/athletes", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name FROM athletes ORDER BY id ASC");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error fetching athletes" });
  }
});

app.post("/api/athletes", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    const result = await pool.query(
      "INSERT INTO athletes (name) VALUES ($1) RETURNING id, name",
      [name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error creating athlete" });
  }
});

app.put("/api/athletes/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    await pool.query("UPDATE athletes SET name=$1 WHERE id=$2", [name, id]);
    res.json({ id, name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error updating athlete" });
  }
});

app.delete("/api/athletes/:id", async (req, res) => {
  const id = Number(req.params.id);
  try {
    await pool.query("DELETE FROM athletes WHERE id=$1", [id]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error deleting athlete" });
  }
});

// --- UNAVAILABILITY ---
app.get("/api/athletes/:id/unavailability", async (req, res) => {
  const id = Number(req.params.id);
  try {
    const result = await pool.query(
      "SELECT id, day, slot_min FROM unavailabilities WHERE athlete_id=$1 ORDER BY day, slot_min",
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error fetching unavailability" });
  }
});

app.post("/api/athletes/:id/unavailability", async (req, res) => {
  const id = Number(req.params.id);
  const { day, from_min, to_min } = req.body;

  if (!DAYS.includes(day)) return res.status(400).json({ error: "invalid day" });
  if (typeof from_min !== "number" || typeof to_min !== "number")
    return res.status(400).json({ error: "from_min and to_min required" });

  try {
    await pool.query(
      "DELETE FROM unavailabilities WHERE athlete_id=$1 AND day=$2 AND slot_min >= $3 AND slot_min < $4",
      [id, day, from_min, to_min]
    );

    const values = [];
    for (let m = from_min; m < to_min; m += SLOT_MINUTES) {
      values.push(`(${id}, '${day}', ${m})`);
    }

    if (values.length) {
      await pool.query(
        `INSERT INTO unavailabilities (athlete_id, day, slot_min) VALUES ${values.join(",")} ON CONFLICT DO NOTHING`
      );
    }

    res.status(201).json({ message: "saved" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error saving unavailability" });
  }
});

app.delete("/api/athletes/:athleteId/unavailability/:entryId", async (req, res) => {
  const athleteId = Number(req.params.athleteId);
  const entryId = Number(req.params.entryId);

  try {
    await pool.query("DELETE FROM unavailabilities WHERE id=$1 AND athlete_id=$2", [
      entryId,
      athleteId
    ]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error deleting slot" });
  }
});

// --- OPTIMIZE ---
app.post("/api/optimize", async (req, res) => {
  const start_min = typeof req.body.start_min === "number" ? req.body.start_min : 6 * 60;
  const end_min = typeof req.body.end_min === "number" ? req.body.end_min : 22 * 60;
  const days = Array.isArray(req.body.days) && req.body.days.length ? req.body.days : DAYS;

  try {
    const totalAthletesResult = await pool.query("SELECT COUNT(*) AS cnt FROM athletes");
    const totalAthletes = parseInt(totalAthletesResult.rows[0].cnt);
    if (totalAthletes === 0)
      return res.status(400).json({ error: "no athletes registered" });

    const placeholders = days.map((_, i) => `$${i + 1}`).join(",");
    const sql = `
      SELECT day, slot_min, COUNT(DISTINCT athlete_id) AS cnt
      FROM unavailabilities
      WHERE day IN (${placeholders})
      AND slot_min >= $${days.length + 1} AND slot_min < $${days.length + 2}
      GROUP BY day, slot_min
    `;
    const params = [...days, start_min, end_min];
    const rows = (await pool.query(sql, params)).rows;

    const slotMap = {};
    for (const d of days) {
      for (let m = start_min; m < end_min; m += SLOT_MINUTES) {
        const key = `${d}|${m}`;
        slotMap[key] = { day: d, slot_min: m, unavailable: 0 };
      }
    }
    for (const r of rows) {
      const key = `${r.day}|${r.slot_min}`;
      if (slotMap[key]) slotMap[key].unavailable = r.cnt;
    }

    const flat = Object.values(slotMap).map(s => {
      const available = totalAthletes - s.unavailable;
      const percentage = Math.round((available / totalAthletes) * 10000) / 100;
      return {
        day: s.day,
        slot_min: s.slot_min,
        label: `${s.day} ${s.slot_min}`,
        available_count: available,
        percentage
      };
    });

    const results_by_percent = flat.sort(
      (a, b) => b.percentage - a.percentage || a.slot_min - b.slot_min
    );

    const results_by_day = {};
    for (const d of DAYS) results_by_day[d] = flat.filter(s => s.day === d);

    res.json({ totalAthletes, results_by_percent, results_by_day });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error optimizing schedule" });
  }
});

// --- FRONTEND FALLBACK ---
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "build", "index.html"));
});

// --- START SERVER ---
app.listen(PORT, "0.0.0.0", () =>
  console.log(`✅ Server running on port ${PORT}`)
);
