package com.kalimba.workshop.dto;

import com.kalimba.workshop.entity.Comment;
import com.kalimba.workshop.entity.Post;
import com.kalimba.workshop.entity.User;
import lombok.Data;

import java.io.Serializable;
import java.time.LocalDateTime;

/**
 * 管理端评论行（仅管理员可见）—— 缺口 B8。
 *
 * <p>为什么不直接返回 {@link Comment} 实体：管理端要判断「这条评论挂在哪个帖子下、是谁发的」
 * 才能决定是下架还是删帖，而实体里只有 {@code postId} / {@code userId} 两个裸 id。
 * 让前端拿到 id 再逐个去查（现在待审帖子 / 举报列表就是这么做的：前端 {@code userName()} 拼接）
 * 会多出一轮请求；这里由服务端**批量补齐**，前端零拼接。
 *
 * <p>因此比实体多两个**已解析**的展示字段：{@code postTitle}（所属帖子标题）
 * 与 {@code nickname}（作者昵称）。⚠️ 帖子可能已被删 —— 那时 {@code postTitle} 为 null，
 * 也就是「孤儿评论」；管理端**正是要能看到它们**才好清理，所以列表刻意不过滤。
 */
@Data
public class AdminCommentVO implements Serializable {

    private Long id;

    private String content;

    private Long postId;

    /** 所属帖子标题；帖子已被删时为 null（孤儿评论）。 */
    private String postTitle;

    private Long userId;

    /** 作者昵称；作者查不到时回落为「用户{id}」，与前端旧口径一致。 */
    private String nickname;

    /** 有值即「回复」，指的是它回复的那条评论 id。 */
    private Long parentId;

    /** 1 正常 / 0 已下架（软删）。 */
    private Integer status;

    private LocalDateTime createdAt;

    public static AdminCommentVO of(Comment c, User author, Post post) {
        if (c == null) return null;
        AdminCommentVO v = new AdminCommentVO();
        v.id = c.getId();
        v.content = c.getContent();
        v.postId = c.getPostId();
        v.postTitle = post == null ? null : post.getTitle();
        v.userId = c.getUserId();
        v.nickname = author == null
                ? "用户" + c.getUserId()
                : ((author.getNickname() == null || author.getNickname().isBlank())
                        ? author.getUsername()
                        : author.getNickname());
        v.parentId = c.getParentId();
        v.status = c.getStatus();
        v.createdAt = c.getCreatedAt();
        return v;
    }
}
