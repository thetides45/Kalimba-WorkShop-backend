package com.kalimba.workshop.module.auth;

import cn.dev33.satoken.stp.StpUtil;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.kalimba.workshop.common.exception.BizException;
import com.kalimba.workshop.common.exception.ErrorCode;
import com.kalimba.workshop.common.sensitive.SensitiveWordFilter;
import com.kalimba.workshop.dto.LoginReq;
import com.kalimba.workshop.dto.RegisterReq;
import com.kalimba.workshop.dto.TokenResp;
import com.kalimba.workshop.entity.User;
import com.kalimba.workshop.mapper.UserMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;

/**
 * 认证与用户服务（WBS 4.1）。
 *
 * <p>密码用 BCrypt（spring-security-crypto，不启用 Security 过滤器链，认证交给 Sa-Token）。
 * 令牌刷新交给 Sa-Token 前端自行续期 —— 后端只负责签发与校验。
 */
@Service
@RequiredArgsConstructor
public class AuthService {

    private final UserMapper userMapper;
    private final PasswordEncoder passwordEncoder;
    private final SensitiveWordFilter sensitiveWordFilter;

    public TokenResp register(RegisterReq req) {
        Long count = userMapper.selectCount(new LambdaQueryWrapper<User>()
                .eq(User::getUsername, req.getUsername()));
        if (count != null && count > 0) {
            throw BizException.of(ErrorCode.USERNAME_TAKEN);
        }
        String nickname = (req.getNickname() == null || req.getNickname().isBlank())
                ? req.getUsername() : req.getNickname().trim();
        sensitiveWordFilter.assertClean(nickname);

        User u = new User();
        u.setUsername(req.getUsername());
        u.setPasswordHash(passwordEncoder.encode(req.getPassword()));
        u.setNickname(nickname);
        u.setRole("user");
        u.setStatus(1);
        u.setCreatedAt(LocalDateTime.now());
        userMapper.insert(u);
        return issue(u);
    }

    public TokenResp login(LoginReq req) {
        User u = userMapper.selectOne(new LambdaQueryWrapper<User>()
                .eq(User::getUsername, req.getUsername()));
        if (u == null || !passwordEncoder.matches(req.getPassword(), u.getPasswordHash())) {
            throw BizException.of(ErrorCode.BAD_CREDENTIALS);
        }
        if (u.getStatus() == null || u.getStatus() != 1) {
            throw BizException.of(ErrorCode.USER_DISABLED);
        }
        return issue(u);
    }

    public TokenResp refresh() {
        Long uid = StpUtil.getLoginIdAsLong();
        User u = userMapper.selectById(uid);
        if (u == null || (u.getStatus() != null && u.getStatus() != 1)) {
            StpUtil.logout();
            throw BizException.of(ErrorCode.UNAUTHORIZED);
        }
        return issue(u);
    }

    private TokenResp issue(User u) {
        StpUtil.login(u.getId());
        StpUtil.getSession().set("role", u.getRole());
        /* username 也放一份进会话：OpLogAspect 记「操作日志」时要写操作者**快照**，
           从会话直接读就不必为了记一行日志再查一次 user 表。
           ⚠️ 旧会话（本次改动前登录的）里没有这个键 → 切面按 null 处理，不报错。 */
        StpUtil.getSession().set("username", u.getUsername());
        return new TokenResp(StpUtil.getTokenValue(), u.getId(), u.getUsername(),
                u.getNickname(), u.getAvatar(), u.getRole());
    }
}
