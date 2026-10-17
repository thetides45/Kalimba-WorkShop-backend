package com.kalimba.workshop.module.file;

import com.kalimba.workshop.common.result.R;
import com.kalimba.workshop.entity.ScoreFile;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.File;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 文件接口。
 *
 * <p>三个与「下载分级」有关的约定（2026-10-03）：
 * <ul>
 *   <li><b>上传与下载</b>要登录（{@code POST /api/files/**}、{@code GET /api/files/{id}}
 *       都不在 {@code SaTokenConfig} 的公开白名单里）；分级是在「登录」之上的**更细**条件，
 *       不是替代它。</li>
 *   <li>⚠️ 例外（2026-10-13）：**只读的** {@code GET /{id}/meta} 与 {@code GET /{id}/content}
 *       已放行匿名 —— 目的是「匿名也能看谱、能试听」。它们只返回元信息与谱面内容，
 *       不含 {@code filePath}，也不改变下载口径。</li>
 *   <li>下载被拒时返回 **HTTP 200 + {@code code:5003} + 具体原因**（本项目业务错误一律 200），
 *       前端直接把 {@code message} 展示给用户即可，不要自己编文案 —— 否则两边口径会漂。</li>
 *   <li>{@code /meta} 与 {@code download} **共用同一个判定函数**（{@code FileService#accessOf}），
 *       保证「页面说能下」和「真的能下」永远一致。</li>
 * </ul>
 */
@Tag(name = "文件")
@RestController
@RequestMapping("/api/files")
@RequiredArgsConstructor
public class FileController {

    private final FileService fileService;

    @Operation(summary = "上传图片")
    @PostMapping("/image")
    public R<Map<String, String>> uploadImage(@RequestParam("file") MultipartFile file) {
        Map<String, String> m = new HashMap<>();
        m.put("url", fileService.uploadImage(file));
        return R.ok(m);
    }

    @Operation(summary = "上传乐谱附件（JSON/klb）")
    @PostMapping("/score")
    public R<ScoreFile> uploadScore(@RequestParam("file") MultipartFile file,
                                    @RequestParam(required = false) String tuningType,
                                    @RequestParam(required = false) String keyName,
                                    @RequestParam(required = false) String difficulty,
                                    @RequestParam(required = false) String musicGenre,
                                    @RequestParam(required = false) String visibility) {
        return R.ok(fileService.uploadScore(file, tuningType, keyName, difficulty, musicGenre, visibility));
    }

    @Operation(summary = "读取乐谱附件（受下载分级约束）")
    @GetMapping("/{id}")
    public ResponseEntity<Resource> download(@PathVariable Long id) {
        ScoreFile sf = fileService.getScore(id);
        /* ★ 分级校验：不通过 → BizException(5003, 具体原因)，由全局处理器转成 JSON 错误体。
           放在读流之前 —— 内容一个字节都不会离开服务器。 */
        fileService.assertDownloadable(sf);
        File f = fileService.resolve(sf.getFilePath());
        String encoded = URLEncoder.encode(sf.getFileName(), StandardCharsets.UTF_8).replace("+", "%20");
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename*=UTF-8''" + encoded)
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .body(new FileSystemResource(f));
    }

    /**
     * 读取乐谱内容用于**内嵌预览 / 试听**（`inline`，不带 attachment 头）。
     *
     * <p>与 {@link #download} 分开是 2026-10-13 的改动，起因是「匿名也要能看谱、能试听」：
     * 此前预览与下载共用 {@code GET /api/files/{id}}，而那个接口整体要登录
     * ⇒ 匿名访客连谱面都渲染不出来（页面只能显示锁定卡片）。
     * 现在拆成两条：
     * <ul>
     *   <li>{@code GET /{id}/content} —— **只读预览**，判定走 {@code assertViewable}
     *       （{@code login} 档匿名放行），并已加入公开白名单；</li>
     *   <li>{@code GET /{id}} —— **下载**，判定走 {@code assertDownloadable}
     *       （必须登录 + 四档），仍在白名单之外。</li>
     * </ul>
     * ⚠️ 能预览 = 浏览器拿到了 JSON 字节，所以 {@code login} 档在技术上匿名可获取源文件；
     * 「下载」按钮是 UX 门槛而非防拷墙。要真正防拷只能服务端渲染成图，本项目不做。
     *
     * <p>{@code no-store}：这是按访问者身份判定的内容，不允许任何中间层缓存后发给别人。
     */
    @Operation(summary = "读取乐谱内容（内嵌预览/试听；login 档匿名可读）")
    @GetMapping("/{id}/content")
    public ResponseEntity<Resource> content(@PathVariable Long id) {
        ScoreFile sf = fileService.getScore(id);
        fileService.assertViewable(sf);
        File f = fileService.resolve(sf.getFilePath());
        return ResponseEntity.ok()
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .contentType(MediaType.APPLICATION_JSON)
                .body(new FileSystemResource(f));
    }

    /**
     * 附件元信息与**当前访问者**的可查看性 / 可下载性。
     *
     * <p>页面需要它来做两件事，而不是先试着下载再猜：
     * ① 帖子详情页事先知道该显示谱面还是「关注后可下载」的提示；
     * ② 发布页编辑态回显原附件的下载分级。
     *
     * <p>⚠️ 本接口**公开**（2026-10-13 起，随「匿名可查看」一起放行）—— 匿名访客也要靠它
     * 决定「渲染谱面」还是「显示锁定卡片」。因此它里面**只有元信息**：
     * 刻意**不返回** {@code filePath}（服务端磁盘相对路径），也不含任何谱面内容。
     */
    @Operation(summary = "乐谱附件元信息 + 可查看性 / 可下载性")
    @GetMapping("/{id}/meta")
    public R<Map<String, Object>> meta(@PathVariable Long id) {
        ScoreFile sf = fileService.getScore(id);
        FileService.AccessInfo d = fileService.accessOf(sf, currentUserId());      // 下载判定
        FileService.AccessInfo v = fileService.accessOfView(sf, currentUserId());  // 查看判定
        ScoreVisibility vis = ScoreVisibility.parse(sf.getVisibility());

        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", String.valueOf(sf.getId()));
        m.put("fileName", sf.getFileName());
        m.put("size", sf.getSize());
        m.put("version", sf.getVersion());
        /* format 让前端分辨「内核格式可直接渲染 / 旧格式该提示重新导出」。
           两者都是上传时从文件头部读出来的（见 FileService#readEnvelope），可能为空串。 */
        m.put("format", sf.getFormat());
        m.put("visibility", vis.code());
        m.put("visibilityLabel", vis.label());
        /* 查看与下载分开报：login 档「可查看但不可下载」是常态，前端据此渲染谱面 + 提示登录下载 */
        m.put("viewable", v.downloadable());
        m.put("viewReason", v.reason());
        m.put("downloadable", d.downloadable());
        m.put("reason", d.reason());
        m.put("needsFollow", d.needsFollow());
        m.put("needsFavorite", d.needsFavorite());
        m.put("ownerId", String.valueOf(sf.getOwnerId()));
        /* 曲谱分类：编辑态回显要用（与 score_file 上是同一份，不用另开接口） */
        Map<String, Object> cat = new LinkedHashMap<>();
        cat.put("tuningType", sf.getTuningType());
        cat.put("keyName", sf.getKeyName());
        cat.put("difficulty", sf.getDifficulty());
        cat.put("musicGenre", sf.getMusicGenre());
        m.put("categories", cat);
        return R.ok(m);
    }

    @Operation(summary = "修改乐谱附件的下载分级（作者/管理员）")
    @PutMapping("/{id}/visibility")
    public R<ScoreFile> setVisibility(@PathVariable Long id, @RequestParam String visibility) {
        return R.ok(fileService.updateVisibility(id, visibility));
    }

    private Long currentUserId() {
        return cn.dev33.satoken.stp.StpUtil.isLogin()
                ? cn.dev33.satoken.stp.StpUtil.getLoginIdAsLong() : null;
    }
}
