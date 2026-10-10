/*
# Demo data schema for "Bean There" coffee chain (Ask Your Data)

1. New Schema
   - `demo` schema holding all bundled demo data for the app.

2. New Tables
   - `demo.stores`   - 12 coffee chain locations (id, city, state, opened_on, sqft).
   - `demo.products` - 20 products (id, name, category, price_usd).
   - `demo.orders`   - about 5,200 order line items from Jan 1 to Sep 30 2026
     (id, store_id fk, product_id fk, quantity, ordered_at, channel).

3. Security
   - Static synthetic demo data; no RLS needed. anon and authenticated roles
     get SELECT only, so the SQL runner and Data API can read but not modify.
*/

CREATE SCHEMA IF NOT EXISTS demo;

CREATE TABLE IF NOT EXISTS demo.stores (
  id        int PRIMARY KEY,
  city      text NOT NULL,
  state     text NOT NULL,
  opened_on date NOT NULL,
  sqft      int  NOT NULL
);

CREATE TABLE IF NOT EXISTS demo.products (
  id        int PRIMARY KEY,
  name      text NOT NULL,
  category  text NOT NULL CHECK (category IN ('coffee','tea','pastry','merch')),
  price_usd numeric(6,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS demo.orders (
  id         int PRIMARY KEY,
  store_id   int NOT NULL REFERENCES demo.stores(id),
  product_id int NOT NULL REFERENCES demo.products(id),
  quantity   int NOT NULL CHECK (quantity BETWEEN 1 AND 5),
  ordered_at timestamptz NOT NULL,
  channel    text NOT NULL CHECK (channel IN ('in_store','mobile','delivery'))
);

CREATE INDEX IF NOT EXISTS idx_orders_ordered_at ON demo.orders (ordered_at);
CREATE INDEX IF NOT EXISTS idx_orders_store_id   ON demo.orders (store_id);
CREATE INDEX IF NOT EXISTS idx_orders_product_id ON demo.orders (product_id);

INSERT INTO demo.stores (id, city, state, opened_on, sqft) VALUES
  (1,  'Denver',      'CO', '2018-03-14', 1450),
  (2,  'Boulder',     'CO', '2019-06-02',  980),
  (3,  'Seattle',     'WA', '2017-11-20', 1750),
  (4,  'Portland',    'OR', '2018-08-09', 1200),
  (5,  'Austin',      'TX', '2020-01-15', 1600),
  (6,  'San Diego',   'CA', '2019-04-22', 1350),
  (7,  'Phoenix',     'AZ', '2021-02-08', 1100),
  (8,  'Minneapolis', 'MN', '2020-09-30', 1050),
  (9,  'Chicago',     'IL', '2017-05-11', 1900),
  (10, 'Nashville',   'TN', '2021-07-19', 1250),
  (11, 'Miami',       'FL', '2022-03-27', 1400),
  (12, 'Brooklyn',    'NY', '2018-10-05', 1300)
ON CONFLICT (id) DO NOTHING;

INSERT INTO demo.products (id, name, category, price_usd) VALUES
  (1,  'House Blend Drip',   'coffee',  3.25),
  (2,  'Latte',              'coffee',  4.75),
  (3,  'Cappuccino',         'coffee',  4.50),
  (4,  'Cold Brew',          'coffee',  4.95),
  (5,  'Iced Vanilla Latte', 'coffee',  5.50),
  (6,  'Espresso Doppio',    'coffee',  3.75),
  (7,  'Caramel Macchiato',  'coffee',  5.25),
  (8,  'Matcha Latte',       'tea',     5.75),
  (9,  'Earl Grey',          'tea',     3.50),
  (10, 'Chai Latte',         'tea',     4.95),
  (11, 'Iced Green Tea',     'tea',     4.25),
  (12, 'Butter Croissant',   'pastry',  3.95),
  (13, 'Blueberry Muffin',   'pastry',  3.75),
  (14, 'Cinnamon Roll',      'pastry',  4.50),
  (15, 'Avocado Toast',      'pastry',  8.95),
  (16, 'Lemon Loaf',         'pastry',  3.95),
  (17, 'Ceramic Mug',        'merch',  14.00),
  (18, 'Travel Tumbler',     'merch',  24.00),
  (19, 'Coffee Beans 12oz',  'merch',  16.50),
  (20, 'Logo Tote Bag',      'merch',  18.00)
ON CONFLICT (id) DO NOTHING;

-- Orders: id g maps to a timestamp spread over Jan 1 - Sep 30 2026.
-- Summer months (6-8) shift picks toward iced/cold drinks.
-- Mobile share ramps from 25 percent in Jan to 45 percent in Sep.
INSERT INTO demo.orders (id, store_id, product_id, quantity, ordered_at, channel)
SELECT
  g,
  1 + floor(r.r1 * 12)::int,
  CASE
    WHEN extract(month from t.ts) BETWEEN 6 AND 8 AND r.r4 < 0.45
      THEN (ARRAY[4,5,8,11])[1 + floor(r.r2 * 4)::int]
    ELSE 1 + floor(r.r3 * 20)::int
  END,
  CASE WHEN r.r1 < 0.6 THEN 1 ELSE 1 + floor(r.r2 * 3)::int END,
  t.ts,
  CASE
    WHEN r.r2 < ms.share THEN 'mobile'
    WHEN r.r2 < ms.share + 0.08 THEN 'delivery'
    ELSE 'in_store'
  END
FROM generate_series(1, 5200) g
CROSS JOIN LATERAL (
  SELECT random() AS r1, random() AS r2, random() AS r3, random() AS r4
) r
CROSS JOIN LATERAL (
  SELECT '2026-01-01'::timestamptz
         + ((g * 72 + floor(r.r3 * 71))::text || ' minutes')::interval AS ts
) t
CROSS JOIN LATERAL (
  SELECT 0.25
         + extract(epoch from (t.ts - '2026-01-01'::timestamptz))
           / extract(epoch from interval '9 months') * 0.20 AS share
) ms
WHERE NOT EXISTS (SELECT 1 FROM demo.orders);

GRANT USAGE ON SCHEMA demo TO anon, authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA demo TO anon, authenticated;
