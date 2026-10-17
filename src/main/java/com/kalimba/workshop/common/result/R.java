package com.kalimba.workshop.common.result;

import lombok.Data;

import java.io.Serializable;

/**
 * 统一返回体：code / message / data（规划书 3.7 约定的三字段）。
 *
 * <p>约定：code=0 表示成功，其余为业务错误码（见 {@link com.kalimba.workshop.common.exception.ErrorCode}）。
 * 之所以不用 HTTP 状态码承载业务错误：前端拦截器只需要看一个 code 字段，
 * 越权、限流、敏感词这些都在同一处处理。
 */
@Data
public class R<T> implements Serializable {

    private int code;
    private String message;
    private T data;

    public static <T> R<T> ok() {
        return ok(null);
    }

    public static <T> R<T> ok(T data) {
        R<T> r = new R<>();
        r.code = 0;
        r.message = "ok";
        r.data = data;
        return r;
    }

    public static <T> R<T> fail(int code, String message) {
        R<T> r = new R<>();
        r.code = code;
        r.message = message;
        return r;
    }

    /**
     * 带 {@code data} 的失败返回 —— 用来把**结构化的定位信息**带给前端，
     * 让页面能滚动到出错的那一栏并框出来，而不是只弹一句「参数不合法」。
     *
     * <p>约定：{@code data} 形如 {@code {"field":"blocks","index":2,"reason":"…"}}。
     * ⚠️ 其中 {@code index} 是 **0 基**（前端直接拿去当数组下标），
     * 而 message 里给人看的说法是 1 基（"第 3 个块"）——两者刻意不同，别混。
     */
    public static <T> R<T> fail(int code, String message, T data) {
        R<T> r = new R<>();
        r.code = code;
        r.message = message;
        r.data = data;
        return r;
    }

    public static <T> R<T> fail(ErrorCodes e) {
        return fail(e.getCode(), e.message());
    }

    /** 错误码接口。方法名用 message() 而非 getMessage()，
        避免与枚举（间接继承 Object）以及 Throwable.getMessage() 产生签名歧义。 */
    public interface ErrorCodes {
        int getCode();
        String message();
    }
}
