-- ============================================================
-- 迁移：新增 op_log 表（操作日志 / 管理端「审核记录」数据源）
-- 日期：2026-10-02
-- 背景：此前 OpLogAspect 只写 slf4j 日志、不落库 → 管理端查不到任何审核/封禁轨迹。
-- 执行：mysql -uroot -proot kalimba_workshop < src/main/resources/db/migrations/2026-10-02-op-log.sql
-- 幂等：CREATE TABLE IF NOT EXISTS，重复执行安全。
-- 对应：schema.sql 里也有同一定义（新库直接跑 schema.sql 即可，不必再跑本文件）。
-- ============================================================
USE kalimba_workshop;

CREATE TABLE IF NOT EXISTS op_log (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED DEFAULT NULL COMMENT '操作者 id；未登录上下文为 NULL',
  username    VARCHAR(32)  DEFAULT NULL COMMENT '操作者用户名快照（冗余：不怕改名，免 join）',
  action      VARCHAR(64)  NOT NULL COMMENT '操作说明，取自 @OpLog 注解的 value',
  method      VARCHAR(8)   NOT NULL DEFAULT '' COMMENT 'HTTP 方法',
  uri         VARCHAR(255) NOT NULL DEFAULT '' COMMENT '请求 URI（含路径参数，如 /api/admin/posts/12/status）',
  success     TINYINT      NOT NULL DEFAULT 1 COMMENT '1 成功 0 失败',
  error_msg   VARCHAR(255) DEFAULT NULL COMMENT '失败原因（异常 message，已截断）',
  duration_ms INT          DEFAULT NULL COMMENT '耗时毫秒；@OpLog(timing=false) 时为 NULL',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_time (created_at),
  KEY idx_action_time (action, created_at),
  KEY idx_user_time (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='操作日志（AOP 记录写接口；管理端审核记录）';
