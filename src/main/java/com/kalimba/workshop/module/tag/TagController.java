package com.kalimba.workshop.module.tag;

import com.kalimba.workshop.common.result.R;
import com.kalimba.workshop.entity.Tag;
import io.swagger.v3.oas.annotations.Operation;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 标签控制器。
 * 注：实体 {@link Tag} 与 Swagger 的 {@code @Tag} 注解同名，
 * 注解用全限定名 {@code @io.swagger.v3.oas.annotations.tags.Tag}，
 * 此处**不能** import swagger 的 Tag，否则与实体 Tag 简名冲突（编译期致命）。
 */
@io.swagger.v3.oas.annotations.tags.Tag(name = "标签")
@RestController
@RequestMapping("/api/tags")
@RequiredArgsConstructor
public class TagController {

    private final TagService tagService;

    @Operation(summary = "标签列表（分类入口）")
    @GetMapping
    public R<List<Tag>> all() {
        return R.ok(tagService.all());
    }
}
