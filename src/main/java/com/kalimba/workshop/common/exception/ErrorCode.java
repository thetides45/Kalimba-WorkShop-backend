package com.kalimba.workshop.common.exception;

/**
 * 业务错误码。区间划分：1xxx 参数与通用、2xxx 认证与用户、3xxx 内容、4xxx 互动、5xxx 文件、6xxx 管理。
 *
 * <p>不依赖 lombok 的 @Getter —— 枚举的 getMessage() 会与接口 / Throwable 的
 * getMessage() 产生签名歧义，lombok 会因此跳过 message 字段的 getter，导致编译失败。
 * 这里手写 getCode() / message()，签名完全可控。
 */
public enum ErrorCode implements com.kalimba.workshop.common.result.R.ErrorCodes {

    PARAM_INVALID(1001, "参数不合法"),
    NOT_FOUND(1002, "资源不存在"),
    RATE_LIMITED(1003, "操作过于频繁，请稍后再试"),
    FORBIDDEN(1004, "没有权限执行该操作"),

    UNAUTHORIZED(2001, "未登录或登录已过期"),
    USERNAME_TAKEN(2002, "该用户名已被占用"),
    BAD_CREDENTIALS(2003, "用户名或密码错误"),
    USER_DISABLED(2004, "账号已被封禁"),

    POST_NOT_FOUND(3001, "帖子不存在或已删除"),
    CONTENT_REJECTED(3002, "内容包含不允许的词汇"),
    TAG_LIMIT(3003, "标签数量超出限制"),

    ALREADY_LIKED(4001, "已经点过赞了"),
    ALREADY_REPORTED(4002, "您已举报过该内容"),

    FILE_TOO_LARGE(5001, "文件超出大小限制"),
    FILE_TYPE_REJECTED(5002, "不支持该文件类型"),
    SCORE_LOCKED(5003, "该乐谱暂不可下载"),

    ADMIN_REQUIRED(6001, "需要管理员权限");

    private final int code;
    private final String message;

    ErrorCode(int code, String message) {
        this.code = code;
        this.message = message;
    }

    @Override
    public int getCode() {
        return code;
    }

    @Override
    public String message() {
        return message;
    }

    /** 兼容旧用法（BizException.getMessage() 走父类）。 */
    public String getMessage() {
        return message;
    }
}
