package com.kalimba.workshop.module.admin;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.kalimba.workshop.common.aspect.OpLog;
import com.kalimba.workshop.common.result.PageResult;
import com.kalimba.workshop.common.result.R;
import com.kalimba.workshop.dto.AdminCommentVO;
import com.kalimba.workshop.dto.AdminUserVO;
import com.kalimba.workshop.entity.OperationLog;
import com.kalimba.workshop.entity.Post;
import com.kalimba.workshop.entity.Report;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

@Tag(name = "管理端")
@RestController
@RequestMapping("/api/admin")
@RequiredArgsConstructor
public class AdminController {

    private final AdminService adminService;

    @Operation(summary = "帖子下架/恢复（status: 1 正常 / 2 下架）")
    @OpLog("管理-改帖子状态")
    @PutMapping("/posts/{id}/status")
    public R<Void> setPostStatus(@PathVariable Long id, @RequestParam int status) {
        adminService.setPostStatus(id, status);
        return R.ok();
    }

    @Operation(summary = "重建热榜缓存（删键重灌，返回成员数）")
    @OpLog("管理-重建热榜缓存")
    @PostMapping("/hot/rebuild")
    public R<Integer> rebuildHot() {
        return R.ok(adminService.rebuildHot());
    }

    @Operation(summary = "评论下架/恢复（status: 1 正常 / 0 下架）")
    @OpLog("管理-改评论状态")
    @PutMapping("/comments/{id}/status")
    public R<Void> setCommentStatus(@PathVariable Long id, @RequestParam int status) {
        adminService.setCommentStatus(id, status);
        return R.ok();
    }

    @Operation(summary = "评论列表（可按关键词 / 状态筛；含作者昵称与所属帖子标题）")
    @GetMapping("/comments")
    public R<PageResult<AdminCommentVO>> comments(@RequestParam(defaultValue = "1") int page,
                                                  @RequestParam(defaultValue = "20") int size,
                                                  @RequestParam(required = false) String keyword,
                                                  @RequestParam(required = false) Integer status) {
        return R.ok(adminService.comments(page, size, keyword, status));
    }

    @Operation(summary = "待审帖子列表（status=0）")
    @GetMapping("/posts/pending")
    public R<PageResult<Post>> pendingPosts(@RequestParam(defaultValue = "1") int page,
                                            @RequestParam(defaultValue = "20") int size) {
        Page<Post> p = adminService.pendingPosts(page, size);
        return R.ok(PageResult.of(p));
    }

    @Operation(summary = "用户列表（可按用户名/昵称模糊搜）")
    @GetMapping("/users")
    public R<PageResult<AdminUserVO>> users(@RequestParam(defaultValue = "1") int page,
                                            @RequestParam(defaultValue = "20") int size,
                                            @RequestParam(required = false) String keyword) {
        return R.ok(adminService.users(page, size, keyword));
    }

    @Operation(summary = "用户封禁/解除（status: 1 正常 / 0 封禁）")
    @OpLog("管理-改用户状态")
    @PutMapping("/users/{id}/status")
    public R<Void> setUserStatus(@PathVariable Long id, @RequestParam int status) {
        adminService.setUserStatus(id, status);
        return R.ok();
    }

    @Operation(summary = "举报列表")
    @GetMapping("/reports")
    public R<PageResult<Report>> reports(@RequestParam(defaultValue = "1") int page,
                                         @RequestParam(defaultValue = "20") int size,
                                         @RequestParam(required = false) Integer status) {
        Page<Report> p = adminService.reports(page, size, status);
        return R.ok(PageResult.of(p));
    }

    @Operation(summary = "处理举报（status: 1 已处理 / 2 已驳回）")
    @OpLog("管理-处理举报")
    @PutMapping("/reports/{id}")
    public R<Void> handleReport(@PathVariable Long id, @RequestParam int status) {
        adminService.handleReport(id, status);
        return R.ok();
    }

    @Operation(summary = "数据统计")
    @GetMapping("/stats")
    public R<Map<String, Object>> stats() {
        return R.ok(adminService.stats());
    }

    @Operation(summary = "操作日志（审核记录）；可按操作类型 / 成败 / 用户名或 URI 筛")
    @GetMapping("/logs")
    public R<PageResult<OperationLog>> logs(@RequestParam(defaultValue = "1") int page,
                                            @RequestParam(defaultValue = "20") int size,
                                            @RequestParam(required = false) String action,
                                            @RequestParam(required = false) String keyword,
                                            @RequestParam(required = false) Integer success) {
        return R.ok(adminService.logs(page, size, action, keyword, success));
    }

    @Operation(summary = "操作日志里出现过的操作类型（渲染筛选 chip，避免前端硬编码）")
    @GetMapping("/logs/actions")
    public R<List<String>> logActions() {
        return R.ok(adminService.logActions());
    }
}
