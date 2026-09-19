-- image_after in 0001 was ported from the base64-blob column in app/lib/db.ts.
-- Here images live in R2 and only the object key is stored, so it gets its
-- own column rather than overloading the old one with a different meaning.
ALTER TABLE experiments ADD COLUMN image_after_key TEXT;
