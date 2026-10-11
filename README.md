# Bottle

**Search your documents. Get answers with sources.**

Bottle is a retrieval-augmented generation (RAG) application for searching a personal document library and answering questions with evidence from that library. Documents can come from web pages, GitHub pages, or local files.

GitHub Stars is an import method: users connect GitHub, select starred repositories, and bring their content into the same document library.

The core experience is **add documents → index content → search or ask → inspect sources**.

## Product direction

- **One library:** manage documents across sources in one place.
- **One search experience:** find relevant passages and ask questions across imported content.
- **Source-grounded answers:** show citations and direct links to the evidence behind an answer.
- **Flexible imports:** add page URLs, local Markdown files, or selected GitHub Stars.
- **Visible progress:** make fetching, parsing, indexing, refreshes, and failures understandable.

See the [Product Definition](docs/product-definition.md) for scope, user journeys, information architecture, and acceptance criteria.

## Implementation status

The current prototype supports local Markdown retrieval, evidence-based answer drafts, GitHub authentication, selective Stars imports, and WebSocket sync progress. Local document search and GitHub repository search currently use separate pipelines.

Direct web-page imports, direct GitHub-page imports, and a unified document/search model are planned work. Current answer drafts are assembled from retrieved evidence; a configurable generative-model answering layer is also planned.

## Development

The application uses a React/TanStack Start frontend, a NestJS application server, a FastAPI RAG service, and a reusable Python RAG core.

- [Development and API reference](README_MVP.md)
- [Python environment setup](apps/api/README.md)

These development references currently contain Chinese instructions. The product definition and terminology are maintained in English.
