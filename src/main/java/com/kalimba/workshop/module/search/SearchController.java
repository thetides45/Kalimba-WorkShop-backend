package com.kalimba.workshop.module.search;

import com.kalimba.workshop.common.result.R;
import com.kalimba.workshop.dto.SearchResp;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * 综合搜索接口。免登录（读接口），已在 SaTokenConfig 白名单里。
 */
@Tag(name = "搜索")
@RestController
@RequestMapping("/api/search")
@RequiredArgsConstructor
public class SearchController {

    private final SearchService searchService;

    @Operation(summary = "综合搜索：关键词匹配标题 / 正文 / 标签名 / 作者昵称，返回帖子+用户+标签三组")
    @GetMapping
    public R<SearchResp> search(
            @RequestParam(required = false) String keyword,
            @RequestParam(defaultValue = "all") String type,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "10") int size) {
        return R.ok(searchService.search(keyword, type, page, size));
    }

    @Operation(summary = "热搜词：近 N 天搜索次数 Top N（返回 [{keyword, count}]，空榜返回空数组）")
    @GetMapping("/hot")
    public R<List<Map<String, Object>>> hot(@RequestParam(defaultValue = "8") int limit,
                                            @RequestParam(defaultValue = "7") int days) {
        return R.ok(searchService.hotWords(limit, days));
    }
}
