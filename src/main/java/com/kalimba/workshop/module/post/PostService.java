package com.kalimba.workshop.module.post;

import cn.dev33.satoken.stp.StpUtil;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.kalimba.workshop.common.exception.BizException;
import com.kalimba.workshop.common.exception.ErrorCode;
import com.kalimba.workshop.common.ratelimit.RateLimiter;
import com.kalimba.workshop.common.sensitive.SensitiveWordFilter;
import com.kalimba.workshop.dto.PostReq;
import com.kalimba.workshop.entity.Comment;
import com.kalimba.workshop.entity.Post;
import com.kalimba.workshop.mapper.CommentMapper;
import com.kalimba.workshop.mapper.PostMapper;
import com.kalimba.workshop.module.hot.HotService;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * 帖子服务（WBS 4.3）。
 *
 * <p>检索走 MySQL LIKE + 标签筛选（规划书 4.4 的取舍），保留 FULLTEXT 升级空间。
 * 越权校验统一在「非作者且非管理员不得改删」一条上。
 */
@Service
@RequiredArgsConstructor
public class PostService {

    private final PostMapper postMapper;
    private final CommentMapper commentMapper;
    private final SensitiveWordFilter sensitiveWordFilter;
    private final RateLimiter rateLimiter;
    private final HotService hotService;
    /** 把清洗后的块数组序列化成 JSON 存库（Spring Boot 自带的 Bean）。 */
    private final ObjectMapper objectMapper;

    /** 发帖审核模式：auto = 发布即过审；pre = 先审后发（status=0，进待审队列）。 */
    @Value("${kalimba.audit.post-mode:auto}")
    private String postAuditMode;

    /**
     * 帖子分页。{@code userId} 可选 —— 传了就只看该作者的帖（「我的谱帖」/ 他人主页都用它）。
     *
     * <p>{@code tagId} 与 {@code tagIds} 二选一：前者单标签（首页 chips 用），
     * 后者是**逗号分隔的多标签并集**（作品广场要「曲谱分享/教程/翻弹/原创」四选一）。
     * 同时给时以 {@code tagId} 为准，保持既有语义不变。
     *
     * <p>⚠️ 有一条**依赖调用者身份**的规则，是刻意的：查**自己**时包含 status=0（待审）。
     * 否则 `post-mode=pre` 下作者发完帖回自己主页会看到「一条都没有」，像发布失败。
     * 查**别人**只给 status=1；下架（2）对谁都不展示。
     */
    public Page<Post> list(int page, int size, Long tagId, String tagIds, String sort, String keyword, Long userId) {
        LambdaQueryWrapper<Post> w = new LambdaQueryWrapper<>();
        if (userId == null) {
            w.eq(Post::getStatus, 1);
        } else {
            w.eq(Post::getUserId, userId);
            /* 自己的帖子：0 待审 + 1 正常 + 3 草稿；别人：只给 1。
               ⚠️ `userId` 是**公开查询参数**（匿名也能带），所以判据必须由 isSelf() 去**登录态**里取，
                  不能写成「传了 userId 就放行」—— 匿名带 ?userId=2 仍然只命中 [1]。 */
            w.in(Post::getStatus, isSelf(userId) ? List.of(0, 1, 3) : List.of(1));
        }
        List<Long> multi = parseTagIds(tagIds);
        if (tagId != null) {
            w.apply("find_in_set({0}, tag_ids)", tagId);
        } else if (!multi.isEmpty()) {
            /* 多标签并集：命中所列**任一**标签即入选。
               ⚠️ 必须用 and(...) 把这一组 OR **包起来** —— 否则 OR 会与上面的
               status / userId 条件落在同一层，变成「status=1 或 命中标签」，
               把待审帖、别人的帖一起漏出来（这是最容易写错的一处）。 */
            List<Long> ids = multi;
            w.and(x -> {
                for (int i = 0; i < ids.size(); i++) {
                    if (i > 0) x.or();
                    x.apply("find_in_set({0}, tag_ids)", ids.get(i));
                }
            });
        }
        if (keyword != null && !keyword.isBlank()) w.like(Post::getTitle, keyword.trim());
        switch (sort == null ? "latest" : sort) {
            case "hot" -> w.orderByDesc(Post::getLikeCount).orderByDesc(Post::getCreatedAt);
            default -> w.orderByDesc(Post::getCreatedAt);
        }
        return postMapper.selectPage(new Page<>(page, size), w);
    }

