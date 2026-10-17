package com.kalimba.workshop.common.config;

import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.security.SecurityRequirement;
import io.swagger.v3.oas.models.security.SecurityScheme;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * 接口文档（SpringDoc / Swagger UI）——「代码即文档」，前后端可平行开发（WBS 3 交付物）。
 * 访问路径：/swagger-ui.html
 */
@Configuration
public class SpringDocConfig {

    private static final String SCHEME = "sa-token";

    @Bean
    public OpenAPI kalimbaOpenApi() {
        return new OpenAPI()
                .info(new Info()
                        .title("卡林巴社区工坊 API")
                        .version("1.0.0")
                        .description("本地优先制谱 + 在线乐谱社区。制谱全部在浏览器内核完成，本服务只承载社区内容与附件。"))
                .components(new Components().addSecuritySchemes(SCHEME,
                        new SecurityScheme()
                                .type(SecurityScheme.Type.APIKEY)
                                .in(SecurityScheme.In.HEADER)
                                .name("sa-token")))
                .addSecurityItem(new SecurityRequirement().addList(SCHEME));
    }
}
