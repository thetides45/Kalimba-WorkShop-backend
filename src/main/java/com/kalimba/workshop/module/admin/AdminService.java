package com.kalimba.workshop.module.admin;

import cn.dev33.satoken.stp.StpUtil;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.kalimba.workshop.common.exception.BizException;
import com.kalimba.workshop.common.exception.ErrorCode;
import com.kalimba.workshop.common.result.PageResult;
import com.kalimba.workshop.dto.AdminCommentVO;
import com.kalimba.workshop.dto.AdminUserVO;
import com.kalimba.workshop.entity.Comment;
import com.kalimba.workshop.entity.Notification;
import com.kalimba.workshop.entity.OperationLog;
import com.kalimba.workshop.entity.Post;
import com.kalimba.workshop.entity.Report;
import com.kalimba.workshop.entity.User;
import com.kalimba.workshop.mapper.CommentMapper;
import com.kalimba.workshop.mapper.NotificationMapper;
import com.kalimba.workshop.mapper.OperationLogMapper;
import com.kalimba.workshop.mapper.PostMapper;
import com.kalimba.workshop.mapper.ReportMapper;
import com.kalimba.workshop.mapper.UserMapper;
import com.kalimba.workshop.module.hot.HotService;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 管理端服务（WBS 4.8）：内容下架、用户封禁、举报处理、数据统计、操作日志（审核记录）。
 * 每个方法入口都先校验管理员角色 —— 防越权不靠拦截器一条路，Service 层再兜一层。
 */
@Service
@RequiredArgsConstructor
public class AdminService {

    private final PostMapper postMapper;
    private final CommentMapper commentMapper;
    private final UserMapper userMapper;
    private final ReportMapper reportMapper;
    private final NotificationMapper notificationMapper;
    private final OperationLogMapper operationLogMapper;
    private final HotService hotService;

    private void requireAdmin() {
        try {
            if (!"admin".equals(StpUtil.getSession().getString("role"))) {
                throw BizException.of(ErrorCode.ADMIN_REQUIRED);
            }
        } catch (BizException e) {
            throw e;
        } catch (Exception e) {
            throw BizException.of(ErrorCode.UNAUTHORIZED);
        }
    }

    /** 改帖子状态（下架/恢复/审核）。状态实质变化时给作者发一条 system 通知。 */
    public void setPostStatus(Long id, int status) {
        requireAdmin();
        Post p = postMapper.selectById(id);
        if (p == null) throw BizException.of(ErrorCode.POST_NOT_FOUND);
        int old = p.getStatus() == null ? 1 : p.getStatus();
        p.setStatus(status);
        postMapper.updateById(p);
        /* 热榜跟着走（缺口 B18）：下架/转待审 → 移出榜单；恢复正常 → 用库里的热度回填。
           sync 内部两种情形都处理，所以这里不用判 status。 */
        hotService.sync(p);
        if (status != old && p.getUserId() != null) {
            String tip = switch (status) {
                case 2 -> "你的帖子《" + clip(p.getTitle()) + "》已被下架";
                case 1 -> "你的帖子《" + clip(p.getTitle()) + "》已通过审核";
                case 0 -> "你的帖子《" + clip(p.getTitle()) + "》已转为待审核";
                default -> null;
            };
            if (tip != null) notify(p.getUserId(), tip, id);
        }
    }

    /**
     * 重建热榜缓存（缺口 B18）。
     *
     * <p>热榜 ZSet 平时靠「预热 + 交互增量」自己维护，正常不需要人工干预；但 Redis 被手工清过、
     * 或增量在边角上漏掉时，榜单会与库对不上，这时用这个入口删键重灌。
     * 与 {@code HotService} 里的自动预热是两条路：预热只补「键不存在」，这里解决「键在但内容脏」。
     *
     * @return 重建后 ZSet 的成员数
     */
    public int rebuildHot() {
        requireAdmin();
        return hotService.rebuild();
    }

