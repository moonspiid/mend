# mend

mend is the command-line tool [SPEC.md](SPEC.md) specifies: it applies an edit
an AI model wrote to a tree of text files. Models write edits in four formats —
a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the
V4A patch format and text-editor tool calls as JSON — and mend reads all four
as one written specification, finds the lines an edit names even when the model
drifted their whitespace or indentation, and changes every file or none.

Run it as `node main.ts [options] [PATCH]` on Node 22, with the standard library
alone, from the root of the tree:

- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; the default, `auto`, detects it.
- `--check` does everything but write.
- `--strict` matches lines exactly (tier 0 only).
- With no `PATCH` or `-`, the patch is read from standard input.

Exit codes and output are described by SPEC.md.
