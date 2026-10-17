package com.kalimba.workshop.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.kalimba.workshop.entity.Post;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Update;

public interface PostMapper extends BaseMapper<Post> {

    /** 浏览量自增走数据库原子操作，避免「读-改-写」在并发下丢计数。 */
    @Update("update post set view_count = view_count + 1 where id = #{id}")
    int incrView(@Param("id") Long id);

    /** 点赞数增减同样原子，且限制不小于 0（取消点赞与并发重复请求都可能减到负数）。 */
    @Update("update post set like_count = greatest(like_count + #{delta}, 0) where id = #{id}")
    int incrLike(@Param("id") Long id, @Param("delta") int delta);
}
