package com.kalimba.workshop.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.io.Serializable;

/** 登录 / 注册返回的令牌与用户摘要。 */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class TokenResp implements Serializable {

    private String token;
    private long userId;
    private String username;
    private String nickname;
    private String avatar;
    private String role;
}
