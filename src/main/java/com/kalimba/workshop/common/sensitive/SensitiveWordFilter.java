package com.kalimba.workshop.common.sensitive;

import com.kalimba.workshop.common.exception.BizException;
import com.kalimba.workshop.common.exception.ErrorCode;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 敏感词过滤（DFA 前缀树，规划书 4.4 内容安全）。
 *
 * <p>选 DFA 而不是正则枚举：词表增长时匹配复杂度只与**文本长度**有关，
 * 与词条数量无关；且一次扫描能给出所有命中位置，便于「命中即拒」与「替换」两种策略共用。
 * 词表放 resources/sensitive-words.txt，一行一词，改词表不用改代码。
 */
@Component
public class SensitiveWordFilter {

    private static final Logger log = LoggerFactory.getLogger(SensitiveWordFilter.class);

    /** 命中词最多留痕几个（日志用，避免刷屏）。 */
    private static final int MAX_LOG_HITS = 5;

    private final TrieNode root = new TrieNode();

    @PostConstruct
    public void load() {
        ClassPathResource res = new ClassPathResource("sensitive-words.txt");
        if (!res.exists()) {
            log.warn("未找到 sensitive-words.txt，敏感词过滤按空词表运行");
            return;
        }
        int n = 0;
        try (BufferedReader br = new BufferedReader(
                new InputStreamReader(res.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = br.readLine()) != null) {
                String w = line.trim();
                if (w.isEmpty() || w.startsWith("#")) continue;
                add(w);
                n++;
            }
        } catch (Exception e) {
            log.error("加载敏感词失败", e);
        }
        log.info("敏感词表加载完成，共 {} 条", n);
    }

    private void add(String word) {
        TrieNode cur = root;
        for (char c : word.toCharArray()) {
            cur = cur.next.computeIfAbsent(c, k -> new TrieNode());
        }
        cur.end = true;
    }

    /** 返回命中的词（最多 {@value #MAX_LOG_HITS} 个）。 */
    public List<String> hits(String text) {
        if (text == null || text.isEmpty()) return List.of();
        List<String> found = new java.util.ArrayList<>();
        char[] cs = text.toCharArray();
        for (int i = 0; i < cs.length; i++) {
            TrieNode cur = root;
            for (int j = i; j < cs.length; j++) {
                cur = cur.next.get(cs[j]);
                if (cur == null) break;
                if (cur.end) {
                    found.add(new String(cs, i, j - i + 1));
                    if (found.size() >= MAX_LOG_HITS) return found;
                    break;
                }
            }
        }
        return found;
    }

    public boolean contains(String text) {
        return !hits(text).isEmpty();
    }

    /** 命中即拒：统一在这里抛，调用方不必各自判断。 */
    public void assertClean(String text) {
        List<String> h = hits(text);
        if (!h.isEmpty()) {
            log.info("内容被拦截，命中词 {} 个（示例：{}）", h.size(), String.join(",", h));
            throw BizException.of(ErrorCode.CONTENT_REJECTED);
        }
    }

    private static class TrieNode {
        final Map<Character, TrieNode> next = new HashMap<>();
        boolean end;
    }
}
