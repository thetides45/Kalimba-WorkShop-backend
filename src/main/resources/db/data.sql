-- ============================================================
-- 种子数据：标签、演示账号、示例帖子
-- 密码均为 BCrypt 哈希（明文 "123456"）
-- ============================================================
USE kalimba_workshop;

-- ---------- 标签 ----------
INSERT INTO tag (name, category) VALUES
  ('曲谱分享', '曲谱'),
  ('求谱', '求谱'),
  ('教程', '教程'),
  ('翻弹', '曲谱'),
  ('原创', '曲谱'),
  ('问题求助', '求助')
ON DUPLICATE KEY UPDATE category = VALUES(category);

-- ---------- 演示账号 ----------
-- 密码明文：123456（BCrypt，已用 BCryptPasswordEncoder 实测验证）
INSERT INTO `user` (username, password_hash, nickname, role, status, intro, fan_type) VALUES
  ('admin', '$2a$10$qIHFRvMo0p2LbLV7mbqqBu74mdM7irWBF6JVbAF4ys43ziQxbcidO', '管理员', 'admin', 1, '负责社区内容审核与维护', 17),
  ('demo',  '$2a$10$qIHFRvMo0p2LbLV7mbqqBu74mdM7irWBF6JVbAF4ys43ziQxbcidO', '阿岚', 'user', 1, '17 键入门第 100 天', 17)
ON DUPLICATE KEY UPDATE nickname = VALUES(nickname), password_hash = VALUES(password_hash),
                        intro = VALUES(intro), fan_type = VALUES(fan_type);
