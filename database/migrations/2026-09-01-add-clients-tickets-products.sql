INSERT INTO modules (slug, name, description, sort_order)
VALUES
 ('clients','Clients','Client profiles and account relationships',30),
 ('tickets','Tickets','Support requests and service work',31),
 ('products','Products','Product catalog, pricing, and inventory',32)
ON DUPLICATE KEY UPDATE name=VALUES(name), description=VALUES(description), sort_order=VALUES(sort_order);

INSERT INTO features (module_id, slug, name, description)
SELECT m.id, CONCAT(m.slug,'.view_dashboard'), 'View Dashboard', CONCAT('Access ', m.name, ' dashboard')
FROM modules m WHERE m.slug IN ('clients','tickets','products')
ON DUPLICATE KEY UPDATE name=VALUES(name), description=VALUES(description);

INSERT INTO features (module_id, slug, name, description)
SELECT m.id, CONCAT(m.slug,'.view_', CASE m.slug WHEN 'clients' THEN 'clients' WHEN 'tickets' THEN 'tickets' ELSE 'products' END), CONCAT('View ', m.name), CONCAT('View ', m.name, ' records')
FROM modules m WHERE m.slug IN ('clients','tickets','products')
ON DUPLICATE KEY UPDATE name=VALUES(name), description=VALUES(description);
