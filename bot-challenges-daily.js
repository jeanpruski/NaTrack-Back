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

function addDaysDate(date = new Date(), days = 0) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
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

function formatDateLabel(date) {
  if (Number.isNaN(date.getTime())) return dateStr;
  const weekdays = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
  const months = [
    "Janvier",
    "Février",
    "Mars",
    "Avril",
    "Mai",
    "Juin",
    "Juillet",
    "Août",
    "Septembre",
    "Octobre",
    "Novembre",
    "Décembre",
  ];
  const dayName = weekdays[date.getDay()];
  const monthName = months[date.getMonth()];
  const day = date.getDate();
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${dayName} ${day} ${monthName} ${year} à ${hours}h${minutes}`;
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

async function ensureBotSession(pool, botId, dateStr, distanceMeters) {
  const distance = Number(distanceMeters);
  if (!botId || !Number.isFinite(distance) || distance <= 0) return;
  const [rows] = await pool.query(
    "SELECT id FROM sessions WHERE user_id = ? AND date = ? LIMIT 1",
    [botId, dateStr]
  );
  if (rows?.length) return;
  await pool.query(
    "INSERT INTO sessions (id, user_id, date, distance, type) VALUES (?, ?, ?, ?, ?)",
    [crypto.randomUUID(), botId, dateStr, distance, "run"]
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
    const [seasonRows] = await pool.query(
      "SELECT season_number FROM seasons WHERE start_date <= ? ORDER BY start_date DESC, season_number DESC LIMIT 1",
      [today]
    );
    const activeSeason = seasonRows?.[0]?.season_number ?? null;

    let botsSql =
      "SELECT id, name, avg_distance_m, bot_card_type, bot_season_int, " +
      "DATE_FORMAT(bot_event_date, '%Y-%m-%d') AS bot_event_date, " +
      "bot_drop_rate, bot_target_distance_m " +
      "FROM users WHERE is_bot = 1";
    const botsParams = [];
    if (activeSeason !== null && activeSeason !== undefined) {
      botsSql += " AND (bot_season_int IS NULL OR bot_season_int <= ?)";
      botsParams.push(activeSeason);
    } else {
      botsSql += " AND bot_season_int IS NULL";
    }
    const [bots] = await pool.query(botsSql, botsParams);
    const [users] = await pool.query("SELECT id, name FROM users WHERE is_bot = 0");

    const [usedRows] = await pool.query("SELECT DISTINCT bot_id FROM user_challenges WHERE start_date = ?", [today]);
    const usedBots = new Set((usedRows || []).map((row) => String(row.bot_id)));

    const eventBots = bots.filter(
      (b) => b.bot_card_type === "evenement" && b.bot_event_date === today && Number(b.bot_target_distance_m) > 0
    );
    const challengeBots = bots.filter(
      (b) => (b.bot_card_type === "defi" || b.bot_card_type === "rare") && Number(b.avg_distance_m) > 0
    );

    const dailyEventBot = eventBots.length ? pickWeighted(eventBots, (b) => Number(b.bot_drop_rate) || 1) : null;

    for (const user of users) {
      const [activeRows] = await pool.query(
        "SELECT id, DATE_FORMAT(due_date, '%Y-%m-%d') AS due_date " +
          "FROM user_challenges WHERE user_id = ? AND status = 'active' " +
          "ORDER BY created_at DESC LIMIT 1",
        [user.id]
      );
      const active = activeRows?.[0] || null;
      if (active && active.due_date < today) {
        await pool.query("UPDATE user_challenges SET status = 'expired' WHERE id = ?", [active.id]);
      }
      if (dailyEventBot && active && active.due_date >= today) {
        await pool.query("UPDATE user_challenges SET status = 'expired' WHERE id = ?", [active.id]);
      } else if (active && active.due_date >= today) {
        continue;
      }

      let bot = null;
      let targetDistance = null;
      let type = "defi";
      let dueDate = addDays(today, 3);
      let dueDateTime = addDaysDate(new Date(), 3);

      const availableChallengeBots = challengeBots.filter((b) => !usedBots.has(String(b.id)));

      if (dailyEventBot) {
        bot = dailyEventBot;
        targetDistance = Number(bot.bot_target_distance_m);
        type = "evenement";
        dueDate = today;
        dueDateTime = new Date();
      } else if (availableChallengeBots.length) {
        bot = pickWeighted(availableChallengeBots, (b) => {
          const base = Number(b.bot_drop_rate) || 1;
          const seasonBoost =
            activeSeason !== null && activeSeason !== undefined && String(b.bot_season_int) === String(activeSeason)
              ? 1.5
              : 1;
          const rarePenalty = b.bot_card_type === "rare" ? 0.5 : 1;
          return base * seasonBoost * rarePenalty;
        });
        if (!bot) continue;
        const baseDistance = normalizeMeters(bot.bot_target_distance_m ?? bot.avg_distance_m);
        targetDistance = jitterDistance(baseDistance, 0.15);
        type = bot.bot_card_type || "defi";
      }

      if (!bot || !targetDistance) continue;
      if (type !== "evenement") {
        usedBots.add(String(bot.id));
      }

      const challengeId = crypto.randomUUID();
      await pool.query(
        "INSERT INTO user_challenges " +
          "(id, user_id, bot_id, type, status, target_distance_m, start_date, due_date, due_at) " +
          "VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)",
        [challengeId, user.id, bot.id, type, targetDistance, today, dueDate, dueDateTime]
      );

      const km = formatKm(targetDistance);
      if (type === "evenement") {
        await createNotification(pool, user.id, {
          type: "event_start",
          title: "Événement du jour",
          body: `Fais ${km} km aujourd'hui pour gagner la carte ${bot.name}.`,
          meta: { bot_id: bot.id, challenge_id: challengeId },
        });
        await ensureBotSession(pool, bot.id, today, targetDistance);
      } else {
        const dueLabel = formatDateLabel(dueDateTime);
        await createNotification(pool, user.id, {
          type: "challenge_start",
          title: "Nouveau défi",
          body: `[${bot.name}] te défie à la course, cours ${km} km avant le ${dueLabel} pour gagner sa carte !`,
          meta: { bot_id: bot.id, challenge_id: challengeId },
        });
        await ensureBotSession(pool, bot.id, today, targetDistance);
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
