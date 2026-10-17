package com.kalimba.workshop.mapper;

import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.util.List;
import java.util.Map;

/**
 * 搜索关键词日志（热搜榜数据源）。
 *
 * <p>刻意不继承 {@code BaseMapper}：这张表只有两个动作 —— 「累加一次」和「取 Top N」，
 * 拿通用 CRUD 没有意义，写清楚这两句 SQL 反而更好读。
 */
public interface SearchLogMapper {

    /**
     * 记一次搜索：当天已有该词就 cnt+1，否则插一行（利用 uk_keyword_day 唯一键）。
     * 用 upsert 而不是「先查再写」，是为了并发下不会插出重复行。
     */
    @Insert("insert into search_log(keyword, day, cnt, created_at, updated_at) "
            + "values(#{kw}, curdate(), 1, now(), now()) "
            + "on duplicate key update cnt = cnt + 1, updated_at = now()")
    int bump(@Param("kw") String kw);

    /**
     * 近 days 天的热搜词 Top N。
     * 返回 [{keyword, count}]；count 是区间内 SUM(cnt)。
     */
    @Select("select keyword, sum(cnt) as `count` from search_log "
            + "where day >= date_sub(curdate(), interval #{days} day) "
            + "group by keyword order by `count` desc, max(updated_at) desc limit #{limit}")
    List<Map<String, Object>> top(@Param("days") int days, @Param("limit") int limit);
}
