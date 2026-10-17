-- ============================================================
-- 迁移：user 表补 intro（简介）与 fan_type（琴型键数）
-- 日期：2026-10-02
-- 背景：V3「我的」页（web/user.html）一直有「编辑资料：昵称 / 简介 / 我的琴」弹层，
--       但 user 表没有这两列 → 后端存不下去，api.js 只能把 intro 写死成 ''、
--       fanType 写死成 17，个人主页的三格统计也全是 0。
-- 执行：mysql -uroot -proot kalimba_workshop < src/main/resources/db/migrations/2026-10-02-user-intro-fantype.sql
-- 幂等：MySQL 8.0 不支持 ADD COLUMN IF NOT EXISTS，故用存储过程先查 information_schema 再决定是否加列，
--       重复执行安全（不会因为列已存在而报错）。
-- 对应：schema.sql 里 user 表也已带这两列（新库直接跑 schema.sql 即可）。
-- ============================================================
USE kalimba_workshop;

DROP PROCEDURE IF EXISTS kal_add_user_cols;

DELIMITER $$
CREATE PROCEDURE kal_add_user_cols()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = DATABASE() AND table_name = 'user' AND column_name = 'intro') THEN
    ALTER TABLE `user`
      ADD COLUMN intro VARCHAR(60) DEFAULT NULL COMMENT '一句话简介（个人主页展示）' AFTER avatar;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = DATABASE() AND table_name = 'user' AND column_name = 'fan_type') THEN
    ALTER TABLE `user`
      ADD COLUMN fan_type TINYINT NOT NULL DEFAULT 17 COMMENT '本人琴型键数 17 / 21（个人主页展示）' AFTER intro;
  END IF;
END$$
DELIMITER ;

CALL kal_add_user_cols();
DROP PROCEDURE kal_add_user_cols;
