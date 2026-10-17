package com.kalimba.workshop.module.moderation;

import com.kalimba.workshop.common.result.R;
import com.kalimba.workshop.dto.ReportReq;
import com.kalimba.workshop.entity.Report;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "举报")
@RestController
@RequestMapping("/api/reports")
@RequiredArgsConstructor
public class ModerationController {

    private final ModerationService moderationService;

    @Operation(summary = "提交举报")
    @PostMapping
    public R<Report> submit(@Valid @RequestBody ReportReq req) {
        return R.ok(moderationService.submit(req));
    }
}
