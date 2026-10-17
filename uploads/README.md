用户上传目录
============

本目录由应用在**运行时**写入，内容不入库（见 ../.gitignore）：

  img/    帖子封面与头像等图片（POST /api/files/image）
  score/  乐谱附件 JSON（POST /api/files/score）

为什么保留这个说明文件：
  git 不跟踪空目录。若整个 uploads/ 都不入库，全新克隆后
  FileService.store() 虽然会自动 mkdirs，但目录语义就此丢失，
  新人容易误以为「上传功能没实现」。

注意：
  score_file 表里存着附件的元数据与属主，磁盘文件与库记录是
  一一对应的。清空本目录会导致已有帖子的乐谱下载 404，
  所以**不要**把这里的文件当临时文件清理。
