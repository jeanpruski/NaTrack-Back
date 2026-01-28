// app.js — API NaTrack (Express + MariaDB) + auth (JWT)
// -----------------------------------------------------
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const mysql = require("mysql2/promise");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || "";

/* =========================
   CORS (prod + dev)
   - Exemple: CORS_ORIGIN="https://natrack.prjski.com,http://localhost:3000"
   ========================= */
const WHITELIST = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (WHITELIST.length === 0 || WHITELIST.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json());

/* =========================
   MySQL pool
   ========================= */
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  enableKeepAlive: true,
});

/* =========================
   Auth helpers (JWT)
   ========================= */
function getBearerToken(req) {
  const header = req.get("authorization") || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  return null;
}

function signToken(user) {
  if (!JWT_SECRET) return null;
  return jwt.sign({ id: user.id, role: user.role, email: user.email }, JWT_SECRET, {
    expiresIn: "14d",
  });
}

function requireAuth(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "unauthorized" });
    if (!JWT_SECRET) return res.status(500).json({ error: "missing_jwt_secret" });
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (e) {
    return res.status(401).json({ error: "unauthorized" });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role === "admin") return next();
  return res.status(403).json({ error: "forbidden" });
}

/* =========================
   Bloquer la navigation directe (GET document) => 204
   ========================= */
function blockBrowserNav(req, res, next) {
  try {
    if (req.method === "GET" && req.path !== "/health") {
      const dest = (req.get("sec-fetch-dest") || "").toLowerCase();
      const mode = (req.get("sec-fetch-mode") || "").toLowerCase();
      const accept = (req.get("accept") || "").toLowerCase();

      const isDocumentNav =
        mode === "navigate" ||
        dest === "document" ||
        (accept.includes("text/html") && !accept.includes("application/json"));

      if (isDocumentNav) {
        return res.status(204).end();
      }
    }
  } catch (e) {
    console.error("blockBrowserNav error:", e);
  }
  return next();
}

/* =========================
   Helpers type validation
   ========================= */
const ALLOWED_TYPES = new Set(["swim", "run"]);

function normalizeType(input) {
  if (!input) return "swim"; // defaut
  const t = String(input).toLowerCase().trim();
  return t;
}

function isValidType(t) {
  return ALLOWED_TYPES.has(t);
}

function validateDistance(distance) {
  const distNum = Number(distance);
  if (!Number.isFinite(distNum) || distNum <= 0) return null;
  return distNum;
}

function formatKm(distanceMeters) {
  const km = Number(distanceMeters) / 1000;
  if (!Number.isFinite(km)) return "";
  return km.toFixed(1);
}

function isDateBetween(dateStr, startStr, endStr) {
  if (!dateStr || !startStr || !endStr) return false;
  return dateStr >= startStr && dateStr <= endStr;
}

async function createNotification(userId, { type, title, body, meta }) {
  const id = uuidv4();
  const metaJson = meta ? JSON.stringify(meta) : null;
  await pool.query(
    "INSERT INTO notifications (id, user_id, type, title, body, meta_json) VALUES (?, ?, ?, ?, ?, ?)",
    [id, userId, type, title || null, body || null, metaJson]
  );
  return id;
}

async function getActiveChallenge(userId) {
  const [rows] = await pool.query(
    "SELECT c.id, c.bot_id, c.type, c.target_distance_m, " +
      "DATE_FORMAT(c.start_date, '%Y-%m-%d') AS start_date, " +
      "DATE_FORMAT(c.due_date, '%Y-%m-%d') AS due_date, " +
      "u.name AS bot_name " +
      "FROM user_challenges c LEFT JOIN users u ON u.id = c.bot_id " +
      "WHERE c.user_id = ? AND c.status = 'active' ORDER BY c.created_at DESC LIMIT 1",
    [userId]
  );
  return rows?.[0] || null;
}

