package com.kalimba.workshop.module.user;

import cn.dev33.satoken.stp.StpUtil;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.kalimba.workshop.common.exception.BizException;
import com.kalimba.workshop.common.exception.ErrorCode;
import com.kalimba.workshop.common.sensitive.SensitiveWordFilter;
import com.kalimba.workshop.dto.UpdateProfileReq;
import com.kalimba.workshop.entity.Follow;
import com.kalimba.workshop.entity.Post;
import com.kalimba.workshop.entity.User;
import com.kalimba.workshop.mapper.FollowMapper;
import com.kalimba.workshop.mapper.PostMapper;
import com.kalimba.workshop.mapper.UserMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;

/**
 * 用户资料服务（WBS 4.2）。
 *
 * <p>主页信息是公开读接口：只返回昵称、头像、简介、琴型与统计，
 * **永不返回密码哈希与邮箱**。
 *
 * <p>2026-10-02 补齐：此前 profile 只返回 5 个字段，导致 V3「我的」页的三格统计、
 * 简介、琴型、关注态全都拿不到（前端只能把数字写死成 0）。
 * 现在简介/琴型来自 user 表新列，三格统计**实时 count**（不冗余计数列）。
 */
@Service
@RequiredArgsConstructor
public class UserService {

    /** 主页展示用的琴型白名单 —— 只允许这两种键数，避免脏值进库再去前端兼容。 */
    private static final Set<Integer> FAN_TYPES = Set.of(17, 21);

    /** 昵称长度上限，与前端 maxlength=20 对齐（列宽 32，放宽会有 500 风险）。 */
    private static final int NICKNAME_MAX = 20;

    private final UserMapper userMapper;
    private final PostMapper postMapper;
    private final FollowMapper followMapper;
    private final SensitiveWordFilter sensitiveWordFilter;

    /** 公开主页信息。 */
    public Map<String, Object> profile(Long id) {
        User u = userMapper.selectById(id);
        /* 「查不到」与「已被封禁」**拆成两个码**（B16，2026-10-10）：
           原先合用一个 NOT_FOUND(1002) → 前端只能干说「资源不存在」，
           看不出到底是「没这个人」还是「这个人被封了」，排查时也难分辨。
           ⚠️ 拆开的前提：**2004 不在前端的 AUTH_CODES 里**（`web-vue/src/shared/res.js`
           只认 2001/40100/40102），所以匿名访客浏览被封用户的主页**不会**被清会话、
           不会被迫跳登录 —— 这是对的。哪天把 2004 加进 AUTH_CODES，务必回看这里。
           ⚠️ 对比 {@link com.kalimba.workshop.module.auth.AuthService#refresh()}：
           那里**刻意**把「用户没了」和「被封了」合并成 2001 并 logout()，
           因为那种场景下**会话本身必须作废**（否则前端会卡在续期循环里）——
           两处语义不同，别顺手统一。 */
        if (u == null) throw BizException.of(ErrorCode.NOT_FOUND);
        if (u.getStatus() != null && u.getStatus() != 1) throw BizException.of(ErrorCode.USER_DISABLED);
        Map<String, Object> m = new HashMap<>();
        m.put("id", u.getId());
        m.put("username", u.getUsername());
        m.put("nickname", u.getNickname());
        m.put("avatar", u.getAvatar());
        m.put("intro", u.getIntro());
        m.put("fanType", u.getFanType() == null ? 17 : u.getFanType());
        m.put("createdAt", u.getCreatedAt());

        /* 三格统计：实时 count。表规模在毕设量级，加索引足够；
           不像 post.like_count 那样冗余成列 —— 那是为了列表排序，这里只要一个数。 */
        m.put("postCount", postMapper.selectCount(new LambdaQueryWrapper<Post>()
                .eq(Post::getUserId, id).eq(Post::getStatus, 1)));
        m.put("followerCount", followMapper.selectCount(new LambdaQueryWrapper<Follow>()
                .eq(Follow::getFolloweeId, id)));
        m.put("followingCount", followMapper.selectCount(new LambdaQueryWrapper<Follow>()
                .eq(Follow::getFollowerId, id)));

        /* 关注态：接口在白名单里（匿名可访问主页），所以必须先判登录 ——
           未登录一律 false，而不是让 StpUtil 抛异常把公开页打成 401。 */
        m.put("isFollowing", isFollowing(id));
        return m;
    }

    private boolean isFollowing(Long targetId) {
        try {
            if (!StpUtil.isLogin()) return false;
            Long me = StpUtil.getLoginIdAsLong();
            if (me.equals(targetId)) return false;
            Long n = followMapper.selectCount(new LambdaQueryWrapper<Follow>()
                    .eq(Follow::getFollowerId, me).eq(Follow::getFolloweeId, targetId));
            return n != null && n > 0;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 更新当前用户资料（昵称 / 头像 / 简介 / 琴型）——**部分更新**：
     * 只改传上来的字段，没传的保持原值（见 {@link UpdateProfileReq} 的说明）。
     */
    public void update(UpdateProfileReq req) {
        Long uid = StpUtil.getLoginIdAsLong();
        User u = userMapper.selectById(uid);
        if (u == null) throw BizException.of(ErrorCode.UNAUTHORIZED);

        if (req.getNickname() != null && !req.getNickname().isBlank()) {
            String nn = req.getNickname().trim();
            if (nn.length() > NICKNAME_MAX) throw BizException.of(ErrorCode.PARAM_INVALID);
            sensitiveWordFilter.assertClean(nn);
            u.setNickname(nn);
        }

        if (req.getAvatar() != null && req.getAvatar().length() <= 2048) {
            u.setAvatar(req.getAvatar());
        }

        if (req.getIntro() != null) {
            String intro = req.getIntro().trim();
            if (intro.length() > 60) throw BizException.of(ErrorCode.PARAM_INVALID);
            /* 简介是用户自由文本，和昵称一样要过敏感词 —— 漏了它就等于留了个后门。 */
            if (!intro.isEmpty()) sensitiveWordFilter.assertClean(intro);
            u.setIntro(intro.isEmpty() ? null : intro);
        }

        if (req.getFanType() != null) {
            if (!FAN_TYPES.contains(req.getFanType())) throw BizException.of(ErrorCode.PARAM_INVALID);
            u.setFanType(req.getFanType());
        }

        userMapper.updateById(u);
    }

    /** 供 controller 取当前登录用户（内部工具，非接口）。 */
    public User current() {
        Long uid = StpUtil.getLoginIdAsLong();
        User u = userMapper.selectById(uid);
        if (u == null) throw BizException.of(ErrorCode.UNAUTHORIZED);
        return u;
    }
}
