package com.kalimba.workshop.module.notification;

import cn.dev33.satoken.stp.StpUtil;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.kalimba.workshop.common.result.PageResult;
import com.kalimba.workshop.dto.NotificationVO;
import com.kalimba.workshop.entity.Notification;
import com.kalimba.workshop.mapper.NotificationMapper;
import com.kalimba.workshop.mapper.PostMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * 通知服务（WBS 4.5）。列表按时间倒序，未读数单独查（前端徽标）。
 *
 * <p>2026-10-11：列表改为返回 {@link NotificationVO}，由服务端**批量补齐帖子标题**
 * （原因见该 VO 的类注释：{@code like}/{@code comment} 的 {@code content} 是 null，
 * 没有标题前端只能显示「某某赞了你的帖子」，看不出是哪一篇）。
 */
@Service
@RequiredArgsConstructor
public class NotificationService {

    private final NotificationMapper notificationMapper;
    private final PostMapper postMapper;

    public PageResult<NotificationVO> list(int page, int size) {
        Long uid = StpUtil.getLoginIdAsLong();
        Page<Notification> p = notificationMapper.selectPage(new Page<>(page, size),
                new LambdaQueryWrapper<Notification>()
                        .eq(Notification::getUserId, uid)
                        .orderByDesc(Notification::getCreatedAt));

        /* 批量补齐标题：只把**本页出现过**的 targetId 去重，**一次** selectBatchIds 查出来再回填。
           ⚠️ 别写成逐条 selectById（N+1），也别把这个活儿丢给前端。
           ⚠️ 查不到的（帖子已删）不进 map → postTitle 保持 null，前端据此不显示书名号。 */
        List<Notification> records = p.getRecords();
        Set<Long> postIds = new HashSet<>();
        for (Notification n : records) {
            if (n.getTargetId() != null) postIds.add(n.getTargetId());
        }
        Map<Long, String> titles = new HashMap<>();
        if (!postIds.isEmpty()) {
            postMapper.selectBatchIds(postIds).forEach(post -> titles.put(post.getId(), post.getTitle()));
        }

        return PageResult.of(p, n -> toVO(n, titles));
    }

    private NotificationVO toVO(Notification n, Map<Long, String> titles) {
        NotificationVO vo = new NotificationVO();
        vo.setId(n.getId());
        vo.setUserId(n.getUserId());
        vo.setType(n.getType());
        vo.setSenderId(n.getSenderId());
        vo.setTargetId(n.getTargetId());
        vo.setContent(n.getContent());
        vo.setIsRead(n.getIsRead());
        vo.setCreatedAt(n.getCreatedAt());
        vo.setPostTitle(n.getTargetId() == null ? null : titles.get(n.getTargetId()));
        return vo;
    }

    public long unreadCount() {
        Long uid = StpUtil.getLoginIdAsLong();
        return notificationMapper.selectCount(new LambdaQueryWrapper<Notification>()
                .eq(Notification::getUserId, uid)
                .eq(Notification::getIsRead, 0));
    }

    public void markRead(Long id) {
        Notification n = notificationMapper.selectById(id);
        if (n == null || !Objects.equals(n.getUserId(), StpUtil.getLoginIdAsLong())) return;
        n.setIsRead(1);
        notificationMapper.updateById(n);
    }

    public void markAllRead() {
        notificationMapper.markAllRead(StpUtil.getLoginIdAsLong());
    }
}
