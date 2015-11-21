/* Create the users table */
CREATE TABLE IF NOT EXISTS users
(
 user_id BIGSERIAL PRIMARY KEY,
 user_name TEXT NOT NULL,
 password_hash TEXT NOT NULL,
 is_admin BOOLEAN NOT NULL
);

/* Create a default admin user with default password 'supreme-power' */
INSERT INTO users
    (user_name, password_hash, is_admin)
SELECT 'admin', '$2a$10$eba/S505uxf9qmiG5AXP5uwt6Oftogo0i/oWoSACSC0qnCz9Gqb4i', true
WHERE
    NOT EXISTS (
            SELECT user_name FROM users WHERE user_name = 'admin'
            );
