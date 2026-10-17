-- ============================================================
-- 迁移：score_file.visibility 的列注释补上 favorite 档
-- 日期：2026-10-03（同一轮迭代的补充）
-- 背景：下载分级新增 `favorite`（收藏这篇帖后可下载），档位顺序
--       login < favorite < follower < author。
--
-- ⚠️ 这次**不需要改结构**：visibility 是 VARCHAR(16)，`favorite` 只有 7 个字符，
--    新档位是纯粹的「多一个合法取值」，任何存量行都不受影响（默认仍是 login）。
--    本脚本只做一件事：把列注释同步成四档，好让 `SHOW FULL COLUMNS` 与 schema.sql 一致 ——
--    注释是这张表自带的口径文档，四档时代还写着三档会误导后来人。
-- 执行：mysql -uroot -proot kalimba_workshop < src/main/resources/db/migrations/2026-10-03-score-visibility-favorite.sql
-- 幂等：先查 information_schema 的 column_comment 是否已含 favorite，含则跳过。
--       ⚠️ MODIFY COLUMN 必须**完整重复**类型/非空/默认值，否则会顺带改掉结构 ——
--          这里的三项与现状严格一致（varchar(16) / NOT NULL / DEFAULT 'login'）。
-- ============================================================
USE kalimba_workshop;

DROP PROCEDURE IF EXISTS kal_score_visibility_comment;

DELIMITER $$
CREATE PROCEDURE kal_score_visibility_comment()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = DATABASE() AND table_name = 'score_file'
                   AND column_name = 'visibility' AND column_comment LIKE '%favorite%') THEN
    ALTER TABLE score_file
      MODIFY COLUMN visibility VARCHAR(16) NOT NULL DEFAULT 'login'
        COMMENT '下载分级 login 登录可下 / favorite 收藏可下 / follower 关注可下 / author 仅作者';
  END IF;
END$$
DELIMITER ;

CALL kal_score_visibility_comment();
DROP PROCEDURE kal_score_visibility_comment;
