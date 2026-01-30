-- News items (événements spéciaux)
CREATE TABLE IF NOT EXISTS news_items (
  id CHAR(36) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  subtitle VARCHAR(255) NOT NULL,
  city VARCHAR(120) NOT NULL,
  image_url VARCHAR(512) NOT NULL,
  image_focus_y TINYINT NULL,
  link_url VARCHAR(512) NULL,
  event_date DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
