# NaTrack API

Backend Express + MariaDB pour NaTrack. Auth JWT, sessions sportives (swim/run), bots, saisons, cartes, defis, events, news et notifications.

---

## Pourquoi c'est cool
- Multi-user + roles (user/admin)
- Endpoints publics + prives
- Bots qui courent tous les jours
- Defis & evenements quotidiens
- Saisons, cartes, drops, notifications
- API propre, simple a deployer

---

## Tech stack
- Node.js + Express
- MariaDB (mysql2/promise)
- JWT + bcrypt
- dotenv + CORS

---

## Demarrage rapide
```bash
npm install
npm start
```

Par defaut l'API ecoute sur `PORT=3001`.

---

## Configuration (.env)
Variables attendues :
- `PORT=3001`
- `JWT_SECRET=...`
- `CORS_ORIGIN=https://natrack.prjski.com,http://localhost:3000`
- `DB_HOST=localhost`
- `DB_PORT=3306`
- `DB_USER=...`
- `DB_PASSWORD=...`
- `DB_NAME=...`
- `BOT_LIST_PATH=./bots.json` (optionnel, pour `bot-daily.js`)
- `STRAVA_CLIENT_ID=...`
- `STRAVA_CLIENT_SECRET=...`
- `STRAVA_REDIRECT_URI=...` (ex: `https://api.monsite.com/strava/callback`)
- `STRAVA_WEBHOOK_VERIFY_TOKEN=...`
- `STRAVA_POST_AUTH_REDIRECT=...` (optionnel, ex: `https://natrack.prjski.com`)

Notes :
- Si `JWT_SECRET` est vide, le login renvoie `missing_jwt_secret`.
- CORS est en whitelist : si `CORS_ORIGIN` est vide, tout est autorise.
- Les routes sont montees sur `/` **et** `/api` (ex: `/health` et `/api/health`).

---

## Endpoints (overview)

### Public
- `GET /health` : healthcheck app + DB
- `GET /news?limit=&offset=` : news / evenements
- `GET /sessions?type=swim|run`
- `GET /dashboard/global`
- `GET /season/active`
- `GET /seasons`
- `GET /users/public`

### Auth
- `POST /auth/login` : `{ email, password }`
- `GET /auth/me`
- `GET /auth/check`

### Strava
- `GET /strava/connect` : demarre l'OAuth
- `GET /strava/callback` : callback OAuth Strava
- `GET /strava/webhook` : validation webhook Strava
- `POST /strava/webhook` : reception webhook Strava

### User (JWT)
- `GET /me/sessions?type=swim|run`
- `POST /me/sessions` : `{ date, distance, type, id? }`
- `PUT /me/sessions/:id` : `{ date?, distance?, type? }`
- `DELETE /me/sessions/:id`
- `GET /me/challenge`
- `POST /me/challenge/cancel`
- `GET /me/notifications?limit=`
- `GET /me/card-results?bot_id=`

### Admin (JWT + role=admin)
- `GET /users`
- `GET /users/:userId/sessions?type=swim|run`
- `POST /users/:userId/sessions`
- `PUT /users/:userId/sessions/:id`
- `DELETE /users/:userId/sessions/:id`
- `GET /users/:id/card-results-counts`

---

## Formats et regles
- `type` accepte `swim` ou `run`.
- `distance` est en **metres** (nombre > 0).
- Les dates sont en `YYYY-MM-DD`.
- Certaines routes utilisent `limit` et `offset`.

L'API renvoie des erreurs JSON simples: `{ error: "..." }`.

---

## Schema update (Strava)
Ajouts pour l'integration Strava :
```sql
CREATE TABLE IF NOT EXISTS strava_accounts (
  user_id VARCHAR(36) PRIMARY KEY,
  athlete_id BIGINT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_strava_athlete (athlete_id)
);

ALTER TABLE sessions
  ADD COLUMN strava_activity_id BIGINT NULL,
  ADD COLUMN start_datetime DATETIME NULL,
  ADD UNIQUE KEY uniq_strava_activity (strava_activity_id);
```

---

## Schema update (Victory one-shot)
Ajout d'un champ pour memoriser la derniere victoire vue :
```sql
ALTER TABLE users ADD COLUMN last_victory_seen_id VARCHAR(36) NULL;
```

---

## Bots quotidiens

### 1) Sessions bots (bot-daily.js)
Cree une session par bot, chaque jour, avec un jitter de +/- 10%.

Format `bots.json` :
```json
[
  { "id": "uuid-bot", "name": "NicoBot", "distance_m": 5200, "type": "run" },
  { "name": "SwimBot", "distance_m": 1500, "type": "swim" }
]
```

Lancer :
```bash
node bot-daily.js
```

### 2) Defis & evenements (bot-challenges-daily.js)
- 1 defi ou evenement par user et par jour.
- Gestion des dates limites + notifications.
- Si evenement du jour, il ecrase le defi actif.

Lancer :
```bash
node bot-challenges-daily.js
```

---

## Schema DB (resume)

### Tables de base (utilisees par l'API)
- `users` (id, email, name, role, password_hash, is_bot, avg_distance_m, description, shoe_name, shoe_start_date, shoe_target_km, card_image, etc.)
- `sessions` (id, user_id, date, distance, type)

### Cartes, defis, saisons, notifications
Voir `schema-bot-cards.sql` :
- `seasons`
- `user_challenges`
- `user_card_results`
- `notifications`

Statuts `user_challenges` : `active`, `completed`, `expired`, `cancelled`.

### News
Voir `schema-news.sql` :
- `news_items`

### Extensions users (bots)
Ajouts utiles :
```sql
ALTER TABLE users
  ADD COLUMN description TEXT NULL,
  ADD COLUMN avg_distance_m DECIMAL(6,1) NULL,
  ADD COLUMN bot_card_type ENUM('defi','objet','evenement','rare') NULL,
  ADD COLUMN bot_event_date DATE NULL,
  ADD COLUMN bot_drop_rate DECIMAL(6,3) NULL,
  ADD COLUMN bot_target_distance_m DECIMAL(8,1) NULL,
  ADD COLUMN bot_season_int INT NULL;
```

---

## Schema update (timestamps)
Ajout d'un timestamp pour l'ordre intra-jour des sessions :
```sql
ALTER TABLE sessions
  ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;
```

Note: l'heure de validation d'un challenge est deja stockee via `user_card_results.created_at` (exposee par l'API).

## Notes utiles
- `GET /` renvoie `API up` (ping simple).
- La navigation directe en navigateur (mode document) renvoie `204` pour eviter les hits accidentels.
- JWT expire en 14 jours.

---

## Roadmap (idee)
- Seeds + migrations
- Swagger / OpenAPI
- Tests e2e

---

## License
ISC


## Schema update (news show_event_date)
Ajout d un champ show_event_date sur news_items (bool, default 1) pour afficher ou masquer la date dans le front :

