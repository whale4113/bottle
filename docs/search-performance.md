# 搜索速度与质量方案

## 结论与证据

30 条数据不应首先靠分页优化。当前 GitHub 搜索已经在同步时生成并持久化文档向量，查询向量也有按配置隔离的 LRU 缓存和并发请求合并。首次查询仍可能需要加载本地模型或调用远程 Embedding；配置 LLM 后，每个未缓存查询还会同步重排，原来最多 20 段、每段约 3000 字符，请求超时 5 秒。这是代码中可确认的秒级等待来源，但没有真实请求分阶段测量，不能断言用户观察到的 4 秒全部来自重排。

Google 提前爬取、建立索引，在线查询索引并排序，而不是每次搜索重新处理全部网页。这里应采用相同的离线预处理、在线低成本召回、少量候选精排的方向。Google 的具体内部延迟分配没有公开，不能直接推导本项目的性能。

参考：
- https://www.google.com/intl/en_us/search/howsearchworks/how-search-works/organizing-information/
- https://www.google.com/search/howsearchworks/how-search-works/ranking-results/
- https://sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html

## 本次实现

设置 → LLM model → Search relevance → Speed and quality：

| 模式 | 召回 | LLM 重排 | 请求超时 |
| --- | --- | --- | --- |
| Fast | BM25 + 向量 | 跳过 | 无重排等待 |
| Balanced（默认） | BM25 + 向量 | 最多 8 段 | min(模型配置, 1 秒) |
| Quality | BM25 + 向量 | 最多 20 段 | min(模型配置, 5 秒) |

原有重排开关继续生效；关闭后所有模式都跳过 LLM。已有配置缺少 search_mode 时使用 balanced，不修改持久化的其他设置。候选不足时不额外请求。无效回复或超时保留混合检索结果；成功重排保留证据引用校验和原有缓存。超出精排预算的尾部候选保留，避免 top_k 较大时丢失结果。

超时是 HTTP socket 超时，不是全链路严格截止时间；响应持续发送数据时可能超过该值。模型加载、Embedding、数据库读取时间另外计算。1 秒预算是可调整的初始工程选择，并非经本项目质量数据验证的最优值。慢模型可能频繁回退；对跨语言意图要求高时选择 quality。

GitHub 日志新增 prepare_ms、vector_ms、rerank_ms、total_ms；本地文档日志记录 retrieval_ms、rerank_ms、total_ms。使用 rag_core 对应模块的 INFO 日志采样，不记录问题、文本或密钥。计时 total 覆盖检索和重排，不含最终结果序列化及网络传输。本地 retrieval 包含首次索引向量和摘要生成。

## 验收与后续

在相同账号、模型、索引上，对快速/平衡/质量各执行至少 30 个不同查询，分别统计首次请求和重复请求的 p50/p95。增加脚本、代码生成、虚拟滚动、精确仓库名、跨语言、无相关结果等带人工标注的查询，比较 Recall@20、nDCG@5 和无结果准确率。快速模式的可验证收益是消除同步 LLM 请求；没有真实模型测量前不承诺毫秒数或质量无损。

如果 vector_ms 占主导：确认本地模型设备和冷启动；在启动时预热模型，或选择延迟更低的 Embedding 服务。如果 rerank_ms 占主导且平衡模式频繁超时：采用专用 cross-encoder/rerank 服务，再依据标注集选择候选数量。当前小规模索引无需引入分布式搜索；当全量向量扫描在实测 p95 中成为瓶颈后再迁移 ANN 和持久化全文索引。

本地文档首次摘要和向量生成仍在搜索路径内，长期应拆为显式索引任务。GitHub 搜索每次重建轻量 BM25 并扫描已有向量；数据规模扩大后应缓存版本化索引。分页应基于同一次召回排序的稳定快照，而不是把文档拆成若干批各自搜索，否则后面的最佳结果可能永远不进入首屏。
