-- ============================================================
-- 迁移：post 表新增 blocks（正文块数组）—— 路线 B
-- 日期：2026-10-16
--
-- 背景：正文原先只有 content 一个字段，前端却用 `v-html` 渲染它 ⇒ 存储型 XSS 面
--       （content 原样入库、后端只过敏感词、前端当 HTML 执行）。
--       ⚠️ 而且 Post 实体的注释本来就写着「前端以安全文本 + 换行渲染，**不做富文本 HTML 透传**」——
--          是 PostView 的实现跑偏了，这次是把它改回设计意图。
--
-- 方案（路线 B，与 B 站专栏的 paragraphs[] 同构）：正文改成**块数组**
--   [{ "type": "text",    "text": "…" }
--    { "type": "image",   "url": "/uploads/img/xxx.jpg", "caption": "…" }
--    { "type": "score",   "fileId": "35", "title": "…" }
--    { "type": "divider" }]
--   前端一个 <BlockRenderer> 按 type 渲染 —— 全程 Vue 模板、自动转义 ⇒ **零 XSS**，
--   而且「组件」天然可插（乐谱块直接挂已有的 ScorePreview）。
--
-- 为什么用 MEDIUMTEXT 而不是 TEXT：
--   块数组带类型名与字段名，同样内容会比纯文本膨胀数倍；TEXT 只有 64KB，容易顶到。
--   MEDIUMTEXT（16MB）留足余量。**这也顺便解决了原计划里「20000 字上限要放宽」的问题**——
--   因为块走**独立列**，content 那条 @Size(max=20000) 完全不用动。
--
-- 老数据：blocks 为 NULL ⇒ 前端回退成 content 的纯文本渲染（剥标签 + 保留换行），不迁移。
--
-- 执行：mysql -uroot -proot kalimba_workshop < src/main/resources/db/migrations/2026-10-16-post-blocks.sql
-- 幂等：MySQL 8.0 不支持 ADD COLUMN IF NOT EXISTS，故用存储过程先查 information_schema
--       再决定是否加列；重复执行安全。
-- 对应：schema.sql 里 post 表也已带该列（新库直接跑 schema.sql 即可）。
-- ============================================================
USE kalimba_workshop;

DROP PROCEDURE IF EXISTS kal_add_post_blocks;

DELIMITER $$
CREATE PROCEDURE kal_add_post_blocks()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = DATABASE() AND table_name = 'post'
                   AND column_name = 'blocks') THEN
    ALTER TABLE post
      ADD COLUMN blocks MEDIUMTEXT NULL
        COMMENT '正文块数组（JSON）：[{"type":"text|image|score|divider",...}]；为空回退 content 纯文本'
        AFTER content;
  END IF;
END$$
DELIMITER ;

CALL kal_add_post_blocks();
DROP PROCEDURE kal_add_post_blocks;
