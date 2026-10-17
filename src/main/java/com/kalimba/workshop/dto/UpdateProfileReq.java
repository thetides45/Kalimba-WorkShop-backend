package com.kalimba.workshop.dto;

import lombok.Data;

import java.io.Serializable;

/**
 * 更新我的资料（{@code PUT /api/users/me}）请求体。
 *
 * <p>字段**全部可选**：传了就改，没传就保持原值。这条不是随便定的 ——
 * Vue 侧 {@code Profile.vue} 只传 nickname + avatar，V3 侧 {@code user.html} 传
 * nickname + intro + fanType。用「部分更新」语义，两个前端可以各自只发自己管的字段，
 * 不需要为了兼容对方而补空值（否则 V3 发一次资料，头像就被 null 覆盖掉了）。
 *
 * <p>为什么不继续用 {@code Map<String, String>}：{@code fanType} 是数字，
 * Map 里拿到的是字符串，得在 Service 里手工 parse 并处理「脏字符串」；
 * 换成 DTO 后由 Jackson 直接报错，参数校验回到框架层。
 */
@Data
public class UpdateProfileReq implements Serializable {

    /** 昵称，最长 20（与前端 maxlength 一致）。 */
    private String nickname;

    /** 头像地址（由文件上传接口返回）。 */
    private String avatar;

    /** 一句话简介，最长 60。 */
    private String intro;

    /** 琴型键数，只接受 17 / 21。 */
    private Integer fanType;
}