    /** 逗号分隔的标签 id → List；脏值静默跳过（筛选参数不该让整个列表 500）。 */
    private static List<Long> parseTagIds(String csv) {
        List<Long> out = new ArrayList<>();
        if (csv == null || csv.isBlank()) return out;
        for (String s : csv.split(",")) {
            String t = s.trim();
            if (t.isEmpty()) continue;
            try {
                out.add(Long.valueOf(t));
            } catch (NumberFormatException ignore) {
                /* 忽略 */
            }
            if (out.size() >= 20) break;   // 上限：避免有人塞几百个 id 把 SQL 撑爆
        }
        return out;
    }

    /** 当前登录者是不是这个 userId（匿名 / 未登录一律 false）。 */
    private boolean isSelf(Long userId) {
        try {
            Object lid = StpUtil.getLoginIdDefaultNull();
            if (lid == null) return false;
            return Long.valueOf(String.valueOf(lid)).equals(userId);
        } catch (NumberFormatException e) {
            return false;
        }
    }

    /** 待审队列（status=0），供管理端审核。 */
    public Page<Post> listPending(int page, int size) {
        return postMapper.selectPage(new Page<>(page, size),
                new LambdaQueryWrapper<Post>()
                        .eq(Post::getStatus, 0)
                        .orderByAsc(Post::getCreatedAt));
    }

    /**
     * 帖子详情。
     *
     * <p><b>非「正常」态（0 待审 / 2 下架 / 3 草稿）只放行两类人：作者本人与管理员</b>，
     * 其余一律仍按 {@code POST_NOT_FOUND} 返回 —— 刻意**不区分**「帖子不存在」与「无权查看」，
     * 否则拿 id 从 1 遍历就能探出谁有几篇草稿、谁被下架过。
     *
     * <p>⚠️ 这条规则原先只认 {@code status == 1}，于是 {@code post-mode=pre} 时
     * <b>作者自己也点不进自己的待审帖</b>：列表里有（{@link #list} 对作者放行 0/1）、
     * 点开却 404。2026-10-14 一并修掉。
     */
    public Post detail(Long id) {
        Post p = postMapper.selectById(id);
        if (p == null) throw BizException.of(ErrorCode.POST_NOT_FOUND);
        int st = p.getStatus() == null ? 1 : p.getStatus();
        if (st != 1 && !isSelf(p.getUserId()) && !isAdmin()) {
            throw BizException.of(ErrorCode.POST_NOT_FOUND);
        }
        /* ⚠️ 只有「正常」态才计浏览与热度：作者反复点开自己的草稿不该把自己顶进热榜；
           待审 / 下架帖更不该计入（热榜侧本来就按 status=1 过滤，这里不拦会让浏览数与榜单口径打架）。
           浏览加热度：热度公式 score = 点赞×8 + 浏览×1（见 HotService）。
           放在这里而不是切面里 —— 切面无法区分「详情读取」与「列表读取」。
           bump() 内部已 try-catch 吞掉 Redis 异常，Redis 不可用时不影响浏览。 */
        if (st == 1) {
            postMapper.incrView(id);
            p.setViewCount((p.getViewCount() == null ? 0 : p.getViewCount()) + 1);
            hotService.bump(id, 1);
        }
        return p;
    }

    public Post create(PostReq req) {
        rateLimiter.check("post:create:" + StpUtil.getLoginIdAsLong(), 5, Duration.ofMinutes(1));
        sensitiveWordFilter.assertClean(req.getTitle());
        if (req.getContent() != null) sensitiveWordFilter.assertClean(req.getContent());

        Post p = new Post();
        p.setUserId(StpUtil.getLoginIdAsLong());
        p.setTitle(req.getTitle().trim());
        p.setContent(req.getContent());
        /* blocks（路线 B）：null → null（没有块）；非 null → 白名单清洗后序列化。 */
        p.setBlocks(sanitizeBlocks(req.getBlocks()));
        p.setCover(req.getCover());
        p.setTagIds(req.getTagIds() == null ? "" :
                req.getTagIds().stream().map(String::valueOf).collect(Collectors.joining(",")));
        p.setScoreFileId(req.getScoreFileId());
        p.setViewCount(0);
        p.setLikeCount(0);
        /* 三种去向（2026-10-14 引入草稿）：
             draft=true → 3 草稿（仅作者可见，不进列表 / 详情 / 搜索 / 热榜）
             pre 模式   → 0 待审（进管理端待审队列）
             其余        → 1 正常
           ⚠️ 草稿**不复用 0** —— 0 已被 listPending() 与管理端待审计数占用，
              混用会把草稿塞进审核队列、并给作者发出「已转为待审核」的错误通知。
           三种去向都要过敏感词，草稿也不例外（assertClean 已在上面拦过）。 */
        p.setStatus(Boolean.TRUE.equals(req.getDraft()) ? 3
                : ("pre".equalsIgnoreCase(postAuditMode) ? 0 : 1));
        p.setCreatedAt(LocalDateTime.now());
        p.setUpdatedAt(LocalDateTime.now());
        postMapper.insert(p);
        return p;
    }

