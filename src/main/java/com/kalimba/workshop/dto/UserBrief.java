package com.kalimba.workshop.dto;

import com.kalimba.workshop.entity.User;
import lombok.Data;

import java.io.Serializable;

/**
 * 用户简要信息（搜索结果、帖子作者等场景）。
 *
 * <p>刻意只暴露 id / username / nickname / avatar —— 实体的 passwordHash、role、
 * status 这些字段不该出现在任何对外返回体里，用一个窄 DTO 比「返回实体再靠前端忽略」可靠。
 */
@Data
public class UserBrief implements Serializable {

    private Long id;

    private String username;

    private String nickname;

    private String avatar;

    public static UserBrief of(User u) {
        if (u == null) return null;
        UserBrief b = new UserBrief();
        b.id = u.getId();
        b.username = u.getUsername();
        b.nickname = (u.getNickname() == null || u.getNickname().isBlank()) ? u.getUsername() : u.getNickname();
        b.avatar = u.getAvatar();
        return b;
    }
}
