package com.kalimba.workshop.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.Data;

/** 发表评论 / 回复请求。parentId 有值即回复。 */
@Data
public class CommentReq {

    @NotBlank(message = "评论内容不能为空")
    @Size(max = 2000, message = "评论过长")
    private String content;

    /** 回复的一级评论 id；为空表示一级评论。 */
    private Long parentId;
}
