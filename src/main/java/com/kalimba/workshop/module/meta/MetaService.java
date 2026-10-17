package com.kalimba.workshop.module.meta;

import com.kalimba.workshop.entity.Tag;
import com.kalimba.workshop.mapper.TagMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 分类字典服务：一次返回「帖子标签」+「曲谱三组分类」两套并行体系，
 * 供发布页下拉、广场筛选、首页分类入口共用。
 */
@Service
@RequiredArgsConstructor
public class MetaService {

    private final TagMapper tagMapper;

    /** 组装完整分类字典。 */
    public Map<String, Object> categories() {
        Map<String, Object> m = new LinkedHashMap<>();

        // 1. 帖子标签（内容/话题维度）
        List<Tag> tags = tagMapper.selectList(null);
        m.put("postTags", tags == null ? List.of() : tags);

        // 2. 曲谱分类（结构化维度）
        m.put("tuningTypes", enumList(ScoreCategories.TuningType.values()));
        m.put("keyNames", enumList(ScoreCategories.KeyName.values()));
        m.put("difficulties", enumList(ScoreCategories.Difficulty.values()));
        m.put("musicGenres", enumList(ScoreCategories.MusicGenre.values()));

        return m;
    }

    private <E extends Enum<E>> List<Map<String, String>> enumList(E[] values) {
        List<Map<String, String>> list = new ArrayList<>(values.length);
        for (E e : values) {
            Map<String, String> item = new LinkedHashMap<>();
            // 用反射取 code/label 字段，保持 ScoreCategories 枚举定义处即可扩展
            try {
                item.put("code", (String) e.getClass().getField("code").get(e));
                item.put("label", (String) e.getClass().getField("label").get(e));
            } catch (NoSuchFieldException | IllegalAccessException ex) {
                item.put("code", e.name());
                item.put("label", e.name());
            }
            list.add(item);
        }
        return list;
    }
}
