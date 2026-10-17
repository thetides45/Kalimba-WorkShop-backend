package com.kalimba.workshop.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.io.Serializable;
import java.time.LocalDateTime;

/**
 * 乐谱附件（表 3-4 score_file）。
 *
 * <p>version 记录**乐谱 JSON 的格式版本**（规划书 3.5 的 version 字段），
 * 与文件大小无关：将来格式升级时，服务端据此判断是否需要提示用户重新导出。
 *
 * <p>曲谱分类（琴型/调性/难度）是**独立于帖子标签 tag 的体系**，落在本附件上：
 * 一份谱无论被哪篇帖子引用，分类都跟着谱走（见 {@link com.kalimba.workshop.module.meta.ScoreCategories}）。
 */
@Data
@TableName("score_file")
public class ScoreFile implements Serializable {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long ownerId;

    private String fileName;

    private String filePath;

    private Long size;

    private String version;

    /**
     * 乐谱 JSON 的**格式标识**（上传时从文件头部读，见 {@code FileService#readEnvelope}）。
     *
     * <p>两个取值：{@code kalimba-tab} = 制谱内核导出的格式，2026-10-13 起是**唯一真源**；
     * {@code kalimba-score} = 旧格式，已无任何生成方（其生成器文件随 Vue SPA 归档）。
     *
     * <p>它存在的意义是让前端能**分辨**：内核格式可以直接渲染，遇到旧格式该提示
     * 「请在制谱器里重新导出」，而不是把一份结构对不上的 JSON 静默渲染成空白谱。
     * 老数据默认 'kalimba-score'（取迁移前实际语义）。
     */
    private String format;

    /**
     * 下载分级（login / favorite / follower / author，见 {@link com.kalimba.workshop.module.file.ScoreVisibility}）。
     *
     * <p>注意分级只约束**别人**：作者本人与管理员永远可下（见 FileService#assertDownloadable）。
     * 匿名访问则由拦截层统一挡住（{@code /api/files/**} 不在公开白名单里），
     * 所以这里**没有** public 档 —— 想放开匿名下载要同时改白名单，不是一个字段能决定的事。
     */
    private String visibility;

    /** 曲谱分类 · 琴型（k17/k21/other，可空=未填）。 */
    private String tuningType;

    /** 曲谱分类 · 调性（C/Db/D/.../B，可空=未填）。 */
    private String keyName;

    /** 曲谱分类 · 难度（beginner/easy/medium/hard，可空=未填）。 */
    private String difficulty;

    /** 曲谱分类 · 音乐类型（anime/cantonese/chinese/classic/pop/folk/ost/pure/other，可空=未填）。 */
    private String musicGenre;

    private LocalDateTime createdAt;
}
