package com.kalimba.workshop.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.io.Serializable;
import java.time.LocalDateTime;

/** 用户（表 3-4 user）。 */
@Data
@TableName("`user`")
public class User implements Serializable {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String username;

    /** BCrypt 哈希，永不出库到接口层。 */
    private String passwordHash;

    private String nickname;

    private String avatar;

    /** 一句话简介（个人主页展示）。2026-10-02 补：此前无此列，前端只能写死成空串。 */
    private String intro;

    /** 本人琴型键数 17 / 21（个人主页展示）。2026-10-02 补。 */
    private Integer fanType;

    /** user / admin */
    private String role;

    /** 1 正常，0 封禁 */
    private Integer status;

    private LocalDateTime createdAt;
}
