-- ============================================================
-- 迁移：score_file 表补 format（乐谱 JSON 的格式标识）
-- 日期：2026-10-13
-- 背景：2026-10-13 定下「乐谱 JSON 以内核导出格式为**唯一真源**」（kalimba-tab / version 1），
--       帖子页的谱面预览已直接吃内核结构，旧的 kalimba-score 格式**已无任何生成方**
--       （其正主 scoreJson.js 随 Vue SPA 于 2026-10-07 归档）。
--
-- 本表原先只记 version，且 FileService 里那段识别逻辑**只认带引号的字符串**：
--   旧格式  "version": "1.0"  → 命中
--   内核    "version": 1      → 读成空串（数字无引号）
-- 旧格式碰巧是字符串，把坑盖住了 —— 换成内核格式后 version 会恒为空。
-- 本次一并修掉：
--   ① 识别逻辑改为「字符串 / 裸数字都认」（FileService#readEnvelope）；
--   ② 增列 format，让 /api/files/{id}/meta 能告诉前端「这份谱是哪个格式」，
--      前端据此对旧格式附件提示「请在内核里重新导出」，而不是静默渲染成空白谱。
--
-- ⚠️ 默认值 'kalimba-score' 是刻意的：迁移前本表里**只可能**是旧格式一族
--    （内核格式是本次才接进来的），按「默认值取迁移前实际语义」的既有约定取值，
--    老数据因此会被前端正确识别为「旧格式，建议重新导出」。
--    新上传一律由代码显式写入，不吃这个默认值。
--
-- 执行：mysql -uroot -proot kalimba_workshop < src/main/resources/db/migrations/2026-10-13-score-file-format.sql
-- 幂等：MySQL 8.0 不支持 ADD COLUMN IF NOT EXISTS，故用存储过程先查 information_schema
--       再决定是否加列；重复执行安全。
-- 对应：schema.sql 里 score_file 表也已带该列（新库直接跑 schema.sql 即可）。
-- ============================================================
USE kalimba_workshop;

DROP PROCEDURE IF EXISTS kal_add_score_format;

DELIMITER $$
CREATE PROCEDURE kal_add_score_format()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = DATABASE() AND table_name = 'score_file'
                   AND column_name = 'format') THEN
    ALTER TABLE score_file
      ADD COLUMN format VARCHAR(32) NOT NULL DEFAULT 'kalimba-score'
        COMMENT '乐谱 JSON 格式标识 kalimba-tab(内核，唯一真源) / kalimba-score(已废弃)' AFTER version;
  END IF;
END$$
DELIMITER ;

CALL kal_add_score_format();
DROP PROCEDURE kal_add_score_format;
