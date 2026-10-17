package com.kalimba.workshop.common.exception;

/**
 * 业务异常。Service 层只管抛，统一由 {@link GlobalExceptionHandler} 转成 {@code R}。
 *
 * <p>getCode() 手写而非 lombok @Getter —— 见项目根 README「构建注意」：
 * 本机 Maven + JDK17 环境下 lombok 对个别类不生效，异常与通知两类小对象直接手写，
 * 避免把环境问题留给后续维护者。
 */
public class BizException extends RuntimeException {

    private final int code;

    /**
     * 给前端的**结构化定位信息**（可空）。形如
     * {@code {"field":"blocks","index":2,"reason":"…"}} —— 由 {@link GlobalExceptionHandler}
     * 原样放进 {@code R.data}，页面据此滚动到出错的那一栏并框出来。
     *
     * <p>为什么不让前端解析 message：文案是给人读的，随时会改；定位是**契约**，得独立传递。
     */
    private final Object data;

    public BizException(ErrorCode ec) {
        this(ec.getCode(), ec.getMessage(), null);
    }

    public BizException(ErrorCode ec, String message) {
        this(ec.getCode(), message, null);
    }

    public BizException(int code, String message) {
        this(code, message, null);
    }

    public BizException(int code, String message, Object data) {
        super(message);
        this.code = code;
        this.data = data;
    }

    public static BizException of(ErrorCode ec) {
        return new BizException(ec);
    }

    public int getCode() {
        return code;
    }

    public Object getData() {
        return data;
    }
}

