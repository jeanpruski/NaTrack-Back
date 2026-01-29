-- Bot cards + challenges + notifications
-- Users table: bot metadata
ALTER TABLE users
  ADD COLUMN bot_card_type ENUM('defi','objet','evenement','rare') NULL,
  ADD COLUMN bot_event_date DATE NULL,
  ADD COLUMN bot_drop_rate DECIMAL(6,3) NULL,
  ADD COLUMN bot_target_distance_m DECIMAL(8,1) NULL,
  ADD COLUMN bot_season_int INT NULL;

-- Active challenges (one per user max)
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

-- All wins (can be multiple for same bot)
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

-- Notifications
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
