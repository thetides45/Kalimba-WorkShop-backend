package com.kalimba.workshop.common.aspect;

import cn.dev33.satoken.stp.StpUtil;
import com.kalimba.workshop.entity.OperationLog;
import com.kalimba.workshop.mapper.OperationLogMapper;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.springframework.stereotype.Component;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

/**
 * 操作日志切面：统一记录「谁、调了哪个接口、耗时、结果」。
 *
 * <p>两路输出，各司其职：
 * <ul>
 *   <li><b>slf4j</b> —— 运维排障看实时日志（原样保留，不破坏既有习惯）。</li>
 *   <li><b>op_log 表</b> —— 管理端「审核记录」的数据源。此前只打日志不落库，
 *       导致管理端**查不到任何审核/封禁轨迹**（谁在何时下架了哪篇、封了谁，全丢失）。</li>
 * </ul>
 *
 * <p>⚠️ 落库是 <b>best-effort</b>：写库失败只 warn，**绝不把异常抛给业务**。
 * 审计日志重要，但不能因为「记日志失败」把一个正常的发布/审核操作搞崩 ——
 * 这是审计日志与业务数据最本质的区别（业务数据要事务性，日志不配当单点）。
 */
@Slf4j
@Aspect
@Component
@RequiredArgsConstructor
public class OpLogAspect {

    private final OperationLogMapper opLogMapper;

    /* 截断上限：与 op_log 表的列宽对齐，避免「超长导致插入报错」把日志整条丢掉。 */
    private static final int ACTION_MAX = 64;
    private static final int METHOD_MAX = 8;
    private static final int URI_MAX = 255;
    private static final int USERNAME_MAX = 32;
    private static final int ERR_MAX = 200;

    @Around("@annotation(opLog)")
    public Object around(ProceedingJoinPoint pjp, OpLog opLog) throws Throwable {
        long t0 = System.currentTimeMillis();

        /* ---- 操作者 ---- */
        Long uid = null;
        String username = null;
        try {
            if (StpUtil.isLogin()) {
                Object lid = StpUtil.getLoginIdDefaultNull();
                if (lid != null) {
                    try { uid = Long.valueOf(String.valueOf(lid)); } catch (NumberFormatException ignored) { }
                }
                Object un = StpUtil.getSession().get("username");
                if (un != null) username = String.valueOf(un);
            }
        } catch (Exception ignored) {
            // 未登录上下文（白名单接口不打这个注解，正常不会走到）
        }

        /* ---- 请求行 ---- */
        String method = "";
        String uri = "";
        ServletRequestAttributes attrs = (ServletRequestAttributes) RequestContextHolder.getRequestAttributes();
        if (attrs != null) {
            HttpServletRequest req = attrs.getRequest();
            method = req.getMethod();
            uri = req.getRequestURI();
        }

        try {
            Object ret = pjp.proceed();
            long cost = System.currentTimeMillis() - t0;
            if (opLog.timing()) {
                log.info("[OpLog] {} | user={} | {} {} | {}ms", opLog.value(), who(uid), method, uri, cost);
            } else {
                log.info("[OpLog] {} | user={} | {} {}", opLog.value(), who(uid), method, uri);
            }
            record(opLog, uid, username, method, uri, true, null, opLog.timing() ? (int) cost : null);
            return ret;
        } catch (Throwable e) {
            long cost = System.currentTimeMillis() - t0;
            log.warn("[OpLog] {} | user={} | {} {} | 失败：{}", opLog.value(), who(uid), method, uri, e.getMessage());
            record(opLog, uid, username, method, uri, false, e.getMessage(), opLog.timing() ? (int) cost : null);
            throw e;
        }
    }

    private String who(Long uid) {
        return uid == null ? "guest" : String.valueOf(uid);
    }

    /**
     * 落库一行操作日志。任何异常都在这里被吃掉（只 warn）——
     * 调用方在业务成功/失败两条路径上都不该因为记日志而改变结果。
     */
    private void record(OpLog opLog, Long uid, String username, String method, String uri,
                        boolean success, String error, Integer durationMs) {
        try {
            OperationLog r = new OperationLog();
            r.setUserId(uid);
            r.setUsername(truncate(username, USERNAME_MAX));
            r.setAction(truncate(opLog.value(), ACTION_MAX));
            r.setMethod(truncate(method, METHOD_MAX));
            r.setUri(truncate(uri, URI_MAX));
            r.setSuccess(success ? 1 : 0);
            r.setErrorMsg(truncate(error, ERR_MAX));
            r.setDurationMs(durationMs);
            opLogMapper.insert(r);
        } catch (Exception ex) {
            log.warn("[OpLog] 操作日志落库失败（已忽略，不影响业务）：{}", ex.getMessage());
        }
    }

    private String truncate(String s, int max) {
        if (s == null) return null;
        return s.length() <= max ? s : s.substring(0, max);
    }
}
