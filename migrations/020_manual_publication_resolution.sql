SET @bot_ndi_expected_legacy_status_check = '(statusin(''pending'',''generating'',''ready'',''publishing'',''published'',''partial'',''failed'',''unknown'',''canceled'',''skipped''))';
SET @bot_ndi_expected_new_status_check = '(statusin(''pending'',''generating'',''ready'',''publishing'',''published'',''partial'',''failed'',''unknown'',''canceled'',''skipped'',''admin_closed_unknown''))';
SET @bot_ndi_status_check = 'ADD CONSTRAINT slots_status_allowed CHECK (status IN (''pending'', ''generating'', ''ready'', ''publishing'', ''published'', ''partial'', ''failed'', ''unknown'', ''canceled'', ''skipped'', ''admin_closed_unknown''))';
SET @bot_ndi_new_status_check_count = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.CHECK_CONSTRAINTS cc
    ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA=DATABASE() AND tc.TABLE_NAME='slots' AND tc.CONSTRAINT_NAME='slots_status_allowed'
    AND tc.CONSTRAINT_TYPE='CHECK'
    AND REPLACE(REPLACE(REPLACE(REPLACE(LOWER(cc.CHECK_CLAUSE), '`', ''), '_utf8mb4', ''), ' ', ''), CHAR(92), '') = @bot_ndi_expected_new_status_check
);
SET @bot_ndi_legacy_status_checks = (
  SELECT GROUP_CONCAT(CONCAT('DROP CHECK `', REPLACE(tc.CONSTRAINT_NAME, '`', '``'), '`') ORDER BY tc.CONSTRAINT_NAME SEPARATOR ', ')
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.CHECK_CONSTRAINTS cc
    ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_SCHEMA=DATABASE() AND tc.TABLE_NAME='slots' AND tc.CONSTRAINT_TYPE='CHECK'
    AND REPLACE(REPLACE(REPLACE(REPLACE(LOWER(cc.CHECK_CLAUSE), '`', ''), '_utf8mb4', ''), ' ', ''), CHAR(92), '') = @bot_ndi_expected_legacy_status_check
);
SET @bot_ndi_unexpected_status_check_count = (
  SELECT COUNT(*) FROM (
    SELECT REPLACE(REPLACE(REPLACE(REPLACE(LOWER(cc.CHECK_CLAUSE), '`', ''), '_utf8mb4', ''), ' ', ''), CHAR(92), '') AS normalized_clause
    FROM information_schema.TABLE_CONSTRAINTS tc
    JOIN information_schema.CHECK_CONSTRAINTS cc
      ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
    WHERE tc.CONSTRAINT_SCHEMA=DATABASE() AND tc.TABLE_NAME='slots' AND tc.CONSTRAINT_TYPE='CHECK'
  ) slot_checks
  WHERE LOCATE('status', normalized_clause) > 0
    AND normalized_clause NOT IN (@bot_ndi_expected_legacy_status_check, @bot_ndi_expected_new_status_check)
);
SET @bot_ndi_ddl = IF(@bot_ndi_unexpected_status_check_count > 0,
  'SELECT bot_ndi_migration_020_unrecognized_slots_status_check',
  IF(@bot_ndi_new_status_check_count > 0 AND @bot_ndi_legacy_status_checks IS NULL,
    'SELECT 1',
    CONCAT('ALTER TABLE slots ', COALESCE(@bot_ndi_legacy_status_checks, ''),
      IF(@bot_ndi_legacy_status_checks IS NOT NULL AND @bot_ndi_new_status_check_count = 0, ', ', ''),
      IF(@bot_ndi_new_status_check_count = 0, @bot_ndi_status_check, ''))
  )
);
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

CREATE TABLE IF NOT EXISTS publication_resolution_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  slot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action VARCHAR(32) NOT NULL,
  actor_id BIGINT UNSIGNED NOT NULL,
  actor_email VARCHAR(254),
  previous_status VARCHAR(24) NOT NULL,
  new_status VARCHAR(24) NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  evidence_summary VARCHAR(2000) NOT NULL,
  profile_id VARCHAR(128),
  account_id VARCHAR(128),
  provider_post_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX publication_resolution_slot (slot_id, created_at),
  FOREIGN KEY (slot_id) REFERENCES slots(id) ON DELETE RESTRICT,
  CHECK (action IN ('close_unverified', 'link_provider_post')),
  CHECK (action='close_unverified' OR (profile_id IS NOT NULL AND account_id IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS automation_provider_holds (
  provider VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scope_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  profile_id VARCHAR(128),
  account_id VARCHAR(128),
  reason_code VARCHAR(64) NOT NULL,
  slot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  cleared_at DATETIME(3),
  cleared_by BIGINT UNSIGNED,
  PRIMARY KEY (provider, scope_key),
  INDEX provider_holds_active (active, provider),
  CHECK (provider IN ('openrouter', 'tebar')),
  CHECK ((provider='openrouter' AND profile_id IS NULL AND account_id IS NULL) OR (provider='tebar' AND profile_id IS NOT NULL AND account_id IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