    /**
     * 改评论状态（下架 / 恢复）—— 缺口 B2。
     *
     * <p>与「物理删除」（{@code DELETE /api/posts/{postId}/comments/{id}}，作者本人或管理员，
     * 见 {@code CommentService.delete}）是**两条不同的路径**：这里是**软删**，数据保留、可随时恢复，
     * 用于「举报 → 先下架 → 复核之后再决定是否彻底删」。公开列表按 {@code status = 1} 过滤，
     * 所以下架后评论会从帖子详情页消失，但库里的行还在。
     *
     * <p>⚠️ <b>以一级评论为单位整组切换</b>：下架一条一级评论时，挂在它下面的回复会一并下架，
     * 恢复时也一并恢复。不做级联的话，回复会变成「孤儿」—— 父评论在公开列表里消失了，
     * 回复却还带着 parentId 露在外面。（物理删除路径没有做级联，属既有行为，见缺口 B8。）
     */
    public void setCommentStatus(Long id, int status) {
        requireAdmin();
        Comment c = commentMapper.selectById(id);
        if (c == null) throw BizException.of(ErrorCode.NOT_FOUND);
        int old = c.getStatus() == null ? 1 : c.getStatus();
        c.setStatus(status);
        commentMapper.updateById(c);

        /* 级联只对一级评论做；回复自己就是叶子，不会有下级。 */
        if (c.getParentId() == null) {
            Comment patch = new Comment();
            patch.setStatus(status);
            commentMapper.update(patch, new LambdaQueryWrapper<Comment>().eq(Comment::getParentId, id));
        }

        if (status != old && c.getUserId() != null) {
            String tip = status == 0
                    ? "你的评论「" + clip(c.getContent()) + "」已被下架"
                    : "你的评论「" + clip(c.getContent()) + "」已恢复显示";
            notify(c.getUserId(), tip, c.getPostId());
        }
    }

    /**
     * 评论列表（管理端）—— 缺口 B8。
     *
     * <p>补上「管理员找不到评论」这一步：评论的**状态机**（下架↔恢复）由 B2 提供，
     * 但那之前管理端没有任何入口能列出评论、拿到 id，等于那条接口没有使用者。
     *
     * <p>筛选：{@code keyword} 同时匹配**评论内容**与**作者昵称/用户名**；
     * {@code status} 传 null 表示不限（管理端既要能看「仅已下架」，也要能看全部）。
     * 昵称那一路先在 user 表把命中的 id 捞出来再 {@code in} 并进条件 ——
     * 项目里没有 XML mapper，不为一次筛选引入 join SQL，两步查询在评论量级下更直接。
     *
     * <p>⚠️ **刻意不过滤孤儿评论**（{@code postId} 指向已删除的帖子）—— 恰恰相反，
     * 管理端正是要能看到它们才好收拾（{@code AdminCommentVO.postTitle} 会是 null）。
     */
    public PageResult<AdminCommentVO> comments(int page, int size, String keyword, Integer status) {
        requireAdmin();

        LambdaQueryWrapper<Comment> w = new LambdaQueryWrapper<>();
        if (status != null) w.eq(Comment::getStatus, status);
        if (keyword != null && !keyword.isBlank()) {
            String k = keyword.trim();
            List<Long> hitUserIds = userMapper.selectList(new LambdaQueryWrapper<User>()
                            .like(User::getNickname, k).or().like(User::getUsername, k))
                    .stream().map(User::getId).toList();
            if (hitUserIds.isEmpty()) {
                /* 昵称一个都没命中 → 只剩「内容命中」一种可能。
                   不要写 `in(空集合)`：那条件恒假，会把内容命中一起挡掉。 */
                w.like(Comment::getContent, k);
            } else {
                w.and(q -> q.like(Comment::getContent, k).or().in(Comment::getUserId, hitUserIds));
            }
        }
        w.orderByDesc(Comment::getCreatedAt);
        Page<Comment> p = commentMapper.selectPage(new Page<>(page, size), w);

        /* 作者与帖子**批量**补齐（各一次 selectBatchIds），既不做 N+1，也不用前端再拼。 */
        List<Comment> rows = p.getRecords();
        Set<Long> userIds = rows.stream().map(Comment::getUserId).filter(Objects::nonNull).collect(Collectors.toSet());
        Set<Long> postIds = rows.stream().map(Comment::getPostId).filter(Objects::nonNull).collect(Collectors.toSet());
        Map<Long, User> authors = userIds.isEmpty() ? Map.of()
                : userMapper.selectBatchIds(userIds).stream().collect(Collectors.toMap(User::getId, u -> u));
        Map<Long, Post> posts = postIds.isEmpty() ? Map.of()
                : postMapper.selectBatchIds(postIds).stream().collect(Collectors.toMap(Post::getId, x -> x));

        return PageResult.of(p, (Comment c) -> AdminCommentVO.of(c, authors.get(c.getUserId()), posts.get(c.getPostId())));
    }

    /** 待审帖子（status=0），供管理端审核。 */
    public Page<Post> pendingPosts(int page, int size) {
        requireAdmin();
        return postMapper.selectPage(new Page<>(page, size),
                new LambdaQueryWrapper<Post>()
                        .eq(Post::getStatus, 0)
                        .orderByAsc(Post::getCreatedAt));
    }

    public void setUserStatus(Long id, int status) {
        requireAdmin();
        User u = userMapper.selectById(id);
        if (u == null) throw BizException.of(ErrorCode.NOT_FOUND);
        u.setStatus(status);
        userMapper.updateById(u);
    }

