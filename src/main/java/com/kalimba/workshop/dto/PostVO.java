package com.kalimba.workshop.dto;

import com.kalimba.workshop.entity.Post;
import com.kalimba.workshop.entity.Tag;
import lombok.Data;

import java.io.Serializable;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

/**
 * 帖子视图对象（列表 / 搜索用）。
 *
 * <p>相比 {@link Post} 实体多了两样东西，都是为了少几次往返：
 * <ul>
 *   <li><b>author</b>：作者简要信息。否则前端拿到列表后要逐个帖去查 /api/users/{id}，
 *       一页 10 条就是 10 次额外请求（N+1）。</li>
 *   <li><b>tags</b>：已解析好的标签对象。实体里存的是逗号分隔的 tagIds 字符串，
 *       前端每次都要自己拆开再拼名字。</li>
 * </ul>
 * <b>matchedIn</b> 只在搜索接口里填，标明「这条是因为标题/正文/标签/作者哪个命中的」，
 * 便于前端在结果卡片上做标注。
 */
@Data
public class PostVO implements Serializable {

    private Long id;

    private String title;

    /** 正文摘要（去空白后截断），列表场景不返回全文。 */
    private String summary;

    private String cover;

    private Long scoreFileId;

    private Integer viewCount;

    private Integer likeCount;

    private LocalDateTime createdAt;

    private UserBrief author;

    private List<Tag> tags = new ArrayList<>();

    /** 命中来源：title / content / tag / user，可多值。非搜索场景为空。 */
    private List<String> matchedIn = new ArrayList<>();

    public static PostVO of(Post p, UserBrief author, List<Tag> tags, List<String> matchedIn) {
        PostVO vo = new PostVO();
        vo.id = p.getId();
        vo.title = p.getTitle();
        vo.summary = summary(p.getContent());
        vo.cover = p.getCover();
        vo.scoreFileId = p.getScoreFileId();
        vo.viewCount = p.getViewCount();
        vo.likeCount = p.getLikeCount();
        vo.createdAt = p.getCreatedAt();
        vo.author = author;
        if (tags != null) vo.tags = tags;
        if (matchedIn != null) vo.matchedIn = matchedIn;
        return vo;
    }

    private static String summary(String content) {
        if (content == null || content.isBlank()) return "";
        String s = content.replaceAll("\\s+", " ").trim();
        return s.length() > 80 ? s.substring(0, 80) + "…" : s;
    }
}
