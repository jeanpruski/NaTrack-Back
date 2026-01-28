// bot-challenges-daily.js
// Assign one daily challenge per user (event or bot challenge).
require("dotenv").config();

const crypto = require("crypto");
const mysql = require("mysql2/promise");

function getLocalDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(dateStr, days) {
  const base = new Date(`${dateStr}T00:00:00`);
  base.setDate(base.getDate() + days);
  return getLocalDateString(base);
}

function jitterDistance(baseMeters, ratio = 0.15) {
  const base = Number(baseMeters);
  if (!Number.isFinite(base) || base <= 0) return null;
  const delta = (Math.random() * (ratio * 2)) - ratio;
  return Math.round(base * (1 + delta));
}

function normalizeMeters(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num < 1000 ? Math.round(num * 1000) : num;
}

function formatKm(meters) {
  const km = Number(meters) / 1000;
  if (!Number.isFinite(km)) return "";
  return km.toFixed(3);
}

function pickWeighted(items, weightFn) {
  const weights = items.map((item) => Math.max(0, Number(weightFn(item)) || 0));
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return null;
  let roll = Math.random() * total;
  for (let i = 0; i < items.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1] || null;
}

async function createNotification(pool, userId, { type, title, body, meta }) {
  await pool.query(
    "INSERT INTO notifications (id, user_id, type, title, body, meta_json) VALUES (?, ?, ?, ?, ?, ?)",
    [crypto.randomUUID(), userId, type, title || null, body || null, meta ? JSON.stringify(meta) : null]
  );
}

async function main() {
  const today = getLocalDateString();

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
    const [bots] = await pool.query(
      "SELECT id, name, avg_distance_m, bot_card_type, " +
        "DATE_FORMAT(bot_event_date, '%Y-%m-%d') AS bot_event_date, " +
        "bot_drop_rate, bot_target_distance_m " +
        "FROM users WHERE is_bot = 1"
    );
    const [users] = await pool.query("SELECT id, name FROM users WHERE is_bot = 0");

    const eventBots = bots.filter(
      (b) => b.bot_card_type === "evenement" && b.bot_event_date === today && Number(b.bot_target_distance_m) > 0
    );
    const challengeBots = bots.filter(
      (b) => (b.bot_card_type === "defi" || b.bot_card_type === "rare") && Number(b.avg_distance_m) > 0
    );

    for (const user of users) {
      const [activeRows] = await pool.query(
        "SELECT id, DATE_FORMAT(due_date, '%Y-%m-%d') AS due_date " +
          "FROM user_challenges WHERE user_id = ? AND status = 'active' " +
          "ORDER BY created_at DESC LIMIT 1",
        [user.id]
      );
      const active = activeRows?.[0] || null;
      if (active && active.due_date >= today) {
        continue;
      }
      if (active && active.due_date < today) {
        await pool.query("UPDATE user_challenges SET status = 'expired' WHERE id = ?", [active.id]);
      }

      let bot = null;
      let targetDistance = null;
      let type = "defi";
      let dueDate = addDays(today, 3);

      if (eventBots.length) {
        bot = pickWeighted(eventBots, (b) => Number(b.bot_drop_rate) || 1);
        if (!bot) continue;
        targetDistance = Number(bot.bot_target_distance_m);
        type = "evenement";
        dueDate = today;
      } else if (challengeBots.length) {
        bot = pickWeighted(challengeBots, (b) => {
          const base = Number(b.bot_drop_rate) || 1;
          return b.bot_card_type === "rare" ? base * 0.5 : base;
        });
        if (!bot) continue;
        const baseDistance = normalizeMeters(bot.bot_target_distance_m ?? bot.avg_distance_m);
        targetDistance = jitterDistance(baseDistance, 0.15);
        type = bot.bot_card_type || "defi";
      }

      if (!bot || !targetDistance) continue;

      const challengeId = crypto.randomUUID();
      await pool.query(
        "INSERT INTO user_challenges " +
          "(id, user_id, bot_id, type, status, target_distance_m, start_date, due_date) " +
          "VALUES (?, ?, ?, ?, 'active', ?, ?, ?)",
        [challengeId, user.id, bot.id, type, targetDistance, today, dueDate]
      );

      const km = formatKm(targetDistance);
      if (type === "evenement") {
        await createNotification(pool, user.id, {
          type: "event_start",
          title: "Événement du jour",
          body: `Fais ${km} km aujourd'hui pour gagner la carte ${bot.name}.`,
          meta: { bot_id: bot.id, challenge_id: challengeId },
        });
      } else {
        await createNotification(pool, user.id, {
          type: "challenge_start",
          title: "Nouveau défi",
          body: `Un bot te défie : ${bot.name}. Tu as 3 jours pour faire ${km} km.`,
          meta: { bot_id: bot.id, challenge_id: challengeId },
        });
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("bot-challenges-daily error:", err);
  process.exit(1);
});