    @Transactional
    public Post update(Long id, PostReq req) {
        Post p = requireOwned(id);
        sensitiveWordFilter.assertClean(req.getTitle());
        if (req.getContent() != null) sensitiveWordFilter.assertClean(req.getContent());
        p.setTitle(req.getTitle().trim());
        p.setContent(req.getContent());
        /* blocks 的更新语义：**null = 本次不改动**（前端编辑老帖时根本不会带这个字段），
           空数组 = 清空（sanitizeBlocks 把空数组归一成 null）。
           之所以要这个约定：Jackson 分不清「字段缺失」与「显式传 null」，只能借空数组表达删除意图。

           ⚠️ 清空必须**额外显式 set 一条**：MyBatis-Plus 的 updateById 默认是 NOT_NULL 策略，
              字段为 null 时**跳过该列** ⇒ 「清空块」永远写不进库（冒烟里就是这条红的）。
              这里用 LambdaUpdateWrapper 显式 set，null 才真的落得下去。
              上面加了 @Transactional：两条语句要么都成、要么都不成。 */
        if (req.getBlocks() != null) {
            String cleanBlocks = sanitizeBlocks(req.getBlocks());
            p.setBlocks(cleanBlocks);
            if (cleanBlocks == null) {
                postMapper.update(null, new LambdaUpdateWrapper<Post>()
                        .eq(Post::getId, id).set(Post::getBlocks, null));
            }
        }
        p.setCover(req.getCover());
        if (req.getTagIds() != null) {
            p.setTagIds(req.getTagIds().stream().map(String::valueOf).collect(Collectors.joining(",")));
        }
        p.setScoreFileId(req.getScoreFileId());
        p.setUpdatedAt(LocalDateTime.now());
        postMapper.updateById(p);
        return p;
    }

    /* ==================== 正文块：白名单清洗（路线 B 的安全边界） ==================== */

    /** 一条正文最多几个块。 */
    private static final int BLOCK_MAX = 60;
    /** 单个文本块的字数上限。 */
    private static final int BLOCK_TEXT_MAX = 5000;
    /** 清洗完的整段 JSON 长度上限（防止超大正文拖垮查询与传输）。 */
    private static final int BLOCK_JSON_MAX = 100_000;
    /** 图片地址前缀白名单 —— 只收本站图床的相对路径。 */
    private static final String IMG_PREFIX = "/uploads/img/";

