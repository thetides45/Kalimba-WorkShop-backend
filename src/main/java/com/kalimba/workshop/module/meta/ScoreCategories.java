package com.kalimba.workshop.module.meta;

/**
 * 曲谱结构化分类字典（WBS 4.3，规划书「曲谱分类」）。
 *
 * <p>与「帖子标签 tag」是**两套并行**的体系：
 *  - tag 是帖子维度的内容/话题标签（教程/求谱/翻弹/原创…），一帖多标签；
 *  - 本类三组枚举是**曲谱本身**的分类（琴型/调性/难度），字段落在乐谱附件 score_file 上，
 *    一份谱无论被哪篇帖子引用，分类都跟着谱走。
 *
 * <p>为什么不建表而用枚举：这三组是**封闭、低频变更**的取值，枚举更简单、可编译期校验；
 * 真要到「运营后台可增删」那一步，再迁成字典表也不迟。
 */
public final class ScoreCategories {

    private ScoreCategories() {}

    /** 琴型。 */
    public enum TuningType {
        K17("k17", "17 键"),
        K21("k21", "21 键"),
        OTHER("other", "其他");

        public final String code;
        public final String label;

        TuningType(String code, String label) {
            this.code = code;
            this.label = label;
        }
    }

    /** 调性（与制谱内核的调名口径一致：C/D/E/F/G/A/B 及其升降）。 */
    public enum KeyName {
        C("C", "C 大调"),
        Db("Db", "降 D 大调"),
        D("D", "D 大调"),
        Eb("Eb", "降 E 大调"),
        E("E", "E 大调"),
        F("F", "F 大调"),
        Fs("F#", "升 F 大调"),
        G("G", "G 大调"),
        Ab("Ab", "降 A 大调"),
        A("A", "A 大调"),
        Bb("Bb", "降 B 大调"),
        B("B", "B 大调");

        public final String code;
        public final String label;

        KeyName(String code, String label) {
            this.code = code;
            this.label = label;
        }
    }

    /** 难度。 */
    public enum Difficulty {
        BEGINNER("beginner", "入门"),
        EASY("easy", "初级"),
        MEDIUM("medium", "中级"),
        HARD("hard", "高级");

        public final String code;
        public final String label;

        Difficulty(String code, String label) {
            this.code = code;
            this.label = label;
        }
    }

    /** 音乐类型（曲风/题材）。 */
    public enum MusicGenre {
        ANIME("anime", "动漫 / 游戏"),
        CANTONESE("cantonese", "粤语"),
        CHINESE("chinese", "国风"),
        CLASSIC("classic", "经典"),
        POP("pop", "流行"),
        FOLK("folk", "民谣"),
        OST("ost", "影视 OST"),
        PURE("pure", "纯音乐"),
        OTHER("other", "其他");

        public final String code;
        public final String label;

        MusicGenre(String code, String label) {
            this.code = code;
            this.label = label;
        }
    }
}
