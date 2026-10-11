# Bottle — Product Definition

## Positioning

Bottle is a personal RAG application that turns documents into a searchable, source-grounded knowledge library. Users add content, search across it, and ask questions whose answers link back to relevant passages.

A document is a unit of searchable content. It may originate from a web page, a GitHub page, or a local file. GitHub Stars helps users discover and import documents from repositories they have already saved.

**Product promise:** Find useful knowledge in the content you choose to keep, and understand where every answer comes from.

**Primary workflow:** Add documents → process and index → search or ask → verify sources.

## Users and problems

The initial audience is developers, researchers, and people who collect technical knowledge across websites, documentation, and GitHub.

| User problem | Product response |
| --- | --- |
| Useful content is scattered across bookmarks, repositories, and files. | Bring selected content into one document library. |
| Remembering a title or exact keyword is difficult. | Search with keywords or a natural-language question. |
| A repository was starred but its purpose has been forgotten. | Import selected Stars and search their descriptions and README content. |
| An answer is difficult to trust without evidence. | Show supporting passages and links to original documents. |
| Imported content becomes outdated or fails to process silently. | Show indexing state, last refresh time, and actionable errors. |

## Product principles

1. **Documents are the primary resource.** Sources and import methods describe how documents enter the library.
2. **Search spans sources.** Users should not need to choose a separate GitHub search product to retrieve repository content.
3. **Answers remain verifiable.** Citations refer to passages actually used to produce an answer.
4. **Import is intentional.** Users choose what to add; linking an account does not automatically import everything.
5. **Progress is understandable.** Use user-facing stages and counts instead of exposing internal pipeline details as the main experience.
6. **Failure is recoverable.** Failed imports can be retried without losing successfully indexed documents.

## Content and import model

| Concept | Definition | Examples |
| --- | --- | --- |
| Document | A searchable item with extracted content, metadata, and a source reference. | An article, a documentation page, a repository overview, a Markdown file. |
| Source type | The origin and extraction rules for a document. | Web, GitHub, Local file. |
| Import method | The way a user submits documents for ingestion. | Add URL, Upload file, Import GitHub Stars. |
| Import job | A tracked operation that fetches, extracts, and indexes selected content. | Import 12 selected starred repositories. |
| Passage | A retrievable section of a document. | A README installation section. |
| Citation | A reference from an answer to supporting document content. | Document title, excerpt, and original URL or local source reference. |

### Web documents

Users submit a URL to a publicly accessible HTML page. Bottle extracts the main readable content, title, canonical URL when available, and indexing metadata. The initial scope is the submitted page; importing a page does not imply crawling its entire website.

### GitHub documents

Users can submit a GitHub repository URL or a supported GitHub content-page URL directly. Repository imports initially include repository metadata and the README. Supported Markdown file pages are imported as individual documents; URL recognition should explain unsupported page types.

Repository imports do not imply indexing the entire codebase. Issues, pull requests, discussions, and arbitrary source-code analysis are outside the initial scope.

### GitHub Stars imports

GitHub Stars is a bulk-selection import method for GitHub documents:

1. Connect a GitHub account.
2. Browse or search starred repositories.
3. Select repositories to import.
4. Confirm the selection and start indexing.
5. Monitor progress and see successful documents in the library.

The importer remembers the confirmed selection for later refreshes. Unselected repositories are not fetched or indexed by that import. Removing a repository from the selection stops future refreshes; deleting imported content requires a separate explicit action. A later unstar does not silently delete an existing document.

### Local documents

Local Markdown content remains a supported document source. The current prototype reads configured local directories; a user-facing file upload flow is planned separately.

## Core user journeys

### Add a document

From the library, choose **Add documents**, then select **Add URL**, **Upload file**, or **Import GitHub Stars**. Show supported formats and the content scope before confirmation. After submission, keep the document visible with its processing state.

### Search documents

Enter keywords or a natural-language query in **Search**. Search the user's accessible indexed documents by default. Offer optional filters for source type and document selection. Results show document titles, relevant passages, source labels, and links to original content.

### Ask a question

Use the same search surface to request an answer based on indexed documents. Show an answer, supporting citations, and relevant search results together. If the available evidence is insufficient, explain that limitation instead of presenting an unsupported answer. Users can open a source to inspect the cited passage.

### Refresh content

Refresh a document or a remembered import selection. Preserve the last usable index until the replacement is ready. Show when the content was last indexed, along with refresh status. Refresh must not create duplicate documents for the same canonical source within a user's library.

### Recover from an import failure

Show a meaningful error for the affected document or import stage. Allow retrying failed items without redoing successful work unnecessarily. Keep partial successes visible, and make cancellation distinguishable from failure.

## Information architecture

