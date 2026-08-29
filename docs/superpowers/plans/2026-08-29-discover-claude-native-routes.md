# Discover Claude Native Routes Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` task-by-task; the OpenSpec task list is the tracker.

> **Authority:** OpenSpec change [`discover-claude-native-routes`](../../../openspec/changes/discover-claude-native-routes/) owns scope, semantics, and completion. Execute its `tasks.md`; this file orders the work only.

**Work order**

1. Confirm its two prerequisite changes share the candidate base.
2. Run task 1 first. If zero-prompt control evidence is incomplete, freeze the negative receipt and return `HOLD`; do not modify Claude admission.
3. Only after a complete fake-native fixture exists, execute task 2 atomically and rerun Claude contract/parity tests.
4. Complete task 3 diagnostics/public-surface work, preserving the existing turn/execution-profile owners.
5. Run task 4 deterministic checks. A live inspection/turn remains an independently authorized final gate.

**Execution boundary:** no static fallback catalog, live paid call, installation, release, archive, or version change.
