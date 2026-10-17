package com.kalimba.workshop;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * 卡林巴社区工坊后端入口。
 *
 * <p>单体应用，按业务域分包（module/*），横切关注点在 common/*。
 * 制谱在内核完成，本服务只承载社区内容与附件（架构图 3.1 分工）。
 */
@SpringBootApplication
@MapperScan("com.kalimba.workshop.mapper")
public class KalimbaWorkshopApplication {

    public static void main(String[] args) {
        SpringApplication.run(KalimbaWorkshopApplication.class, args);
    }
}
