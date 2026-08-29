## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).


## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists.
- Use `graphify path "<A>" "<B>"` for relationships.
- Use `graphify explain "<concept>"` for focused concepts.
- Use graphify-out/wiki/index.md before browsing source.
- Read GRAPH_REPORT.md only when necessary.
- After modifying code run `graphify update .`.

---

# Damar Development Guide

Damar is an AI Runtime Framework.

Its long-term goal is to become:

- AI Runtime
- AI Agent Platform
- Workflow Engine
- MCP Server
- Local AI Platform
- Home Automation Platform
- Enterprise AI Platform

Always preserve the existing architecture unless there is a compelling reason to change it.

---

# Token Efficiency

Always minimize token usage.

Rules:

- Never read the entire repository.
- Never inspect unrelated modules.
- Read only files required for the current task.
- Never summarize unchanged code.
- Never restate user requirements.
- Never explain unless requested.
- Stop immediately after completing the task.
- Prefer Graphify queries over source browsing.
- Prefer updating existing code over creating new files.

---

# Development Principles

- Keep the Core small.
- Preserve backward compatibility.
- Avoid overengineering.
- Reuse existing services.
- Reuse existing abstractions.
- Never duplicate logic.
- Never duplicate providers.
- Never duplicate middleware.
- Never duplicate helpers.

---

# Architecture

Prefer extension points instead of modifying the Core.

If possible, implement new functionality as:

- Plugin
- Provider
- Adapter
- Driver
- Middleware
- Strategy
- Extension

Core modules should rarely change.

---

# Refactoring

Never perform unrelated refactoring.

Only modify files directly involved in the requested task.

Avoid speculative improvements.

If the current implementation is already good, keep it.

---

# Coding Style

Follow the existing project conventions.

Prefer:

- composition
- dependency injection
- SOLID
- Clean Architecture
- Dependency Inversion

Never introduce circular dependencies.

---

# Output

Unless explicitly requested otherwise:

Return only:

- Root cause
- Files changed
- Code changes
- Reason for changes
- Remaining risks

Keep responses concise.
