package com.kalimba.workshop.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.kalimba.workshop.entity.Notification;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Update;

public interface NotificationMapper extends BaseMapper<Notification> {

    @Update("update notification set is_read = 1 where user_id = #{userId} and is_read = 0")
    int markAllRead(@Param("userId") Long userId);
}
