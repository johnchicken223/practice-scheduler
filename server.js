const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// --- In-memory data store ---
let athletes = [];
let unavailability = {}; // key: athleteId → array of slots
let coachCode = "secret123"; // change if you want

// --- Athlete APIs ---
app.get("/api/athletes", (req, res) => {
  res.json(athletes);
});

app.post("/api/athletes", (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Name required" });

  const newAthlete = { id: Date.now(), name };
  athletes.push(newAthlete);
  unavailability[newAthlete.id] = [];
  res.json(newAthlete);
});

app.put("/api/athletes/:id", (req, res) => {
  const id = Number(req.params.id);
  const athlete = athletes.find((a) => a.id === id);
  if (!athlete) return res.status(404).json({ error: "Not found" });

  athlete.name = req.body.name || athlete.name;
  res.json(athlete);
});

app.delete("/api/athletes/:id", (req, res) => {
  const id = Number(req.params.id);
  athletes = athletes.filter((a) => a.id !== id);
  delete unavailability[id];
  res.json({ success: true });
});

// --- Unavailability APIs ---
app.get("/api/athletes/:id/unavailability", (req, res) => {
  const id = Number(req.params.id);
  res.json(unavailability[id] || []);
});

app.post("/api/athletes/:id/unavailability", (req, res) => {
  const id = Number(req.params.id);
  const { day, from_min, to_min } = req.body;

  if (!day || from_min == null || to_min == null) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const entry = { id: Date.now(), day, slot_min: from_min, to_min };
  unavailability[id] = unavailability[id] || [];
  unavailability[id].push(entry);
  res.json(entry);
});

app.delete("/api/athletes/:id/unavailability/:entryId", (req, res) => {
  const id = Number(req.params.id);
  const entryId = Number(req.params.entryId);
  unavailability[id] = (unavailability[id] || []).filter(
    (u) => u.id !== entryId
  );
  res.json({ success: true });
});

app.delete("/api/athletes/:id/unavailability", (req, res) => {
  const id = Number(req.params.id);
  unavailability[id] = [];
  res.json({ success: true });
});

// --- Coach login ---
app.post("/api/coach-login", (req, res) => {
  const { code } = req.body;
  if (code === coachCode) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: "Invalid code" });
  }
});

// --- Placeholder optimization route ---
app.post("/api/optimize", (req, res) => {
  // TODO: Add real logic later
  res.json({
    totalAthletes: athletes.length,
    results_by_percent: [],
    results_by_day: {},
  });
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
