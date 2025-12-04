// frontend/src/App.js
import React, { useEffect, useState } from "react";
import axios from "axios";
import "./index.css";

const API = "https://practice-scheduler-1.onrender.com/api";

async function fetchAthletes() {
  const res = await fetch(`${API}/athletes`);
  const data = await res.json();
  console.log("Fetched athletes:", data);
}

const DAYS = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const SLOT_MINUTES = 30;

function generateTimes() {
  const times = [];
  for (let m = 0; m < 24*60; m += SLOT_MINUTES) {
    const h = Math.floor(m/60);
    const mm = m % 60;
    const ampm = h >= 12 ? "PM" : "AM";
    const hh = ((h + 11) % 12) + 1;
    times.push({ min: m, label: `${hh}:${mm.toString().padStart(2,"0")} ${ampm}` });
  }
  return times;
}
const ALL_TIMES = generateTimes();

export default function App(){
  const [tab, setTab] = useState("athlete"); // "athlete" | "coach"
  const [athletes, setAthletes] = useState([]);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState("");

  // athlete selected to manage unavailability
  const [selectedAthlete, setSelectedAthlete] = useState(null);
  const [unavailSlots, setUnavailSlots] = useState([]); // raw {id, day, slot_min}

  // inputs for unavailability
  const [day, setDay] = useState("Mon");
  const [fromMin, setFromMin] = useState(18*60); // default 6:00 PM? adjust as you like
  const [toMin, setToMin] = useState(19*60);

  // coach auth + filters
  const [coachCode, setCoachCode] = useState("");
  const [coachAuthed, setCoachAuthed] = useState(false);
  const [selectedDays, setSelectedDays] = useState(() => { const m={}; for(const d of DAYS) m[d]=true; return m; });
  const [minPercentFilter, setMinPercentFilter] = useState(0);
  const [coachEarliest, setCoachEarliest] = useState(6*60);
  const [coachLatest, setCoachLatest] = useState(22*60);
  const [coachResults, setCoachResults] = useState(null);

  useEffect(()=>{ fetchAthletes(); }, []);

  // --- Athlete APIs ---
  async function fetchAthletes(){
    try{
      const r = await axios.get(`${API}/athletes`);
      setAthletes(r.data);
    }catch(e){ console.error(e); alert("Error fetching athletes"); }
  }

  async function createAthlete(){
    if(!newName.trim()) return alert("Enter a name");
    try {
      const r = await axios.post(`${API}/athletes`, { name: newName.trim() });
      setNewName("");
      fetchAthletes();
    } catch(e){ alert("Error creating athlete: " + (e.response?.data?.error || e.message)); }
  }

  async function saveEdit(){
    if(!editingName.trim()) return alert("Name required");
    try {
      await axios.put(`${API}/athletes/${editingId}`, { name: editingName.trim() });
      setEditingId(null);
      setEditingName("");
      fetchAthletes();
    } catch(e){ alert("Error renaming: " + (e.response?.data?.error || e.message)); }
  }

  async function deleteAthlete(id){
    if(!window.confirm("Delete athlete and all their unavailability?")) return;
    try {
      await axios.delete(`${API}/athletes/${id}`);
      if(selectedAthlete === id){ setSelectedAthlete(null); setUnavailSlots([]); }
      fetchAthletes();
    } catch(e){ alert("Error deleting: " + (e.response?.data?.error || e.message)); }
  }

  // unavailability
  async function fetchUnavailability(aid){
    if(!aid) return setUnavailSlots([]);
    try {
      const r = await axios.get(`${API}/athletes/${aid}/unavailability`);
      setUnavailSlots(r.data);
    } catch(e){ console.error(e); alert("Error fetching unavailability"); }
  }

  async function addUnavailability(){
    if(!selectedAthlete) return alert("Select an athlete first");
    if(toMin <= fromMin) return alert("End must be after start");
    try {
      await axios.post(`${API}/athletes/${selectedAthlete}/unavailability`, { day, from_min: fromMin, to_min: toMin });
      fetchUnavailability(selectedAthlete);
    } catch(e){ alert("Error saving unavailability: " + (e.response?.data?.error || e.message)); }
  }

  async function deleteSlot(entryId){
    if(!selectedAthlete) return;
    try {
      await axios.delete(`${API}/athletes/${selectedAthlete}/unavailability/${entryId}`);
      fetchUnavailability(selectedAthlete);
    } catch(e){ alert("Error deleting slot"); }
  }

  async function clearAll(){
    if(!selectedAthlete) return;
    if(!window.confirm("Clear all unavailability for this athlete?")) return;
    try {
      await axios.delete(`${API}/athletes/${selectedAthlete}/unavailability`);
      fetchUnavailability(selectedAthlete);
    } catch(e){ alert("Error clearing"); }
  }

  // --- Coach actions ---
  async function coachLogin(){
    try {
      const r = await axios.post(`${API}/coach-login`, { code: coachCode });
      setCoachAuthed(true);
      setTab("coach");
    } catch(e){ alert("Invalid coach code"); }
  }

  function toggleDay(dayKey){
    setSelectedDays(prev => ({ ...prev, [dayKey]: !prev[dayKey] }));
  }

  async function applyCoachFilters(){
    const days = Object.keys(selectedDays).filter(d => selectedDays[d]);
    if(days.length === 0) return alert("Select at least one day");
    try {
      const payload = { start_min: coachEarliest, end_min: coachLatest, days };
      const r = await axios.post(`${API}/optimize`, payload);
      // r.data has totalAthletes, results_by_percent, results_by_day
      // apply minPercentFilter client-side to both sets shown
      setCoachResults(r.data);
    } catch(e){ alert("Error computing results: " + (e.response?.data?.error || e.message)); }
  }

  // helpers
  function formatMinLabel(min){
    const h = Math.floor(min/60); const m = min%60;
    const ampm = h >= 12 ? "PM" : "AM"; const hh = ((h+11)%12)+1;
    return `${hh}:${m.toString().padStart(2,"0")} ${ampm}`;
  }

  // UI rendering
  return (
    <div style={{ padding:20, fontFamily: "Segoe UI, Roboto, Arial", maxWidth:1000, margin:"0 auto" }}>
      <header style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <h1>Practice Scheduler</h1>
        <div>
          <button onClick={()=>{ setTab("athlete"); setCoachAuthed(false); }}>Athlete Tab</button>
          <button onClick={()=>{ setTab("coach"); }}>Coach Tab</button>
        </div>
      </header>

      {tab === "athlete" && (
        <section style={{ marginTop:16 }}>
          <h2>Athlete — manage players & unavailability</h2>
          <div style={{ display:"flex", gap:20 }}>
            <div style={{ minWidth:320 }}>
              <h3>Players</h3>

              <div style={{ marginBottom:12 }}>
                <input placeholder="New athlete name" value={newName} onChange={e=>setNewName(e.target.value)} />
                <button onClick={createAthlete} style={{ marginLeft:8 }}>Add</button>
              </div>

              <ul>
                {athletes.map(a => (
                  <li key={a.id} style={{ marginBottom:8 }}>
                    <button onClick={() => { setSelectedAthlete(a.id); fetchUnavailability(a.id); }} style={{ marginRight:8 }}>{a.name}</button>
                    <button onClick={() => { setEditingId(a.id); setEditingName(a.name); }} style={{ marginRight:6 }}>Edit</button>
                    <button onClick={() => deleteAthlete(a.id)}>Delete</button>
                    <div style={{ fontSize:11, color:"#666" }}>id {a.id}</div>
                  </li>
                ))}
              </ul>
            </div>

            <div style={{ flex:1 }}>
              <h3>{ selectedAthlete ? `Selected athlete id ${selectedAthlete}` : "Select an athlete to edit or add unavailability" }</h3>

              {editingId && editingId === selectedAthlete ? (
                <div style={{ marginBottom:10 }}>
                  <input value={editingName} onChange={e=>setEditingName(e.target.value)} />
                  <button onClick={saveEdit} style={{ marginLeft:8 }}>Save</button>
                  <button onClick={()=>{ setEditingId(null); setEditingName(""); }} style={{ marginLeft:6 }}>Cancel</button>
                </div>
              ) : editingId ? (
                // editing an unselected athlete toggles save for that athlete
                <div style={{ marginBottom:10 }}>
                  <input value={editingName} onChange={e=>setEditingName(e.target.value)} />
                  <button onClick={saveEdit} style={{ marginLeft:8 }}>Save</button>
                  <button onClick={()=>{ setEditingId(null); setEditingName(""); }} style={{ marginLeft:6 }}>Cancel</button>
                </div>
              ) : null}

              <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:12 }}>
                <label>
                  Day
                  <select value={day} onChange={e=>setDay(e.target.value)} style={{ display:"block", marginTop:4 }}>
                    {DAYS.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </label>

                <label>
                  From
                  <select value={fromMin} onChange={e=>setFromMin(Number(e.target.value))} style={{ display:"block", marginTop:4 }}>
                    {ALL_TIMES.map(t => <option key={t.min} value={t.min}>{t.label}</option>)}
                  </select>
                </label>

                <label>
                  To
                  <select value={toMin} onChange={e=>setToMin(Number(e.target.value))} style={{ display:"block", marginTop:4 }}>
                    {ALL_TIMES.map(t => <option key={t.min} value={t.min}>{t.label}</option>)}
                  </select>
                </label>

                <div>
                  <button onClick={addUnavailability}>Add Unavailability</button>
                </div>
              </div>

              <div style={{ marginBottom:8 }}>
                <button onClick={clearAll}>Clear All Unavailability (selected athlete)</button>
              </div>

              <div style={{ maxHeight:300, overflowY:"auto", border:'1px solid #eee', padding:8 }}>
                <h4>Saved entries (slots)</h4>
                {unavailSlots.length === 0 ? <p><small>No unavailability saved for this athlete.</small></p> : (
                  <ul>
                    {unavailSlots.map(s => (
                      <li key={s.id} style={{ marginBottom:6 }}>
                        <strong>{s.day}</strong> — {formatMinLabel(s.slot_min)}
                        <button onClick={()=>deleteSlot(s.id)} style={{ marginLeft:8 }}>Delete</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {tab === "coach" && (
        <section style={{ marginTop:16 }}>
          <h2>Coach — filters & results</h2>

          {!coachAuthed ? (
            <div>
              <p>Enter coach access code to view filters/results.</p>
              <input value={coachCode} onChange={e=>setCoachCode(e.target.value)} placeholder="Coach code" />
              <button onClick={coachLogin} style={{ marginLeft:8 }}>Login</button>
            </div>
          ) : (
            <div>
              <div style={{ display:"flex", gap:12, alignItems:"center", marginBottom:12 }}>
                <label>
                  Earliest:
                  <select value={coachEarliest} onChange={e=>setCoachEarliest(Number(e.target.value))} style={{ marginLeft:8 }}>
                    {ALL_TIMES.map(t => <option key={t.min} value={t.min}>{t.label}</option>)}
                  </select>
                </label>

                <label>
                  Latest:
                  <select value={coachLatest} onChange={e=>setCoachLatest(Number(e.target.value))} style={{ marginLeft:8 }}>
                    {ALL_TIMES.map(t => <option key={t.min} value={t.min}>{t.label}</option>)}
                  </select>
                </label>

                <label>
                  Min % available:
                  <input type="number" min="0" max="100" value={minPercentFilter} onChange={e=>setMinPercentFilter(Number(e.target.value))} style={{ width:80, marginLeft:8 }} />
                </label>

                <button onClick={applyCoachFilters}>Apply Filters</button>
              </div>

              <div style={{ marginBottom:12 }}>
                <strong>Days:</strong>{' '}
                {DAYS.map(d => (
                  <label key={d} style={{ marginLeft:8 }}>
                    <input type="checkbox" checked={selectedDays[d]} onChange={()=>toggleDay(d)} /> {d}
                  </label>
                ))}
              </div>

              {coachResults ? (
                <>
                  <p><small>Total athletes: {coachResults.totalAthletes}</small></p>

                  <h3>Top suggestions (highest % first)</h3>
                  <ol>
                    {coachResults.results_by_percent.filter(r=>r.percentage>=minPercentFilter).slice(0,10).map((r,i)=>(
                      <li key={i}><strong>{r.label}</strong> — {r.available_count} / {coachResults.totalAthletes} ({r.percentage}%)</li>
                    ))}
                  </ol>

                  <h3>Grouped by day</h3>
                  {Object.entries(coachResults.results_by_day).map(([dayKey, arr])=>(
                    selectedDays[dayKey] && arr.length>0 && (
                      <div key={dayKey} style={{ marginBottom:12 }}>
                        <h4>{dayKey}</h4>
                        <ul>
                          {arr.filter(r=>r.percentage>=minPercentFilter).map((r,idx)=>(
                            <li key={idx}><strong>{r.label}</strong> — {r.available_count} / {coachResults.totalAthletes} ({r.percentage}%)</li>
                          ))}
                        </ul>
                      </div>
                    )
                  ))}
                </>
              ) : (
                <p><small>Press "Apply Filters" to compute availability.</small></p>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
