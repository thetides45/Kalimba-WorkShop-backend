package com.kalimba.workshop.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.io.Serializable;
import java.time.LocalDateTime;

/** 举报（表 3-4 report）。status：0 待处理，1 已处理，2 已驳回。 */
@Data
@TableName("report")
public class Report implements Serializable {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long reporterId;

    /** post / comment / user */
    private String targetType;

    private Long targetId;

    private String reason;

    private Integer status;

    private LocalDateTime createdAt;
}
