package com.kalimba.workshop.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.kalimba.workshop.entity.Favorite;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

public interface FavoriteMapper extends BaseMapper<Favorite> {

    /**
     * 该用户是否**收藏过引用这份乐谱的帖子**（供 {@code ScoreVisibility.FAVORITE} 档判定）。
     *
     * <p>为什么要 join：收藏挂在 {@code post} 上（`favorite.post_id`），而下载分级挂在
     * {@code score_file} 上（`post.score_file_id`），两者的连接点只有帖子。
     *
     * <p>一份附件被多篇帖子引用时，**收藏其中任意一篇**即算达成条件 —— 这是刻意的宽松口径：
     * 附件本身没有独立页面，用户能点到的只有帖子，按帖子收是唯一可交互的语义。
     *
     * <p>反向的边界：附件**没有被任何帖子引用**时，谁也无法收藏它，于是除作者/管理员外都下不了。
     * 这是自洽的（没帖子就没法收藏），但排查时容易看成 bug，故在此写明。
     */
    @Select("select count(*) from favorite f join post p on p.id = f.post_id "
            + "where f.user_id = #{userId} and p.score_file_id = #{scoreFileId}")
    int countUserFavoritedScore(@Param("userId") Long userId, @Param("scoreFileId") Long scoreFileId);
}
