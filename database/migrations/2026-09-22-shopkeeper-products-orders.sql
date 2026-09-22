-- =============================================================
-- Shopkeeper mobile — tenant-owned products, orders and order items
-- =============================================================
-- The ERP `products` table is a GLOBAL catalogue with no tenant_id and an
-- inventory/accounting shape (HSN/SAC, GST, valuation method, ledger accounts)
-- that the Shopkeeper app does not use. Exposing it to a mobile tenant would
-- leak every tenant's catalogue, so the Shopkeeper domain gets its own
-- tenant-owned tables instead. Likewise `sales_invoices` / `operations_work_orders`
-- are not tenant-scoped and are not a shop-order service.
--
-- Every table here carries tenant_id and is registered in lib/tenant-tables.ts,
-- so the fail-closed guard in lib/tenant-guard.ts rejects any unscoped query.
--
-- Idempotent: safe to re-run.
-- =============================================================

SET NAMES utf8mb4;

-- -------------------------------------------------------------
-- Products
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shopkeeper_products (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  name VARCHAR(190) NOT NULL,
  sku VARCHAR(64) NULL,
  category VARCHAR(120) NULL,
  description TEXT NULL,
  -- Money as DECIMAL, never FLOAT: binary floats cannot represent 0.10 exactly
  -- and order totals are computed from these.
  price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  offer_price DECIMAL(12,2) NULL,
  currency VARCHAR(8) NOT NULL DEFAULT 'INR',
  image_url VARCHAR(500) NULL,
  stock_status ENUM('in_stock','out_of_stock','low_stock') NOT NULL DEFAULT 'in_stock',
  stock_quantity INT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- SKU is unique per tenant, not globally: two shops may legitimately use "A-1".
  UNIQUE KEY uq_shopkeeper_products_sku (tenant_id, sku),
  KEY idx_shopkeeper_products_tenant_status (tenant_id, status),
  KEY idx_shopkeeper_products_tenant_category (tenant_id, category),
  KEY idx_shopkeeper_products_tenant_created (tenant_id, created_at),
  CONSTRAINT fk_shopkeeper_products_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -------------------------------------------------------------
-- Orders
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shopkeeper_orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  order_number VARCHAR(40) NOT NULL,
  -- INT UNSIGNED to match marketing_whatsapp_contacts.id / _conversations.id;
  -- a wider type here makes the foreign key invalid.
  contact_id INT UNSIGNED NULL,
  conversation_id INT UNSIGNED NULL,
  customer_name VARCHAR(190) NULL,
  customer_phone VARCHAR(40) NULL,
  subtotal DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  discount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  currency VARCHAR(8) NOT NULL DEFAULT 'INR',
  status ENUM('new','processing','completed','cancelled') NOT NULL DEFAULT 'new',
  payment_status ENUM('pending','paid','cod') NOT NULL DEFAULT 'pending',
  delivery_method ENUM('shop_pickup','home_delivery') NOT NULL DEFAULT 'shop_pickup',
  delivery_address VARCHAR(500) NULL,
  notes TEXT NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_shopkeeper_orders_number (tenant_id, order_number),
  KEY idx_shopkeeper_orders_tenant_status (tenant_id, status),
  KEY idx_shopkeeper_orders_tenant_created (tenant_id, created_at),
  KEY idx_shopkeeper_orders_tenant_contact (tenant_id, contact_id),
  KEY idx_shopkeeper_orders_tenant_conversation (tenant_id, conversation_id),
  CONSTRAINT fk_shopkeeper_orders_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  -- Contact/conversation are SET NULL rather than CASCADE: deleting a contact
  -- must never silently destroy financial history.
  CONSTRAINT fk_shopkeeper_orders_contact FOREIGN KEY (contact_id)
    REFERENCES marketing_whatsapp_contacts(id) ON DELETE SET NULL,
  CONSTRAINT fk_shopkeeper_orders_conversation FOREIGN KEY (conversation_id)
    REFERENCES marketing_whatsapp_conversations(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -------------------------------------------------------------
-- Order items
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shopkeeper_order_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  order_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NULL,
  -- Name and unit price are COPIED at order time, not joined at read time, so
  -- renaming or repricing a product never rewrites historical orders.
  product_name VARCHAR(190) NOT NULL,
  sku VARCHAR(64) NULL,
  quantity INT UNSIGNED NOT NULL DEFAULT 1,
  unit_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  line_total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_shopkeeper_order_items_tenant_order (tenant_id, order_id),
  KEY idx_shopkeeper_order_items_tenant_product (tenant_id, product_id),
  CONSTRAINT fk_shopkeeper_order_items_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_shopkeeper_order_items_order FOREIGN KEY (order_id)
    REFERENCES shopkeeper_orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_shopkeeper_order_items_product FOREIGN KEY (product_id)
    REFERENCES shopkeeper_products(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