| Area | Purpose | Primary actions |
| --- | --- | --- |
| Search | Find passages and ask source-grounded questions across the library. | Search, filter, inspect citations, open documents. |
| Library | Manage documents on the standalone `/library` page. | View local and imported documents, open the dedicated `/import/github-stars` selection page, track and cancel imports, and confirm deletion within Library. |
| Imports | Track running and recent ingestion jobs. | View progress, retry failures, cancel active work. |
| Settings | Configure document retrieval and answer generation per account. | Save/test embedding and OpenAI-compatible LLM settings on a standalone page. |
| Login | Authenticate and return to the intended destination. | Email login, create account, GitHub login. |

**Add documents** is a primary action available from Search and Library. **Import GitHub Stars** belongs inside this flow, rather than being a peer to the core search experience.

## Processing and feedback

The ingestion pipeline is fetch → extract → normalize → split into passages → embed → index. Retrieval combines suitable lexical and semantic methods before generating or assembling an evidence-grounded answer.

User-facing states are **Queued**, **Fetching**, **Processing**, **Indexing**, **Ready**, **Failed**, and **Canceled**. For a bulk import, report both overall document progress and the current item's stage. Import completion can include a mixture of successful and failed items; show counts and per-item outcomes.

Push progress updates over WebSocket. Reconnecting clients receive the latest status. Detailed model, networking, and timing diagnostics belong in development logs; production UI should show useful progress and actionable errors without exposing credentials or stack traces.

## Scope and delivery

| Capability | Current prototype | Required next step |
| --- | --- | --- |
| Local Markdown retrieval | Available from configured directories. | Represent local content in the unified document model. |
| GitHub Stars import | Selected repositories, saved selection, metadata and README indexing. | Present it as an import method feeding the shared library. |
| GitHub authentication | Available. | Manage the connection as an optional import integration. |
| Import progress | Stars sync uses WebSocket updates. | Generalize jobs and progress to every document source. |
| Web-page URL import | Planned. | Fetch and extract readable content from supported public pages. |
| Direct GitHub-page import | Planned. | Recognize supported URLs and import without requiring a star. |
| Unified library and search | Planned; local and GitHub retrieval are currently separate. | Shared document identity, metadata, indexing, and retrieval. |
| Grounded answers | Evidence-based drafts and configurable OpenAI-compatible LLM answers with numbered source references are available. | Improve passage-level citation validation and evidence limits. |
| User-facing file upload | Planned. | Validate and ingest supported Markdown uploads. |
| Account isolation | GitHub indices are user-scoped; local documents come from shared configured directories. | Apply document ownership and access checks consistently across every source. |

Delivery order:

1. Establish the shared document and import-job model, including ownership, canonical identity, and source metadata.
2. Move existing Markdown and Stars content into the shared library and search experience.
3. Add direct web and GitHub URL ingestion with per-document failures and retries.
4. Add the answer-generation layer and validate citation quality against representative questions.
5. Extend refresh controls and file uploads using the same ingestion contracts.

### Outside the initial scope

Whole-site crawling, a general web search engine, whole-repository code analysis, collaborative workspaces, and automatic imports of every starred repository are outside the initial scope. Private-page access and additional GitHub content types require separate product and access-control decisions.

## Acceptance criteria

- A supported web URL can produce an indexed document with readable content and its original source link.
- A supported GitHub URL can be imported without first starring it.
- A Stars import processes only the selected repositories and exposes their results in the same library as other documents.
- A single query can retrieve relevant passages across all supported source types.
- Answer citations identify the underlying document and the supporting passage; insufficient evidence is visible to the user.
- A user's queries and imports cannot access another user's private library or integration credentials.
- Import progress survives a client reconnect; a server interruption produces a retryable state instead of an indefinite spinner.
- Refreshes preserve usable content until replacement succeeds, and importing the same canonical source does not silently duplicate it.
- Failed items can be retried, while canceling a job preserves already completed documents.

These criteria describe the intended product. Capabilities marked as planned above are not yet implemented.

## Success measures

Track time from adding a document to its first useful search result, import success and retry rates, search-to-source-open rate, and answer helpfulness with citation correctness. Establish a baseline before setting targets. Keep measurements content-minimal and avoid recording tokens, private document text, or integration credentials in diagnostics.

## English product vocabulary

Use **Search**, **Library**, **Documents**, **Add documents**, **Add URL**, **Upload file**, **Import GitHub Stars**, **Imports**, **Refresh**, **Sources**, and **Citations** consistently.

Use **document** as the umbrella term across web, GitHub, and local content. Use **GitHub** for the source type and **GitHub Stars** only for the import integration. Reserve **chunk**, **embedding**, and **vector index** for developer documentation or optional technical details.