    /**
     * 把前端传来的块数组**逐块重建**成干净结构，再序列化成 JSON。
     *
     * <p>这是路线 B 的**安全边界**。前端渲染全程走 Vue 模板（自动转义），所以
     * 「库里只有白名单字段、且类型正确」就等于没有 XSS 面；反过来，这里一旦放行未知 type
     * 或者原样存整块，白名单就白设了。
     *
     * <p>规则：
     * <ul>
     *   <li>只认 text / image / score / divider；**别的 type 直接报 1001**，不静默丢弃 ——
     *       静默丢弃会让前端以为存成功了、实际正文少一块，比报错难查得多。</li>
     *   <li>每个块都**重新构造**，只拷白名单字段 ⇒ 请求里夹带的多余键一概进不来。</li>
     *   <li>image.url 必须以 {@code /uploads/img/} 开头：既挡外链（盗链、追踪像素），
     *       也挡 {@code javascript:} / {@code data:} 这类伪协议。</li>
     *   <li>text 原样存字符串 —— 里面的 {@code <script>} 只是一段文字，前端用
     *       {@code {{ }}} 输出会被转义显示，不会被当标签解析。</li>
     * </ul>
     *
     * @return 清洗后的 JSON；入参为 null／空数组、或清洗后一个块都不剩时返回 null（表示"没有块"）
     */
    private String sanitizeBlocks(List<Map<String, Object>> raw) {
        if (raw == null || raw.isEmpty()) return null;
        if (raw.size() > BLOCK_MAX) {
            throw blockError(-1, "正文块太多：最多 " + BLOCK_MAX + " 个，当前 " + raw.size() + " 个");
        }

        List<Map<String, Object>> out = new ArrayList<>();
        for (int i = 0; i < raw.size(); i++) {
            Map<String, Object> b = raw.get(i);
            if (b == null) continue;
            String type = str(b.get("type"));
            Map<String, Object> c = new LinkedHashMap<>();
            switch (type == null ? "" : type) {
                case "text" -> {
                    String t = str(b.get("text"));
                    if (t == null) continue;                        // 空文字块直接丢掉
                    if (t.length() > BLOCK_TEXT_MAX) {
                        throw blockError(i, "文字太长：最多 " + BLOCK_TEXT_MAX + " 字，当前 " + t.length() + " 字");
                    }
                    c.put("type", "text");
                    c.put("text", t);
                }
                case "image" -> {
                    String url = str(b.get("url"));
                    if (url == null || !url.startsWith(IMG_PREFIX)) {
                        throw blockError(i, "图片地址必须是站内图床（以 " + IMG_PREFIX + " 开头），不支持外链或伪协议");
                    }
                    if (url.length() > 300) throw blockError(i, "图片地址过长");
                    c.put("type", "image");
                    c.put("url", url);
                    String cap = str(b.get("caption"));
                    if (cap != null) c.put("caption", clip(cap, 120));
                }
                case "divider" -> c.put("type", "divider");
                case "score" -> {
                    String fid = str(b.get("fileId"));
                    if (fid == null || !fid.matches("\\d{1,19}")) {
                        throw blockError(i, "这一块没有关联到有效的乐谱文件 —— 请先在下面「乐谱文件」里上传一份");
                    }
                    c.put("type", "score");
                    c.put("fileId", fid);
                    String ttl = str(b.get("title"));
                    if (ttl != null) c.put("title", clip(ttl, 80));
                }
                default -> throw blockError(i, "不支持的块类型「" + type + "」");
            }
            out.add(c);
        }
        if (out.isEmpty()) return null;

        String json;
        try {
            json = objectMapper.writeValueAsString(out);
        } catch (JsonProcessingException ex) {
            throw blockError(-1, "正文内容无法保存，请精简后重试");
        }
        if (json.length() > BLOCK_JSON_MAX) throw blockError(-1, "正文内容过大，请精简后重试");
        return json;
    }

    /**
     * 抛一个带「哪一块出错」信息的 1001。
     *
     * <p>以前这里全是 {@code BizException.of(PARAM_INVALID)} ⇒ 用户点提交只看到一句
     * 「参数不合法」，完全不知道要改哪里。现在分成两份信息：
     * <ul>
     *   <li>{@code message} —— 给**人**看，用 1 基序号（"第 3 个块：…"）；</li>
     *   <li>{@code data} —— 给**前端定位**用，{@code {field:'blocks', index: 0基}}。</li>
     * </ul>
     * ⚠️ 两者**刻意不同基**：前端直接拿 index 当数组下标，别顺手在文案里也用 0 基。
     *
     * @param index 0 基块下标；**-1** 表示「不是某一块的问题」（如块数超限、整段过大）
     */
    private static BizException blockError(int index, String reason) {
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("field", "blocks");
        if (index >= 0) d.put("index", index);
        d.put("reason", reason);
        String where = index >= 0 ? "第 " + (index + 1) + " 个块：" : "";
        return new BizException(ErrorCode.PARAM_INVALID.getCode(), where + reason, d);
    }

    /** 任意值 → 去空白后的字符串；null 或空串 → null。 */
    private static String str(Object o) {
        if (o == null) return null;
        String s = String.valueOf(o).trim();
        return s.isEmpty() ? null : s;
    }

    /** 截断到 n 个字符。 */
    private static String clip(String s, int n) {
        return s.length() <= n ? s : s.substring(0, n);
    }

