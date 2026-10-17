-- ============================================================
-- 迁移：score_file 表补 visibility（乐谱附件的下载分级）
-- 日期：2026-10-03
-- 背景：2026-10-03 上一步把「乐谱附件必须登录」这条地基铺好了
--       （SaTokenConfig 按方法收白名单 + WebConfig 堵掉 /uploads/score 静态旁路），
--       但 score_file 表**没有任何可见性字段** → 只能做到「登录就能下」，
--       做不出「关注可下 / 仅作者」这类真正的下载条件。
-- 分级（三档，见 ScoreVisibility.java）：
--   login     登录可下载（默认；与迁移前的实际行为一致，不改动已有数据语义）
--   follower  关注作者后可下载
--   author    仅作者本人（与管理员）可下载
-- 执行：mysql -uroot -proot kalimba_workshop < src/main/resources/db/migrations/2026-10-03-score-file-visibility.sql
-- 幂等：MySQL 8.0 不支持 ADD COLUMN IF NOT EXISTS，故用存储过程先查 information_schema
--       再决定是否加列；重复执行安全。
-- 对应：schema.sql 里 score_file 表也已带该列（新库直接跑 schema.sql 即可）。
-- ============================================================
USE kalimba_workshop;

DROP PROCEDURE IF EXISTS kal_add_score_visibility;

DELIMITER $$
CREATE PROCEDURE kal_add_score_visibility()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = DATABASE() AND table_name = 'score_file'
                   AND column_name = 'visibility') THEN
    -- ⚠️ 默认 'login' 是刻意的：迁移前「登录即可下载」是本表的实际语义，
    --    默认值取它，老数据的行为不会因为这次迁移而改变。
    ALTER TABLE score_file
      ADD COLUMN visibility VARCHAR(16) NOT NULL DEFAULT 'login'
        COMMENT '下载分级 login 登录可下 / follower 关注可下 / author 仅作者' AFTER version;
  END IF;
END$$
DELIMITER ;

CALL kal_add_score_visibility();
DROP PROCEDURE kal_add_score_visibility;
