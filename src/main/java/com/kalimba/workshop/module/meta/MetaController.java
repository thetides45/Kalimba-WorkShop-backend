package com.kalimba.workshop.module.meta;

import com.kalimba.workshop.common.result.R;
import io.swagger.v3.oas.annotations.Operation;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@io.swagger.v3.oas.annotations.tags.Tag(name = "分类字典")
@RestController
@RequestMapping("/api/meta")
@RequiredArgsConstructor
public class MetaController {

    private final MetaService metaService;

    @Operation(summary = "分类字典（帖子标签 + 曲谱分类）")
    @GetMapping("/categories")
    public R<Map<String, Object>> categories() {
        return R.ok(metaService.categories());
    }
}
