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
