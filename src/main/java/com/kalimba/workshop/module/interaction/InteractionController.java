package com.kalimba.workshop.module.interaction;

import com.kalimba.workshop.common.result.R;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.HashMap;
import java.util.Map;

@Tag(name = "互动")
@RestController
@RequestMapping("/api/posts/{id}")
@RequiredArgsConstructor
public class InteractionController {

    private final InteractionService interactionService;

    @Operation(summary = "点赞（幂等）")
    @PostMapping("/likes")
    public R<Void> like(@PathVariable Long id) {
        interactionService.like(id);
        return R.ok();
    }

    @Operation(summary = "取消点赞")
    @DeleteMapping("/likes")
    public R<Void> unlike(@PathVariable Long id) {
        interactionService.unlike(id);
        return R.ok();
    }

    @Operation(summary = "收藏（幂等）")
    @PostMapping("/favorite")
    public R<Void> favorite(@PathVariable Long id) {
        interactionService.favorite(id);
        return R.ok();
    }

    @Operation(summary = "取消收藏")
    @DeleteMapping("/favorite")
    public R<Void> unfavorite(@PathVariable Long id) {
        interactionService.unfavorite(id);
        return R.ok();
    }

    @Operation(summary = "互动状态（点赞/收藏）")
    @GetMapping("/interaction")
    public R<Map<String, Boolean>> state(@PathVariable Long id) {
        Map<String, Boolean> m = new HashMap<>();
        m.put("liked", interactionService.liked(id));
        m.put("favorited", interactionService.favorited(id));
        return R.ok(m);
    }
}
