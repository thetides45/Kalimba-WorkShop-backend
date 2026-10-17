package com.kalimba.workshop.module.tag;

import com.kalimba.workshop.entity.Tag;
import com.kalimba.workshop.mapper.TagMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;

/** 标签服务：只读，种子数据建库时灌入。 */
@Service
@RequiredArgsConstructor
public class TagService {

    private final TagMapper tagMapper;

    public List<Tag> all() {
        return tagMapper.selectList(null);
    }
}
