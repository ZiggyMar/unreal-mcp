# Competitive Landscape — Unreal Engine MCP Servers

Survey date: 2026-08-07. Scope: the 9 third-party GitHub repos identified as of this date as
competing/related "MCP server for Unreal Engine" projects, plus Epic's own first-party
experimental plugin in UE 5.8 as a non-competitor comparison point.

**Methodology.** For each repo: fetched repo metadata via the GitHub REST API
(`api.github.com/repos/<owner>/<repo>`, which includes GitHub's own license-file detection),
fetched `LICENSE`/`LICENSE.md`/`LICENSE.txt` directly from `raw.githubusercontent.com` (trying
