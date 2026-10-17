package com.kalimba.workshop.module.file;

import java.util.Locale;

/**
 * 乐谱附件的**下载分级**（表 3-4 score_file.visibility）。
 *
 * <p>设计出发点：制谱 JSON 里的 {@code source} 就是作品本身（一行明文简谱，且保证可再解析、可继续编辑），
 * 而帖子详情页又需要它来渲染谱面与试听 —— 「能播」和「能拿」压在同一份数据上必然矛盾。
 * 这一层分级**不试图加密**（发给浏览器的东西一定能被取回），只做一件事：
 * <b>把「谁有资格拿到源文件」变成服务端可判定的条件</b>。
 *
 * <p>三档都在「登录」之上（匿名由 {@code SaTokenConfig} 的拦截层统一挡住，
 * {@code /api/files/**} 不在公开白名单里），所以没有 public 档：
 * 若要放开匿名下载，必须同时改白名单，那不是这一个字段能决定的事。
 *
 * <p>⚠️ 分级只约束**别人**。作者本人与管理员**永远可下**（否则作者自己就改不了自己的谱）。
 *
 * <p><b>档位顺序 = 门槛从宽到严</b>：{@code login} &lt; {@code favorite} &lt; {@code follower} &lt; {@code author}。
 * 前端选择器按声明顺序渲染，所以**别随手调整声明次序**（那会改变用户看到的推荐顺序）。
 * 「收藏」比「关注」门槛低：关注是订阅作者（长期关系），收藏只是标记这一篇（一次性动作）。
 */
public enum ScoreVisibility {

    /** 登录即可下载（默认档；与引入本字段前的实际行为一致）。 */
    LOGIN("login", "登录可下载", false, false),

    /** 收藏**这篇帖**后可下载（比关注轻：不用订阅作者，标记一下就能拿走）。 */
    FAVORITE("favorite", "收藏后可下载", false, true),

    /** 关注作者后可下载。 */
    FOLLOWER("follower", "关注作者后可下载", true, false),

    /** 仅作者本人（与管理员）可下载。 */
    AUTHOR("author", "仅自己可下载", false, false);

    private final String code;
    private final String label;
    private final boolean needsFollow;
    private final boolean needsFavorite;

    ScoreVisibility(String code, String label, boolean needsFollow, boolean needsFavorite) {
        this.code = code;
        this.label = label;
        this.needsFollow = needsFollow;
        this.needsFavorite = needsFavorite;
    }

    public String code() {
        return code;
    }

    public String label() {
        return label;
    }

    /** 判定「未达标时」的提示语要用到它，前端也据此决定是否给「关注作者」按钮。 */
    public boolean needsFollow() {
        return needsFollow;
    }

    /** 同上，对应「收藏这篇帖」按钮。两个 flag 互斥（一档只对应一个解锁动作）。 */
    public boolean needsFavorite() {
        return needsFavorite;
    }

    public static final ScoreVisibility DEFAULT = LOGIN;

    /** 宽松解析：不认识的值（含 null / 空串）一律回落默认档，**不抛异常**。 */
    public static ScoreVisibility parse(String raw) {
        if (raw == null) return DEFAULT;
        String v = raw.trim().toLowerCase(Locale.ROOT);
        for (ScoreVisibility s : values()) {
            if (s.code.equals(v)) return s;
        }
        return DEFAULT;
    }

    /** 严格解析：用于**写接口**的参数校验，非法值直接拒（避免把脏数据写进库）。 */
    public static ScoreVisibility parseStrict(String raw) {
        if (raw == null) return null;
        String v = raw.trim().toLowerCase(Locale.ROOT);
        for (ScoreVisibility s : values()) {
            if (s.code.equals(v)) return s;
        }
        return null;
    }

    /** 存库用：库里恒为非空，读出来为空时按默认档处理。 */
    public static String codeOf(ScoreVisibility s) {
        return s == null ? DEFAULT.code : s.code;
    }
}
