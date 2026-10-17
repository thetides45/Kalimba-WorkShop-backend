package com.kalimba.workshop.module.hot;

import com.kalimba.workshop.common.result.R;
import com.kalimba.workshop.entity.Post;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@Tag(name = "热榜")
@RestController
@RequestMapping("/api/hot")
@RequiredArgsConstructor
public class HotController {

    private final HotService hotService;

    @Operation(summary = "热榜（Redis 缓存）")
    @GetMapping
    public R<List<Post>> top(@RequestParam(defaultValue = "10") int limit) {
        return R.ok(hotService.top(Math.min(limit, 50)));
    }
}
