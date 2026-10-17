package com.kalimba.workshop.module.follow;

import cn.dev33.satoken.stp.StpUtil;
import com.kalimba.workshop.common.result.R;
import com.kalimba.workshop.module.interaction.InteractionService;
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

@Tag(name = "关注")
@RestController
@RequestMapping("/api/users/{id}/follow")
@RequiredArgsConstructor
public class FollowController {

    private final InteractionService interactionService;

    @Operation(summary = "关注")
    @PostMapping
    public R<Void> follow(@PathVariable Long id) {
        interactionService.follow(id);
        return R.ok();
    }

    @Operation(summary = "取消关注")
    @DeleteMapping
    public R<Void> unfollow(@PathVariable Long id) {
        interactionService.unfollow(id);
        return R.ok();
    }

    @Operation(summary = "关注状态")
    @GetMapping
    public R<Map<String, Boolean>> state(@PathVariable Long id) {
        Map<String, Boolean> m = new HashMap<>();
        m.put("following", StpUtil.isLogin() && interactionService.following(id));
        return R.ok(m);
    }
}
