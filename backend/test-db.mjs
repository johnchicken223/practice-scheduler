import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  const res = await pool.query("SELECT NOW()");
  console.log("✅ Connected! Time:", res.rows[0].now);
} catch (err) {
  console.error("❌ Connection failed:", err);
} finally {
  await pool.end();
}
