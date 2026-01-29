# NaTrack API

API Express + MariaDB pour le tracker NaTrack.

## Nouveautes (v2)
- Multi-user: chaque utilisateur a ses propres sessions.
- Auth JWT: login, /auth/me, roles user/admin.
- Admin: gestion et lecture des sessions de tous les users.
- Public read: sessions et dashboard global visibles par tous.

En bref: c est enorme.

## Endpoints principaux
- GET /api/health
- POST /api/auth/login
- GET /api/auth/me
- GET /api/sessions (public)
- GET /api/dashboard/global (public)
- GET /api/me/sessions (user)
- POST /api/me/sessions (user)
- PUT /api/me/sessions/:id (user)
- DELETE /api/me/sessions/:id (user)
- GET /api/users (admin)
- GET /api/users/:userId/sessions (admin)
- POST /api/users/:userId/sessions (admin)
- PUT /api/users/:userId/sessions/:id (admin)
- DELETE /api/users/:userId/sessions/:id (admin)

## Schema update (description)
Ajout d'un champ description pour users + bots :
```sql
ALTER TABLE users ADD COLUMN description TEXT NULL;
ALTER TABLE users ADD COLUMN avg_distance_m DECIMAL(6,1) NULL;
```

## Schema update (bot cards + challenges)
```sql
ALTER TABLE users
  ADD COLUMN bot_card_type ENUM('defi','objet','evenement','rare') NULL,
  ADD COLUMN bot_event_date DATE NULL,
  ADD COLUMN bot_drop_rate DECIMAL(6,3) NULL,
  ADD COLUMN bot_target_distance_m DECIMAL(8,1) NULL,
  ADD COLUMN bot_season_int INT NULL;

CREATE TABLE IF NOT EXISTS seasons (
  season_number INT PRIMARY KEY,
  start_date DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_season_start (start_date)
);

CREATE TABLE IF NOT EXISTS user_challenges (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  bot_id VARCHAR(36) NOT NULL,
  type ENUM('defi','objet','evenement','rare') NOT NULL,
  status ENUM('active','completed','expired') NOT NULL DEFAULT 'active',
  target_distance_m DECIMAL(8,1) NOT NULL,
  start_date DATE NOT NULL,
  due_date DATE NOT NULL,
  due_at DATETIME NULL,
  completed_at DATETIME NULL,
  completed_session_id VARCHAR(36) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_status (user_id, status),
  INDEX idx_user_due (user_id, due_date),
  INDEX idx_bot (bot_id)
);

CREATE TABLE IF NOT EXISTS user_card_results (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  bot_id VARCHAR(36) NOT NULL,
  type ENUM('defi','objet','evenement','rare') NOT NULL,
  distance_m DECIMAL(8,1) NOT NULL,
  target_distance_m DECIMAL(8,1) NULL,
  session_id VARCHAR(36) NULL,
  achieved_at DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_bot (user_id, bot_id),
  INDEX idx_user_date (user_id, achieved_at)
);

CREATE TABLE IF NOT EXISTS notifications (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  type VARCHAR(64) NOT NULL,
  title VARCHAR(255) NULL,
  body TEXT NULL,
  meta_json JSON NULL,
  read_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_created (user_id, created_at)
);
```

## Config
Variables d environnement attendues (exemple):
- PORT=3001
- JWT_SECRET=...
- CORS_ORIGIN=https://natrack.prjski.com,http://localhost:3000
- DB_HOST=...
- DB_PORT=3306
- DB_USER=...
- DB_PASSWORD=...
- DB_NAME=...

## Lancer en local
```bash
npm install
node app.js
```
