-- ============================================================
-- 迁移：comment 表补 status（评论软删 / 下架）
-- 日期：2026-10-10
-- 背景（缺口 B2）：评论原先**没有任何状态字段** —— 举报一条评论后，管理员唯一的
--       处置手段是「物理删除」（`DELETE /api/posts/{postId}/comments/{id}`，admin 可删
--       任意评论，见 CommentService.delete）。删掉就找不回来，做不到
--       「先下架、复核之后再决定是否彻底删」。
-- 取值（与 user.status 的二元语义保持一致，刻意不用 post 的三态）：
--   1  正常      默认。迁移前「评论一律可见」是本表的实际语义，取 1 作默认值，
--                老数据的可见性不会因为这次迁移而改变。
--   0  已下架    软删：公开列表（GET /api/posts/{postId}/comments）不再返回，
--                数据保留，管理员可随时恢复。
-- 执行：mysql -uroot -proot kalimba_workshop < src/main/resources/db/migrations/2026-10-10-comment-status.sql
-- 幂等：MySQL 8.0 不支持 ADD COLUMN IF NOT EXISTS，故用存储过程先查 information_schema
--       再决定是否加列；重复执行安全。
-- 对应：schema.sql 里 comment 表也已带该列（新库直接跑 schema.sql 即可）。
-- 索引：未加 `(post_id, status, created_at)` 组合索引 —— 现有 idx_post (post_id, created_at)
--       已能定位到帖子维度，status 只是回表后的一个过滤条件；评论量级下不值得多一个索引。
-- ============================================================
USE kalimba_workshop;

DROP PROCEDURE IF EXISTS kal_add_comment_status;

DELIMITER $$
CREATE PROCEDURE kal_add_comment_status()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = DATABASE() AND table_name = 'comment'
                   AND column_name = 'status') THEN
    ALTER TABLE comment
      ADD COLUMN status TINYINT NOT NULL DEFAULT 1
        COMMENT '1 正常 / 0 已下架（软删，可恢复）' AFTER content;
  END IF;
END$$
DELIMITER ;

CALL kal_add_comment_status();
DROP PROCEDURE kal_add_comment_status;
