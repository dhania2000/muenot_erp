-- Adds a column to track the start of the currently open work session so a
-- single day can hold multiple clock-in / clock-out cycles in one row. Worked
-- hours accumulate per session in `working_hours`; the gaps between sessions
-- (breaks) are stored in `break_minutes` and never counted as worked time.
-- The app also creates this column at runtime if it is missing, so running
-- this migration is optional but recommended for fresh setups.
ALTER TABLE `hr_attendance` ADD COLUMN `active_since` DATETIME NULL DEFAULT NULL AFTER `clock_out`;
