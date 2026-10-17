package com.kalimba.workshop.common.result;

import com.baomidou.mybatisplus.core.metadata.IPage;
import lombok.Data;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

/**
 * 分页返回体。分页参数统一为 page / size（规划书 3.7）。
 */
@Data
public class PageResult<T> implements Serializable {

    private long total;
    private long page;
    private long size;
    private List<T> records = new ArrayList<>();

    public static <T> PageResult<T> of(IPage<T> p) {
        PageResult<T> r = new PageResult<>();
        r.total = p.getTotal();
        r.page = p.getCurrent();
        r.size = p.getSize();
        r.records = p.getRecords();
        return r;
    }

    /** 从实体分页映射为 VO 分页。 */
    public static <E, T> PageResult<T> of(IPage<E> p, Function<E, T> mapper) {
        PageResult<T> r = new PageResult<>();
        r.total = p.getTotal();
        r.page = p.getCurrent();
        r.size = p.getSize();
        r.records = p.getRecords().stream().map(mapper).toList();
        return r;
    }

    public static <T> PageResult<T> empty(long page, long size) {
        PageResult<T> r = new PageResult<>();
        r.total = 0;
        r.page = page;
        r.size = size;
        return r;
    }
}
