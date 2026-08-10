-- Keep the persistent Worker credential recoverable for its owner without
-- storing the bearer secret as plaintext. The encryption key lives in a
-- Cloudflare Secret and is never written to D1 or returned to a browser.

ALTER TABLE worker_registrations ADD COLUMN credential_ciphertext TEXT;
