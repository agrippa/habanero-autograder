/* Create the users table */
CREATE TABLE IF NOT EXISTS users
(
 user_id BIGSERIAL PRIMARY KEY,
 user_name TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL,
 is_admin BOOLEAN NOT NULL,
 receive_email_notifications BOOLEAN NOT NULL DEFAULT TRUE
);

/* Create a default admin user with default password 'supreme-power' */
INSERT INTO users
    (user_name, password_hash, is_admin)
SELECT 'admin', '$2a$10$eba/S505uxf9qmiG5AXP5uwt6Oftogo0i/oWoSACSC0qnCz9Gqb4i', true
WHERE
    NOT EXISTS (
            SELECT user_name FROM users WHERE user_name = 'admin'
            );

CREATE TABLE IF NOT EXISTS assignments
(
 assignment_id BIGSERIAL PRIMARY KEY,
 name TEXT NOT NULL UNIQUE,
 visible BOOLEAN NOT NULL,
 correctness_only BOOLEAN NOT NULL DEFAULT TRUE,
 jvm_args TEXT NOT NULL DEFAULT '',
 correctness_timeout_ms INTEGER NOT NULL DEFAULT 1200000,
 performance_timeout_str TEXT NOT NULL DEFAULT '00:10:00',
 ncores TEXT NOT NULL DEFAULT '16',
 custom_slurm_flags TEXT NOT NULL DEFAULT '',
 n_nodes TEXT NOT NULL DEFAULT '1',
 deadline TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS runs
(
 run_id BIGSERIAL PRIMARY KEY,
 user_id BIGSERIAL,
 assignment_id BIGSERIAL,
 done_token TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL,
 job_id TEXT,
 correctness_only BOOLEAN NOT NULL DEFAULT FALSE,
 enable_profiling BOOLEAN NOT NULL DEFAULT FALSE,
 viola_msg TEXT NOT NULL DEFAULT '',
 cello_msg TEXT NOT NULL DEFAULT '',
 ncores TEXT NOT NULL DEFAULT '16',
 passed_checkstyle BOOLEAN NOT NULL DEFAULT FALSE,
 compiled BOOLEAN NOT NULL DEFAULT FALSE,
 passed_all_correctness BOOLEAN NOT NULL DEFAULT FALSE,
 passed_performance BOOLEAN NOT NULL DEFAULT FALSE,
 start_time TIMESTAMP DEFAULT current_timestamp,
 finish_time TIMESTAMP,
 on_behalf_of INTEGER,
 characteristic_speedup TEXT NOT NULL DEFAULT '',
 tag TEXT NOT NULL DEFAULT ''
);
