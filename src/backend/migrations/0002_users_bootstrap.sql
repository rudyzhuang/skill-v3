-- bootstrap flag for default admin protection
ALTER TABLE users ADD COLUMN is_bootstrap INTEGER NOT NULL DEFAULT 0;
