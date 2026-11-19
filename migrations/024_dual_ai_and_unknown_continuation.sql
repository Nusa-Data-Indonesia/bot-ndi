SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='integration_config' AND column_name='reviewer_model') = 0, 'ALTER TABLE integration_config ADD COLUMN reviewer_model VARCHAR(200) NULL AFTER model', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='integration_config' AND column_name='pending_reviewer_model') = 0, 'ALTER TABLE integration_config ADD COLUMN pending_reviewer_model VARCHAR(200) NULL AFTER pending_model', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='integration_config_history' AND column_name='reviewer_model') = 0, 'ALTER TABLE integration_config_history ADD COLUMN reviewer_model VARCHAR(200) NULL AFTER model', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='integration_config_history' AND column_name='pending_model') = 0, 'ALTER TABLE integration_config_history ADD COLUMN pending_model VARCHAR(200) NULL AFTER pending_account_id', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='integration_config_history' AND column_name='pending_reviewer_model') = 0, 'ALTER TABLE integration_config_history ADD COLUMN pending_reviewer_model VARCHAR(200) NULL AFTER pending_model', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

UPDATE integration_config SET pending_reviewer_model=reviewer_model
WHERE status IN ('SWITCHING','BLOCKED_RECONCILIATION') AND pending_reviewer_model IS NULL;

SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='slots' AND column_name='openrouter_reviewer_model') = 0, 'ALTER TABLE slots ADD COLUMN openrouter_reviewer_model VARCHAR(200) NULL', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='slots' AND column_name='business_knowledge_snapshot_json') = 0, 'ALTER TABLE slots ADD COLUMN business_knowledge_snapshot_json JSON NULL', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='slots' AND column_name='business_knowledge_snapshot_version') = 0, 'ALTER TABLE slots ADD COLUMN business_knowledge_snapshot_version BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='slots' AND column_name='generation_settings_snapshot_json') = 0, 'ALTER TABLE slots ADD COLUMN generation_settings_snapshot_json JSON NULL', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='slots' AND column_name='reviewed') = 0, 'ALTER TABLE slots ADD COLUMN reviewed BOOLEAN NOT NULL DEFAULT FALSE', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='slots' AND column_name='review_metadata_json') = 0, 'ALTER TABLE slots ADD COLUMN review_metadata_json JSON NULL', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='slots' AND column_name='unknown_occurrence_count') = 0, 'ALTER TABLE slots ADD COLUMN unknown_occurrence_count INT UNSIGNED NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

CREATE TABLE IF NOT EXISTS slot_content_review_attempts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  slot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sequence_no SMALLINT UNSIGNED NOT NULL,
  phase VARCHAR(24) NOT NULL,
  technical_retry BOOLEAN NOT NULL DEFAULT FALSE,
  decision VARCHAR(16) NULL,
  rationale_code VARCHAR(64) NULL,
  sanitized_draft TEXT NULL,
  violations_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY slot_review_attempt_sequence (slot_id, sequence_no),
  CONSTRAINT slot_review_attempts_slot_fk FOREIGN KEY (slot_id) REFERENCES slots(id) ON DELETE RESTRICT,
  CHECK (phase IN ('generator','reviewer')),
  CHECK (decision IS NULL OR decision IN ('PASS','REVISE','REJECT','ERROR'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS dual_ai_unknown_alert_lock (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY CHECK (id=1)
) ENGINE=InnoDB;
INSERT IGNORE INTO dual_ai_unknown_alert_lock (id) VALUES (1);

CREATE TABLE IF NOT EXISTS publication_unknown_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  slot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  occurrence_no INT UNSIGNED NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  UNIQUE KEY publication_unknown_slot_occurrence (slot_id, occurrence_no),
  INDEX publication_unknown_rolling_window (occurred_at, id),
  CONSTRAINT publication_unknown_events_slot_fk FOREIGN KEY (slot_id) REFERENCES slots(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS publication_unknown_threshold_alerts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  threshold_event_id BIGINT UNSIGNED NOT NULL,
  dedupe_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY publication_unknown_threshold_event (threshold_event_id),
  UNIQUE KEY publication_unknown_threshold_dedupe (dedupe_key),
  CONSTRAINT publication_unknown_threshold_event_fk FOREIGN KEY (threshold_event_id) REFERENCES publication_unknown_events(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO publication_unknown_events (slot_id, occurrence_no, occurred_at)
SELECT id, 1, COALESCE(updated_at, publish_started_at, scheduled_at)
FROM slots WHERE status='unknown';
UPDATE slots SET unknown_occurrence_count=1
WHERE status='unknown' AND unknown_occurrence_count=0;
