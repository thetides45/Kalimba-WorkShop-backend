package com.kalimba.workshop.module.interaction;

import cn.dev33.satoken.stp.StpUtil;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.kalimba.workshop.common.exception.BizException;
import com.kalimba.workshop.common.exception.ErrorCode;
import com.kalimba.workshop.entity.Favorite;
import com.kalimba.workshop.entity.Follow;
import com.kalimba.workshop.entity.LikeRecord;
import com.kalimba.workshop.entity.Notification;
import com.kalimba.workshop.entity.Post;
import com.kalimba.workshop.mapper.FavoriteMapper;
import com.kalimba.workshop.mapper.FollowMapper;
import com.kalimba.workshop.mapper.LikeRecordMapper;
import com.kalimba.workshop.mapper.NotificationMapper;
import com.kalimba.workshop.mapper.PostMapper;
import com.kalimba.workshop.module.hot.HotService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.dao.DeadlockLoserDataAccessException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.LocalDateTime;

/**
 * 互动服务（WBS 4.4）：点赞 / 收藏 / 关注。
 *
 * <p>幂等靠数据库唯一约束 + {@link DuplicateKeyException} 兜底，
 * 而不是「先查后插」—— 并发下「先查后插」有竞态，唯一约束是唯一可靠的写法。
 *
 * <h3>为什么会有一个 {@code txWithRetry}（2026-10-04 压测后加）</h3>
 * 并发对**同一条** (user, post) 记录点赞 / 取消时，InnoDB 在
 * {@code like_record} 的插入与删除之间会形成死锁。实测（20 并发 × 300 次）：
 * 98 次 `DeadlockLoserDataAccessException` 直接落到全局兜底 → 前端拿到 {@code code 1000}「服务器开小差了」。
 * 死锁是**瞬时**错误，MySQL 自己的提示就是 `try restarting transaction` ——
 * 正确做法是**重放整个事务**，而不是把它当业务失败抛出去。
 * 因此这两个方法不再用 {@code @Transactional}（注解层拿不到「重试」的机会，事务已被标记回滚），
 * 改为把事务边界下移到 {@link TransactionTemplate}，外面套一层有限次重试。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class InteractionService {

    private final LikeRecordMapper likeRecordMapper;
    private final FavoriteMapper favoriteMapper;
    private final FollowMapper followMapper;
    private final PostMapper postMapper;
    private final NotificationMapper notificationMapper;
    private final TransactionTemplate txTemplate;
    private final HotService hotService;

    /** 死锁重放次数上限。超过就明确告诉用户「稍后再试」，而不是暴露一个 500。 */
    private static final int MAX_DEADLOCK_RETRY = 3;

    /**
     * 在一个事务里执行 {@code work}，遇**瞬时**死锁/锁等待超时则整体重放。
     *
     * <p>只重试死锁与锁等待超时这两类；业务异常（如 `ALREADY_LIKED`）原样抛出 ——
     * 那是语义结果，重放多少次都一样。
     *
     * <p>用 {@code Supplier} 而不是 {@code Runnable}：调用方需要拿到事务内的**真实结果**
     * （例如「到底删掉了几行」），再据此决定事务外的 Redis 热度怎么写。
     * 若改成在回调里直接操作 Redis，死锁重放会导致重复计数 —— 所以结果必须带出来。
     */
    private <T> T txWithRetry(java.util.function.Supplier<T> work) {
        for (int attempt = 1; ; attempt++) {
            try {
                return txTemplate.execute(status -> work.get());
            } catch (DeadlockLoserDataAccessException | CannotAcquireLockException e) {
                if (attempt >= MAX_DEADLOCK_RETRY) {
                    log.warn("死锁重放 {} 次仍失败，返回「稍后再试」：{}", attempt, e.getMessage());
                    throw BizException.of(ErrorCode.RATE_LIMITED);
                }
                log.warn("死锁，第 {} 次重放：{}", attempt, e.getMostSpecificCause().getMessage());
            }
        }
    }

    /* ---------------- 点赞 ---------------- */
    public void like(Long postId) {
        Long uid = StpUtil.getLoginIdAsLong();
        Post p = postMapper.selectById(postId);
        if (p == null) throw BizException.of(ErrorCode.POST_NOT_FOUND);
        txWithRetry(() -> {
            try {
                LikeRecord r = new LikeRecord();
                r.setUserId(uid);
                r.setTargetType("post");
                r.setTargetId(postId);
                r.setCreatedAt(LocalDateTime.now());
                likeRecordMapper.insert(r);
            } catch (DuplicateKeyException e) {
                throw BizException.of(ErrorCode.ALREADY_LIKED);
            }
            postMapper.incrLike(postId, 1);
            notify(p.getUserId(), Notification.TYPE_LIKE, uid, postId);
            /* 返回值这里用不上（加分是无条件的），仅为满足 Supplier 签名。 */
            return null;
        });
        /* 热度加分放在事务**之外**：Redis 不参与事务、也没有回滚，若放在 txWithRetry 内部，
           一次死锁重放就会重复加分（点一个赞却加两次热度）。放外面则只有事务成功才加，
           重放不会重复计数。bump() 内部已吞掉 Redis 异常，Redis 挂了也不影响点赞。
           权重 8 = 点赞，权重 1 = 浏览（浏览在 PostService.detail 里加）。 */
        hotService.bump(postId, 8);
    }

    public void unlike(Long postId) {
        Long uid = StpUtil.getLoginIdAsLong();
        /* 把「确实删掉了几行」带出事务：只有真删了才该扣热度。
           n == 0 表示本来就没点过赞，此时扣分会让热度和点赞数脱节。 */
        int removed = txWithRetry(() -> {
            int n = likeRecordMapper.delete(new LambdaQueryWrapper<LikeRecord>()
                    .eq(LikeRecord::getUserId, uid)
                    .eq(LikeRecord::getTargetType, "post")
                    .eq(LikeRecord::getTargetId, postId));
            if (n > 0) postMapper.incrLike(postId, -1);
            return n;
        });
        /* 与 like() 对称：热度 -8。同样放在事务**之外**，避免死锁重放时重复扣分。
           注意 ZSet 分数允许为负 —— 那只是排名靠底，不会影响热榜读取（reverseRange 仍照取）。
           副作用：历史预热过的分数（按 likeCount×8 + viewCount 灌入）与逐次增减的差值
           会有少量漂移，属可接受误差；要完全对齐只能定期重算。 */
        if (removed > 0) hotService.bump(postId, -8);
    }

    public boolean liked(Long postId) {
        Long uid = StpUtil.getLoginIdAsLong();
        return likeRecordMapper.selectCount(new LambdaQueryWrapper<LikeRecord>()
                .eq(LikeRecord::getUserId, uid)
                .eq(LikeRecord::getTargetType, "post")
                .eq(LikeRecord::getTargetId, postId)) > 0;
    }

    /* ---------------- 收藏 ---------------- */
    public void favorite(Long postId) {
        Long uid = StpUtil.getLoginIdAsLong();
        if (postMapper.selectById(postId) == null) throw BizException.of(ErrorCode.POST_NOT_FOUND);
        Favorite f = new Favorite();
        f.setUserId(uid);
        f.setPostId(postId);
        f.setCreatedAt(LocalDateTime.now());
        try {
            favoriteMapper.insert(f);
        } catch (DuplicateKeyException ignored) {
            // 已收藏视为成功（幂等）
        }
    }

    public void unfavorite(Long postId) {
        Long uid = StpUtil.getLoginIdAsLong();
        favoriteMapper.delete(new LambdaQueryWrapper<Favorite>()
                .eq(Favorite::getUserId, uid).eq(Favorite::getPostId, postId));
    }

    public boolean favorited(Long postId) {
        Long uid = StpUtil.getLoginIdAsLong();
        return favoriteMapper.selectCount(new LambdaQueryWrapper<Favorite>()
                .eq(Favorite::getUserId, uid).eq(Favorite::getPostId, postId)) > 0;
    }

    /* ---------------- 关注 ---------------- */
    public void follow(Long targetId) {
        Long uid = StpUtil.getLoginIdAsLong();
        if (uid.equals(targetId)) throw BizException.of(ErrorCode.PARAM_INVALID);
        Follow f = new Follow();
        f.setFollowerId(uid);
        f.setFolloweeId(targetId);
        f.setCreatedAt(LocalDateTime.now());
        try {
            followMapper.insert(f);
        } catch (DuplicateKeyException ignored) {
            // 幂等
        }
        notify(targetId, Notification.TYPE_FOLLOW, uid, null);
    }

    public void unfollow(Long targetId) {
        Long uid = StpUtil.getLoginIdAsLong();
        followMapper.delete(new LambdaQueryWrapper<Follow>()
                .eq(Follow::getFollowerId, uid).eq(Follow::getFolloweeId, targetId));
    }

    public boolean following(Long targetId) {
        Long uid = StpUtil.getLoginIdAsLong();
        return followMapper.selectCount(new LambdaQueryWrapper<Follow>()
                .eq(Follow::getFollowerId, uid).eq(Follow::getFolloweeId, targetId)) > 0;
    }

    /* ---------------- 通知产生 ---------------- */
    private void notify(Long toUserId, String type, Long senderId, Long targetId) {
        if (toUserId == null || toUserId.equals(senderId)) return;   // 自己给自己不通知
        Notification n = new Notification();
        n.setUserId(toUserId);
        n.setType(type);
        n.setSenderId(senderId);
        n.setTargetId(targetId);
        n.setIsRead(0);
        n.setCreatedAt(LocalDateTime.now());
        notificationMapper.insert(n);
    }
}
