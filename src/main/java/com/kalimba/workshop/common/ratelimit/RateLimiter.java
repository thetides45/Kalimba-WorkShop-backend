package com.kalimba.workshop.common.ratelimit;

import com.kalimba.workshop.common.exception.BizException;
import com.kalimba.workshop.common.exception.ErrorCode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.time.Duration;

/**
 * 轻量限流（规划书 4.8「限流」）。
 *
 * <p>用 Redis 的 INCR + 首次过期实现固定窗口计数：一个操作一条命令，
 * 比 Lua 令牌桶简单得多，而毕设演示与压测的量级完全够用。
 * Redis 不可用时**放行**而不是拒绝 —— 限流是保护措施，不该变成新的故障点。
 */
@Component
public class RateLimiter {

    private static final Logger log = LoggerFactory.getLogger(RateLimiter.class);

    private final StringRedisTemplate redis;

    public RateLimiter(@Autowired(required = false) StringRedisTemplate redis) {
        this.redis = redis;
    }

    /**
     * @param key      业务键，例如 "post:create:12"
     * @param limit    窗口内允许次数
     * @param window   窗口长度
     */
    public void check(String key, int limit, Duration window) {
        if (redis == null) return;
        try {
            String k = "rl:" + key;
            Long n = redis.opsForValue().increment(k);
            if (n != null && n == 1L) {
                redis.expire(k, window);
            }
            if (n != null && n > limit) {
                throw BizException.of(ErrorCode.RATE_LIMITED);
            }
        } catch (BizException e) {
            throw e;
        } catch (Exception e) {
            log.warn("限流不可用，放行：{}", e.getMessage());
        }
    }
}