async function handleChallengeCompletion({ userId, sessionId, sessionDate, distance }) {
  const challenge = await getActiveChallenge(userId);
  if (!challenge) return null;
  if (!isDateBetween(sessionDate, challenge.start_date, challenge.due_date)) return null;
  if (Number(distance) < Number(challenge.target_distance_m)) return null;

  const [result] = await pool.query(
    "UPDATE user_challenges SET status = 'completed', completed_at = NOW(), completed_session_id = ? " +
      "WHERE id = ? AND status = 'active'",
    [sessionId, challenge.id]
  );
  if (result.affectedRows === 0) return null;

  await pool.query(
    "INSERT INTO user_card_results (id, user_id, bot_id, type, distance_m, target_distance_m, session_id, achieved_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      uuidv4(),
      userId,
      challenge.bot_id,
      challenge.type,
      distance,
      challenge.target_distance_m,
      sessionId,
      sessionDate,
    ]
  );

  const targetKm = formatKm(challenge.target_distance_m);
  const actualKm = formatKm(distance);
  const isEvent = challenge.type === "evenement";
  await createNotification(userId, {
    type: isEvent ? "event_success" : "challenge_success",
    title: isEvent ? "Événement réussi !" : "Défi réussi !",
    body: `Bravo ! Tu as fait ${actualKm} km sur ${targetKm} km.`,
    meta: { bot_id: challenge.bot_id, challenge_id: challenge.id },
  });

  await pool.query(
    "UPDATE notifications SET read_at = NOW() " +
      "WHERE user_id = ? AND read_at IS NULL AND type IN ('challenge_start','event_start')",
    [userId]
  );

  return challenge;
}

async function handleObjectCards({ userId, sessionId, sessionDate, distance }) {
  const [bots] = await pool.query(
    "SELECT id, bot_card_type, bot_target_distance_m FROM users " +
      "WHERE is_bot = 1 AND bot_card_type = 'objet' AND bot_target_distance_m IS NOT NULL " +
      "AND bot_target_distance_m <= ?",
    [distance]
  );
  if (!bots?.length) return 0;

  for (const bot of bots) {
    await pool.query(
      "INSERT INTO user_card_results (id, user_id, bot_id, type, distance_m, target_distance_m, session_id, achieved_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [uuidv4(), userId, bot.id, bot.bot_card_type, distance, bot.bot_target_distance_m, sessionId, sessionDate]
    );
  }
  return bots.length;
}

function mapSessionRow(row) {
  return {
    id: row.id,
    date: row.date,
    distance: row.distance,
    type: row.type,
    user_id: row.user_id,
    user_name: row.user_name || null,
  };
}

/* =========================
   Router API
   ========================= */
const api = express.Router();
api.use(blockBrowserNav);

