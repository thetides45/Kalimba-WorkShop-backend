package com.kalimba.workshop.module.moderation;

import cn.dev33.satoken.stp.StpUtil;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.kalimba.workshop.common.exception.BizException;
import com.kalimba.workshop.common.exception.ErrorCode;
import com.kalimba.workshop.dto.ReportReq;
import com.kalimba.workshop.entity.Report;
import com.kalimba.workshop.mapper.ReportMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.Set;

/** 举报服务（WBS 4.7）：提交举报，人工复审在管理端。 */
@Service
@RequiredArgsConstructor
public class ModerationService {

    private static final Set<String> VALID_TYPES = Set.of("post", "comment", "user");

    private final ReportMapper reportMapper;

    public Report submit(ReportReq req) {
        Long uid = StpUtil.getLoginIdAsLong();
        Long targetId = parseId(req.getTargetId());
        if (!VALID_TYPES.contains(req.getTargetType())) {
            throw BizException.of(ErrorCode.PARAM_INVALID);
        }
        /* 同一用户对同一对象只能举报一次 —— 挡刷屏。
           表上另有 uk_reporter_target 唯一键兜底（并发下先插的那条赢）。 */
        Long exists = reportMapper.selectCount(new LambdaQueryWrapper<Report>()
                .eq(Report::getReporterId, uid)
                .eq(Report::getTargetType, req.getTargetType())
                .eq(Report::getTargetId, targetId));
        if (exists != null && exists > 0) {
            throw BizException.of(ErrorCode.ALREADY_REPORTED);
        }

        Report r = new Report();
        r.setReporterId(uid);
        r.setTargetType(req.getTargetType());
        r.setTargetId(targetId);
        r.setReason(req.getReason());
        r.setStatus(0);
        r.setCreatedAt(LocalDateTime.now());
        reportMapper.insert(r);
        return r;
    }

    private Long parseId(String s) {
        try {
            return Long.parseLong(s);
        } catch (NumberFormatException e) {
            throw BizException.of(ErrorCode.PARAM_INVALID);
        }
    }
}