    /**
     * 用户列表（管理端）—— 封禁/解除的入口。
     * 不返回 User 实体，而是映射成 {@link AdminUserVO}：实体里有 passwordHash，
     * 用窄 DTO 从源头杜绝「顺手把哈希返回出去」。
     */
    public PageResult<AdminUserVO> users(int page, int size, String keyword) {
        requireAdmin();
        LambdaQueryWrapper<User> w = new LambdaQueryWrapper<>();
        if (keyword != null && !keyword.isBlank()) {
            String k = keyword.trim();
            w.and(q -> q.like(User::getUsername, k).or().like(User::getNickname, k));
        }
        w.orderByDesc(User::getCreatedAt);
        Page<User> p = userMapper.selectPage(new Page<>(page, size), w);
        return PageResult.of(p, AdminUserVO::of);
    }

    public Page<Report> reports(int page, int size, Integer status) {
        requireAdmin();
        LambdaQueryWrapper<Report> w = new LambdaQueryWrapper<>();
        if (status != null) w.eq(Report::getStatus, status);
        w.orderByAsc(Report::getCreatedAt);
        return reportMapper.selectPage(new Page<>(page, size), w);
    }

    /** 处理举报（1 已处理 / 2 已驳回）。结果通知举报人。 */
    public void handleReport(Long id, int status) {
        requireAdmin();
        Report r = reportMapper.selectById(id);
        if (r == null) throw BizException.of(ErrorCode.NOT_FOUND);
        r.setStatus(status);
        reportMapper.updateById(r);
        if (r.getReporterId() != null) {
            String tip = status == 1 ? "你提交的举报已受理，感谢反馈" : "你提交的举报经核实未予处理";
            notify(r.getReporterId(), tip, r.getTargetId());
        }
    }

    /** 截断到 20 字（帖子标题、评论内容等通知文案都用它，避免把长文塞进通知）。 */
    private String clip(String t) {
        if (t == null) return "";
        return t.length() > 20 ? t.substring(0, 20) + "…" : t;
    }

    /** 写一条 system 通知（content 存文案，targetId 关联帖子/对象）。 */
    private void notify(Long toUserId, String tip, Long targetId) {
        Notification n = new Notification();
        n.setUserId(toUserId);
        n.setType(Notification.TYPE_SYSTEM);
        n.setSenderId(null);
        n.setTargetId(targetId);
        n.setContent(tip);
        n.setIsRead(0);
        n.setCreatedAt(LocalDateTime.now());
        notificationMapper.insert(n);
    }

    public Map<String, Object> stats() {
        requireAdmin();
        Map<String, Object> m = new HashMap<>();
        m.put("users", userMapper.selectCount(null));
        m.put("posts", postMapper.selectCount(null));
        m.put("postsActive", postMapper.selectCount(new LambdaQueryWrapper<Post>().eq(Post::getStatus, 1)));
        m.put("pendingReports", reportMapper.selectCount(new LambdaQueryWrapper<Report>().eq(Report::getStatus, 0)));
        return m;
    }

    /* ==================== 操作日志（审核记录） ==================== */

    /**
     * 操作日志分页。筛选项都可选：{@code action} 精确匹配（配合前端 chip）、
     * {@code success} 只挑成功/失败、{@code keyword} 模糊匹配**操作者用户名或 URI**。
     *
     * <p>⚠️ 排序是 created_at DESC **再补一个 id DESC**。这不是凑数：created_at 是
     * DATETIME（秒精度），同一秒内完全可能落多条（例如一次批量审核），
     * 只按时间排会让同秒行的相对顺序在两次查询间漂移 → 翻页时**重复或漏行**。
     * 补 id 把顺序钉死。
     *
     * <p>另外这里的排序方向与待审/举报**相反**（那两处按时间正序，先来先处理）：
     * 审计场景关心的是「最近发生了什么」，最新的必须在第一页。
     */
    public PageResult<OperationLog> logs(int page, int size, String action, String keyword, Integer success) {
        requireAdmin();
        LambdaQueryWrapper<OperationLog> w = new LambdaQueryWrapper<>();
        if (action != null && !action.isBlank()) {
            w.eq(OperationLog::getAction, action.trim());
        }
        if (success != null) {
            w.eq(OperationLog::getSuccess, success);
        }
        if (keyword != null && !keyword.isBlank()) {
            String k = keyword.trim();
            w.and(q -> q.like(OperationLog::getUsername, k).or().like(OperationLog::getUri, k));
        }
        w.orderByDesc(OperationLog::getCreatedAt).orderByDesc(OperationLog::getId);
        Page<OperationLog> p = operationLogMapper.selectPage(new Page<>(page, size), w);
        return PageResult.of(p);
    }

    /** 出现过的操作类型（去重），供管理端渲染筛选 chip —— 从数据反查，不硬编码。 */
    public List<String> logActions() {
        requireAdmin();
        return operationLogMapper.distinctActions();
    }
}
