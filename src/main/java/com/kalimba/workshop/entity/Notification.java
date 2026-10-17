package com.kalimba.workshop.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;

import java.io.Serializable;
import java.time.LocalDateTime;

/**
 * 通知（表 3-4 notification）。type：like / comment / follow / system。
 *
 * <p>getter/setter 手写（不用 lombok @Data）：本机 Maven + JDK17 环境下
 * lombok 对个别类不生效（详见 README「构建注意」），此类的 setter 被多个 Service 依赖，
 * 手写最稳妥。
 */
@TableName("notification")
public class Notification implements Serializable {

    public static final String TYPE_LIKE = "like";
    public static final String TYPE_COMMENT = "comment";
    public static final String TYPE_FOLLOW = "follow";
    public static final String TYPE_SYSTEM = "system";

    @TableId(type = IdType.AUTO)
    private Long id;

    /** 收件人。 */
    private Long userId;

    private String type;

    /** 触发者（系统通知为 null）。 */
    private Long senderId;

    /** 关联对象 id：帖子 id 或评论 id，随 type 解释。 */
    private Long targetId;

    /** 通知文案（system 类审核/处置通知用；互动类为 NULL，由前端按 type 渲染）。 */
    private String content;

    private Integer isRead;

    private LocalDateTime createdAt;

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public Long getUserId() { return userId; }
    public void setUserId(Long userId) { this.userId = userId; }
    public String getType() { return type; }
    public void setType(String type) { this.type = type; }
    public Long getSenderId() { return senderId; }
    public void setSenderId(Long senderId) { this.senderId = senderId; }
    public Long getTargetId() { return targetId; }
    public void setTargetId(Long targetId) { this.targetId = targetId; }
    public String getContent() { return content; }
    public void setContent(String content) { this.content = content; }
    public Integer getIsRead() { return isRead; }
    public void setIsRead(Integer isRead) { this.isRead = isRead; }
    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }
}
