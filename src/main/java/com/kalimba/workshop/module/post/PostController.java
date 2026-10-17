package com.kalimba.workshop.module.post;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.kalimba.workshop.common.aspect.OpLog;
import com.kalimba.workshop.common.result.PageResult;
import com.kalimba.workshop.common.result.R;
import com.kalimba.workshop.dto.PostReq;
import com.kalimba.workshop.entity.Post;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "帖子")
@RestController
@RequestMapping("/api/posts")
@RequiredArgsConstructor
public class PostController {

    private final PostService postService;

    @Operation(summary = "帖子分页（支持单标签 tagId / 多标签并集 tagIds / 排序 / 关键词 / 按作者）")
    @GetMapping
    public R<PageResult<Post>> list(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "10") int size,
            @RequestParam(required = false) Long tagId,
            /* ★ 2026-10-13：多标签**并集**（逗号分隔，命中所列任一即入选）。
               作品广场只放「曲谱分享/教程/翻弹/原创」四类，单标签的 tagId 表达不了。
               与 tagId 同时传时以 tagId 为准（既有语义不变）。 */
            @RequestParam(required = false) String tagIds,
            @RequestParam(required = false) String sort,
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false) Long userId) {
        Page<Post> p = postService.list(page, size, tagId, tagIds, sort, keyword, userId);
        return R.ok(PageResult.of(p));
    }

    @Operation(summary = "帖子详情")
    @GetMapping("/{id}")
    public R<Post> detail(@PathVariable Long id) {
        return R.ok(postService.detail(id));
    }

    @Operation(summary = "发布帖子")
    @OpLog("发布帖子")
    @PostMapping
    public R<Post> create(@Valid @RequestBody PostReq req) {
        return R.ok(postService.create(req));
    }

    @Operation(summary = "编辑帖子")
    @OpLog("编辑帖子")
    @PutMapping("/{id}")
    public R<Post> update(@PathVariable Long id, @Valid @RequestBody PostReq req) {
        return R.ok(postService.update(id, req));
    }

    /**
     * 作者侧状态流转：**只接受 1（发布）与 3（转草稿）**，其余值由 service 抛 1001。
     *
     * <p>刻意**不复用**管理端的 {@code PUT /api/admin/posts/{id}/status}：
     * 那条路内部是 {@code requireAdmin()}，参数是裸 int，一旦为「作者发布草稿」而放宽，
     * 作者就能把已被下架的帖子改回正常、也能改别人的帖子。权限模型不同的接口不能合并。
     */
    @Operation(summary = "改帖子状态（作者：1 发布 / 3 转草稿）")
    @OpLog("改帖子状态（作者）")
    @PutMapping("/{id}/status")
    public R<Post> updateStatus(@PathVariable Long id, @RequestParam int status) {
        return R.ok(postService.updateStatusByAuthor(id, status));
    }

    @Operation(summary = "删除帖子")
    @OpLog("删除帖子")
    @DeleteMapping("/{id}")
    public R<Void> delete(@PathVariable Long id) {
        postService.delete(id);
        return R.ok();
    }
}
