package com.kalimba.workshop.module.auth;

import com.kalimba.workshop.common.result.R;
import com.kalimba.workshop.dto.LoginReq;
import com.kalimba.workshop.dto.RegisterReq;
import com.kalimba.workshop.dto.TokenResp;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "认证")
@RestController
@RequestMapping("/api/auth")
@RequiredArgsConstructor
public class AuthController {

    private final AuthService authService;

    @Operation(summary = "注册")
    @PostMapping("/register")
    public R<TokenResp> register(@Valid @RequestBody RegisterReq req) {
        return R.ok(authService.register(req));
    }

    @Operation(summary = "登录")
    @PostMapping("/login")
    public R<TokenResp> login(@Valid @RequestBody LoginReq req) {
        return R.ok(authService.login(req));
    }

    @Operation(summary = "令牌刷新（登录态）")
    @PostMapping("/refresh")
    public R<TokenResp> refresh() {
        return R.ok(authService.refresh());
    }
}
