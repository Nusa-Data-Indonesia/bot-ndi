SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='slots' AND column_name='fact_versions') = 0, 'ALTER TABLE slots ADD COLUMN fact_versions JSON NULL AFTER fact_ids', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='slots' AND column_name='content_safety_hash') = 0, 'ALTER TABLE slots ADD COLUMN content_safety_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER fact_versions', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;
