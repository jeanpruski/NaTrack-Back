// scripts/bot-daily.js
// Create one "run" session per bot per day with +/-10% jitter.
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");

const BOT_LIST_PATH = process.env.BOT_LIST_PATH || path.join(__dirname, "bots.json");

function getLocalDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function jitterDistance(baseMeters) {
  const base = Number(baseMeters);
  if (!Number.isFinite(base) || base <= 0) return null;
  const delta = (Math.random() * 0.2) - 0.1; // -10% .. +10%
  return Math.round(base * (1 + delta));
}

function normalizeType(input) {
  if (!input) return "run";
  const t = String(input).toLowerCase().trim();
  return t === "swim" ? "swim" : "run";
}

async function main() {
  const today = getLocalDateString();
  const listRaw = fs.readFileSync(BOT_LIST_PATH, "utf-8");
  const bots = JSON.parse(listRaw);

  if (!Array.isArray(bots) || bots.length === 0) {
    console.log("No bots configured.");
    return;
  }

  const pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 5,
    enableKeepAlive: true,
  });

  try {
    for (const bot of bots) {
      const botId = bot.id;
      const botName = bot.name;
      if (!botId && !botName) {
        console.log("Skip bot without id/name:", bot);
        continue;
      }

      let userId = botId;
      if (!userId && botName) {
        const [rows] = await pool.query(
          "SELECT id FROM users WHERE name = ? AND is_bot = 1 LIMIT 1",
          [botName]
        );
        userId = rows?.[0]?.id || null;
      }

      if (!userId) {
        console.log("Bot user not found:", botName || botId);
        continue;
      }

      const type = normalizeType(bot.type);
      const [existing] = await pool.query(
        "SELECT id FROM sessions WHERE user_id = ? AND date = ? AND type = ? LIMIT 1",
        [userId, today, type]
      );
      if (existing?.length) {
        console.log("Already has session today:", userId);
        continue;
      }

      const distance = jitterDistance(bot.distance_m);
      if (!distance) {
        console.log("Invalid distance for bot:", botName || userId);
        continue;
      }

      const newId = crypto.randomUUID();
      await pool.query(
        "INSERT INTO sessions (id, user_id, date, distance, type) VALUES (?, ?, ?, ?, ?)",
        [newId, userId, today, distance, type]
      );

      console.log(`Created session for ${botName || userId}: ${distance}m ${type} on ${today}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("bot-daily error:", err);
  process.exit(1);
});
