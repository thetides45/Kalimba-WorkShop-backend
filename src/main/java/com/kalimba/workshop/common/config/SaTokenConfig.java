package com.kalimba.workshop.common.config;

import cn.dev33.satoken.interceptor.SaInterceptor;
import cn.dev33.satoken.jwt.StpLogicJwtForSimple;
import cn.dev33.satoken.stp.StpLogic;
import cn.dev33.satoken.stp.StpUtil;
import com.kalimba.workshop.common.exception.BizException;
import com.kalimba.workshop.common.exception.ErrorCode;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.util.AntPathMatcher;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.util.List;

/**
 * 认证配置：Sa-Token 的 JWT 模式（规划书 3.2 技术选型）。
 *
 * <p>规则是「默认要登录」，公开接口走白名单 —— 这样新增接口忘了配权限时
 * 默认是**安全**的，而不是默认敞开。管理端再叠一层角色校验。
 *
 * <h3>为什么白名单是「HTTP 方法 + 路径」而不是 {@code excludePathPatterns}</h3>
 * Sa-Token 的路径排除**只能按路径、不能按方法**。于是写
 * {@code excludePathPatterns("/api/posts/*")} 会连 {@code PUT/DELETE /api/posts/{id}}
 * 一起放行 —— 本意只想公开「读」，结果「写」也绕过了登录拦截（此前只能靠 Service 层
 * 里那句 {@code StpUtil.getLoginIdAsLong()} 兜底，属于「拦截层不设防」）。
 * 这里改成在拦截器内部按 {@link PublicRule} 精确匹配方法，读/写彻底分开。
 */
@Configuration
public class SaTokenConfig implements WebMvcConfigurer {

    /** 一条公开规则：HTTP 方法 + 路径模式（Ant 风格）。 */
    private record PublicRule(String method, String pattern) {}

    /**
     * 公开接口清单。**只放 GET 的读接口**，写接口一律要登录。
     *
     * <p>三个刻意的决定：
     * <ul>
     *   <li>{@code /api/users/*}（公开主页）放行，但 {@code /api/files/{id}}（**下载**）**不放行** ——
     *       乐谱源文件属于「达到条件才能拿」的东西，必须登录（条件分级见 visibility 字段）。</li>
     *   <li><b>只读的</b> {@code /api/files/{id}/meta} 与 {@code /api/files/{id}/content} **放行**
     *       （2026-10-13 新增）—— 前者只有元信息、后者是谱面内容，用途是「匿名也能看谱、能试听」。
     *       ⚠️ 只放 GET 这两个后缀，**绝不能写成 {@code /api/files/**}**，否则下载接口会一起敞开。</li>
     *   <li>上传接口（{@code POST /api/files/image} / {@code /score}）也**不放行** ——
     *       否则匿名就能往服务器写文件，等于开放免费图床。</li>
     * </ul>
     */
    private static final List<PublicRule> PUBLIC_RULES = List.of(
            /* ---- 认证：注册/登录/续期本身就是「尚未登录」时调的 ---- */
            new PublicRule("POST", "/api/auth/register"),
            new PublicRule("POST", "/api/auth/login"),
            new PublicRule("POST", "/api/auth/refresh"),

            /* ---- 公开「读」（注意：每条都只放 GET）---- */
            new PublicRule("GET", "/api/posts"),              // 帖子列表
            new PublicRule("GET", "/api/posts/*"),            // 帖子详情
            new PublicRule("GET", "/api/posts/*/comments"),   // 评论列表
            new PublicRule("GET", "/api/users/*"),            // 用户公开主页
            new PublicRule("GET", "/api/hot"),                // 热榜
            new PublicRule("GET", "/api/tags"),               // 标签
            new PublicRule("GET", "/api/meta/**"),            // 分类字典
            new PublicRule("GET", "/api/search"),             // 综合搜索
            new PublicRule("GET", "/api/search/**"),          // 热搜词
            // 乐谱的只读面：元信息 + 内容（查看 / 试听）
            // ⚠️ 两条都用**单段通配**，只吃「files/{id}/meta|content」这一级：
            //    匹配不到 files/{id}（下载），也匹配不到 files/{id}/visibility（改权限），
            //    正是想要的「读放行、写与下载照旧」。
            //    （别写成块注释 —— 路径里的星号加斜杠会把注释提前闭合。）
            new PublicRule("GET", "/api/files/*/meta"),       // 附件元信息（不含 filePath）
            new PublicRule("GET", "/api/files/*/content")     // 谱面内容（login 档匿名可读）
    );

    private static final AntPathMatcher PATH_MATCHER = new AntPathMatcher();

    private static boolean isPublic(String method, String path) {
        for (PublicRule r : PUBLIC_RULES) {
            if (r.method().equalsIgnoreCase(method) && PATH_MATCHER.match(r.pattern(), path)) {
                return true;
            }
        }
        return false;
    }

    /** 当前请求路径（已剥掉 context-path）。 */
    private static String currentPath() {
        ServletRequestAttributes attrs = (ServletRequestAttributes) RequestContextHolder.getRequestAttributes();
        if (attrs == null) return "";
        HttpServletRequest req = attrs.getRequest();
        String uri = req.getRequestURI();
        String ctx = req.getContextPath();
        return (ctx != null && !ctx.isEmpty() && uri.startsWith(ctx)) ? uri.substring(ctx.length()) : uri;
    }

    /** 开启 JWT 模式：令牌自包含，服务端不存会话（便于多实例与演示部署）。 */
    @Bean
    public StpLogic getStpLogicJwt() {
        return new StpLogicJwtForSimple();
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        // 第一层：默认要登录，只有 PUBLIC_RULES 里「方法 + 路径」都命中的才放行。
        // ⚠️ 这里不能用 excludePathPatterns —— 它不支持按方法，会把写接口一起漏出去。
        registry.addInterceptor(new SaInterceptor(handle -> {
            ServletRequestAttributes attrs = (ServletRequestAttributes) RequestContextHolder.getRequestAttributes();
            if (attrs == null) return;   // 非 Web 上下文（理论上不会走到）
            if (isPublic(attrs.getRequest().getMethod(), currentPath())) return;
            StpUtil.checkLogin();
        })).addPathPatterns("/api/**");

        // 第二层：管理端再叠一道角色校验，非 admin 一律拒绝 ——
        // 拦截层统一管住，Service 层的 requireAdmin() 作为第二道兜底。
        registry.addInterceptor(new SaInterceptor(handle -> {
            if (!"admin".equals(StpUtil.getSession().getString("role"))) {
                throw BizException.of(ErrorCode.ADMIN_REQUIRED);
            }
        })).addPathPatterns("/api/admin/**");
    }
}
