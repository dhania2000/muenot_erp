-- Add the shared workspace modules and their permission-gated features.
INSERT INTO modules (slug, name, description, sort_order)
VALUES
 ('calendar','My Calendar','Personal schedule and shared calendar events',20),
 ('events','Events','Company events and registrations',21),
 ('messages','Messages','Internal team conversations',22),
 ('notice-board','Notice Board','Company announcements and notices',23),
 ('knowledge-base','Knowledge Base','Searchable company knowledge',24),
 ('assets','Assets','Equipment and asset register',25),
 ('biolinks','Biolinks','Shareable profile links',26),
 ('biometric','Biometric','Attendance device and punch records',27),
 ('letter','Letter','Employee letters and documents',28),
 ('monitor-center','Monitor Center','System activity and health monitoring',29)
ON DUPLICATE KEY UPDATE name=VALUES(name), description=VALUES(description);

INSERT INTO features (module_id, slug, name, description)
SELECT m.id, CONCAT(m.slug,'.view'), CONCAT('View ',m.name), CONCAT('Access ',m.name,' workspace')
FROM modules m WHERE m.slug IN ('calendar','events','messages','notice-board','knowledge-base','assets','biolinks','biometric','letter','monitor-center')
ON DUPLICATE KEY UPDATE name=VALUES(name), description=VALUES(description);
