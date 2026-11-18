SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='settings' AND column_name='business_knowledge_json') = 0, 'ALTER TABLE settings ADD COLUMN business_knowledge_json JSON NULL', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='settings' AND column_name='business_knowledge_approved') = 0, 'ALTER TABLE settings ADD COLUMN business_knowledge_approved BOOLEAN NOT NULL DEFAULT FALSE', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='settings' AND column_name='legacy_business_settings_json') = 0, 'ALTER TABLE settings ADD COLUMN legacy_business_settings_json JSON NULL', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='settings' AND column_name='legacy_business_knowledge_json') = 0, 'ALTER TABLE settings ADD COLUMN legacy_business_knowledge_json JSON NULL', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

SET @bot_ndi_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='slots' AND column_name='cta_url') = 0, 'ALTER TABLE slots ADD COLUMN cta_url VARCHAR(2048) NULL', 'SELECT 1');
PREPARE bot_ndi_migration_stmt FROM @bot_ndi_ddl;
EXECUTE bot_ndi_migration_stmt;
DEALLOCATE PREPARE bot_ndi_migration_stmt;

UPDATE settings
SET legacy_business_settings_json=COALESCE(legacy_business_settings_json,settings_json),
    legacy_business_knowledge_json=COALESCE(legacy_business_knowledge_json,knowledge_json),
    business_knowledge_json=COALESCE(business_knowledge_json,JSON_OBJECT(
      'companyName','Nusa Data Indonesia',
      'positioning','A data technology company. Built around useful decisions.',
      'description','Nusa Data Indonesia berfokus pada pengembangan teknologi data dan produk perangkat lunak sendiri. Kami berangkat dari informasi yang dimiliki orang dan organisasi untuk membantu mereka mengambil keputusan yang dibutuhkan. NDI Ticketing merupakan salah satu penerapan dari fokus yang lebih luas ini.',
      'vision','Membantu orang dan organisasi mengubah informasi menjadi pemahaman dan keputusan yang lebih baik.',
      'mission','Mengembangkan teknologi data dan produk perangkat lunak dengan memahami masalah nyata, menata informasi sesuai konteks, dan mengevaluasi seberapa baik hasilnya mendukung penggunanya.',
      'primaryAudience','Pendiri startup, perusahaan, dan organisasi (B2B).',
      'secondaryAudience','UMKM, pelajar, mahasiswa, pengembang, dan komunitas teknologi.',
      'services',JSON_ARRAY('Pengembangan perangkat lunak kustom','Sistem informasi','Analitik data','Dashboard','Pengembangan dan integrasi API','Konsultasi teknologi','Sistem dan solusi sesuai kebutuhan klien'),
      'ticketing','NDI Ticketing adalah produk dalam pengembangan yang ditampilkan sebagai portofolio pengembangan, dengan MVP pilot undangan untuk triase dukungan pelanggan. Produk ini bukan SaaS tiket acara yang tersedia untuk pembelian umum.',
      'contentGuidance','Utamakan kesadaran merek dan percakapan prospek yang relevan. Tulis dalam Bahasa Indonesia dengan nada berguna, autentik, dan membangun kepercayaan. Jelaskan layanan, masalah yang dapat dibantu, dan potensi nilai tanpa menyatakan hasil yang belum terbukti.',
      'approvedClaims',JSON_ARRAY(),
      'forbiddenClaims',JSON_ARRAY('kami telah membantu banyak klien','dipercaya oleh banyak klien','hasil terukur dari klien','berpengalaman selama bertahun-tahun','bersertifikat resmi','jaminan hasil','studi kasus klien','harga resmi NDI Ticketing','refund NDI Ticketing','NDI Ticketing tersedia untuk umum','NDI Ticketing untuk tiket acara','SaaS tiket acara'),
      'ctaUrl','https://nusadataindonesia.com'
    ));

UPDATE settings
SET settings_json=JSON_SET(JSON_REMOVE(settings_json,'$.brand','$.guardrails','$.gameWhitelist','$.priceMode','$.trackedLinks','$.hashtags'), '$.hashtags', JSON_ARRAY(), '$.onboardingComplete', FALSE),
    knowledge_json=JSON_OBJECT()
WHERE id=1;
