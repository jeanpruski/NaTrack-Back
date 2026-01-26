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
      "SELECT id, email, name, role, password_hash, shoe_name, card_image, " +
        "DATE_FORMAT(shoe_start_date, '%Y-%m-%d') AS shoe_start_date, " +
        "shoe_target_km FROM users WHERE email = ? LIMIT 1",
      [String(email).trim().toLowerCase()]
    );

    const user = rows?.[0];
    if (!user) return res.status(401).json({ error: "invalid_credentials" });

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
        role: user.role,
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
      "SELECT id, email, name, role, shoe_name, card_image, " +
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
        role: user.role,
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
      "SELECT id, name, shoe_name, card_image, created_at, " +
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

    res.status(201).json({ id: newId, user_id: req.user.id, date, distance: distNum, type: t });
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
      "SELECT id, email, name, role, created_at, shoe_name, card_image, " +
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

    await pool.query(
      "INSERT INTO sessions (id, user_id, date, distance, type) VALUES (?, ?, ?, ?, ?)",
      [newId, userId, date, distNum, t]
    );

    res.status(201).json({ id: newId, user_id: userId, date, distance: distNum, type: t });
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
