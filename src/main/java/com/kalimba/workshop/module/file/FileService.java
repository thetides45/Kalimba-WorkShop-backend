package com.kalimba.workshop.module.file;

import cn.dev33.satoken.stp.StpUtil;
import com.kalimba.workshop.common.exception.BizException;
import com.kalimba.workshop.common.exception.ErrorCode;
import com.kalimba.workshop.entity.Follow;
import com.kalimba.workshop.entity.ScoreFile;
import com.kalimba.workshop.mapper.FavoriteMapper;
import com.kalimba.workshop.mapper.FollowMapper;
import com.kalimba.workshop.mapper.ScoreFileMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 文件服务（WBS 4.3）：图片与乐谱 JSON 附件的上传下载。
 *
 * <p>安全：只按扩展名 + 大小把关（规划书 2.3 非功能需求）。
 * 文件名落到磁盘一律用 UUID 重命名，原始名只存库，避免路径穿越与中文编码问题。
 *
 * <p>乐谱附件另有一层**下载分级**（{@link ScoreVisibility}）：登录只是下限，
 * 具体能不能下由附件自己的 visibility 决定（关注可下 / 仅作者）。判定集中在
 * {@link #accessOf}，下载与元信息接口共用同一份结论，避免两处口径漂移。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class FileService {

    private static final Set<String> IMAGE_EXT = Set.of("png", "jpg", "jpeg", "gif", "webp", "svg");
    private static final Set<String> SCORE_EXT = Set.of("json", "klb");
    private static final long MAX_IMAGE = 5 * 1024 * 1024;
    private static final long MAX_SCORE = 2 * 1024 * 1024;

    private final ScoreFileMapper scoreFileMapper;
    private final FollowMapper followMapper;
    private final FavoriteMapper favoriteMapper;

    @Value("${kalimba.upload.dir:./uploads}")
    private String uploadDir;

    /* ================================================================
       下载分级判定
       ================================================================ */

    /**
     * 一次判定的结论。{@code reason} 是**可以直接展示给用户**的中文说明
     * （前端不再自己编文案，避免与后端策略不一致）。
     *
     * @param downloadable  当前访问者能否**通过这次判定**。字段名沿用 downloadable 是为了不动
     *                      既有调用方与 JSON 字段面：**下载语境** = 能否拿到源文件；
     *                      **查看语境**（{@link #accessOfView}）= 能否查看/试听谱面。
     * @param reason        不通过时的原因（可直接展示）；通过时为 null
     * @param needsFollow   不通过、且「关注作者」就能解锁 —— 前端据此决定要不要给关注按钮
     * @param needsFavorite 不通过、且「收藏这篇帖」就能解锁 —— 同上，对应收藏按钮
     */
    public record AccessInfo(boolean downloadable, String reason, boolean needsFollow, boolean needsFavorite) {
        static AccessInfo yes() {
            return new AccessInfo(true, null, false, false);
        }

        static AccessInfo no(String reason) {
            return new AccessInfo(false, reason, false, false);
        }

        /** 缺条件、且**有一个明确动作可以解锁**（关注 / 收藏）时用这个。 */
        static AccessInfo locked(String reason, boolean needsFollow, boolean needsFavorite) {
            return new AccessInfo(false, reason, needsFollow, needsFavorite);
        }
    }

    /**
     * 判定「当前登录者」能否下载该附件。
     *
     * <p>判定顺序（先例外的、后一般的）：
     * <ol>
     *   <li>作者本人 → 放行（否则作者改不了自己的谱）</li>
     *   <li>管理员 → 放行（否则无法处置违规内容）</li>
     *   <li>否则看 visibility：login 放行 / favorite 查收藏 / follower 查关注 / author 拒绝</li>
     * </ol>
     *
     * <p>⚠️ 这是**下载**判定 —— 匿名一律不通过（「必须登录」是下载的下限，分级是下限之上的更细条件）。
     * 匿名能不能**看**谱面是另一件事，走 {@link #accessOfView}。
     */
    public AccessInfo accessOf(ScoreFile sf, Long viewerId) {
        if (viewerId != null && viewerId.equals(sf.getOwnerId())) return AccessInfo.yes();
        if (isAdmin()) return AccessInfo.yes();
        if (viewerId == null) return AccessInfo.no("登录后才能下载乐谱");

        ScoreVisibility vis = ScoreVisibility.parse(sf.getVisibility());
        return switch (vis) {
            case LOGIN -> AccessInfo.yes();
            case FAVORITE -> isFavoritedBy(viewerId, sf.getId())
                    ? AccessInfo.yes()
                    : AccessInfo.locked("收藏这篇帖后可下载", false, true);
            case FOLLOWER -> isFollowing(viewerId, sf.getOwnerId())
                    ? AccessInfo.yes()
                    : AccessInfo.locked("关注作者后可下载", true, false);
            case AUTHOR -> AccessInfo.no("作者未公开该乐谱");
        };
    }

    /** 下载前的硬校验：不通过就抛业务异常，由全局处理器转成 `R{code:5003}`。 */
    public void assertDownloadable(ScoreFile sf) {
        AccessInfo a = accessOf(sf, currentUserIdOrNull());
        if (!a.downloadable()) throw new BizException(ErrorCode.SCORE_LOCKED, a.reason());
    }

    /**
     * 判定「当前访问者」能否**查看 / 试听**该附件的谱面。
     *
     * <p>与 {@link #accessOf}（下载）**只差一条**：{@code login} 档对**匿名**也放行。
     * 这是 2026-10-13 用户拍板的口径 ——「登录可下载」说的是**下载**要登录；
     * 谱面的查看与试听对所有人开放。其余三档（favorite / follower / author）
     * 的查看条件与下载完全一致：档位本身就是「谁能看这份谱」，登录只是其中一种条件。
     *
     * <p>⚠️ 语义后果（必须知道）：查看得到内容 = 浏览器拿到了 JSON 字节，
     * 所以 {@code login} 档在技术上**匿名可获取源文件**；「下载」按钮只是 UX 门槛，
     * 不是防拷墙。要真正防拷只能把内容留在服务端（如服务端渲染成图），本项目不做。
     */
    public AccessInfo accessOfView(ScoreFile sf, Long viewerId) {
        if (viewerId != null && viewerId.equals(sf.getOwnerId())) return AccessInfo.yes();
        if (isAdmin()) return AccessInfo.yes();

        ScoreVisibility vis = ScoreVisibility.parse(sf.getVisibility());
        return switch (vis) {
            /* ★ 与下载的唯一差别：这里不放 viewerId == null 的前置拦截 */
            case LOGIN -> AccessInfo.yes();
            case FAVORITE -> (viewerId != null && isFavoritedBy(viewerId, sf.getId()))
                    ? AccessInfo.yes()
                    : AccessInfo.locked(viewerId == null ? "登录并收藏这篇帖后可查看"
                            : "收藏这篇帖后可查看", false, true);
            case FOLLOWER -> (viewerId != null && isFollowing(viewerId, sf.getOwnerId()))
                    ? AccessInfo.yes()
                    : AccessInfo.locked(viewerId == null ? "登录并关注作者后可查看"
                            : "关注作者后可查看", true, false);
            case AUTHOR -> AccessInfo.no("作者未公开该乐谱");
        };
    }

    /** 读取内容前的硬校验（对应 {@link #assertDownloadable} 的查看版本）。 */
    public void assertViewable(ScoreFile sf) {
        AccessInfo a = accessOfView(sf, currentUserIdOrNull());
        if (!a.downloadable()) throw new BizException(ErrorCode.SCORE_LOCKED, a.reason());
    }

    private boolean isFollowing(Long followerId, Long followeeId) {
        return followMapper.selectCount(new LambdaQueryWrapper<Follow>()
                .eq(Follow::getFollowerId, followerId)
                .eq(Follow::getFolloweeId, followeeId)) > 0;
    }

    /** 收藏判定要 join 一次（favorite 挂 post、分级挂 score_file），SQL 写在 FavoriteMapper 上。 */
    private boolean isFavoritedBy(Long userId, Long scoreFileId) {
        return favoriteMapper.countUserFavoritedScore(userId, scoreFileId) > 0;
    }

    /** 当前登录者 id；未登录返回 null（不抛异常，供判定与 meta 复用）。 */
    private Long currentUserIdOrNull() {
        return StpUtil.isLogin() ? StpUtil.getLoginIdAsLong() : null;
    }

    private boolean isAdmin() {
        if (!StpUtil.isLogin()) return false;
        return "admin".equals(StpUtil.getSession().getString("role"));
    }

    /* ================================================================
       上传 / 读取 / 改权限
       ================================================================ */

    /** 上传图片，返回可访问 URL（相对路径）。 */
    public String uploadImage(MultipartFile file) {
        String ext = extOf(file);
        if (!IMAGE_EXT.contains(ext)) throw BizException.of(ErrorCode.FILE_TYPE_REJECTED);
        if (file.getSize() > MAX_IMAGE) throw BizException.of(ErrorCode.FILE_TOO_LARGE);
        return "/uploads/img/" + store(file, "img", ext);
    }

    /**
     * 上传乐谱附件，登记 score_file 表，返回 file_id。
     * 曲谱分类（琴型/调性/难度/音乐类型）与**下载分级**一并落库。
     *
     * @param visibility 分级 code；null/空 视为默认档 login，**非法值直接拒**（不静默回落）
     */
    public ScoreFile uploadScore(MultipartFile file, String tuningType, String keyName,
                                 String difficulty, String musicGenre, String visibility) {
        String ext = extOf(file);
        if (!SCORE_EXT.contains(ext)) throw BizException.of(ErrorCode.FILE_TYPE_REJECTED);
        if (file.getSize() > MAX_SCORE) throw BizException.of(ErrorCode.FILE_TOO_LARGE);

        /* ⚠️ 参数校验必须**全部做在写盘之前**：store() 一执行文件就落盘了，
           而 score_file 没有删除接口 —— 先写后拒会留下一堆**没有库记录的孤儿文件**
           （2026-10-03 实测：非法 visibility 的请求被拒了，但每个都在 uploads/score 留了一个 json）。 */
        ScoreVisibility vis;
        if (visibility == null || visibility.isBlank()) {
            vis = ScoreVisibility.DEFAULT;
        } else {
            vis = ScoreVisibility.parseStrict(visibility);
            /* 不静默回落：写接口收到没见过的档位，多半是前后端口径分家了，必须报出来。 */
            if (vis == null) throw new BizException(ErrorCode.PARAM_INVALID, "不支持的下载分级：" + visibility);
        }

        String stored = store(file, "score", ext);

        /* 信封字段从**原始上传内容**读，不是从落盘文件读 —— store() 已经消耗掉输入流，
           这里再读 file 才拿得到字节（MultipartFile 支持重复读，磁盘上的 UUID 名无关）。 */
        Envelope env = readEnvelope(file);

        ScoreFile sf = new ScoreFile();
        sf.setOwnerId(StpUtil.getLoginIdAsLong());
        sf.setFileName(file.getOriginalFilename() == null ? "score." + ext : file.getOriginalFilename());
        sf.setFilePath("/uploads/score/" + stored);
        sf.setSize(file.getSize());
        sf.setVersion(env.version());
        sf.setFormat(env.format());
        sf.setVisibility(ScoreVisibility.codeOf(vis));
        sf.setTuningType(blankToNull(tuningType));
        sf.setKeyName(blankToNull(keyName));
        sf.setDifficulty(blankToNull(difficulty));
        sf.setMusicGenre(blankToNull(musicGenre));
        sf.setCreatedAt(LocalDateTime.now());
        scoreFileMapper.insert(sf);
        return sf;
    }

    /** 修改已有附件的下载分级（作者或管理员）。改完不用重传文件 —— 权限与文件是两件事。 */
    public ScoreFile updateVisibility(Long id, String visibility) {
        ScoreFile sf = getScore(id);
        Long uid = StpUtil.getLoginIdAsLong();
        if (!uid.equals(sf.getOwnerId()) && !isAdmin()) {
            throw BizException.of(ErrorCode.FORBIDDEN);
        }
        ScoreVisibility vis = ScoreVisibility.parseStrict(visibility);
        if (vis == null) throw new BizException(ErrorCode.PARAM_INVALID, "不支持的下载分级：" + visibility);
        sf.setVisibility(vis.code());
        scoreFileMapper.updateById(sf);
        return sf;
    }

    private String blankToNull(String s) {
        return (s == null || s.isBlank()) ? null : s.trim();
    }

    public ScoreFile getScore(Long id) {
        ScoreFile sf = scoreFileMapper.selectById(id);
        if (sf == null) throw BizException.of(ErrorCode.NOT_FOUND);
        /* 库里恒为非空（DEFAULT 'login'），但老库/手工插的数据可能是空串，统一兜一下，
           否则 parse("") 虽会回落默认档，前端拿到的却是空值、看不出是哪一档。 */
        if (sf.getVisibility() == null || sf.getVisibility().isBlank()) {
            sf.setVisibility(ScoreVisibility.DEFAULT.code());
        }
        return sf;
    }

    /** 磁盘绝对路径（供下载控制器读流），并校验不越出上传目录。 */
    public File resolve(String filePath) {
        String abs = new File(uploadDir).getAbsolutePath();
        File f = new File(abs, filePath.replace("/uploads/", ""));
        try {
            if (!f.getCanonicalPath().startsWith(new File(abs).getCanonicalPath())) {
                throw BizException.of(ErrorCode.FILE_TYPE_REJECTED);
            }
        } catch (IOException e) {
            throw BizException.of(ErrorCode.FILE_TYPE_REJECTED);
        }
        return f;
    }

    private String store(MultipartFile file, String sub, String ext) {
        File dir = new File(new File(uploadDir).getAbsolutePath(), sub);
        if (!dir.exists() && !dir.mkdirs()) throw new BizException(5001, "上传目录不可用");
        String name = UUID.randomUUID().toString().replace("-", "") + "." + ext;
        File target = new File(dir, name);
        try (InputStream in = file.getInputStream()) {
            try (var out = new java.io.FileOutputStream(target)) {
                in.transferTo(out);
            }
        } catch (IOException e) {
            log.error("写文件失败", e);
            throw new BizException(5001, "文件写入失败");
        }
        return name;
    }

    private String extOf(MultipartFile file) {
        String name = file.getOriginalFilename();
        if (name == null) return "";
        int i = name.lastIndexOf('.');
        return i < 0 ? "" : name.substring(i + 1).toLowerCase(Locale.ROOT);
    }

    /* ================================================================
       乐谱 JSON 信封（format / version）
       ================================================================ */

    /** 乐谱 JSON 头部的两个信封字段；读不到时都是空串（**不抛异常**，绝不因为一个元字段把上传打挂）。 */
    private record Envelope(String format, String version) {
        static final Envelope EMPTY = new Envelope("", "");
    }

    /**
     * 从乐谱 JSON 头部读出 {@code format} 与 {@code version}。
     *
     * <p>两个「看着奇怪」的实现选择都是刻意的：
     * <ul>
     *   <li><b>只读前 4 KB</b> —— 附件上限 2 MB（{@link #MAX_SCORE}），为两个信封字段把整份谱
     *       读进内存没意义；而内核导出把 {@code format} / {@code version} 固定放在最前面
     *       （第 1、2 个键），头部必然够。</li>
     *   <li><b>不用 JSON 解析器，用手写正则</b> —— 读的是**截断的前缀**，正规解析器必然抛错；
     *       信封字段又都是顶层标量，正则反而稳。</li>
     * </ul>
     *
     * <p>⚠️ 值**同时认字符串和裸数字**，这是 2026-10-13 修掉的那个坑：
     * 旧格式写 {@code "version": "1.0"}（带引号），而内核导出写 {@code "version": 1}（数字）。
     * 此前只认带引号的那种，于是换成内核格式后 version 恒为空串 —— 旧格式碰巧是字符串，
     * 把这个 bug 一直盖着，直到「内核成为唯一真源」才暴露。
     */
    private Envelope readEnvelope(MultipartFile file) {
        String head;
        try (InputStream in = file.getInputStream()) {
            head = new String(in.readNBytes(4096), StandardCharsets.UTF_8);
        } catch (IOException e) {
            log.warn("读取乐谱信封失败，format/version 留空");
            return Envelope.EMPTY;
        }
        return new Envelope(field(head, "format"), field(head, "version"));
    }

    /** 取 JSON 里某个顶层字段的值：带引号的字符串或裸数字都认；取不到返回空串。 */
    private static String field(String json, String key) {
        Matcher m = Pattern.compile("\"" + key + "\"\\s*:\\s*(?:\"([^\"]*)\"|([0-9][0-9.]*))").matcher(json);
        return m.find() ? (m.group(1) != null ? m.group(1) : m.group(2)) : "";
    }
}
