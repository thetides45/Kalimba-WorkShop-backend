package com.kalimba.workshop.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.kalimba.workshop.entity.OperationLog;
import org.apache.ibatis.annotations.Select;

import java.util.List;

/**
 * 操作日志 Mapper。
 *
 * <p>通用 CRUD 用 {@link BaseMapper} 就够（追加一行 / 按条件分页），
 * 只有「有哪些操作类型」这一句需要手写 —— 它必须是**从数据反查**而不是前端硬编码：
 * 将来往某个接口补一个 {@code @OpLog("...")}，管理页的筛选 chip 会自动多出来，
 * 不需要有人记得同步前端常量（本项目反复强调的「单一来源、防漂移」）。
 */
public interface OperationLogMapper extends BaseMapper<OperationLog> {

    /** 出现过的操作类型（去重）。用于管理端筛选 chip。 */
    @Select("select distinct action from op_log order by action")
    List<String> distinctActions();
}
