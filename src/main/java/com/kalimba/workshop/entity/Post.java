package com.kalimba.workshop.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.io.Serializable;
import java.time.LocalDateTime;

/** 帖子（表 3-4 post）。 */
@Data
@TableName("post")
public class Post implements Serializable {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    private String title;

    /**
     * 图文正文（纯文本）。**前端以安全文本 + 换行渲染，不做富文本 HTML 透传**。
     *
     * <p>⚠️ 2026-10-16 修正：`PostView` 之前用 `v-html` 渲染这个字段，既与这里的设计意图矛盾，
     * 也构成存储型 XSS 面（原样入库 + 只过敏感词 + 当 HTML 执行）。现已改为纯文本渲染，
     * 见 `web-vue/src/views/PostView.vue` 与 `components/BlockRenderer.vue`。
     */
    private String content;

    /**
     * 正文块数组（JSON 字符串）：{@code [{"type":"text"|"image"|"score"|"divider", ...}]}。
     *
     * <p>2026-10-16 引入（路线 B，与 B 站专栏的 {@code paragraphs[]} 同构）—— 正文不再是
     * 「一整块文本」，而是可混排的块数组，前端按 {@code type} 渲染；于是**组件**（比如内嵌
     * 可播放的谱面）能插在正文任意位置，这是把正文塞进 HTML 做不到的。
     *
     * <p>为 null 表示老帖子：前端回退成 {@link #content} 的纯文本渲染。
     *
     * <p>⚠️ 写入前**必过** {@code PostService#sanitizeBlocks} 的白名单清洗（逐块重建、丢弃未知字段）。
     * 前端全程走 Vue 模板（自动转义），所以「存进来的只有白名单字段」就是全部的安全边界 ——
     * 这里一旦放行未知字段，白名单就形同虚设。
     */
    private String blocks;

    private String cover;

    /** 逗号分隔的标签 id，读多写少，避免一次查询引入第三张关联表。 */
    private String tagIds;

    private Long scoreFileId;

    private Integer viewCount;

    private Integer likeCount;

    /** 0 审核中，1 正常，2 已下架 */
    private Integer status;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;
}
