package com.kalimba.workshop.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.Data;

import java.util.List;
import java.util.Map;

/** 发布 / 编辑帖子请求。 */
@Data
public class PostReq {

    @NotBlank(message = "标题不能为空")
    @Size(max = 80, message = "标题过长")
    private String title;

    @Size(max = 20000, message = "正文过长")
    private String content;

    @Size(max = 2048, message = "封面地址过长")
    private String cover;

    /** 标签 id 列表（前端从 /api/tags 拿 id）。 */
    private List<Long> tagIds;

    /** 乐谱附件 id（先 POST /api/files 上传，再拿 id 关联）。 */
    private Long scoreFileId;

    /**
     * true = 存为**草稿**（status=3，仅作者本人可见，不进列表 / 搜索 / 热榜）；缺省 = 直接发布。
     *
     * <p>⚠️ 草稿**同样受上面的 @NotBlank / @Size 校验**：标题与正文该填还得填。
     * 不做「草稿可空标题」的分组校验是刻意的 —— 那会动到现有校验链，
     * 而 api_smoke 里钉着「空标题被拒」这条基线。将来真要放宽，再引入 {@code @Validated(Group)}。
     */
    private Boolean draft;

    /**
     * 正文块数组（路线 B，2026-10-16）。前端直接传**数组**，Jackson 收成 List；
     * 服务端逐块白名单清洗后序列化成 JSON 存进 `post.blocks`（详见 `PostService#sanitizeBlocks`）。
     *
     * <p>支持的块类型：`text` / `image` / `score` / `divider`，别的 type 一律拒绝。
     *
     * <p>⚠️ 更新语义：**null 表示「本次不改动」**（前端编辑老帖时不会带这个字段），
     * 空数组 `[]` 表示「清空块」。之所以用这个约定，是因为 Jackson 无法区分
     * 「字段缺失」与「显式传 null」，只能借「空数组」表达删除意图。
     */
    private List<Map<String, Object>> blocks;
}
