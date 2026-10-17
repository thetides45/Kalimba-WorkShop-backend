package com.kalimba.workshop.module.user;

import cn.dev33.satoken.stp.StpUtil;
import com.kalimba.workshop.common.aspect.OpLog;
import com.kalimba.workshop.common.result.R;
import com.kalimba.workshop.dto.TokenResp;
import com.kalimba.workshop.dto.UpdateProfileReq;
import com.kalimba.workshop.entity.User;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@Tag(name = "用户")
@RestController
@RequestMapping("/api/users")
@RequiredArgsConstructor
public class UserController {

    private final UserService userService;

    @Operation(summary = "用户主页信息（公开）")
    @GetMapping("/{id}")
    public R<Map<String, Object>> profile(@PathVariable Long id) {
        return R.ok(userService.profile(id));
    }

    @Operation(summary = "更新我的资料（昵称 / 头像 / 简介 / 琴型，部分更新）")
    @OpLog("更新个人资料")
    @PutMapping("/me")
    public R<TokenResp> updateMe(@RequestBody UpdateProfileReq req) {
        userService.update(req);
        User u = userService.current();
        return R.ok(new TokenResp(StpUtil.getTokenValue(), u.getId(), u.getUsername(),
                u.getNickname(), u.getAvatar(), u.getRole()));
    }
}
