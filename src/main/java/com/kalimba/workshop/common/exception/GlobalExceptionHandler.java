package com.kalimba.workshop.common.exception;

import cn.dev33.satoken.exception.NotLoginException;
import cn.dev33.satoken.exception.NotRoleException;
import com.kalimba.workshop.common.result.R;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.validation.BindException;
import org.springframework.validation.FieldError;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.multipart.MaxUploadSizeExceededException;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 全局异常处理：把各类异常收敛成统一返回体，并保证**不把堆栈泄漏给前端**。
 * 日志里保留完整堆栈，便于排查。
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(BizException.class)
    public R<Object> handleBiz(HttpServletRequest req, BizException e) {
        /* ⚠️ 日志**必须带上 method + URI**：业务异常在 HTTP 上恒为 200，只体现在 body 的 code 里，
           所以「哪个接口抛的」只能从日志看。2026-10-10 排查一条 `code=1002 资源不存在` 时，
           日志里只有 code/msg，只能靠时间戳反推是哪一次请求，白走了不少弯路。
           刻意用 `getRequestURI()`（**不含 query string**）：搜索关键词、token 之类可能落在参数里，
           不该进日志。 */
        log.warn("业务异常 code={} msg={} <- {} {}",
                e.getCode(), e.getMessage(), req.getMethod(), req.getRequestURI());
        /* data 原样带出去：业务异常可以捎上「哪个字段/哪一块出错」，
           页面据此滚动定位并框出那一栏（否则只弹一句文案，用户不知道该改哪里）。 */
        return R.fail(e.getCode(), e.getMessage(), e.getData());
    }

    @ExceptionHandler(NotLoginException.class)
    public R<Void> handleNotLogin(NotLoginException e) {
        return R.fail(ErrorCode.UNAUTHORIZED);
    }

    @ExceptionHandler(NotRoleException.class)
    public R<Void> handleNotRole(NotRoleException e) {
        return R.fail(ErrorCode.ADMIN_REQUIRED);
    }

    @ExceptionHandler({MethodArgumentNotValidException.class, BindException.class})
    public R<Object> handleValid(BindException e) {
        FieldError fe = e.getBindingResult().getFieldError();
        if (fe == null) return R.fail(ErrorCode.PARAM_INVALID);
        /* message 只给**人话**（"标题过长"），字段名走 data ——
           以前 message 是 "title 标题过长"，用户看不懂，前端也没法据此定位。
           ⚠️ 字段名要与前端表单元素的 `data-field` 对齐（title / content / …）。 */
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("field", fe.getField());
        d.put("reason", fe.getDefaultMessage());
        return R.fail(ErrorCode.PARAM_INVALID.getCode(), fe.getDefaultMessage(), d);
    }

    @ExceptionHandler(MissingServletRequestParameterException.class)
    public R<Object> handleMissingParam(MissingServletRequestParameterException e) {
        /* 同样带上字段名（这里的"字段"就是查询参数名），前端能定位就定位。 */
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("field", e.getParameterName());
        d.put("reason", "缺少参数");
        return R.fail(ErrorCode.PARAM_INVALID.getCode(), "缺少参数：" + e.getParameterName(), d);
    }

    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public R<Void> handleUploadSize(MaxUploadSizeExceededException e) {
        return R.fail(ErrorCode.FILE_TOO_LARGE);
    }

    @ExceptionHandler(Exception.class)
    public R<Void> handleOther(HttpServletRequest req, Exception e) {
        log.error("未处理异常 {} {}", req.getMethod(), req.getRequestURI(), e);
        return R.fail(1000, "服务器开小差了，请稍后重试");
    }
}
