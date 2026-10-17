package com.kalimba.workshop.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.Data;

/** 举报请求。 */
@Data
public class ReportReq {

    @NotBlank(message = "举报对象类型不能为空")
    private String targetType;

    @NotBlank(message = "举报对象不能为空")
    private String targetId;

    @Size(max = 500, message = "举报理由过长")
    private String reason;
}