// Healthcheck DB + app
api.get("/health", async (_req, res) => {
  try {
    const [rows] = await pool.query("SELECT 1 AS ok");
    res.json({ ok: true, db: rows?.[0]?.ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Login email/mot de passe
api.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "missing_credentials" });

    const [rows] = await pool.query(
      "SELECT id, email, name, description, avg_distance_m, role, password_hash, shoe_name, card_image, is_bot, bot_color, bot_border_color, " +
        "bot_card_type, DATE_FORMAT(bot_event_date, '%Y-%m-%d') AS bot_event_date, bot_drop_rate, bot_target_distance_m, " +
        "DATE_FORMAT(shoe_start_date, '%Y-%m-%d') AS shoe_start_date, " +
        "shoe_target_km FROM users WHERE email = ? LIMIT 1",
      [String(email).trim().toLowerCase()]
    );

    const user = rows?.[0];
    if (!user) return res.status(401).json({ error: "invalid_credentials" });

    if (user.is_bot) return res.status(403).json({ error: "bot_account" });

    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) return res.status(401).json({ error: "invalid_credentials" });

    const token = signToken(user);
    if (!token) return res.status(500).json({ error: "missing_jwt_secret" });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avg_distance_m: user.avg_distance_m ?? null,
        description: user.description || null,
        role: user.role,
        is_bot: !!user.is_bot,
        bot_color: user.bot_color || null,
        bot_border_color: user.bot_border_color || null,
        bot_card_type: user.bot_card_type || null,
        bot_event_date: user.bot_event_date || null,
        bot_drop_rate: user.bot_drop_rate ?? null,
        bot_target_distance_m: user.bot_target_distance_m ?? null,
        shoe_name: user.shoe_name || null,
        card_image: user.card_image || null,
        shoe_start_date: user.shoe_start_date || null,
        shoe_target_km: user.shoe_target_km ?? null,
      },
    });
  } catch (e) {
    console.error("POST /auth/login error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Infos user courant
api.get("/auth/me", requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, email, name, description, avg_distance_m, role, shoe_name, card_image, is_bot, bot_color, bot_border_color, " +
        "bot_card_type, DATE_FORMAT(bot_event_date, '%Y-%m-%d') AS bot_event_date, bot_drop_rate, bot_target_distance_m, " +
        "DATE_FORMAT(shoe_start_date, '%Y-%m-%d') AS shoe_start_date, " +
        "shoe_target_km FROM users WHERE id = ? LIMIT 1",
      [req.user.id]
    );
    const user = rows?.[0];
    if (!user) return res.status(404).json({ error: "not_found" });
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avg_distance_m: user.avg_distance_m ?? null,
        description: user.description || null,
        role: user.role,
        is_bot: !!user.is_bot,
        bot_color: user.bot_color || null,
        bot_border_color: user.bot_border_color || null,
        bot_card_type: user.bot_card_type || null,
        bot_event_date: user.bot_event_date || null,
        bot_drop_rate: user.bot_drop_rate ?? null,
        bot_target_distance_m: user.bot_target_distance_m ?? null,
        shoe_name: user.shoe_name || null,
        card_image: user.card_image || null,
        shoe_start_date: user.shoe_start_date || null,
        shoe_target_km: user.shoe_target_km ?? null,
      },
    });
  } catch (e) {
    console.error("GET /auth/me error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Compat: check auth (ancien endpoint)
api.get("/auth/check", requireAuth, (_req, res) => {
  res.json({ ok: true });
});

// Liste des sessions globales (public)
api.get("/sessions", async (req, res) => {
  try {
    const type = req.query?.type ? normalizeType(req.query.type) : null;

    if (type && !isValidType(type)) {
      return res.status(400).json({ error: "type invalide (swim|run)" });
    }

    let sql =
      "SELECT s.id, DATE_FORMAT(s.date, '%Y-%m-%d') AS date, s.distance, s.type, s.user_id, u.name AS user_name " +
      "FROM sessions s LEFT JOIN users u ON u.id = s.user_id";
    const params = [];

    if (type) {
      sql += " WHERE s.type = ?";
      params.push(type);
    }

    sql += " ORDER BY s.date ASC";

    const [rows] = await pool.query(sql, params);
    res.json(rows.map(mapSessionRow));
  } catch (e) {
    console.error("GET /sessions error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Dashboard global public
api.get("/dashboard/global", async (_req, res) => {
  try {
    const [totalsRows] = await pool.query(
      "SELECT COUNT(*) AS sessions, SUM(distance) AS distance, " +
        "SUM(CASE WHEN type='swim' THEN distance ELSE 0 END) AS swim_distance, " +
        "SUM(CASE WHEN type='run' THEN distance ELSE 0 END) AS run_distance " +
        "FROM sessions"
    );

    const [byUserRows] = await pool.query(
      "SELECT s.user_id, u.name AS user_name, COUNT(*) AS sessions, SUM(s.distance) AS distance, " +
        "SUM(CASE WHEN s.type='swim' THEN s.distance ELSE 0 END) AS swim_distance, " +
        "SUM(CASE WHEN s.type='run' THEN s.distance ELSE 0 END) AS run_distance " +
        "FROM sessions s LEFT JOIN users u ON u.id = s.user_id " +
        "GROUP BY s.user_id, u.name " +
        "ORDER BY distance DESC"
    );

    res.json({
      totals: {
        sessions: totalsRows?.[0]?.sessions || 0,
        distance: totalsRows?.[0]?.distance || 0,
        swim_distance: totalsRows?.[0]?.swim_distance || 0,
        run_distance: totalsRows?.[0]?.run_distance || 0,
      },
      users: byUserRows || [],
    });
  } catch (e) {
    console.error("GET /dashboard/global error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Liste publique des utilisateurs
api.get("/users/public", async (_req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, name, description, avg_distance_m, shoe_name, card_image, is_bot, bot_color, bot_border_color, " +
        "bot_card_type, DATE_FORMAT(bot_event_date, '%Y-%m-%d') AS bot_event_date, bot_drop_rate, bot_target_distance_m, created_at, " +
        "DATE_FORMAT(shoe_start_date, '%Y-%m-%d') AS shoe_start_date, " +
        "shoe_target_km FROM users ORDER BY name ASC"
    );
    res.json(rows);
  } catch (e) {
    console.error("GET /users/public error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Sessions du user courant
api.get("/me/sessions", requireAuth, async (req, res) => {
  try {
    const type = req.query?.type ? normalizeType(req.query.type) : null;

    if (type && !isValidType(type)) {
      return res.status(400).json({ error: "type invalide (swim|run)" });
    }

    let sql =
      "SELECT s.id, DATE_FORMAT(s.date, '%Y-%m-%d') AS date, s.distance, s.type, s.user_id, u.name AS user_name " +
      "FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.user_id = ?";
    const params = [req.user.id];

    if (type) {
      sql += " AND s.type = ?";
      params.push(type);
    }

    sql += " ORDER BY s.date ASC";

    const [rows] = await pool.query(sql, params);
    res.json(rows.map(mapSessionRow));
  } catch (e) {
    console.error("GET /me/sessions error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Defi actif du user courant
api.get("/me/challenge", requireAuth, async (req, res) => {
  try {
    const active = await getActiveChallenge(req.user.id);
    if (!active) return res.json({ challenge: null });
    res.json({ challenge: active });
  } catch (e) {
    console.error("GET /me/challenge error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Notifications du user courant
api.get("/me/notifications", requireAuth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query?.limit) || 50, 200);
    const [rows] = await pool.query(
      "SELECT id, type, title, body, meta_json, " +
        "DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at, " +
        "DATE_FORMAT(read_at, '%Y-%m-%d %H:%i:%s') AS read_at " +
        "FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
      [req.user.id, limit]
    );
    const mapped = rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title || null,
      body: row.body || null,
      meta: row.meta_json ? JSON.parse(row.meta_json) : null,
      created_at: row.created_at,
      read_at: row.read_at || null,
    }));
    res.json(mapped);
  } catch (e) {
    console.error("GET /me/notifications error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Resultats des cartes pour un bot
api.get("/me/card-results", requireAuth, async (req, res) => {
  try {
    const botId = req.query?.bot_id;
    const params = [req.user.id];
    let sql =
      "SELECT r.id, r.bot_id, u.name AS bot_name, r.type, r.distance_m, r.target_distance_m, r.session_id, " +
      "DATE_FORMAT(r.achieved_at, '%Y-%m-%d') AS achieved_at " +
      "FROM user_card_results r LEFT JOIN users u ON u.id = r.bot_id WHERE r.user_id = ?";
    if (botId) {
      sql += " AND r.bot_id = ?";
      params.push(botId);
    }
    sql += " ORDER BY r.achieved_at DESC, r.created_at DESC";
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error("GET /me/card-results error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Creation pour user courant
api.post("/me/sessions", requireAuth, async (req, res) => {
  try {
    const { distance, date, id, type } = req.body || {};

    const t = normalizeType(type);

    if (!date) return res.status(400).json({ error: "date requise" });
    if (typeof distance === "undefined" || distance === null || distance === "") {
      return res.status(400).json({ error: "distance requise" });
    }

    const distNum = validateDistance(distance);
    if (!distNum) return res.status(400).json({ error: "distance invalide" });

    if (!isValidType(t)) {
      return res.status(400).json({ error: "type invalide (swim|run)" });
    }

    const newId = id || uuidv4();

    await pool.query(
      "INSERT INTO sessions (id, user_id, date, distance, type) VALUES (?, ?, ?, ?, ?)",
      [newId, req.user.id, date, distNum, t]
    );

    const challengeCompleted = await handleChallengeCompletion({
      userId: req.user.id,
      sessionId: newId,
      sessionDate: date,
      distance: distNum,
    });
    await handleObjectCards({
      userId: req.user.id,
      sessionId: newId,
      sessionDate: date,
      distance: distNum,
    });

    res.status(201).json({
      id: newId,
      user_id: req.user.id,
      date,
      distance: distNum,
      type: t,
      challenge_completed: !!challengeCompleted,
      challenge: challengeCompleted
        ? {
            id: challengeCompleted.id,
            bot_id: challengeCompleted.bot_id,
            bot_name: challengeCompleted.bot_name || null,
            type: challengeCompleted.type,
            target_distance_m: challengeCompleted.target_distance_m,
            due_date: challengeCompleted.due_date,
          }
        : null,
    });
  } catch (e) {
    console.error("POST /me/sessions error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Update pour user courant
api.put("/me/sessions/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { distance, date, type } = req.body || {};

    if (typeof distance === "undefined" && !date && typeof type === "undefined") {
      return res.status(400).json({ error: "aucune donnée à mettre à jour" });
    }

    const fields = [];
    const params = [];

    if (date) {
      fields.push("date = ?");
      params.push(date);
    }

    if (typeof distance !== "undefined") {
      const distNum = validateDistance(distance);
      if (!distNum) return res.status(400).json({ error: "distance invalide" });
      fields.push("distance = ?");
      params.push(distNum);
    }

    if (typeof type !== "undefined") {
      const t = normalizeType(type);
      if (!isValidType(t)) return res.status(400).json({ error: "type invalide (swim|run)" });
      fields.push("type = ?");
      params.push(t);
    }

    params.push(id, req.user.id);

    const [result] = await pool.query(
      `UPDATE sessions SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`,
      params
    );

    if (result.affectedRows === 0) return res.status(404).json({ error: "not found" });

    res.json({ id, date, distance, type });
  } catch (e) {
    console.error("PUT /me/sessions/:id error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Suppression pour user courant
api.delete("/me/sessions/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query("DELETE FROM sessions WHERE id = ? AND user_id = ?", [id, req.user.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: "not found" });
    res.status(204).end();
  } catch (e) {
    console.error("DELETE /me/sessions/:id error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Admin: liste des users
api.get("/users", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, email, name, description, avg_distance_m, role, created_at, shoe_name, card_image, is_bot, bot_color, bot_border_color, " +
        "bot_card_type, DATE_FORMAT(bot_event_date, '%Y-%m-%d') AS bot_event_date, bot_drop_rate, bot_target_distance_m, " +
        "DATE_FORMAT(shoe_start_date, '%Y-%m-%d') AS shoe_start_date, " +
        "shoe_target_km FROM users ORDER BY created_at ASC"
    );
    res.json(rows);
  } catch (e) {
    console.error("GET /users error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Admin: sessions d'un user
api.get("/users/:userId/sessions", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const type = req.query?.type ? normalizeType(req.query.type) : null;

    if (type && !isValidType(type)) {
      return res.status(400).json({ error: "type invalide (swim|run)" });
    }

    let sql =
      "SELECT s.id, DATE_FORMAT(s.date, '%Y-%m-%d') AS date, s.distance, s.type, s.user_id, u.name AS user_name " +
      "FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.user_id = ?";
    const params = [userId];

    if (type) {
      sql += " AND s.type = ?";
      params.push(type);
    }

    sql += " ORDER BY s.date ASC";

    const [rows] = await pool.query(sql, params);
    res.json(rows.map(mapSessionRow));
  } catch (e) {
    console.error("GET /users/:userId/sessions error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Admin: creation pour un user
api.post("/users/:userId/sessions", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { distance, date, id, type } = req.body || {};

    const t = normalizeType(type);

    if (!date) return res.status(400).json({ error: "date requise" });
    if (typeof distance === "undefined" || distance === null || distance === "") {
      return res.status(400).json({ error: "distance requise" });
    }

    const distNum = validateDistance(distance);
    if (!distNum) return res.status(400).json({ error: "distance invalide" });

    if (!isValidType(t)) {
      return res.status(400).json({ error: "type invalide (swim|run)" });
    }

    const newId = id || uuidv4();
    const [userRows] = await pool.query("SELECT is_bot FROM users WHERE id = ? LIMIT 1", [userId]);
    const isBotUser = !!userRows?.[0]?.is_bot;

    await pool.query(
      "INSERT INTO sessions (id, user_id, date, distance, type) VALUES (?, ?, ?, ?, ?)",
      [newId, userId, date, distNum, t]
    );

    let challengeCompleted = null;
    if (!isBotUser) {
      challengeCompleted = await handleChallengeCompletion({
        userId,
        sessionId: newId,
        sessionDate: date,
        distance: distNum,
      });
      await handleObjectCards({
        userId,
        sessionId: newId,
        sessionDate: date,
        distance: distNum,
      });
    }

    res.status(201).json({
      id: newId,
      user_id: userId,
      date,
      distance: distNum,
      type: t,
      challenge_completed: !!challengeCompleted,
      challenge: challengeCompleted
        ? {
            id: challengeCompleted.id,
            bot_id: challengeCompleted.bot_id,
            bot_name: challengeCompleted.bot_name || null,
            type: challengeCompleted.type,
            target_distance_m: challengeCompleted.target_distance_m,
            due_date: challengeCompleted.due_date,
          }
        : null,
    });
  } catch (e) {
    console.error("POST /users/:userId/sessions error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Admin: update pour un user
api.put("/users/:userId/sessions/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId, id } = req.params;
    const { distance, date, type } = req.body || {};

    if (typeof distance === "undefined" && !date && typeof type === "undefined") {
      return res.status(400).json({ error: "aucune donnée à mettre à jour" });
    }

    const fields = [];
    const params = [];

    if (date) {
      fields.push("date = ?");
      params.push(date);
    }

    if (typeof distance !== "undefined") {
      const distNum = validateDistance(distance);
      if (!distNum) return res.status(400).json({ error: "distance invalide" });
      fields.push("distance = ?");
      params.push(distNum);
    }

    if (typeof type !== "undefined") {
      const t = normalizeType(type);
      if (!isValidType(t)) return res.status(400).json({ error: "type invalide (swim|run)" });
      fields.push("type = ?");
      params.push(t);
    }

    params.push(id, userId);

    const [result] = await pool.query(
      `UPDATE sessions SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`,
      params
    );

    if (result.affectedRows === 0) return res.status(404).json({ error: "not found" });

    res.json({ id, user_id: userId, date, distance, type });
  } catch (e) {
    console.error("PUT /users/:userId/sessions/:id error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Admin: suppression pour un user
api.delete("/users/:userId/sessions/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId, id } = req.params;
    const [result] = await pool.query("DELETE FROM sessions WHERE id = ? AND user_id = ?", [id, userId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: "not found" });
    res.status(204).end();
  } catch (e) {
    console.error("DELETE /users/:userId/sessions/:id error:", e);
    res.status(500).json({ error: e.message });
  }
});

/* =========================
   Montage: couvre / ET /api
   ========================= */
app.use("/", api);
app.use("/api", api);

// Ping simple
app.get("/", (_req, res) => res.send("API up"));

/* =========================
   Error handler global (JSON)
   ========================= */
app.use((err, req, res, _next) => {
  try {
    console.error("Unhandled error:", err);
  } catch {}
  if (res.headersSent) return;
  res.status(500).json({ error: "internal_error" });
});

/* =========================
   Start
   ========================= */
app.listen(PORT, () => {
  console.log("Listening on", PORT);
});