    /**
     * 删除帖子（作者本人或管理员）—— 会**连带物理删除该帖下的全部评论**。
     *
     * <p>这是 2026-10-11 定下的删帖策略（缺口 B17），三条取舍都写在下面，别再顺手改：
     * <ul>
     *   <li><b>评论不留</b> —— 删帖即删评论（含所有回复）。不做级联的话评论会变成「孤儿」：
     *       帖子查不到了，评论还挂在 {@code post_id} 上；管理端的评论列表会一直躺着一批
     *       「所属帖子已删除」的行（那时实测积了 22 条）。</li>
     *   <li><b>附件保留</b> —— <b>不删</b> {@code score_file}。同一附件可能被多篇帖引用，
     *       而现在附件**根本没有删除接口**（缺口 B14），删了就会留下无法回收的文件；
     *       孤儿附件交给 B14 单独处理。</li>
     *   <li><b>通知不回收</b> —— <b>不动</b> {@code notification}。通知是「用户的收件箱」，
     *       把「某某赞过你」直接抹掉，比「点进去发现帖子没了」更突兀。
     *       已知代价：会留下指向空帖的通知（实测 70 条），见 B17。</li>
     * </ul>
     *
     * <p>同样<b>不动</b> {@code like_record} / {@code favorite}：它们都按 {@code postId} 精确查，
     * 帖子没了自然查不到，当前<b>没有用户可见影响</b>（「我的收藏」列表目前还走 mock）。
     * 将来收藏列表接真实接口时，要回来把它们一起清掉。
     *
     * <p>⚠️ 这里只删「该帖的评论」。另一条产生孤儿的路径 ——
     * <b>删一条一级评论、它下面的回复悬空</b> —— 由 {@code CommentService.delete} 自己处理。
     */
    @Transactional
    public void delete(Long id) {
        requireOwned(id);
        commentMapper.delete(new LambdaQueryWrapper<Comment>().eq(Comment::getPostId, id));
        postMapper.deleteById(id);
        /* 热榜也要清 —— 否则 ZSet 会攒下指向已删帖的孤儿成员，它们看不见却占着榜单名额（缺口 B18）。 */
        hotService.drop(id);
    }

    /**
     * 作者侧状态流转：**只放行 1（发布）与 3（转草稿）**，别的值一律 {@code PARAM_INVALID}。
     *
     * <p>为什么是**新接口**而不是放宽 {@code PUT /api/admin/posts/{id}/status}：
     * 那个接口内部是 {@code requireAdmin()}，参数又是裸 int。一旦为了「作者能发布草稿」
     * 去掉管理员校验，作者就能把自己**已被下架**的帖子改回 1（绕过管理员下架），
     * 还能顺手改**别人的**帖子。<b>读接口可以放宽，写接口不行</b> —— 路由按权限模型拆，
     * 不按业务场景拆。
     *
     * <p>两道额外防线：
     * <ul>
     *   <li>传 0 / 2 直接拒绝：0 是管理端的审核队列，2 是下架，都不该由作者自己声明。</li>
     *   <li>下架帖（old == 2）拒绝作者自恢复 —— 否则等于给了作者一条绕过下架的暗道。</li>
     * </ul>
     *
     * <p>转「发布」时仍要尊重 {@code post-mode}：{@code pre} 模式下落地为 0 待审，
     * 而不是直接 1 —— 否则存一次草稿再发布就成了绕过审核的后门。
     */
    public Post updateStatusByAuthor(Long id, int status) {
        if (status != 1 && status != 3) throw BizException.of(ErrorCode.PARAM_INVALID);
        Post p = requireOwned(id);
        int old = p.getStatus() == null ? 1 : p.getStatus();
        if (old == 2) throw BizException.of(ErrorCode.FORBIDDEN);
        int next = (status == 1 && "pre".equalsIgnoreCase(postAuditMode)) ? 0 : status;
        p.setStatus(next);
        p.setUpdatedAt(LocalDateTime.now());
        postMapper.updateById(p);
        /* 热榜同步：转草稿 → 移出榜单；恢复正常 → 用库里的热度回填（sync 两种情形都处理）。 */
        hotService.sync(p);
        return p;
    }

    /** 仅作者或管理员可改删。 */
    private Post requireOwned(Long id) {
        Post p = postMapper.selectById(id);
        if (p == null) throw BizException.of(ErrorCode.POST_NOT_FOUND);
        boolean isAdmin = isAdmin();
        if (!p.getUserId().equals(StpUtil.getLoginIdAsLong()) && !isAdmin) {
            throw BizException.of(ErrorCode.FORBIDDEN);
        }
        return p;
    }

    public boolean isAdmin() {
        try {
            return "admin".equals(StpUtil.getSession().getString("role"));
        } catch (Exception e) {
            return false;
        }
    }
}
