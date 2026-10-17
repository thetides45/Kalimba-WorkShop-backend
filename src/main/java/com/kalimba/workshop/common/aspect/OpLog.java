package com.kalimba.workshop.common.aspect;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * 操作日志注解（AOP，架构图「横切关注点」之一）。
 * 打在需要留痕的写接口上：发布、删除、封禁、下架等。
 */
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface OpLog {

    /** 操作说明，写进日志。 */
    String value();

    /** 是否记录耗时（默认记录）。 */
    boolean timing() default true;
}
