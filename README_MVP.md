# RAG MVP

这是一个零第三方依赖的本地 Hybrid Search RAG 最小原型。

它会读取当前目录下的 Markdown 文件，完成：

- 文档解析
- 按章节分块
- BM25 关键词检索
- TF-IDF 余弦相似检索
- 检索结果融合
- 基于证据片段生成答案草稿和引用来源

## 运行

```bash
python3 rag_mvp.py "为什么生产级 RAG 需要混合搜索？"
```

也可以直接以包方式运行：

```bash
python3 -m rag_core "为什么生产级 RAG 需要混合搜索？"
```

查看检索明细：

```bash
python3 rag_mvp.py "重排序 RAG 解决什么问题？" --show-hits
```

指定知识库文件：

```bash
python3 rag_mvp.py "什么时候需要 SQL + Vector RAG？" --docs "从基础检索到生产级 AI 系统的 10 个 RAG 项目.md"
```

## MVP 边界

当前版本为了保证本地直接可运行，没有接入外部 LLM、embedding 模型或向量数据库。

## 代码结构

```text
rag_mvp.py              # 兼容入口，保留原运行方式
rag_core/
  cli.py                # 命令行参数、文档加载编排、输出
  markdown.py           # Markdown 解析和分块
  tokenization.py       # 中英文分词和查询词处理
  retrieval.py          # BM25 + TF-IDF 混合检索索引
  answering.py          # 基于命中片段生成答案草稿和调试输出
  models.py             # Chunk、SearchHit 等共享数据模型
```

默认会递归索引当前项目里的 Markdown 文件，并跳过 README 类说明文档。需要精确指定知识库时继续使用 `--docs`。

后续可以按这个顺序演进：

1. 将 TF-IDF 替换为 Sentence Transformers 或 OpenAI embeddings。
2. 将内存索引替换为 FAISS、pgvector 或 Elasticsearch。
3. 在 `build_answer` 后接入真实 LLM，并把命中的 chunk 作为上下文。
4. 增加元数据过滤、重排序器和检索质量评估。
