package com.kalimba.workshop.common.config;

import com.baomidou.mybatisplus.annotation.DbType;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * MyBatis-Plus 配置：只需分页插件。
 *
 * <p>逻辑删除不做全局配置 —— 帖子的「下架」是内容状态（post.status），
 * 不是删除语义，两件事混在一起会让管理端查询和统计都变复杂。
 */
@Configuration
public class MybatisPlusConfig {

    @Bean
    public MybatisPlusInterceptor mybatisPlusInterceptor() {
        MybatisPlusInterceptor interceptor = new MybatisPlusInterceptor();
        PaginationInnerInterceptor page = new PaginationInnerInterceptor(DbType.MYSQL);
        page.setMaxLimit(100L);
        page.setOverflow(false);
        interceptor.addInnerInterceptor(page);
        return interceptor;
    }
}
