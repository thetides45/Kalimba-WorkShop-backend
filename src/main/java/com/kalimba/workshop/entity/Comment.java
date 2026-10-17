package com.kalimba.workshop.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.io.Serializable;
import java.time.LocalDateTime;

/** 评论与两级回复（表 3-4 comment）。parentId 为 null 即一级评论。 */
@Data
@TableName("comment")
public class Comment implements Serializable {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long postId;

    private Long userId;

    /** 一级评论 id；回复的回复仍挂在同一根评论下（两级封顶）。 */
    private Long parentId;

    private String content;

    /**
     * 1 正常 / 0 已下架（软删，可恢复）。
     * <p>下架由管理员经 {@code PUT /api/admin/comments/{id}/status} 触发，公开列表会过滤掉
     * status≠1 的评论；作者自查的物理删除（{@code DELETE /api/posts/{postId}/comments/{id}}）
     * 走的是另一条路径，不受此字段影响。见 {@code db/migrations/2026-10-10-comment-status.sql}。
     */
    private Integer status;

    private LocalDateTime createdAt;
}
