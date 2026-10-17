package com.kalimba.workshop.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.io.Serializable;
import java.time.LocalDateTime;

/**
 * 点赞记录（表 3-4 like_record）。
 * 用 (user_id, target_type, target_id) 唯一约束实现幂等：重复点赞被数据库挡掉，
 * 而不是靠「先查后插」这种在并发下并不可靠的写法。
 */
@Data
@TableName("like_record")
public class LikeRecord implements Serializable {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    /** post / comment */
    private String targetType;

    private Long targetId;

    private LocalDateTime createdAt;
}
