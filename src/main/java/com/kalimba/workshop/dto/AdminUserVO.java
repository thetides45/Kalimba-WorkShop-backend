package com.kalimba.workshop.dto;

import com.kalimba.workshop.entity.User;
import lombok.Data;

import java.io.Serializable;
import java.time.LocalDateTime;

/**
 * 管理端用户行（仅管理员可见）。
 *
 * <p>为什么不复用 {@link UserBrief}：Brief 是**公开**的用户摘要（搜索结果、帖子作者），
 * 只该有 id/昵称/头像；而管理端要判断「封禁 / 解除」按钮的状态，必须看到 status 和 role。
 * 两者字段集不同、可见性也不同，硬塞进一个 DTO 早晚会把 role/status 漏到公开接口上。
 * 同样地，这个 VO 里**没有 passwordHash**。
 */
@Data
public class AdminUserVO implements Serializable {

    private Long id;

    private String username;

    private String nickname;

    private String avatar;

    /** user / admin */
    private String role;

    /** 1 正常 / 0 封禁 */
    private Integer status;

    private LocalDateTime createdAt;

    public static AdminUserVO of(User u) {
        if (u == null) return null;
        AdminUserVO v = new AdminUserVO();
        v.id = u.getId();
        v.username = u.getUsername();
        v.nickname = (u.getNickname() == null || u.getNickname().isBlank()) ? u.getUsername() : u.getNickname();
        v.avatar = u.getAvatar();
        v.role = u.getRole();
        v.status = u.getStatus();
        v.createdAt = u.getCreatedAt();
        return v;
    }
}
