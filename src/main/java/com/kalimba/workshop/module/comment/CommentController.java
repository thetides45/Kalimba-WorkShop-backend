package com.kalimba.workshop.module.comment;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.kalimba.workshop.common.aspect.OpLog;
import com.kalimba.workshop.common.result.PageResult;
import com.kalimba.workshop.common.result.R;
import com.kalimba.workshop.dto.CommentReq;
import com.kalimba.workshop.entity.Comment;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "评论")
@RestController
@RequestMapping("/api/posts/{postId}/comments")
@RequiredArgsConstructor
public class CommentController {

    private final CommentService commentService;

    @Operation(summary = "评论列表")
    @GetMapping
    public R<PageResult<Comment>> list(@PathVariable Long postId,
                                       @RequestParam(defaultValue = "1") int page,
                                       @RequestParam(defaultValue = "20") int size) {
        Page<Comment> p = commentService.list(postId, page, size);
        return R.ok(PageResult.of(p));
    }

    @Operation(summary = "发表评论/回复")
    @OpLog("发表评论")
    @PostMapping
    public R<Comment> create(@PathVariable Long postId, @Valid @RequestBody CommentReq req) {
        return R.ok(commentService.create(postId, req));
    }

    @Operation(summary = "删除评论")
    @OpLog("删除评论")
    @DeleteMapping("/{commentId}")
    public R<Void> delete(@PathVariable Long postId, @PathVariable Long commentId) {
        commentService.delete(commentId);
        return R.ok();
    }
}
