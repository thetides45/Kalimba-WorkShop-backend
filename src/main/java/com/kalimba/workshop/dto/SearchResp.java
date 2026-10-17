package com.kalimba.workshop.dto;

import com.kalimba.workshop.common.result.PageResult;
import com.kalimba.workshop.entity.Tag;
import lombok.Data;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.List;

/**
 * 综合搜索结果：一次返回「帖子 / 用户 / 标签」三组。
 *
 * <p>为什么不做成三个独立接口：搜索框只有一次提交动作，三次往返在弱网下明显迟滞；
 * 而且三组的命中集合本来就共享同一个关键词，放在一次查询里还能复用「标签全表」这一次读取。
 * 未请求的分组返回空集合而不是 null，前端省掉判空。
 */
@Data
public class SearchResp implements Serializable {

    private String keyword;

    /** 帖子命中（分页）。 */
    private PageResult<PostVO> posts;

    /** 用户命中（昵称 / 用户名），最多若干条。 */
    private List<UserBrief> users = new ArrayList<>();

    /** 标签命中（标签名），最多若干条。 */
    private List<Tag> tags = new ArrayList<>();
}
