CREATE TABLE IF NOT EXISTS content_categories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(80) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  guidance TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  archived_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS content_styles (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(80) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  instructions TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  archived_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS content_strategy_settings (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_by BIGINT UNSIGNED NULL,
  enabled_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT content_strategy_enabled_by_fk FOREIGN KEY (enabled_by) REFERENCES admins(id) ON DELETE SET NULL
) ENGINE=InnoDB;

INSERT IGNORE INTO content_strategy_settings (id, enabled) VALUES (1, FALSE);

CREATE TABLE IF NOT EXISTS category_proposal_settings (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  interval_days SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  next_run_at DATETIME(3) NULL,
  lease_token CHAR(36) NULL,
  lease_until DATETIME(3) NULL,
  last_started_at DATETIME(3) NULL,
  last_completed_at DATETIME(3) NULL,
  last_error_code VARCHAR(64) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT category_proposal_interval_days CHECK (interval_days BETWEEN 30 AND 365)
) ENGINE=InnoDB;

INSERT IGNORE INTO category_proposal_settings (id, enabled, interval_days) VALUES (1, FALSE, 30);

CREATE TABLE IF NOT EXISTS category_proposals (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  guidance TEXT NOT NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  source VARCHAR(32) NOT NULL DEFAULT 'openrouter',
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT category_proposals_reviewer_fk FOREIGN KEY (reviewed_by) REFERENCES admins(id) ON DELETE SET NULL,
  INDEX category_proposals_status_created (status, created_at, id)
) ENGINE=InnoDB;

SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='slots' AND column_name='content_category_id') = 0, 'ALTER TABLE slots ADD COLUMN content_category_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='slots' AND column_name='content_style_id') = 0, 'ALTER TABLE slots ADD COLUMN content_style_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='slots' AND column_name='content_strategy_json') = 0, 'ALTER TABLE slots ADD COLUMN content_strategy_json JSON NULL', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='slots' AND column_name='provider_published_at') = 0, 'ALTER TABLE slots ADD COLUMN provider_published_at DATETIME(3) NULL', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='slots' AND index_name='slots_strategy_published_order') = 0, 'CREATE INDEX slots_strategy_published_order ON slots (status, provider_published_at, id)', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

INSERT IGNORE INTO content_categories (slug, name, guidance) VALUES
  ('edukasi-data-teknologi', 'Edukasi Data & Teknologi', 'Jelaskan satu konsep data atau teknologi dengan bahasa Indonesia yang mudah dipahami dan contoh umum yang tidak mengaku sebagai pengalaman klien.'),
  ('solusi-masalah-bisnis', 'Solusi Masalah Bisnis', 'Angkat masalah proses atau informasi yang umum. Jelaskan pendekatan yang mungkin membantu tanpa menjanjikan hasil atau mengarang kasus nyata.'),
  ('pengenalan-ndi', 'Pengenalan NDI', 'Perkenalkan cara pandang, tujuan, atau layanan Nusa Data Indonesia hanya berdasarkan knowledge bisnis yang disetujui.'),
  ('produk-ndi', 'Produk NDI', 'Bahas produk NDI berdasarkan status yang tercatat. NDI Ticketing hanya produk dalam pengembangan dan pilot undangan untuk triase dukungan pelanggan.'),
  ('insight-startup', 'Insight Startup', 'Bagikan pertanyaan atau praktik umum yang relevan bagi startup tanpa mengklaim hasil atau pengalaman khusus NDI.'),
  ('studi-kasus-hipotetis', 'Studi Kasus Hipotetis', 'Jika memakai skenario rekaan, mulai caption dengan kata Ilustrasi: dan jangan menyiratkan bahwa itu klien atau proyek nyata.'),
  ('soft-selling', 'Soft-selling', 'Hubungkan tantangan umum dengan layanan NDI secara konsultatif, relevan, dan tanpa tekanan atau klaim yang tidak disetujui.'),
  ('engagement', 'Engagement', 'Ajukan pertanyaan terbuka yang relevan untuk mengundang percakapan profesional, jangan meminta data sensitif.');

INSERT IGNORE INTO content_styles (slug, name, instructions) VALUES
  ('korporat-profesional', 'Korporat profesional', 'Gunakan bahasa profesional, jelas, ringkas, dan terpercaya. Hindari jargon yang tidak dijelaskan.'),
  ('edukatif-sederhana', 'Edukatif sederhana', 'Jelaskan ide secara bertahap dengan kata umum dan satu gagasan utama. Jangan menyederhanakan hingga mengubah fakta.'),
  ('teknis-informatif', 'Teknis informatif', 'Sampaikan detail teknis seperlunya dengan istilah yang tepat dan konteks ringkas. Jangan menambah spesifikasi yang tidak tersedia.'),
  ('storytelling-masalah-bisnis', 'Storytelling masalah bisnis', 'Mulai dari situasi umum, uraikan masalah, lalu tawarkan sudut pandang. Skenario rekaan wajib diawali Ilustrasi:.'),
  ('soft-selling-konsultatif', 'Soft-selling konsultatif', 'Gunakan nada membantu dan ajakan berdiskusi yang wajar. Jangan menjanjikan hasil atau memberi kesan penjualan agresif.'),
  ('conversational', 'Conversational', 'Gunakan Bahasa Indonesia yang hangat dan alami, tetap profesional, dan akhiri dengan undangan percakapan yang relevan.'),
  ('problem-solving', 'Problem solving', 'Susun masalah, satu pendekatan yang mungkin, dan pertanyaan tindak lanjut. Tandai kemungkinan sebagai kemungkinan, bukan hasil terbukti.');
