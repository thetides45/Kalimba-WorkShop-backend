package com.kalimba.workshop.common.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;
import org.springframework.web.filter.CorsFilter;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.io.File;
import java.util.List;

/**
 * Web 基础配置：跨域 + 上传目录静态映射。
 *
 * <p>生产环境由 Nginx 统一转发，本配置主要服务于本地开发（前端 5173 → 后端 8080）；
 * 允许的来源从配置读取，不写死成 {@code *}，避免上线时把凭据能力敞开。
 */
@Configuration
public class WebConfig implements WebMvcConfigurer {

    @Value("${kalimba.cors.allowed-origins:http://localhost:5173,http://127.0.0.1:5173}")
    private List<String> allowedOrigins;

    @Value("${kalimba.upload.dir:./uploads}")
    private String uploadDir;

    @Bean
    public CorsFilter corsFilter() {
        CorsConfiguration cfg = new CorsConfiguration();
        cfg.setAllowedOrigins(allowedOrigins);
        cfg.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE", "OPTIONS"));
        cfg.setAllowedHeaders(List.of("*"));
        cfg.setExposedHeaders(List.of("Content-Disposition"));
        cfg.setAllowCredentials(true);
        cfg.setMaxAge(3600L);
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", cfg);
        return new CorsFilter(source);
    }

    /**
     * 上传目录静态映射。
     *
     * <p>⚠️ **只挂图片目录，刻意不挂乐谱目录**，理由是两者的访问方式根本不同：
     * <ul>
     *   <li><b>图片</b>（帖子封面 / 头像）是用 {@code <img src>} 加载的。而本项目用的是
     *       {@code sa-token} **自定义请求头**（不是 Cookie），{@code <img>} 发不出这个头 ——
     *       所以图片**必须免鉴权可读**，只能作为静态资源直出。</li>
     *   <li><b>乐谱附件</b>是用 JS 的 {@code fetch} 拉的，能带请求头，所以能走鉴权接口
     *       {@code GET /api/files/{id}}。如果把 {@code /uploads/score/**} 也挂成静态资源，
     *       等于给乐谱开了一条**绕过登录校验的旁路** —— 2026-10-03 实测：
     *       {@code curl http://localhost:8080/uploads/score/<uuid>.json} 不带 token 直接 200。
     *       只保护 {@code /api/files/{id}} 而留这条路，等于白做。</li>
     * </ul>
     * 生产环境同样建议由 Nginx 只放行 {@code /uploads/img/}。
     */
    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        String abs = new File(uploadDir).getAbsolutePath() + File.separator;
        registry.addResourceHandler("/uploads/img/**")
                .addResourceLocations("file:" + abs + "img" + File.separator);
    }
}
