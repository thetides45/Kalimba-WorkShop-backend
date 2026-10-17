package com.kalimba.workshop.module.comment;

import cn.dev33.satoken.stp.StpUtil;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.kalimba.workshop.common.exception.BizException;
import com.kalimba.workshop.common.exception.ErrorCode;
import com.kalimba.workshop.common.sensitive.SensitiveWordFilter;
import com.kalimba.workshop.dto.CommentReq;
import com.kalimba.workshop.entity.Comment;
import com.kalimba.workshop.entity.Notification;
import com.kalimba.workshop.entity.Post;
import com.kalimba.workshop.mapper.CommentMapper;
import com.kalimba.workshop.mapper.NotificationMapper;
import com.kalimba.workshop.mapper.PostMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;

/**
 * 评论服务（WBS 4.4）。两级回复：parentId 为 null 是一级，否则挂在某条一级评论下。
 */
@Service
@RequiredArgsConstructor
public class CommentService {

    private final CommentMapper commentMapper;
    private final PostMapper postMapper;
    private final NotificationMapper notificationMapper;
    private final SensitiveWordFilter sensitiveWordFilter;

    /**
     * 公开评论列表（一级评论 + 回复按 created_at 平铺返回）。
     * <p>⚠️ 只返回 {@code status = 1} 的评论 —— 被管理员下架的评论（软删）不出现在这里，
     * 但数据仍在库中，可经 {@code PUT /api/admin/comments/{id}/status} 恢复。见缺口 B2。
     */
    public Page<Comment> list(Long postId, int page, int size) {
        return commentMapper.selectPage(new Page<>(page, size),
                new LambdaQueryWrapper<Comment>()
                        .eq(Comment::getPostId, postId)
                        .eq(Comment::getStatus, 1)
                        .orderByAsc(Comment::getCreatedAt));
    }

    @Transactional
    public Comment create(Long postId, CommentReq req) {
        sensitiveWordFilter.assertClean(req.getContent());
        Post p = postMapper.selectById(postId);
        if (p == null || (p.getStatus() != null && p.getStatus() != 1)) {
            throw BizException.of(ErrorCode.POST_NOT_FOUND);
        }
        Long uid = StpUtil.getLoginIdAsLong();

        Comment c = new Comment();
        c.setPostId(postId);
        c.setUserId(uid);
        c.setContent(req.getContent());
        /* 显式写 1：DB 有默认值兜底，但 MyBatis-Plus 的 insert 会跳过 null 字段，
           写出来才能保证实体与落库结果一致（后续判断「状态有没有变」时要用它）。 */
        c.setStatus(1);
        c.setCreatedAt(LocalDateTime.now());

        if (req.getParentId() != null) {
            Comment parent = commentMapper.selectById(req.getParentId());
            if (parent == null || !parent.getPostId().equals(postId)) {
                throw BizException.of(ErrorCode.PARAM_INVALID);
            }
            c.setParentId(parent.getId());
            notify(parent.getUserId(), Notification.TYPE_COMMENT, uid, postId, c.getContent());
        } else {
            c.setParentId(null);
            notify(p.getUserId(), Notification.TYPE_COMMENT, uid, postId, c.getContent());
        }
        commentMapper.insert(c);
        return c;
    }

    /**
     * 物理删除一条评论（作者本人或管理员）。
     *
     * <p>⚠️ 删**一级评论**时会**连带删掉它下面的全部回复** —— 这是 2026-10-11 与「删帖即删评论」
     * 一起定下的口径（缺口 B17）。不级联的话回复会变成孤儿：父评论没了，它们还带着
     * {@code parentId} 留在表里；而列表是按 {@code postId} 平铺返回的，前端会把它渲染成
     * 一条「莫名其妙、没有上下文」的普通评论。
     *
     * <p>注意与 {@code AdminService.setCommentStatus} 的区别：那条是**软删**（改 status，可恢复），
     * 这条是**真删**；两者并存，只是用途不同。
     */
    @Transactional
    public void delete(Long commentId) {
        Comment c = commentMapper.selectById(commentId);
        if (c == null) throw BizException.of(ErrorCode.NOT_FOUND);
        boolean admin = "admin".equals(StpUtil.getSession().getString("role"));
        if (!c.getUserId().equals(StpUtil.getLoginIdAsLong()) && !admin) {
            throw BizException.of(ErrorCode.FORBIDDEN);
        }
        /* 级联只对一级评论做 —— 回复本身是叶子，没有下级。 */
        if (c.getParentId() == null) {
            commentMapper.delete(new LambdaQueryWrapper<Comment>().eq(Comment::getParentId, commentId));
        }
        commentMapper.deleteById(commentId);
    }

    /**
     * 写一条通知。
     *
     * <p>⚠️ 2026-10-11 起 {@code content} 不再恒为 null —— 评论类通知会把**评论正文**一起写进去，
     * 消息页才能显示「某某 评论了你的帖子《标题》：正文」。
     * 此前只有 {@code system} 类通知会写 content，于是消息页的评论通知只能显示到「评论了你的帖子」为止，
     * 用户看不出对方说了什么（{@code like}/{@code follow} 至今仍不写 content，它们本来就没有正文）。
     */
    private void notify(Long toUserId, String type, Long senderId, Long targetId, String content) {
        if (toUserId == null || toUserId.equals(senderId)) return;
        Notification n = new Notification();
        n.setUserId(toUserId);
        n.setType(type);
        n.setSenderId(senderId);
        n.setTargetId(targetId);
        n.setContent(content);
        n.setIsRead(0);
        n.setCreatedAt(LocalDateTime.now());
        notificationMapper.insert(n);
    }
}
