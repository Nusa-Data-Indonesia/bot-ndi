SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='settings' AND column_name='business_knowledge_version') = 0, 'ALTER TABLE settings ADD COLUMN business_knowledge_version INT UNSIGNED NOT NULL DEFAULT 1', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

CREATE TABLE IF NOT EXISTS website_sync_runs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  requested_by BIGINT UNSIGNED NULL,
  source_url VARCHAR(2048) NOT NULL,
  knowledge_version INT UNSIGNED NOT NULL,
  status ENUM('running','completed','failed') NOT NULL DEFAULT 'running',
  proposal_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  error_code VARCHAR(64) NULL,
  fetched_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT website_sync_runs_requester_fk FOREIGN KEY (requested_by) REFERENCES admins(id) ON DELETE SET NULL,
  INDEX website_sync_runs_created (created_at, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS website_sync_proposals (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  sync_run_id CHAR(36) NOT NULL,
  knowledge_version INT UNSIGNED NOT NULL,
  field_name VARCHAR(32) NOT NULL DEFAULT 'services',
  operation ENUM('add','edit','remove') NOT NULL,
  target_value VARCHAR(300) NOT NULL,
  base_value VARCHAR(300) NULL,
  source_url VARCHAR(2048) NOT NULL,
  source_title VARCHAR(200) NOT NULL,
  fetched_at DATETIME(3) NOT NULL,
  status ENUM('pending','approved','rejected','conflict') NOT NULL DEFAULT 'pending',
  conflict_code VARCHAR(64) NULL,
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT website_sync_proposals_run_fk FOREIGN KEY (sync_run_id) REFERENCES website_sync_runs(id) ON DELETE CASCADE,
  CONSTRAINT website_sync_proposals_reviewer_fk FOREIGN KEY (reviewed_by) REFERENCES admins(id) ON DELETE SET NULL,
  INDEX website_sync_proposals_status (status, created_at, id),
  INDEX website_sync_proposals_run (sync_run_id, id)
) ENGINE=InnoDB;
