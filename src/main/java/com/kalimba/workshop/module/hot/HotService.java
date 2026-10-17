package com.kalimba.workshop.module.hot;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.kalimba.workshop.entity.Post;
import com.kalimba.workshop.mapper.PostMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ZSetOperations;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 热榜服务（WBS 4.6，规划书 4.4 性能）。
 *
 * <p>Redis ZSet 维护加权热度：score = 点赞×8 + 浏览×1。读接口先取 Redis 排名、再回 MySQL 补全帖子；
 * Redis 不可用则退化为按点赞数查库 —— 保证功能不因缓存故障而断。
 *
 * <p><b>⚠️ 增量维护的 ZSet 必须守三条，少一条热榜就会「比降级路径还差」（缺口 B18 的落点）：</b>
 * <ol>
 *   <li><b>要预热</b>：{@link #bump} 只加增量，ZSet <b>不会自己长出历史热度</b>。判据**不能**写成
 *       「键不存在才灌」—— 实测踩到：Redis 重启后第一个请求就是「浏览某篇帖」，{@code INCREMENT}
 *       会把键**抢先创建成只有 1 个成员**，于是「键存在」成立、预热再也不触发，热榜永远只有 1 条。
 *       正解是<b>按「齐不齐」判断</b>：见 {@link #ensureWarm()}。</li>
 *   <li><b>要失效</b>：帖子被删 / 下架必须 {@link #drop}。不清的话 ZSet 会攒下指向已消失帖子的
 *       孤儿成员 —— 它们看不见，却<b>占着 {@code reverseRange} 的名额</b>，让返回条数莫名少于 limit。</li>
 *   <li><b>要过滤</b>：ZSet 只是「热度索引」，不是「可见性真相」。读取必须回库按 {@code status=1}
 *       复核，否则已下架的帖子会照常出现在热榜上。</li>
 * </ol>
 *
 * <p>构造器手写（不用 {@code @RequiredArgsConstructor}）：redis 用
 * {@code @Autowired(required = false)} 可空注入，Redis 缺席时整个类退化成「只查库」。
 */
@Slf4j
@Service
public class HotService {

    private static final String KEY = "hot:posts";

    /** 点赞与浏览的换算比（与规划书 4.4 一致）。 */
    private static final int LIKE_WEIGHT = 8;

    /** 榜单最多维护多少篇（按热度降序取）。帖量级小、正常是「全维护」，这个上限纯属防御。 */
    private static final int WARM_MAX = 2000;

    private final PostMapper postMapper;
    private final StringRedisTemplate redis;

    public HotService(PostMapper postMapper, @Autowired(required = false) StringRedisTemplate redis) {
        this.postMapper = postMapper;
        this.redis = redis;
    }

    /**
     * 热榜前 N。缓存（先补齐再读）给不出结果时，退化为按点赞数查库。
     */
    public List<Post> top(int limit) {
        if (!ensureWarm()) return fallback(limit);      // Redis 不可用 → 直接降级（已告警一次）
        List<Long> ids = redisIds(limit);
        if (ids != null && !ids.isEmpty()) {
            List<Post> posts = loadOrdered(ids);
            if (!posts.isEmpty()) return posts;         // 补全后仍为空 → 降到兜底
        }
        return fallback(limit);
    }

    /** 降级路径：Redis 不可用 / 榜单已失效时的兜底，按点赞数排序。 */
    private List<Post> fallback(int limit) {
        return postMapper.selectList(new LambdaQueryWrapper<Post>()
                .eq(Post::getStatus, 1)
                .orderByDesc(Post::getLikeCount)
                .orderByDesc(Post::getCreatedAt)
                .last("limit " + Math.min(limit, 50)));
    }

    /**
     * 保证榜单「齐」：ZSet 成员数少于「库中可见帖数」时，把缺的那些补进去。
     *
     * <p>判据是<b>数量对比</b>而不是「键在不在」（理由见类注释第 1 条）。这样 Redis 丢数据
     * （重启 / 被清）、或键被某次 {@code INCREMENT} 抢先建成了半截，下一次读都会自动补齐 ——
     * 不需要额外的标记键，也不会因为交互先发生就永久失灵。
     *
     * <p>成本是一次 {@code ZCARD} + 一次 {@code COUNT(*)}；数量对齐后本方法立即返回，不做多余命令。
     *
     * @return {@code false} 表示 Redis 不可用（已告警），调用方应直接走降级、别再读缓存
     */
    private boolean ensureWarm() {
        if (redis == null) return false;
        try {
            Long size = redis.opsForZSet().size(KEY);
            long want = Math.min(countVisible(), WARM_MAX);
            if (size == null || size < want) fillMissing();
            return true;
        } catch (Exception e) {
            log.warn("热榜缓存不可用（预热探测失败），本次退化为查库：{}", e.getMessage());
            return false;
        }
    }

    /** 库中可见（status=1）的帖子数 —— 榜单「应该」有的成员数。 */
    private long countVisible() {
        Long n = postMapper.selectCount(new LambdaQueryWrapper<Post>().eq(Post::getStatus, 1));
        return n == null ? 0 : n;
    }

    /**
     * 把库里有、榜里没有的帖子补进 ZSet。
     *
     * <p>⚠️ <b>只补缺失的，绝不覆盖已有的</b>：已有成员身上带着交互攒出来的分数（点赞 +8 / 浏览 +1），
     * 用库里的 {@code 点赞×8 + 浏览} 重新算一遍虽然大体相等，但会抹掉「下架期间被 drop、恢复时
     * 已由 {@link #sync} 回填」这类边界状态的差值。补缺不覆盖，怎么触发都不会错。
     *
     * @return 本次补入的条数
     */
    private int fillMissing() {
        Set<String> have = redis.opsForZSet().range(KEY, 0, -1);
        List<Post> src = postMapper.selectList(new LambdaQueryWrapper<Post>()
                .eq(Post::getStatus, 1)
                .orderByDesc(Post::getLikeCount)
                .orderByDesc(Post::getViewCount)
                .last("limit " + WARM_MAX));
        if (src.isEmpty()) return 0;
        Set<ZSetOperations.TypedTuple<String>> add = new LinkedHashSet<>();
        for (Post p : src) {
            String id = String.valueOf(p.getId());
            if (have != null && have.contains(id)) continue;
            add.add(ZSetOperations.TypedTuple.of(id, scoreOf(p)));
        }
        if (add.isEmpty()) return 0;
        redis.opsForZSet().add(KEY, add);
        return add.size();
    }

    /**
     * 重建热榜缓存（管理员 / 运维入口）。
     *
     * <p>与自动预热的分工：预热只补「缺的」，<b>不会纠正已经错了的分数</b>；这里删键重灌，
     * 让全部分数回到「按库里的点赞/浏览重算」的基准 —— 用于榜单与库明显对不上、
     * 或想重置手动调过分的场景。
     *
     * <p>刻意**不吞异常**：这是管理员显式发起的运维动作，失败就该报出来（走全局异常处理返回错误码），
     * 而不是返回一个看着正常的 0。
     *
     * @return 重建后写入的成员数；Redis 缺席时返回 0
     */
    public int rebuild() {
        if (redis == null) return 0;
        redis.delete(KEY);
        int n = fillMissing();
        log.info("热榜缓存已重建：{} 篇", n);
        return n;
    }

    /**
     * 把一篇帖子的热度**覆盖**成库里的当前值（帖子重新上架时调用）。
     *
     * <p>用「覆盖」而不是 {@link #bump} 的「累加」：帖子下架期间已被 {@link #drop} 移出 ZSet，
     * 恢复时若从 0 累加，它攒过的历史热度就丢了。找不到 / 已不可见时等同 {@link #drop}。
     */
    public void sync(Post p) {
        if (redis == null || p == null || p.getId() == null) return;
        try {
            if (p.getStatus() != null && p.getStatus() != 1) {
                drop(p.getId());
                return;
            }
            redis.opsForZSet().add(KEY, String.valueOf(p.getId()), scoreOf(p));
        } catch (Exception e) {
            log.warn("热榜同步失败：{}", e.getMessage());
        }
    }

    /**
     * 把一篇帖子移出热榜（删帖 / 下架时调用）。
     *
     * <p>⚠️ 不做这一步，ZSet 会攒下指向已消失帖子的孤儿成员 —— 读取时虽然会被
     * {@link #loadOrdered} 丢掉（回库查不到），但它们**仍占着 {@code reverseRange} 的名额**，
     * 结果就是「榜里明明有 id，返回的条数却少于 limit」。
     */
    public void drop(Long postId) {
        if (redis == null || postId == null) return;
        try {
            redis.opsForZSet().remove(KEY, String.valueOf(postId));
        } catch (Exception e) {
            log.warn("热榜移除失败：{}", e.getMessage());
        }
    }

    /** 点赞 / 浏览时由互动与浏览路径调用，给热度加分。 */
    public void bump(Long postId, double score) {
        if (redis == null) return;
        try {
            redis.opsForZSet().incrementScore(KEY, String.valueOf(postId), score);
        } catch (Exception e) {
            log.warn("热榜写入失败：{}", e.getMessage());
        }
    }

    /** 热度公式：点赞×8 + 浏览×1（字段可能为 null，按 0 计）。 */
    private static double scoreOf(Post p) {
        int like = p.getLikeCount() == null ? 0 : p.getLikeCount();
        int view = p.getViewCount() == null ? 0 : p.getViewCount();
        return like * (double) LIKE_WEIGHT + view;
    }

    /** @return 降序的 id 列表；Redis 不可用返回 {@code null}（区别于「键为空」的空列表） */
    private List<Long> redisIds(int limit) {
        if (redis == null) return null;
        try {
            Set<String> ids = redis.opsForZSet().reverseRange(KEY, 0, limit - 1);
            List<Long> out = new ArrayList<>();
            if (ids != null) for (String s : ids) out.add(Long.parseLong(s));
            return out;
        } catch (Exception e) {
            log.warn("热榜读取失败，退化为查库：{}", e.getMessage());
            return null;
        }
    }

    /**
     * 按 ZSet 给出的顺序回库补全帖子。
     *
     * <p>查询里带 {@code status=1} —— 见「要过滤」那条。顺手也让「ZSet 里的孤儿 / 已下架 id」
     * 在这一步自然落空（{@code in} 查不到就不返回），不需要另外做集合差。
     */
    private List<Post> loadOrdered(List<Long> ids) {
        List<Post> posts = postMapper.selectList(new LambdaQueryWrapper<Post>()
                .in(Post::getId, ids)
                .eq(Post::getStatus, 1));
        posts.sort((a, b) -> ids.indexOf(a.getId()) - ids.indexOf(b.getId()));
        return posts;
    }
}
