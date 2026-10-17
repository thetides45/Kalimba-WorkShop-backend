package com.kalimba.workshop.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

import java.io.Serializable;
import java.time.LocalDateTime;

/**
 * 操作日志（表 op_log）—— 管理端「审核记录」的数据源。
 *
 * <p>为什么叫 OperationLog 而不是 OpLog：{@code common.aspect.OpLog} 已经是**注解**，
 * 实体同名会让 {@code import} 打架、读代码时也分不清是注解还是记录。这里让实体用全称。
 *
 * <p>几个字段是刻意的设计，不是随手加的：
 * <ul>
 *   <li>{@code username} —— **快照**。只存 user_id 的话，用户改名 / 注销后记录就不可读，
 *       列表还要 join user 表；冗余一列换「日志独立可读」很划算。</li>
 *   <li>{@code success} / {@code errorMsg} —— 审计价值一半在「失败的尝试」。
 *       只记成功的日志回答不了「谁试过越权」。</li>
 *   <li>{@code durationMs} —— 可空，因为 {@code @OpLog(timing = false)} 的接口不记耗时。</li>
 * </ul>
 *
 * <p>getter/setter 手写（不用 lombok）：与本项目 {@code Notification} 同理 ——
 * 本机 Maven + JDK17 下 lombok 对个别类偶发不生效，而本类的访问器被切面与 AdminService 依赖，
 * 手写最稳妥。
 */
@TableName("op_log")
public class OperationLog implements Serializable {

    @TableId(type = IdType.AUTO)
    private Long id;

    /** 操作者 id；未登录上下文（理论上白名单接口不打注解）为 null。 */
    private Long userId;

    /** 操作者用户名快照。 */
    private String username;

    /** 操作说明，取自 {@code @OpLog} 注解的 value，与代码同源。 */
    private String action;

    /** HTTP 方法，如 PUT / POST / DELETE。 */
    private String method;

    /** 请求 URI，含路径参数（如 /api/admin/posts/12/status）。 */
    private String uri;

    /** 1 成功 / 0 失败。 */
    private Integer success;

    /** 失败原因（异常 message，已截断）。 */
    private String errorMsg;

    /** 耗时毫秒；@OpLog(timing=false) 时为 null。 */
    private Integer durationMs;

    private LocalDateTime createdAt;

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public Long getUserId() { return userId; }
    public void setUserId(Long userId) { this.userId = userId; }
    public String getUsername() { return username; }
    public void setUsername(String username) { this.username = username; }
    public String getAction() { return action; }
    public void setAction(String action) { this.action = action; }
    public String getMethod() { return method; }
    public void setMethod(String method) { this.method = method; }
    public String getUri() { return uri; }
    public void setUri(String uri) { this.uri = uri; }
    public Integer getSuccess() { return success; }
    public void setSuccess(Integer success) { this.success = success; }
    public String getErrorMsg() { return errorMsg; }
    public void setErrorMsg(String errorMsg) { this.errorMsg = errorMsg; }
    public Integer getDurationMs() { return durationMs; }
    public void setDurationMs(Integer durationMs) { this.durationMs = durationMs; }
    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }
}
