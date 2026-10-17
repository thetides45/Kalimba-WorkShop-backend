package com.kalimba.workshop.module.search;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.kalimba.workshop.common.result.PageResult;
import com.kalimba.workshop.dto.PostVO;
import com.kalimba.workshop.dto.SearchResp;
import com.kalimba.workshop.dto.UserBrief;
import com.kalimba.workshop.entity.Post;
import com.kalimba.workshop.entity.Tag;
import com.kalimba.workshop.entity.User;
import com.kalimba.workshop.mapper.PostMapper;
import com.kalimba.workshop.mapper.SearchLogMapper;
import com.kalimba.workshop.mapper.TagMapper;
import com.kalimba.workshop.mapper.UserMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 综合搜索（WBS 4.4 的增强）：关键词同时匹配 <b>标题 / 正文 / 标签名 / 作者昵称(用户名)</b>。
 *
 * <p><b>实现取舍</b>：这里走 MySQL {@code LIKE '%kw%'}，不上 FULLTEXT / ES。原因是
 * 当前数据量（社区早期）下全表扫完全够用，而 FULLTEXT 在中文场景必须配 {@code ngram} 解析器、
 * 且 MyBatis-Plus 的 LambdaQueryWrapper 表达不了 {@code MATCH ... AGAINST}（要另写 Mapper SQL）。
 * 这段注释就是留给后续升级的锚点：数据量上万级、或需要「相关度排序」时，把
 * {@link #search} 里的帖子查询换成 {@code MATCH(title,content) AGAINST(? IN BOOLEAN MODE)}
 * 并给 post 表加 {@code FULLTEXT ft_ptc (title, content) WITH PARSER ngram} 即可，
 * 接口契约（SearchResp）不用动。
 *
 * <p><b>为什么先查标签/用户再查帖子</b>：post.tag_ids 是逗号分隔字符串（设计上避免第三张表），
 * 用 {@code find_in_set} 无法索引，也无法在 SQL 里 join 标签名。所以先按名字挑出候选
 * 标签 id / 用户 id，再作为「或」条件拼进帖子查询 —— 两小步换一个可读且不用改表结构的实现。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class SearchService {

    /** 参与 OR 匹配的标签/作者上限：避免命中过多 id 把 SQL 拉成超长 IN 列表。 */
    private static final int MAX_TAG_HITS = 20;
    private static final int MAX_USER_HITS = 50;

    /** users / tags 两个分组各自最多返回多少条。 */
    private static final int MAX_SIDE_LIST = 20;

    /** 单页最大条数，防止前端传 size=9999 拖库。 */
    private static final int MAX_PAGE_SIZE = 50;

    /** 关键词入库上限：超长多半是误粘贴，不入热搜。 */
    private static final int MAX_KEYWORD_LEN = 32;

    private final PostMapper postMapper;
    private final UserMapper userMapper;
    private final TagMapper tagMapper;
    private final SearchLogMapper searchLogMapper;

    /** 是否把搜索词写入 search_log（热搜榜数据源）。关掉则热搜恒空，前端会回退显示热门标签。 */
    @Value("${kalimba.search.log-keywords:true}")
    private boolean logKeywords;

    /** 热搜榜默认统计窗口（天）。 */
    @Value("${kalimba.search.hot-days:7}")
    private int hotDays;

    public SearchResp search(String keyword, String type, int page, int size) {
        SearchResp resp = new SearchResp();
        String kw = keyword == null ? "" : keyword.trim();
        int p = Math.max(page, 1);
        int s = Math.min(Math.max(size, 1), MAX_PAGE_SIZE);
        resp.setKeyword(kw);
        resp.setPosts(PageResult.empty(p, s));

        /* 空关键词直接返回空结果：否则 LIKE '%%' 会命中全表，既是无意义查询也是变相的拖库入口。 */
        if (kw.isEmpty()) return resp;

        String t = (type == null || type.isBlank()) ? "all" : type.trim().toLowerCase();
        boolean wantPosts = "all".equals(t) || "post".equals(t);
        boolean wantUsers = "all".equals(t) || "user".equals(t);
        boolean wantTags = "all".equals(t) || "tag".equals(t);

        /* 只把「一次新搜索」计入热搜：翻页（page>1）与结果页内切分组（type≠all）
           都不该把同一个词重复计数，否则点几次 chip 就刷出假热度。 */
        if (logKeywords && p <= 1 && "all".equals(t)) logKeyword(kw);

        /* 标签表很小（< 百行），一次读全：既用于「标签名命中」，也用于给帖子回填 tags 对象。 */
        List<Tag> allTags = tagMapper.selectList(null);
        Map<Long, Tag> tagById = allTags.stream()
                .filter(x -> x.getId() != null)
                .collect(Collectors.toMap(Tag::getId, x -> x, (a, b) -> a, LinkedHashMap::new));
        List<Tag> matchedTags = allTags.stream()
                .filter(x -> x.getName() != null && x.getName().contains(kw))
                .toList();
        List<Long> matchedTagIds = matchedTags.stream().map(Tag::getId).limit(MAX_TAG_HITS).toList();

        /* 用户维度：昵称或用户名命中，且只搜正常账号（封禁用户不该被搜出来）。 */
        List<User> matchedUsers = userMapper.selectList(new LambdaQueryWrapper<User>()
                .eq(User::getStatus, 1)
                .and(q -> q.like(User::getNickname, kw).or().like(User::getUsername, kw))
                .orderByDesc(User::getCreatedAt)
                .last("limit " + MAX_USER_HITS));
        List<Long> matchedUserIds = matchedUsers.stream().map(User::getId).toList();

        if (wantPosts) {
            LambdaQueryWrapper<Post> w = new LambdaQueryWrapper<>();
            w.eq(Post::getStatus, 1);
            w.and(q -> {
                q.like(Post::getTitle, kw).or().like(Post::getContent, kw);
                for (Long tid : matchedTagIds) {
                    q.or().apply("find_in_set({0}, tag_ids)", tid);
                }
                if (!matchedUserIds.isEmpty()) {
                    q.or().in(Post::getUserId, matchedUserIds);
                }
            });
            /* 排序：LIKE 没有相关度可言，先按发布时间倒序（后续上 FULLTEXT 可换成 score 排序）。 */
            w.orderByDesc(Post::getCreatedAt);

            Page<Post> postPage = postMapper.selectPage(new Page<>(p, s), w);
            Map<Long, UserBrief> authors = loadAuthors(postPage.getRecords());
            resp.setPosts(PageResult.of(postPage, post -> toVO(post, authors, tagById, kw, matchedTagIds)));
        }

        if (wantUsers) {
            resp.setUsers(matchedUsers.stream().limit(MAX_SIDE_LIST).map(UserBrief::of).toList());
        }
        if (wantTags) {
            resp.setTags(matchedTags.stream().limit(MAX_SIDE_LIST).toList());
        }
        return resp;
    }

    /* ---------------- 热搜词 ---------------- */

    /**
     * 近 N 天的热搜词 Top N，返回 [{keyword, count}]。
     *
     * <p>榜是「锦上添花」，所以这里没有任何权限要求，也不缓存 —— 数据量是
     * 「词数 × 天数」，一次 group by 的代价恒定且很小。
     */
    public List<Map<String, Object>> hotWords(int limit, int days) {
        int d = days > 0 ? Math.min(days, 90) : Math.max(hotDays, 1);
        int n = Math.min(Math.max(limit, 1), 20);
        return searchLogMapper.top(d, n);
    }

    /**
     * 记一次搜索词。best-effort：写日志失败绝不能影响搜索本身，
     * 所以异常只记 warn 不抛 —— 热搜榜停更远好过搜索报错。
     */
    private void logKeyword(String kw) {
        try {
            if (kw.length() > MAX_KEYWORD_LEN) return;
            searchLogMapper.bump(kw);
        } catch (Exception e) {
            log.warn("记录搜索词失败（不影响搜索）：{}", kw, e);
        }
    }

    /** 一次批量取回本页作者，避免逐条查用户。 */
    private Map<Long, UserBrief> loadAuthors(List<Post> posts) {
        Set<Long> ids = posts.stream().map(Post::getUserId).filter(Objects::nonNull).collect(Collectors.toSet());
        if (ids.isEmpty()) return Map.of();
        return userMapper.selectBatchIds(ids).stream()
                .collect(Collectors.toMap(User::getId, UserBrief::of, (a, b) -> a));
    }

    private PostVO toVO(Post post, Map<Long, UserBrief> authors, Map<Long, Tag> tagById,
                        String kw, List<Long> matchedTagIds) {
        UserBrief author = authors.get(post.getUserId());
        Map<String, Tag> hitTags = new LinkedHashMap<>();
        List<String> matchedIn = new ArrayList<>();

        if (post.getTitle() != null && post.getTitle().contains(kw)) matchedIn.add("title");
        if (post.getContent() != null && post.getContent().contains(kw)) matchedIn.add("content");

        List<Tag> tags = new ArrayList<>();
        if (post.getTagIds() != null && !post.getTagIds().isBlank()) {
            for (String raw : post.getTagIds().split(",")) {
                String idStr = raw.trim();
                if (idStr.isEmpty()) continue;
                Long tid = parseLong(idStr);
                Tag tag = tid == null ? null : tagById.get(tid);
                if (tag != null) {
                    tags.add(tag);
                    hitTags.put(idStr, tag);
                }
            }
        }
        /* 标签命中：这条帖子挂了「名字含关键词」的标签。
           用 id 集合比对而非直接看 tags，是因为命中的标签可能超出 MAX_TAG_HITS 未进入 OR 条件。 */
        for (Long tid : matchedTagIds) {
            if (hitTags.containsKey(String.valueOf(tid))) { matchedIn.add("tag"); break; }
        }
        /* 作者命中：作者昵称/用户名含关键词。 */
        if (author != null
                && ((author.getNickname() != null && author.getNickname().contains(kw))
                    || (author.getUsername() != null && author.getUsername().contains(kw)))) {
            matchedIn.add("user");
        }

        return PostVO.of(post, author, tags, matchedIn.stream().distinct().toList());
    }

    private static Long parseLong(String s) {
        try {
            return Long.parseLong(s);
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
