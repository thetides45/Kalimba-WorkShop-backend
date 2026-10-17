-- ============================================================
-- 卡林巴社区工坊 数据库建表脚本（MySQL 8.0）
-- 对应规划书 表 3-4 核心数据表设计
-- 字符集统一 utf8mb4，InnoDB
-- ============================================================

CREATE DATABASE IF NOT EXISTS kalimba_workshop
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE kalimba_workshop;

-- ---------- 用户 ----------
CREATE TABLE IF NOT EXISTS `user` (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username      VARCHAR(32)  NOT NULL COMMENT '登录名',
  password_hash VARCHAR(100) NOT NULL COMMENT 'BCrypt 哈希',
  nickname      VARCHAR(32)  NOT NULL COMMENT '昵称',
  avatar        VARCHAR(2048)         DEFAULT NULL COMMENT '头像地址',
  intro         VARCHAR(60)           DEFAULT NULL COMMENT '一句话简介（个人主页展示）',
  fan_type      TINYINT      NOT NULL DEFAULT 17 COMMENT '本人琴型键数 17 / 21（个人主页展示）',
  role          VARCHAR(16)  NOT NULL DEFAULT 'user' COMMENT 'user / admin',
  status        TINYINT      NOT NULL DEFAULT 1 COMMENT '1 正常 0 封禁',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户';

-- ---------- 帖子 ----------
CREATE TABLE IF NOT EXISTS post (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NOT NULL,
  title          VARCHAR(80)  NOT NULL,
  content        TEXT         NULL COMMENT '图文正文（纯文本，不做 HTML 透传）',
  blocks         MEDIUMTEXT   NULL COMMENT '正文块数组（JSON）：[{"type":"text|image|score|divider",...}]；为空回退 content',
  cover          VARCHAR(2048) DEFAULT NULL,
  tag_ids        VARCHAR(255) DEFAULT '' COMMENT '逗号分隔标签 id',
  score_file_id  BIGINT UNSIGNED DEFAULT NULL COMMENT '乐谱附件 id',
  view_count     INT          NOT NULL DEFAULT 0,
  like_count     INT          NOT NULL DEFAULT 0,
  status         TINYINT      NOT NULL DEFAULT 1 COMMENT '0 审核 1 正常 2 下架 3 草稿（仅作者可见）',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_user_time (user_id, created_at),
  KEY idx_status_time (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='帖子';

-- ---------- 评论与回复 ----------
CREATE TABLE IF NOT EXISTS comment (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  post_id    BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  parent_id  BIGINT UNSIGNED DEFAULT NULL COMMENT '一级评论 id；NULL 即一级',
  content    VARCHAR(2000) NOT NULL,
  status     TINYINT      NOT NULL DEFAULT 1 COMMENT '1 正常 / 0 已下架（软删，可恢复）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_post (post_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='评论';

-- ---------- 点赞记录 ----------
CREATE TABLE IF NOT EXISTS like_record (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  target_type VARCHAR(16) NOT NULL COMMENT 'post / comment',
  target_id   BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_target (user_id, target_type, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='点赞记录';

-- ---------- 收藏 ----------
CREATE TABLE IF NOT EXISTS favorite (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  post_id    BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_post (user_id, post_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='收藏';

-- ---------- 关注 ----------
CREATE TABLE IF NOT EXISTS follow (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  follower_id BIGINT UNSIGNED NOT NULL,
  followee_id BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_follow (follower_id, followee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='关注关系';

-- ---------- 标签 ----------
CREATE TABLE IF NOT EXISTS tag (
  id       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name     VARCHAR(32) NOT NULL,
  category VARCHAR(32) NOT NULL DEFAULT '' COMMENT '分类：曲谱/教程/求谱…',
  PRIMARY KEY (id),
  UNIQUE KEY uk_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='标签';

-- ---------- 乐谱附件 ----------
CREATE TABLE IF NOT EXISTS score_file (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_id   BIGINT UNSIGNED NOT NULL,
  file_name  VARCHAR(255) NOT NULL,
  file_path  VARCHAR(512) NOT NULL,
  size       BIGINT UNSIGNED NOT NULL DEFAULT 0,
  version    VARCHAR(32) NOT NULL DEFAULT '' COMMENT '乐谱 JSON 格式版本',
  format     VARCHAR(32) NOT NULL DEFAULT 'kalimba-score' COMMENT '乐谱 JSON 格式标识 kalimba-tab(内核，唯一真源) / kalimba-score(已废弃)',
  visibility VARCHAR(16) NOT NULL DEFAULT 'login' COMMENT '下载分级 login 登录可下 / favorite 收藏可下 / follower 关注可下 / author 仅作者',
  tuning_type VARCHAR(16) DEFAULT NULL COMMENT '曲谱分类·琴型 k17/k21/other',
  key_name    VARCHAR(16) DEFAULT NULL COMMENT '曲谱分类·调性 C/Db/D/.../B',
  difficulty  VARCHAR(16) DEFAULT NULL COMMENT '曲谱分类·难度 beginner/easy/medium/hard',
  music_genre VARCHAR(16) DEFAULT NULL COMMENT '曲谱分类·音乐类型 anime/cantonese/chinese/classic/pop/folk/ost/pure/other',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_owner (owner_id, created_at),
  KEY idx_key (key_name),
  KEY idx_diff (difficulty)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='乐谱附件';

-- ---------- 通知 ----------
CREATE TABLE IF NOT EXISTS notification (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL COMMENT '收件人',
  type       VARCHAR(20) NOT NULL COMMENT 'like/comment/follow/system',
  sender_id  BIGINT UNSIGNED DEFAULT NULL COMMENT '触发者',
  target_id  BIGINT UNSIGNED DEFAULT NULL COMMENT '关联帖子/评论 id',
  content    VARCHAR(255) DEFAULT NULL COMMENT '通知文案（system 类审核/处置通知用；互动类为 NULL 由前端按 type 渲染）',
  is_read    TINYINT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_user (user_id, is_read, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='通知';

-- ---------- 举报 ----------
CREATE TABLE IF NOT EXISTS report (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reporter_id BIGINT UNSIGNED NOT NULL,
  target_type VARCHAR(16) NOT NULL COMMENT 'post/comment/user',
  target_id   BIGINT UNSIGNED NOT NULL,
  reason      VARCHAR(500) DEFAULT NULL,
  status      TINYINT NOT NULL DEFAULT 0 COMMENT '0 待处理 1 已处理 2 已驳回',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_reporter_target (reporter_id, target_type, target_id),
  KEY idx_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='举报（同一用户对同一对象只能举报一次，见 uk_reporter_target）';

-- ---------- 操作日志（管理端「审核记录」数据源） ----------
-- 设计要点：
--   ① 操作者存 **username 快照**（不只 user_id）：用户改名/注销后记录仍可读，列表也不必 join user 表。
--   ② success / error_msg 分开存：只记「成功」的审计日志回答不了「谁试过但没成」。
--   ③ action 取自 @OpLog("...") 注解的说明文本，与代码同源，不另造枚举（避免两处维护会漂移）。
--   ④ duration_ms 可空（@OpLog(timing=false) 的接口不记耗时）。
--   ⑤ 这张表**只增不改**：列表按 created_at 倒序翻页，老数据归档交给 DBA。
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

-- ---------- 搜索关键词日志（热搜榜数据源） ----------
-- 设计要点：**按「关键词 + 天」唯一**，同词当天只累加计数。
-- 若直接一搜一行，热门词会把表撑爆且统计要全表 group by；按天聚行后
-- 行数上界 ≈ 词数 × 天数，热搜查询只扫近 N 天，代价恒定。
CREATE TABLE IF NOT EXISTS search_log (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  keyword    VARCHAR(64) NOT NULL COMMENT '搜索关键词（已 trim，超 32 字不入库）',
  day        DATE NOT NULL COMMENT '按天聚合',
  cnt        INT NOT NULL DEFAULT 1 COMMENT '该词当天被搜次数',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_keyword_day (keyword, day),
  KEY idx_day (day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='搜索关键词日志（热搜榜按近 N 天 SUM(cnt) 排序）';
