package com.kalimba.workshop.dto;

import com.kalimba.workshop.entity.Notification;
import lombok.Data;

import java.io.Serializable;
import java.time.LocalDateTime;

/**
 * 通知行（前端消息页）—— 2026-10-11 新增。
 *
 * <p>为什么不直接返回 {@link Notification} 实体：{@code like} / {@code comment} 两类通知的
 * {@code content} 是 <b>null</b>（只有 {@code system} 类才写正文），而消息页要显示的是
 * 「<b>谁</b> 赞了你的帖子 <b>《标题》</b>」—— 没有标题的话，一条点赞通知只能显示
 * 「某某赞了你的帖子」，根本看不出是哪一篇。
 *
 * <p>让前端拿 {@code targetId} 再逐条查会变成 N+1；这里由服务端**批量补齐**（一次
 * {@code selectBatchIds}），前端零拼接 —— 与 {@link AdminCommentVO} 同一口径。
 *
 * <p>⚠️ 目标帖子可能**已被删除**：那时 {@code postTitle} 为 null，前端**不显示书名号**即可，
 * 千万别去拼接出一个「《null》」。
 */
@Data
public class NotificationVO implements Serializable {

    private Long id;

    private Long userId;

    /** like / comment / follow / system，见 {@link Notification} 的 TYPE_* 常量 */
    private String type;

    private Long senderId;

    private Long targetId;

    private String content;

    private Integer isRead;

    private LocalDateTime createdAt;

    /** 目标帖子标题；帖子已删或该类型本就没有 targetId 时为 null */
    private String postTitle;
}
